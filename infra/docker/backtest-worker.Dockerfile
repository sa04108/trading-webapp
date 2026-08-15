# syntax=docker/dockerfile:1.7

# Node 이미지는 digest로 고정한다. 새 보안 패치를 반영할 때 버전과 digest를 함께 갱신한다.
ARG NODE_BUILD_IMAGE=node:24.18.0-bookworm@sha256:5711a0d445a1af54af9589066c646df387d1831a608226f4cd694fc59e745059
ARG NODE_RUNTIME_IMAGE=node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d

FROM ${NODE_BUILD_IMAGE} AS dependencies
WORKDIR /app

# better-sqlite3 같은 native dependency를 target Linux ABI로 설치한다.
RUN apt-get update \
  && apt-get install -y --no-install-recommends g++ make python3 \
  && rm -rf /var/lib/apt/lists/*
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN corepack enable \
  && corepack pnpm install --prod --frozen-lockfile \
  && corepack pnpm store prune
COPY dist ./dist
COPY migrations ./migrations

FROM ${NODE_RUNTIME_IMAGE} AS runtime
ARG BUILD_GIT_SHA
ARG BUILD_CREATED_AT
ARG BUILD_RELEASE

LABEL org.opencontainers.image.title="Quant Platform Remote Backtest Worker" \
  org.opencontainers.image.revision="${BUILD_GIT_SHA}" \
  org.opencontainers.image.created="${BUILD_CREATED_AT}" \
  io.quant-platform.release="${BUILD_RELEASE}"

# flock은 PID namespace와 무관한 work-root 단일 실행 잠금에 사용한다.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates util-linux \
  && rm -rf /var/lib/apt/lists/* \
  && groupadd --gid 10001 quant-worker \
  && useradd --uid 10001 --gid 10001 --no-create-home --home-dir /nonexistent \
       --shell /usr/sbin/nologin quant-worker \
  && install -d -o 10001 -g 10001 -m 0700 /var/lib/quant-backtest-worker

WORKDIR /app
COPY --from=dependencies --chown=10001:10001 /app /app
COPY --chmod=0755 worker-entrypoint.sh /usr/local/bin/worker-entrypoint

ENV NODE_ENV=production \
  BACKTEST_WORK_ROOT=/var/lib/quant-backtest-worker
USER 10001:10001
ENTRYPOINT ["/usr/local/bin/worker-entrypoint"]
CMD ["node", "/app/dist/workers/remote-backtest-supervisor.js"]
