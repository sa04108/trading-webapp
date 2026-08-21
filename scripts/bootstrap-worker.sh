#!/usr/bin/env bash
# 신규 Ubuntu/Debian amd64 PC를 Docker 전용 원격 백테스트 Worker로 준비한다.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=scripts/lib/remote-host.sh
source "${REPO_ROOT}/scripts/lib/remote-host.sh"

TARGET="${QP_WORKER_HOST:-}"
if [ -z "${TARGET}" ]; then read -rp "Worker 주소 [user@]host: " TARGET || true; fi
[ -n "${TARGET}" ] || { echo "QP_WORKER_HOST가 필요합니다" >&2; exit 1; }
ENV_FILE="${QP_WORKER_ENV_FILE:-}"
[ -n "${ENV_FILE}" ] || { echo "QP_WORKER_ENV_FILE이 필요합니다" >&2; exit 1; }
[ -f "${ENV_FILE}" ] || { echo "Worker 환경 파일이 없습니다: ${ENV_FILE}" >&2; exit 1; }

ENV_MODE="$(stat -c '%a' "${ENV_FILE}" 2>/dev/null || true)"
case "${ENV_MODE}" in 600|400) : ;; *) echo "Worker 환경 파일 권한은 600 또는 400이어야 합니다: ${ENV_MODE:-unknown}" >&2; exit 1 ;; esac
grep -q $'\r' "${ENV_FILE}" && { echo "Worker 환경 파일은 LF 줄바꿈이어야 합니다" >&2; exit 1; }
for required in NODE_ENV BACKTEST_SERVER_URL BACKTEST_WORKER_TOKEN BACKTEST_WORKER_ID \
  BACKTEST_WORKER_CONCURRENCY BACKTEST_WORK_ROOT BACKTEST_CLAIM_WAIT_SECONDS \
  BACKTEST_HEARTBEAT_SECONDS LOG_LEVEL; do
  [ "$(grep -c "^${required}=" "${ENV_FILE}" || true)" -eq 1 ] || {
    echo "Worker 환경 파일에 ${required}= 항목이 정확히 하나 필요합니다" >&2
    exit 1
  }
done
token="$(sed -n 's/^BACKTEST_WORKER_TOKEN=//p' "${ENV_FILE}")"
[ "${#token}" -ge 32 ] && [ "${#token}" -le 256 ] || {
  echo "BACKTEST_WORKER_TOKEN은 32~256자여야 합니다" >&2
  exit 1
}
case "${token}" in *[[:space:]]*) echo "BACKTEST_WORKER_TOKEN에는 공백을 넣을 수 없습니다" >&2; exit 1 ;; esac
unset token
grep -qx 'NODE_ENV=production' "${ENV_FILE}" || { echo "Worker는 NODE_ENV=production이어야 합니다" >&2; exit 1; }
grep -qx 'BACKTEST_WORK_ROOT=/var/lib/quant-backtest-worker' "${ENV_FILE}" || {
  echo "컨테이너 Worker의 BACKTEST_WORK_ROOT는 /var/lib/quant-backtest-worker여야 합니다" >&2
  exit 1
}
server_url="$(sed -n 's/^BACKTEST_SERVER_URL=//p' "${ENV_FILE}")"
case "${server_url}" in https://*/*|https://*\?*|https://*\#*|*@*|*[[:space:]]*)
  echo "BACKTEST_SERVER_URL은 path/query/userinfo 없는 HTTPS origin이어야 합니다" >&2
  exit 1
  ;;
  https://?*) : ;;
  *) echo "BACKTEST_SERVER_URL은 HTTPS여야 합니다" >&2; exit 1 ;;
