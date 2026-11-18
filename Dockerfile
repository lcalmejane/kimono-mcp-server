FROM node:24-trixie-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:24-trixie-slim AS production-dependencies
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

# RTK (https://github.com/rtk-ai/rtk, Apache-2.0) compiled from source: published binaries need glibc >= 2.39.
# The open-source edition (--no-default-features) has no telemetry endpoint.
FROM rust:1-trixie AS rtk
ARG RTK_VERSION=v1.1.0
ENV PATH="/opt/rtk/bin:${PATH}"
RUN cargo install --git https://github.com/rtk-ai/rtk --tag "${RTK_VERSION}" rtk --no-default-features --locked --root /opt/rtk

FROM rust:1-trixie AS tooling-base
RUN apt-get update && apt-get install -y --no-install-recommends git gh jq openssh-client ca-certificates libatomic1 poppler-utils \
    && rm -rf /var/lib/apt/lists/* \
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

FROM tooling-base AS tooling
ARG FAST_GREP_VERSION=0.5.0
RUN cargo install fast-grep --version "${FAST_GREP_VERSION}" --locked

FROM tooling AS semantic-build
# ~200 Tree-sitter grammars are large C files (1-2 GB RAM each at -O): bound parallel compilation
# so an 8 GB Docker VM does not run out of memory. Raise on bigger builders.
ARG CARGO_BUILD_JOBS=4
ENV CARGO_BUILD_JOBS=${CARGO_BUILD_JOBS}
ENV ORT_SKIP_DOWNLOAD=1
WORKDIR /semantic
COPY semantic/Cargo.toml semantic/Cargo.lock ./
COPY semantic/src ./src
RUN cargo build --release --locked && cargo test --release --locked

FROM tooling AS semantic-assets
WORKDIR /assets
COPY semantic/model.json semantic/versions.json ./semantic/
COPY scripts/prepare-semantic.mjs scripts/onnxruntime-package.mjs ./scripts/
RUN node scripts/prepare-semantic.mjs /opt/kimono

FROM tooling AS semantic-tooling
COPY --from=semantic-build /semantic/target/release/kimono-semantic /usr/local/bin/kimono-semantic
COPY --from=semantic-assets /opt/kimono /opt/kimono
COPY THIRD_PARTY_NOTICES.md /opt/kimono/THIRD_PARTY_NOTICES.md
ENV ORT_DYLIB_PATH=/opt/kimono/onnxruntime/lib/libonnxruntime.so \
    KIMONO_MODEL_DIR=/opt/kimono/model

FROM build AS test-files
COPY vitest.config.ts Dockerfile ./
COPY tests ./tests
COPY semantic ./semantic
COPY scripts ./scripts
COPY benchmarks ./benchmarks
# tests/native-env.ts loads vscode/native.cjs (shared native-tooling environment)
COPY vscode ./vscode

FROM semantic-tooling AS test
COPY --from=test-files --chown=node:node /app /app
RUN chown node:node /app
USER node
CMD ["npm", "test"]

# Release images and CI consume the same verified Linux bundle as the VSIX.
# Ubuntu 24.04-built engines run on the newer glibc in Debian 13; smoke tests
# exercise the resulting image on each native architecture before publication.
FROM tooling-base AS bundled-tooling
ARG BUNDLE_TARGET
COPY --chown=node:node native-bundles/${BUNDLE_TARGET}/ /opt/kimono/
COPY vscode/native.cjs /usr/local/lib/kimono-native.cjs
RUN node --input-type=module -e 'import { nativeEnvironment } from "/usr/local/lib/kimono-native.cjs"; await nativeEnvironment("/opt/kimono");' \
    && install -m 755 /opt/kimono/bin/fgr /usr/local/bin/fgr \
    && install -m 755 /opt/kimono/bin/kimono-semantic /usr/local/bin/kimono-semantic
ENV ORT_DYLIB_PATH=/opt/kimono/lib/libonnxruntime.so \
    LD_LIBRARY_PATH=/opt/kimono/lib \
    KIMONO_MODEL_DIR=/opt/kimono/model

FROM bundled-tooling AS test-prebuilt
COPY --from=test-files --chown=node:node /app /app
RUN chown node:node /app
USER node
CMD ["npm", "test"]

FROM bundled-tooling AS runtime-prebuilt
ENV NODE_ENV=production
COPY --from=production-dependencies --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./package.json
USER node
EXPOSE 3000
CMD ["node", "dist/index.js"]

FROM semantic-tooling AS runtime
ENV NODE_ENV=production
COPY --from=production-dependencies --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./package.json
USER node
EXPOSE 3000
CMD ["node", "dist/index.js"]