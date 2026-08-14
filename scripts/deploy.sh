#!/usr/bin/env bash
# 스펙 §30 — 릴리스 배포. 개발 PC 에서 빌드·검증 후 서버로 배포한다.
#
# 사용법: ./scripts/deploy.sh
#         실행 후 서버 주소를 물어본다. 비대화형으로 돌리려면 환경변수를 미리 설정한다 —
#         ssh config 는 필요하지 않다:
#
#         SSH_KEY=~/.ssh/your-key QP_SSH_USER=ubuntu QP_HOST=203.0.113.10 \
#           ./scripts/deploy.sh
#
#   QP_HOST          서버 주소, `[user@]host` 형식. 미설정이면 첫 단계에서 물어본다
#   QP_SSH_USER      로그인 사용자명. QP_HOST 에 `user@` 가 없을 때만 쓴다
#   QP_SSH_PORT      SSH 포트 (미지정이면 22)
#   SSH_KEY          개인키 경로. `~/` 로 시작하면 아래에서 $HOME 으로 펼친다
#   QP_SSH_JUMP      점프 호스트, `[user@]host[:port]` (ssh 의 ProxyJump)
#   QP_SSH_HOST_KEY  호스트키 확인: accept-new(기본) | yes | no
#   QP_SSH_OPTS      그 밖의 ssh 옵션을 그대로 (예: "-o ServerAliveInterval=30")
#
# 접속 파라미터의 이름과 의미는 bootstrap.sh 와 같다 — 부트스트랩이 성공한 조합을
# 그대로 배포에 쓸 수 있어야 한다 (부트스트랩 마지막 출력이 그 명령을 찍어 준다).
#
# 로그인 사용자명을 가정하지 않는다 — 클라우드 이미지마다 다르고(ubuntu / admin /
# ec2-user) 자체 설치 호스트는 임의다 (스펙 §2.1).
# 비밀값을 command line argument 로 넘기지 않는다.
set -euo pipefail

# 기본 창은 60회 × 2초 = 2분이다. 옛 값(10회 = 18초)은 부팅이 마이그레이션까지
# 떠안던 시절에도 빠듯했고, 2026-08-09 배포가 그 창을 2초 차이로 넘겨 롤백됐다.
# 지금은 마이그레이션이 기동 전으로 빠져 부팅이 다시 짧지만, 창을 넓게 두는 값은
# 여전히 필요하다 — EC2 t계열은 CPU 크레딧 상태에 따라 기동 시간이 흔들린다.
# 넓혀도 정상 배포는 첫 시도에 통과하므로 배포 시간이 늘지 않는다.
wait_for_ready() {
  local max_attempts="${1:-60}"
  local delay_seconds="${2:-2}"
  local attempt
  for ((attempt = 1; attempt <= max_attempts; attempt += 1)); do
    if curl -fsS http://127.0.0.1:3000/api/v1/health/ready >/dev/null 2>&1; then
      return 0
    fi
    if ((attempt < max_attempts)); then sleep "${delay_seconds}"; fi
  done
  return 1
}

print_service_diagnostics() {
  local phase="$1"
  local since="$2"
  echo "==> service diagnostics: ${phase} (since ${since})" >&2
  echo '-- current release --' >&2
  readlink -f /opt/quant-platform/current >&2 || true
  if [ -f /opt/quant-platform/current/dist/build-info.json ]; then
    sudo cat /opt/quant-platform/current/dist/build-info.json >&2 || true
  fi
  echo '-- systemd properties --' >&2
  sudo systemctl show quant-platform --no-pager \
    --property=ActiveState,SubState,Result,ExecMainCode,ExecMainStatus,NRestarts >&2 || true
  echo '-- systemd status --' >&2
  sudo systemctl status quant-platform --no-pager -l >&2 || true
  echo '-- service journal --' >&2
  sudo journalctl -u quant-platform --since "${since}" --no-pager -o short-iso >&2 || true
}

