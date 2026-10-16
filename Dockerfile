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

FROM rust:1-bookworm AS tooling
ARG FAST_GREP_VERSION=0.5.0
RUN apt-get update && apt-get install -y --no-install-recommends git openssh-client ca-certificates libatomic1 \
    && rm -rf /var/lib/apt/lists/* \
    && cargo install fast-grep --version "${FAST_GREP_VERSION}" --locked \
    && useradd --create-home --uid 1000 node \
    && mkdir -p /home/node/.cache/kimono \
    && chown -R node:node /home/node/.cache
COPY --from=build /usr/local/bin/node /usr/local/bin/node
COPY --from=build /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/npm
RUN ln -s /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
    && ln -s /usr/local/lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx
ENV KIMONO_CACHE_DIR=/home/node/.cache/kimono
WORKDIR /app

FROM tooling AS test
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package*.json tsconfig.json ./
COPY --chown=node:node src ./src
COPY --chown=node:node tests ./tests
RUN chown node:node /app
USER node
CMD ["npm", "test"]

FROM tooling AS runtime
ENV NODE_ENV=production
COPY --from=production-dependencies --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./package.json
USER node
EXPOSE 3000
CMD ["node", "dist/index.js"]