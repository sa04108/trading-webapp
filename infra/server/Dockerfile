# syntax=docker/dockerfile:1
ARG NODE_VERSION=24.22.2
FROM node:${NODE_VERSION}-bookworm-slim AS build
WORKDIR /build
# 프록시 인증서는 빌드 secret으로만 읽고 배포 이미지에는 저장하지 않는다.
RUN --mount=type=secret,id=proxy_ca \
    if [ -f /run/secrets/proxy_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca; fi; \
    apt-get update && apt-get install --no-install-recommends -y python3 make g++ pkg-config \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --global corepack@0.34.6 && corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=secret,id=proxy_ca \
    if [ -f /run/secrets/proxy_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca; fi; \
    pnpm install --frozen-lockfile
COPY . .
ARG BUILD_GIT_SHA
RUN node --input-type=module -e 'if(!/^[a-f0-9]{40,64}$/.test(process.env.BUILD_GIT_SHA??"")) throw new Error("BUILD_GIT_SHA is required")' \
    && pnpm build \
    && node --input-type=module -e 'import fs from "node:fs"; fs.writeFileSync("dist/build-info.json",JSON.stringify({gitSha:process.env.BUILD_GIT_SHA,builtAt:new Date().toISOString()}))' \
    && pnpm prune --prod

FROM node:${NODE_VERSION}-bookworm-slim
ARG BUILD_GIT_SHA
ARG AGENT_CONTAINER_IMAGE=ghcr.io/sa04108/quant-agent:latest
LABEL org.opencontainers.image.source="https://github.com/sa04108/trading-webapp" \
      org.opencontainers.image.revision="${BUILD_GIT_SHA}" \
      org.opencontainers.image.title="Quant Platform"
WORKDIR /opt/quant-platform
COPY --chown=node:node --from=build /build/node_modules ./node_modules
COPY --chown=node:node --from=build /build/dist ./dist
COPY --chown=node:node --from=build /build/migrations ./migrations
COPY --chown=node:node --from=build /build/package.json ./package.json
COPY --chown=node:node --from=build /build/scripts/install-agent-windows.ps1 ./scripts/install-agent-windows.ps1
RUN mkdir -p /var/lib/quant-platform && chown node:node /var/lib/quant-platform
ENV NODE_ENV=production APP_BIND_ADDRESS=0.0.0.0 APP_PORT=3000 \
    DATABASE_PATH=/var/lib/quant-platform/app.sqlite \
    DATA_ROOT=/var/lib/quant-platform/market-data \
    IMPORT_ROOT=/var/lib/quant-platform/imports \
    EXPORT_ROOT=/var/lib/quant-platform/exports \
    TEMP_ROOT=/var/lib/quant-platform/temp \
    AGENT_CONTAINER_IMAGE=${AGENT_CONTAINER_IMAGE}
USER node
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=15s --timeout=5s --start-period=60s --retries=4 \
    CMD node -e 'fetch("http://127.0.0.1:"+(process.env.APP_PORT||3000)+"/api/v1/health/ready").then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))'
CMD ["node", "dist/server/bootstrap/main.js"]