esac
worker_id="$(sed -n 's/^BACKTEST_WORKER_ID=//p' "${ENV_FILE}")"
[[ "${worker_id}" =~ ^[a-zA-Z0-9._-]{1,48}$ ]] || {
  echo "BACKTEST_WORKER_ID 형식이 올바르지 않습니다" >&2
  exit 1
}
concurrency="$(sed -n 's/^BACKTEST_WORKER_CONCURRENCY=//p' "${ENV_FILE}")"
claim_wait="$(sed -n 's/^BACKTEST_CLAIM_WAIT_SECONDS=//p' "${ENV_FILE}")"
heartbeat="$(sed -n 's/^BACKTEST_HEARTBEAT_SECONDS=//p' "${ENV_FILE}")"
[[ "${concurrency}" =~ ^[0-9]+$ ]] && ((concurrency >= 1 && concurrency <= 32)) || {
  echo "BACKTEST_WORKER_CONCURRENCY는 1~32 정수여야 합니다" >&2
  exit 1
}
[[ "${claim_wait}" =~ ^[0-9]+$ ]] && ((claim_wait >= 1 && claim_wait <= 25)) || {
  echo "BACKTEST_CLAIM_WAIT_SECONDS는 1~25 정수여야 합니다" >&2
  exit 1
}
[[ "${heartbeat}" =~ ^[0-9]+$ ]] && ((heartbeat >= 2 && heartbeat <= 20)) || {
  echo "BACKTEST_HEARTBEAT_SECONDS는 2~20 정수여야 합니다" >&2
  exit 1
}
log_level="$(sed -n 's/^LOG_LEVEL=//p' "${ENV_FILE}")"
case "${log_level}" in fatal|error|warn|info|debug|trace) : ;; *) echo "LOG_LEVEL이 올바르지 않습니다" >&2; exit 1 ;; esac

remote_host_configure "${TARGET}"
remote_host_preflight
REMOTE_DIR="$(ssh "${REMOTE_SSH_OPTS[@]}" "${REMOTE_TARGET}" mktemp -d /tmp/quant-worker-bootstrap.XXXXXX)"
[[ "${REMOTE_DIR}" =~ ^/tmp/quant-worker-bootstrap\.[a-zA-Z0-9]+$ ]] || {
  echo "원격 임시 경로가 올바르지 않습니다" >&2
  exit 1
}
cleanup_remote() {
  ssh "${REMOTE_SSH_OPTS[@]}" "${REMOTE_TARGET}" rm -rf -- "${REMOTE_DIR}" >/dev/null 2>&1 || true
}
trap cleanup_remote EXIT

echo "==> Worker provision 파일 업로드"
scp "${REMOTE_SSH_OPTS[@]}" \
  "${REPO_ROOT}/infra/provision-worker.sh" \
  "${REPO_ROOT}/infra/worker-host-manifest.json" \
  "${REPO_ROOT}/infra/docker/compose.worker.yaml" \
  "${REMOTE_TARGET}:${REMOTE_DIR}/"
scp "${REMOTE_SSH_OPTS[@]}" "${ENV_FILE}" "${REMOTE_TARGET}:${REMOTE_DIR}/worker.env.upload"
remote_env="${REMOTE_DIR}/worker.env.upload"
case "${QP_REPLACE_WORKER_ENV:-0}" in 0|1) replace="${QP_REPLACE_WORKER_ENV:-0}" ;; *) echo "QP_REPLACE_WORKER_ENV는 0 또는 1이어야 합니다" >&2; exit 1 ;; esac
ssh "${REMOTE_SSH_OPTS[@]}" "${REMOTE_TARGET}" \
  sudo sh "${REMOTE_DIR}/provision-worker.sh" "${remote_env}" "${replace}"

echo "==> 설치 검증"
ssh "${REMOTE_SSH_OPTS[@]}" "${REMOTE_TARGET}" sh -s <<'EOF'
set -eu
sudo docker version >/dev/null
sudo docker compose version >/dev/null
[ "$(sudo stat -c '%U:%G %a' /etc/quant-platform/worker.env)" = 'root:root 600' ]
[ "$(sudo stat -c '%u:%g %a' /var/lib/quant-backtest-worker)" = '10001:10001 700' ]
[ "$(sudo stat -c '%U:%G %a' /opt/quant-backtest-worker/managed-paths.json)" = 'root:root 644' ]
sudo test -f /opt/quant-backtest-worker/compose.yaml
EOF

cat <<MSG

Docker Worker 부트스트랩 완료: ${REMOTE_TARGET}
Ansible inventory에 worker 접속 정보를 작성한 뒤 프로젝트 루트에서 실행:
  pnpm run deploy --target worker
MSG