rollback_release() {
  local previous_release="$1"
  local db_snapshot="$2"
  local db_path="$3"
  local rollback_ok=1
  local rollback_started_at

  sudo systemctl stop quant-platform || rollback_ok=0
  if [ "${rollback_ok}" -eq 1 ] && sudo test -f "${db_snapshot}"; then
    if sudo cp "${db_snapshot}" "${db_path}" &&
      sudo rm -f "${db_path}-wal" "${db_path}-shm"; then
      echo 'DB를 배포 전 스냅샷으로 복원했습니다' >&2
    else
      rollback_ok=0
    fi
  fi
  if [ "${rollback_ok}" -eq 1 ]; then
    sudo ln -sfn "${previous_release}" /opt/quant-platform/current || rollback_ok=0
  fi

  rollback_started_at="$(date --iso-8601=seconds)"
  if [ "${rollback_ok}" -eq 1 ] &&
    sudo systemctl restart quant-platform &&
    wait_for_ready; then
    echo "rolled back to ${previous_release}" >&2
    return 0
  fi

  echo "rollback failed for ${previous_release}" >&2
  print_service_diagnostics 'rollback failed' "${rollback_started_at}"
  return 1
}

handle_deploy_failure() {
  local deploy_started_at="$1"
  local previous_release="$2"
  local db_snapshot="$3"
  local db_path="$4"

  echo '기동 또는 readiness 실패 — 새 릴리스 진단을 수집한 뒤 롤백합니다' >&2
  print_service_diagnostics 'new release failed' "${deploy_started_at}"
  if [ -n "${previous_release}" ] && [ -d "${previous_release}" ]; then
    rollback_release "${previous_release}" "${db_snapshot}" "${db_path}" || true
  else
    echo '롤백할 이전 release가 없습니다 — 서비스 상태를 직접 확인하세요' >&2
  fi
  return 1
}

if [[ "${BASH_SOURCE[0]}" != "$0" ]]; then
  return 0
fi

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
# 사용자명은 주소에 붙여도 되고 QP_SSH_USER 로 따로 줘도 된다 (bootstrap.sh 와 같은 규칙).
if [ -n "${QP_SSH_USER:-}" ]; then
  case "${TARGET}" in
    *@*) echo "QP_SSH_USER 는 무시합니다 — 주소에 이미 사용자명이 있습니다: ${TARGET}" >&2 ;;
    *) TARGET="${QP_SSH_USER}@${TARGET}" ;;
  esac
fi
case "${TARGET}" in
  -* | *[[:space:]]*)
    echo "서버 주소 형식이 올바르지 않습니다: ${TARGET}" >&2
    exit 1
    ;;
esac

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

# ── 접속 옵션을 환경변수에서 만든다 (bootstrap.sh 와 같은 규칙) ───────────────
# 포트와 점프 호스트를 -p / -J 가 아니라 -o 로 넘기는 이유: 같은 배열을 ssh 와 scp 에
# 함께 쓰기 때문이다 — scp 의 포트 플래그는 -P 라서 -p 를 받지 못한다.
SSH_OPTS=()
SSH_FLAGS=""  # 실패 안내에서 손으로 재현할 때 쓰는 ssh 플래그

# QP_SSH_OPTS 를 맨 앞에 둔다 — ssh 는 같은 옵션이 여러 번 오면 "먼저 나온 값"을 쓰므로,
# 앞에 둬야 사용자가 아래 기본값을 덮을 수 있다.
if [ -n "${QP_SSH_OPTS:-}" ]; then
  read -ra SSH_OPTS <<< "${QP_SSH_OPTS}"
fi

if [ -n "${SSH_KEY:-}" ]; then
  # 따옴표 안의 `~` 는 셸이 펼치지 않는다
  case "${SSH_KEY}" in
    '~/'*) SSH_KEY="${HOME}/${SSH_KEY#'~/'}" ;;
  esac
  [ -f "${SSH_KEY}" ] || { echo "SSH_KEY 파일이 없습니다: ${SSH_KEY}" >&2; exit 1; }
  # IdentitiesOnly 를 함께 켜는 이유: 하드닝이 MaxAuthTries 3 을 걸기 때문에 agent 의
  # 다른 키들이 먼저 제시되면 맞는 키가 4번째가 되어 서버가 먼저 연결을 끊을 수 있다.
  SSH_OPTS+=(-i "${SSH_KEY}" -o IdentitiesOnly=yes)
  SSH_FLAGS="${SSH_FLAGS}-i ${SSH_KEY} "
fi

if [ -n "${QP_SSH_PORT:-}" ]; then
  case "${QP_SSH_PORT}" in
    '' | *[!0-9]*) echo "QP_SSH_PORT 는 숫자여야 합니다: ${QP_SSH_PORT}" >&2; exit 1 ;;
  esac
  SSH_OPTS+=(-o "Port=${QP_SSH_PORT}")
  SSH_FLAGS="${SSH_FLAGS}-p ${QP_SSH_PORT} "
