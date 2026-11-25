# syntax=docker/dockerfile:1

# Node 24 LTS (bookworm-slim) multi-arch OCI index (linux/arm64 + linux/amd64)
FROM --platform=$BUILDPLATFORM node:24-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54 AS base
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable ; corepack prepare pnpm@12.21.0 --activate

FROM base AS builder
WORKDIR /src

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json tsconfig.json ./
COPY shared/package.json ./shared/package.json
COPY server/package.json ./server/package.json
COPY web/package.json ./web/package.json

RUN pnpm install --frozen-lockfile --ignore-scripts

COPY shared ./shared
COPY server ./server
COPY web ./web

ARG GIT_SHA=dev
ENV GIT_SHA=${GIT_SHA}

RUN pnpm --filter @sql-scratchpad/shared build ; pnpm --filter @sql-scratchpad/server build ; pnpm --filter @sql-scratchpad/web build

FROM base AS prod-deps
WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY shared/package.json ./shared/package.json
COPY server/package.json ./server/package.json
COPY web/package.json ./web/package.json

RUN pnpm --filter @sql-scratchpad/server... install --frozen-lockfile --prod --ignore-scripts

FROM node:24-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54 AS runtime
WORKDIR /app

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=5050

COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=prod-deps /app/server/node_modules ./server/node_modules
COPY --from=builder /src/shared/package.json ./shared/package.json
COPY --from=builder /src/shared/dist ./shared/dist
COPY --from=builder /src/server/package.json ./server/package.json
COPY --from=builder /src/server/datasets.json ./server/datasets.json
COPY --from=builder /src/server/dist ./server/dist
COPY --from=builder /src/web/dist ./web/dist

USER node
EXPOSE 5050

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:5050/api/health').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

CMD ["node", "server/dist/server.js"]
