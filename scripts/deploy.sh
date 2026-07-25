#!/usr/bin/env bash
# 스펙 §30 — 릴리스 배포. 개발 PC 에서 빌드·검증 후 WireGuard IP 로 배포한다.
# 사용법: ./scripts/deploy.sh <wireguard-host>   (예: ./scripts/deploy.sh 10.20.0.15)
# 비밀값을 command line argument 로 넘기지 않는다.
set -euo pipefail

HOST="${1:?usage: deploy.sh <wireguard-host>}"
RELEASE="$(date -u +%Y%m%d-%H%M%S)-$(git rev-parse --short HEAD)"
GIT_SHA="$(git rev-parse HEAD)"
ARCHIVE="quant-platform-${RELEASE}.tar.gz"
# 배포가 어디서 실패하든 (검증 게이트, 업로드, health check 롤백) 아카이브는 남기지 않는다
trap 'rm -f "${ARCHIVE}"' EXIT

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
# 업로드본은 풀고 나면 쓸모없다 — 40GB 디스크에 배포마다 쌓이지 않게 즉시 지운다
rm -f "/tmp/${ARCHIVE}"
cd "/opt/quant-platform/releases/${RELEASE}"
sudo corepack pnpm install --prod --frozen-lockfile

# 롤백 대비: 전환 전의 release 를 기억한다 (최초 배포면 비어 있음)
PREVIOUS_RELEASE="\$(readlink -f /opt/quant-platform/current 2>/dev/null || true)"

# 파괴적 마이그레이션 대비 (D-010): 재시작(=마이그레이션 적용) 전 DB 스냅샷.
# 롤백 시 코드와 스키마가 짝으로 되돌아가도록 스냅샷을 함께 복원한다.
DB_PATH="/var/lib/quant-platform/app.sqlite"
DB_SNAPSHOT="/var/lib/quant-platform/backups/pre-deploy-${RELEASE}.sqlite"
if [ -f "\${DB_PATH}" ]; then
  sudo mkdir -p /var/lib/quant-platform/backups
  sudo sqlite3 "\${DB_PATH}" ".backup '\${DB_SNAPSHOT}'"
fi

sudo ln -sfn "/opt/quant-platform/releases/${RELEASE}" /opt/quant-platform/current

# 기동과 준비 확인은 같은 롤백 핸들러 아래에 둔다. restart 자체가 실패하면
# set -e 로 셸이 먼저 죽어버려, 심볼릭 링크와 마이그레이션된 DB 는 새 릴리스에
# 남은 채 롤백이 아예 돌지 않는다 (D-010 이 막으려던 바로 그 상태).
DEPLOY_FAILED=0
sudo systemctl restart quant-platform || DEPLOY_FAILED=1

# 준비될 때까지 재시도한다 — 단발 curl 은 부팅이 조금만 느려도 정상 릴리스를 롤백시키고,
# 롤백은 이제 DB 스냅샷 복원까지 동반하므로 헛된 롤백에 쓰기 유실이 따라온다.
if [ "\${DEPLOY_FAILED}" -eq 0 ]; then
  READY=0
  for _ in \$(seq 1 10); do
    if curl -fsS http://127.0.0.1:3000/api/v1/health/ready; then READY=1; break; fi
    sleep 2
  done
  [ "\${READY}" -eq 1 ] || DEPLOY_FAILED=1
fi

if [ "\${DEPLOY_FAILED}" -ne 0 ]; then
  echo "기동 또는 health check 실패 — 이전 release 로 롤백합니다 (스펙 §30)" >&2
  if [ -n "\${PREVIOUS_RELEASE}" ] && [ -d "\${PREVIOUS_RELEASE}" ]; then
    sudo systemctl stop quant-platform
    if [ -f "\${DB_SNAPSHOT}" ]; then
      sudo cp "\${DB_SNAPSHOT}" "\${DB_PATH}"
      sudo rm -f "\${DB_PATH}-wal" "\${DB_PATH}-shm"
      echo "DB 를 배포 전 스냅샷으로 복원했습니다" >&2
    fi
    sudo ln -sfn "\${PREVIOUS_RELEASE}" /opt/quant-platform/current
    sudo systemctl restart quant-platform
    echo "rolled back to \${PREVIOUS_RELEASE}" >&2
  else
    echo "롤백할 이전 release 가 없습니다 — 서비스 상태를 직접 확인하세요" >&2
  fi
  exit 1
fi
# 성공한 배포의 스냅샷도 즉시 지우지 않는다 (D-010): health check 통과 뒤에 발견된 문제는
# 수동 롤백으로 되돌리는데, 짝이 맞는 스냅샷이 없으면 이전 코드가 새 스키마를 만나 죽는다.
# 최근 KEEP_SNAPSHOTS 개만 남긴다 — backup.sh 의 정리 규칙은 backup-* 디렉터리만 훑는다.
KEEP_SNAPSHOTS=5
sudo sh -c "ls -1t /var/lib/quant-platform/backups/pre-deploy-*.sqlite 2>/dev/null | tail -n +\$((KEEP_SNAPSHOTS + 1)) | xargs -r rm -f" || true

echo "release ${RELEASE} live"
if [ -f "\${DB_SNAPSHOT}" ]; then
  echo "수동 롤백 시 코드와 스키마를 짝으로 되돌린다 (D-010):"
  echo "  sudo systemctl stop quant-platform"
  echo "  sudo ln -sfn <이전 release 경로> /opt/quant-platform/current"
  echo "  sudo cp \${DB_SNAPSHOT} \${DB_PATH} && sudo rm -f \${DB_PATH}-wal \${DB_PATH}-shm"
  echo "  sudo systemctl start quant-platform"
fi
EOF

echo "==> 완료"