fi

if [ -n "${QP_SSH_JUMP:-}" ]; then
  SSH_OPTS+=(-o "ProxyJump=${QP_SSH_JUMP}")
  SSH_FLAGS="${SSH_FLAGS}-J ${QP_SSH_JUMP} "
fi

# accept-new 기본값의 이유는 bootstrap.sh 에 적어 뒀다 — 접속 확인이 BatchMode 라
# ssh 기본값(ask)은 처음 보는 호스트에서 물어볼 TTY 가 없어 그냥 실패한다.
case "${QP_SSH_HOST_KEY:=accept-new}" in
  accept-new | yes | no) SSH_OPTS+=(-o "StrictHostKeyChecking=${QP_SSH_HOST_KEY}") ;;
  *) echo "QP_SSH_HOST_KEY 는 accept-new | yes | no 중 하나입니다: ${QP_SSH_HOST_KEY}" >&2; exit 1 ;;
esac

# 업로드 전에 접속을 확인한다 — 검증 게이트(수 분)를 다 돌린 뒤 SSH 로 실패하면
# 그 시간이 통째로 버려진다. bootstrap.sh 와 같은 이유의 preflight 다.
echo "==> SSH 접속 확인: ${TARGET}"
# stderr 를 버리지 않는다 — 원인별 처방이 전혀 다르므로 ssh 가 한 말을 그대로 보여준다.
if ! SSH_ERR="$(ssh "${SSH_OPTS[@]}" -o ConnectTimeout=15 -o BatchMode=yes "${TARGET}" true 2>&1)"; then
  {
    echo "SSH 접속 실패: ${TARGET}"
    echo
    printf '%s\n' "${SSH_ERR}" | sed 's/^/  /'
    echo
    echo "ssh config 없이 환경변수로 지정할 수 있는 것들:"
    echo "  QP_SSH_USER=ubuntu  QP_SSH_PORT=2222  SSH_KEY=~/.ssh/your-key"
    echo "  QP_SSH_JUMP=user@bastion  QP_SSH_HOST_KEY=yes  QP_SSH_OPTS='-o ...'"
    echo "원인 가르기: ssh -v ${SSH_FLAGS}${TARGET} true"
  } >&2
  exit 1
fi

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
tar -czf "${ARCHIVE}" dist migrations package.json pnpm-lock.yaml pnpm-workspace.yaml

echo "==> 업로드 및 릴리스 전환"
scp "${SSH_OPTS[@]}" "${ARCHIVE}" "${TARGET}:/tmp/"
REMOTE_SERVICE_HELPERS="$(
  declare -f wait_for_ready
  declare -f print_service_diagnostics
  declare -f rollback_release
  declare -f handle_deploy_failure
)"
ssh "${SSH_OPTS[@]}" "${TARGET}" bash -s <<EOF
set -euo pipefail
${REMOTE_SERVICE_HELPERS}
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
if sudo test -f "\${DB_PATH}"; then
  sudo mkdir -p /var/lib/quant-platform/backups
  sudo sqlite3 "\${DB_PATH}" ".backup '\${DB_SNAPSHOT}'"
fi

sudo ln -sfn "/opt/quant-platform/releases/${RELEASE}" /opt/quant-platform/current

# 기동과 준비 확인은 같은 롤백 핸들러 아래에 둔다. restart 자체가 실패하면
# set -e 로 셸이 먼저 죽어버려, 심볼릭 링크와 마이그레이션된 DB 는 새 릴리스에
# 남은 채 롤백이 아예 돌지 않는다 (D-010 이 막으려던 바로 그 상태).
DEPLOY_FAILED=0
DEPLOY_ATTEMPT_STARTED_AT="\$(date --iso-8601=seconds)"

# restart 를 stop → 마이그레이션 → start 로 나눈다.
#
# 마이그레이션을 부팅 안에서 돌리면 그동안 포트가 열리지 않아 readiness 확인이
# 타임아웃한다 (2026-08-09 장애: SCD 이행 16초 vs readiness 창 18초). 게다가
# 롤백이 DB 스냅샷을 되돌리므로 재시도해도 진행이 쌓이지 않아 같은 자리를 맴돈다.
#
# 서비스를 먼저 멈추는 이유는 DB 를 잡은 프로세스가 없는 창에서 스키마를 바꾸기
# 위해서다. 옛 코드가 새 스키마를 만나는 구간을 만들지 않는다 (D-010).
sudo systemctl stop quant-platform || DEPLOY_FAILED=1

