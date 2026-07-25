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
pnpm build

# 릴리스 SHA 를 산출물에 포함 — 런타임(서버·백테스트 워커)이 읽어 §9.5 메타데이터에 기록한다
printf '{"gitSha":"%s","builtAt":"%s"}\n' "${GIT_SHA}" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > dist/build-info.json

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

# 롤백 대비: 전환 전의 release 를 기억한다 (최초 배포면 비어 있음)
PREVIOUS_RELEASE="\$(readlink -f /opt/quant-platform/current 2>/dev/null || true)"

sudo ln -sfn "/opt/quant-platform/releases/${RELEASE}" /opt/quant-platform/current
sudo systemctl restart quant-platform
sleep 3
if ! curl -fsS http://127.0.0.1:3000/api/v1/health/ready; then
  echo "health check 실패 — 이전 release 로 롤백합니다 (스펙 §30)" >&2
  if [ -n "\${PREVIOUS_RELEASE}" ] && [ -d "\${PREVIOUS_RELEASE}" ]; then
    sudo ln -sfn "\${PREVIOUS_RELEASE}" /opt/quant-platform/current
    sudo systemctl restart quant-platform
    echo "rolled back to \${PREVIOUS_RELEASE}" >&2
  else
    echo "롤백할 이전 release 가 없습니다 — 서비스 상태를 직접 확인하세요" >&2
  fi
  exit 1
fi
echo "release ${RELEASE} live"
EOF

rm -f "${ARCHIVE}"
echo "==> 완료"
