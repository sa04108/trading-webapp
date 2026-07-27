#!/usr/bin/env bash
# 스펙 §30 — 릴리스 배포. 개발 PC 에서 빌드·검증 후 서버로 배포한다.
#
# 사용법: ./scripts/deploy.sh
#         실행 후 서버 주소를 물어본다. 비대화형으로 돌리려면 환경변수를 미리 설정한다.
#
#   QP_HOST  서버 주소, `[user@]host` 형식. 미설정이면 첫 단계에서 물어본다.
#            (bootstrap.sh 와 같은 변수·같은 형식이다)
#   SSH_KEY  개인키 경로 (선택). 지정하면 -i 로 넘긴다. 없으면 ~/.ssh/config 나
#            기본 이름 키(id_ed25519 등)에 의존한다 — bootstrap.sh 와 같은 규칙이다.
#
# 로그인 사용자명을 가정하지 않는다 — 클라우드 이미지마다 다르고(ubuntu / admin /
# ec2-user) 자체 설치 호스트는 임의다 (스펙 §2.1).
# 비밀값을 command line argument 로 넘기지 않는다.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# 주소를 먼저 받는다 — 아래 검증 게이트가 몇 분 걸리므로 그 뒤에 묻지 않는다.
# 아래 로그 리다이렉트보다 앞에 두는 이유는 bootstrap.sh 와 같다: tee 를 거치면
# 프롬프트가 버퍼링에 걸려 화면에 안 나타날 수 있다.
# read 뒤의 `|| true`: 비대화형 실행에서 read 는 EOF 로 비영점 종료하고, set -e 가
# 바로 아래 안내에 도달하기 전에 스크립트를 죽인다. 판단은 다음 줄에 맡긴다.
TARGET="${QP_HOST:-}"
if [ -z "${TARGET}" ]; then
  read -rp "서버 주소 [user@]host: " TARGET || true
fi
[ -n "${TARGET}" ] || {
  echo "서버 주소가 필요합니다 — 비대화형이면 QP_HOST 로 지정하세요" >&2
  exit 1
}

# ── 여기서부터 모든 출력을 로그 파일에도 남긴다 ───────────────────────────────
# 배포는 검증 게이트(lint·typecheck·test·build)에서 출력이 많다. 화면에 의존하지 않는
# 것이 요점이다 — 터미널 종류·스크롤백 한도와 무관하게 실행 기록이 남아야 한다.
# 파일명은 *.log 로 .gitignore 에 이미 걸려 있다. QP_LOG 로 경로를 바꿀 수 있다.
LOG="${QP_LOG:-${REPO_ROOT}/.logs/deploy-$(date -u +%Y%m%d-%H%M%S).log}"
mkdir -p "$(dirname "${LOG}")"
exec > >(tee "${LOG}") 2>&1
TEE_PID=$!

# 아카이브 정리와 로그 안내를 EXIT trap 하나로 묶는다 — 검증 게이트·업로드·health
# check 어디서 죽어도 걸린다.
on_exit() {
  status=$?
  if [ -n "${ARCHIVE:-}" ]; then rm -f "${ARCHIVE}"; fi
  if [ "${status}" -ne 0 ]; then
    echo
    echo "실패 (exit ${status}). 로그: ${LOG}"
  fi
  # tee 가 마지막 줄까지 쓰도록 fd 를 닫고 기다린다 — 안 하면 끝이 잘릴 수 있다
  exec 1>&- 2>&-
  wait "${TEE_PID}" 2>/dev/null || true
  exit "${status}"
}
trap on_exit EXIT

echo "로그: ${LOG}"

# IdentitiesOnly 를 함께 켜는 이유: 하드닝이 MaxAuthTries 3 을 걸기 때문에 agent 의
# 다른 키들이 먼저 제시되면 맞는 키가 4번째가 되어 서버가 먼저 연결을 끊을 수 있다.
SSH_OPTS=()
if [ -n "${SSH_KEY:-}" ]; then
  [ -f "${SSH_KEY}" ] || { echo "SSH_KEY 파일이 없습니다: ${SSH_KEY}" >&2; exit 1; }
  SSH_OPTS=(-i "${SSH_KEY}" -o IdentitiesOnly=yes)
fi

# 업로드 전에 접속을 확인한다 — 검증 게이트(수 분)를 다 돌린 뒤 SSH 로 실패하면
# 그 시간이 통째로 버려진다. bootstrap.sh 와 같은 이유의 preflight 다.
echo "==> SSH 접속 확인: ${TARGET}"
ssh "${SSH_OPTS[@]}" -o ConnectTimeout=15 -o BatchMode=yes "${TARGET}" true 2>/dev/null || {
  {
    echo "SSH 접속 실패: ${TARGET}"
    echo "  키를 지정하려면: SSH_KEY=~/.ssh/<your-key> ./scripts/deploy.sh"
    echo "  원인 가르기:     ssh -v ${SSH_KEY:+-i ${SSH_KEY} }${TARGET} true"
  } >&2
  exit 1
}

RELEASE="$(date -u +%Y%m%d-%H%M%S)-$(git rev-parse --short HEAD)"
GIT_SHA="$(git rev-parse HEAD)"
# 배포가 어디서 실패하든 (검증 게이트, 업로드, health check 롤백) 아카이브는 남기지 않는다.
# 정리는 맨 위의 on_exit 가 맡는다 — 여기서 trap 을 다시 걸면 on_exit 를 덮어써
# 실패 시 멈춤이 사라진다.
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
scp "${SSH_OPTS[@]}" "${ARCHIVE}" "${TARGET}:/tmp/"
ssh "${SSH_OPTS[@]}" "${TARGET}" bash -s <<EOF
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
