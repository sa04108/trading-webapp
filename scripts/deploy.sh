#!/usr/bin/env bash
# 스펙 §30 — 릴리스 배포. 개발 PC 에서 빌드·검증 후 WireGuard IP 로 배포한다.
# 사용법: ./scripts/deploy.sh <wireguard-host>   (예: ./scripts/deploy.sh 10.20.0.15)
# 비밀값을 command line argument 로 넘기지 않는다.
set -euo pipefail

HOST="${1:?usage: deploy.sh <wireguard-host>}"
RELEASE="$(date -u +%Y%m%d-%H%M%S)-$(git rev-parse --short HEAD)"
GIT_SHA="$(git rev-parse HEAD)"
ARCHIVE="quant-platform-${RELEASE}.tar.gz"

echo "==> 검증 게이트"
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm test
BUILD_GIT_SHA="${GIT_SHA}" pnpm build

echo "==> 아티팩트 생성: ${ARCHIVE}"
tar -czf "${ARCHIVE}" dist migrations package.json pnpm-lock.yaml

echo "==> 업로드 및 릴리스 전환"
scp "${ARCHIVE}" "ubuntu@${HOST}:/tmp/"
ssh "ubuntu@${HOST}" bash -s <<EOF
set -euo pipefail
sudo mkdir -p "/opt/quant-platform/releases/${RELEASE}"
sudo tar -xzf "/tmp/${ARCHIVE}" -C "/opt/quant-platform/releases/${RELEASE}"
cd "/opt/quant-platform/releases/${RELEASE}"
sudo corepack pnpm install --prod --frozen-lockfile
sudo ln -sfn "/opt/quant-platform/releases/${RELEASE}" /opt/quant-platform/current
sudo systemctl restart quant-platform
sleep 3
curl -fsS http://127.0.0.1:3000/api/v1/health/ready
echo "release ${RELEASE} live"
EOF

rm -f "${ARCHIVE}"
echo "==> 완료. 롤백: 이전 release 로 symlink 교체 후 restart"