# 서비스와 같은 User·EnvironmentFile 로 돌린다 — DB 파일 소유자가 어긋나지 않고
# 비밀값이 command line argument 로 새지 않는다. --wait 로 종료 코드를 그대로 받는다.
if [ "\${DEPLOY_FAILED}" -eq 0 ]; then
  sudo systemd-run --quiet --pipe --wait --collect \
    --unit=quant-platform-db-prepare \
    --property=User=quant \
    --property=Group=quant \
    --property=EnvironmentFile=/etc/quant-platform/app.env \
    --property=WorkingDirectory=/opt/quant-platform/current \
    /usr/local/bin/node /opt/quant-platform/current/dist/server/cli.js db:prepare \
    || DEPLOY_FAILED=1
fi

if [ "\${DEPLOY_FAILED}" -eq 0 ]; then
  sudo systemctl start quant-platform || DEPLOY_FAILED=1
fi

if [ "\${DEPLOY_FAILED}" -eq 0 ]; then
  wait_for_ready || DEPLOY_FAILED=1
fi

if [ "\${DEPLOY_FAILED}" -ne 0 ]; then
  handle_deploy_failure \
    "\${DEPLOY_ATTEMPT_STARTED_AT}" \
    "\${PREVIOUS_RELEASE}" \
    "\${DB_SNAPSHOT}" \
    "\${DB_PATH}" || exit 1
fi
# 성공한 배포의 스냅샷도 즉시 지우지 않는다 (D-010): health check 통과 뒤에 발견된 문제는
# 수동 롤백으로 되돌리는데, 짝이 맞는 스냅샷이 없으면 이전 코드가 새 스키마를 만나 죽는다.
# 최근 KEEP_SNAPSHOTS 개만 남긴다 — backup.sh 의 정리 규칙은 backup-* 디렉터리만 훑는다.
KEEP_SNAPSHOTS=5
sudo sh -c "ls -1t /var/lib/quant-platform/backups/pre-deploy-*.sqlite 2>/dev/null | tail -n +\$((KEEP_SNAPSHOTS + 1)) | xargs -r rm -f" || true

# 릴리스 디렉터리도 같이 회전시킨다. 각 릴리스는 서버에서 설치한 node_modules 를 통째로
# 들고 있어(better-sqlite3·argon2 네이티브 바이너리 포함) 수백 MB 이고, 여기를
# 정리하지 않으면 40GB 디스크가 배포 횟수에 비례해 줄어든다 — 시장 데이터보다 이쪽이
# 먼저 디스크를 먹는다.
#
# 개수는 스냅샷과 같아야 한다. 릴리스를 더 적게 남기면 짝이 맞는 코드가 없는 스냅샷이
# 생겨 위 D-010 의 "코드와 스키마를 짝으로 되돌린다" 가 성립하지 않는다.
KEEP_RELEASES=\${KEEP_SNAPSHOTS}
CURRENT_TARGET="\$(readlink -f /opt/quant-platform/current || true)"
# 이름이 <UTC타임스탬프>-<sha> 라 사전순 = 시간순 (backup.sh 의 backup-* 와 같은 규약).
# 지금 막 전환한 current 는 최신이라 어차피 남지만, 안전을 위해 명시적으로 건너뛴다.
sudo ls -1 /opt/quant-platform/releases 2>/dev/null | sort -r | tail -n +\$((KEEP_RELEASES + 1)) \
  | while IFS= read -r old; do
      dir="/opt/quant-platform/releases/\${old}"
      if [ -n "\${old}" ] && [ "\${dir}" != "\${CURRENT_TARGET}" ]; then
        sudo rm -rf "\${dir}"
      fi
    done || true

echo "release ${RELEASE} live"
if sudo test -f "\${DB_SNAPSHOT}"; then
  echo "수동 롤백 시 코드와 스키마를 짝으로 되돌린다 (D-010):"
  echo "  sudo systemctl stop quant-platform"
  echo "  sudo ln -sfn <이전 release 경로> /opt/quant-platform/current"
  echo "  sudo cp \${DB_SNAPSHOT} \${DB_PATH} && sudo rm -f \${DB_PATH}-wal \${DB_PATH}-shm"
  echo "  sudo systemctl start quant-platform"
fi
EOF

echo "==> 완료"
