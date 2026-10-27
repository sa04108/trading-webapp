# syntax=docker/dockerfile:1
ARG NODE_VERSION=24.22.1
FROM node:${NODE_VERSION}-bookworm-slim AS build
WORKDIR /build
# 관리형 환경의 프록시 CA는 빌드에만 마운트하고 이미지에 보관하지 않는다.
RUN --mount=type=secret,id=proxy_ca \
    if [ -f /run/secrets/proxy_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca; fi; \
    apt-get update \
    && apt-get install --no-install-recommends -y python3 make g++ pkg-config \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --global corepack@0.34.6 && corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=secret,id=proxy_ca \
    if [ -f /run/secrets/proxy_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca; fi; \
    pnpm install --frozen-lockfile
COPY . .
ARG BUILD_GIT_SHA
ARG AGENT_VERSION
RUN node --input-type=module -e 'import fs from "node:fs"; const gitSha=process.env.BUILD_GIT_SHA; if(!/^[a-f0-9]{40,64}$/.test(gitSha??"")) throw new Error("BUILD_GIT_SHA is required"); fs.mkdirSync("dist",{recursive:true}); fs.writeFileSync("dist/build-info.json",JSON.stringify({gitSha,builtAt:new Date().toISOString()}));' \
    && pnpm build:agent --prepared \
    && node --input-type=module -e 'import fs from "node:fs"; const v=JSON.parse(fs.readFileSync("dist/clients/manifest.json")).runnerVersion; if(v!==process.env.AGENT_VERSION) throw new Error("Server/container agent versions differ");' \
    && mkdir /agent \
    && tar -xzf dist/clients/quant-agent-linux-$(node -p process.arch).tar.gz -C /agent \
    && rm /agent/bin/node \
    && ln -s /usr/local/bin/node /agent/bin/node

FROM node:${NODE_VERSION}-bookworm-slim
ARG BUILD_GIT_SHA
ARG AGENT_VERSION
LABEL org.opencontainers.image.source="https://github.com/sa04108/trading-webapp" \
      org.opencontainers.image.revision="${BUILD_GIT_SHA}" \
      org.opencontainers.image.version="${AGENT_VERSION}" \
      org.opencontainers.image.title="Quant Agent"
WORKDIR /opt/quant-agent
COPY --from=build --chown=node:node /agent/ ./
RUN mkdir -p /var/lib/quant-agent && chown node:node /var/lib/quant-agent
ENV QUANT_AGENT_CONTAINER=1 XDG_STATE_HOME=/var/lib NODE_ENV=production
USER node
STOPSIGNAL SIGTERM
ENTRYPOINT ["/opt/quant-agent/quant-agent"]
CMD ["run"]
