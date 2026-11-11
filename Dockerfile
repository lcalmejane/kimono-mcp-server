FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:24-bookworm-slim AS production-dependencies
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

# RTK (https://github.com/rtk-ai/rtk, Apache-2.0) compiled from source: published binaries need glibc >= 2.39.
# The open-source edition (--no-default-features) has no telemetry endpoint.
FROM rust:1-bookworm AS rtk
ARG RTK_VERSION=v1.1.0
RUN cargo install --git https://github.com/rtk-ai/rtk --tag "${RTK_VERSION}" rtk --no-default-features --locked --root /opt/rtk

FROM rust:1-bookworm AS tooling
ARG FAST_GREP_VERSION=0.5.0
RUN apt-get update && apt-get install -y --no-install-recommends git gh jq openssh-client ca-certificates libatomic1 poppler-utils \
    && rm -rf /var/lib/apt/lists/* \
    && cargo install fast-grep --version "${FAST_GREP_VERSION}" --locked \
    && useradd --create-home --uid 1000 node \
    && mkdir -p /home/node/.cache/kimono \
    && chown -R node:node /home/node/.cache
COPY --from=build /usr/local/bin/node /usr/local/bin/node
COPY --from=build /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/npm
RUN ln -s /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
    && ln -s /usr/local/lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx
COPY --from=rtk /opt/rtk/bin/rtk /usr/local/bin/rtk
ENV KIMONO_CACHE_DIR=/home/node/.cache/kimono \
    RTK_TELEMETRY_DISABLED=1
WORKDIR /app

FROM tooling AS semantic-build
# ~200 Tree-sitter grammars are large C files (1-2 GB RAM each at -O): bound parallel compilation
# so an 8 GB Docker VM does not run out of memory. Raise on bigger builders.
ARG CARGO_BUILD_JOBS=4
ENV CARGO_BUILD_JOBS=${CARGO_BUILD_JOBS}
ENV ORT_SKIP_DOWNLOAD=1
WORKDIR /semantic
COPY semantic/Cargo.toml semantic/Cargo.lock ./
COPY semantic/src ./src
RUN cargo build --release --locked && cargo test --locked

FROM tooling AS semantic-assets
WORKDIR /assets
COPY semantic/model.json semantic/versions.json ./semantic/
COPY scripts/prepare-semantic.mjs ./scripts/
RUN node scripts/prepare-semantic.mjs /opt/kimono

FROM tooling AS semantic-tooling
COPY --from=semantic-build /semantic/target/release/kimono-semantic /usr/local/bin/kimono-semantic
COPY --from=semantic-assets /opt/kimono /opt/kimono
COPY THIRD_PARTY_NOTICES.md /opt/kimono/THIRD_PARTY_NOTICES.md
ENV ORT_DYLIB_PATH=/opt/kimono/onnxruntime/lib/libonnxruntime.so \
    KIMONO_MODEL_DIR=/opt/kimono/model

FROM semantic-tooling AS test
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package*.json tsconfig.json vitest.config.ts Dockerfile ./
COPY --chown=node:node src ./src
COPY --chown=node:node tests ./tests
COPY --chown=node:node semantic ./semantic
COPY --chown=node:node scripts ./scripts
COPY --chown=node:node benchmarks ./benchmarks
RUN chown node:node /app
USER node
CMD ["npm", "test"]

FROM semantic-tooling AS runtime
ENV NODE_ENV=production
COPY --from=production-dependencies --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./package.json
USER node
EXPOSE 3000
CMD ["node", "dist/index.js"]