#!/usr/bin/env bash
# deploy.mjs가 app 노드에서 실행하는 release transaction.
#
# 사용법: deploy-app.sh <release-archive> <checksum-file> <release-name>
# SSH·업로드·대상 선택은 deploy.mjs가 담당하고, 이 스크립트는 잠금 이후의 원자적 전환과
# 성공/실패 산출물 정리만 담당한다. source하면 테스트 가능한 함수만 정의한다.
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

validate_release_directory() {
  local release_directory="$1"
  local release_name

  case "${release_directory}" in
    /opt/quant-platform/releases/*) ;;
    *)
      echo "정리할 release 경로가 허용된 위치가 아닙니다: ${release_directory}" >&2
      return 1
      ;;
  esac
  release_name="${release_directory#/opt/quant-platform/releases/}"
  case "${release_name}" in
    ''|.|..|*/*|*[!a-zA-Z0-9._-]*)
      echo "정리할 release 이름이 올바르지 않습니다: ${release_name}" >&2
      return 1
      ;;
  esac
}

resolve_current_release() {
  local current_link="${1:-/opt/quant-platform/current}"
  local current_release=""

  if current_release="$(readlink -e "${current_link}" 2>/dev/null)" &&
    [ -n "${current_release}" ]; then
    validate_release_directory "${current_release}" || return 1
    printf '%s\n' "${current_release}"
    return 0
  fi
  if [ -e "${current_link}" ] || [ -L "${current_link}" ]; then
    echo "current release 경로를 안전하게 해석할 수 없습니다: ${current_link}" >&2
    return 1
  fi
}

is_normal_deploy_artifact() {
  local in_progress_marker="$1"
  local failed_marker="$2"

  # 두 검사가 모두 성공해 마커가 없다고 확인된 경우에만 정상 회전 대상으로 본다.
  # sudo 자체가 실패하면 복구 산출물을 정상으로 오인해 삭제하지 않도록 false가 된다.
  sudo test ! -e "${in_progress_marker}" && sudo test ! -e "${failed_marker}"
}

validate_deploy_snapshot() {
  local snapshot="$1"
  local release_name

  case "${snapshot}" in
    /var/lib/quant-platform/backups/pre-deploy-*.sqlite) ;;
    *)
      echo "정리할 DB snapshot 경로가 허용된 위치가 아닙니다: ${snapshot}" >&2
      return 1
      ;;
  esac
  release_name="${snapshot#/var/lib/quant-platform/backups/pre-deploy-}"
  release_name="${release_name%.sqlite}"
  case "${release_name}" in
    ''|*/*|*[!a-zA-Z0-9._-]*)
      echo "정리할 DB snapshot 이름이 올바르지 않습니다: ${release_name}" >&2
      return 1
      ;;
  esac
}

cleanup_incomplete_snapshot() {
  local snapshot="$1"
  local release_name
  local final_snapshot

  case "${snapshot}" in
    /var/lib/quant-platform/backups/.pre-deploy-*.sqlite.incomplete) ;;
    *)
      echo "정리할 incomplete snapshot 경로가 허용된 위치가 아닙니다: ${snapshot}" >&2
      return 1
      ;;
  esac
  release_name="${snapshot#/var/lib/quant-platform/backups/.pre-deploy-}"
  release_name="${release_name%.sqlite.incomplete}"
  case "${release_name}" in
    ''|*/*|*[!a-zA-Z0-9._-]*)
      echo "정리할 incomplete snapshot 이름이 올바르지 않습니다: ${release_name}" >&2
      return 1
      ;;
  esac
  final_snapshot="/var/lib/quant-platform/backups/pre-deploy-${release_name}.sqlite"
  sudo rm -f -- "${snapshot}" "${snapshot}-journal" "${snapshot}-wal" "${snapshot}-shm" \
    "${final_snapshot}.deploy-in-progress" "${final_snapshot}.deploy-failed"
}

cleanup_failed_deploy_artifacts() {
  local failed_release="$1"
  local db_snapshot="$2"
  local current_release=""

  if [ -n "${failed_release}" ]; then
    validate_release_directory "${failed_release}" || return 1
    current_release="$(resolve_current_release)" || return 1
    if [ "${failed_release}" = "${current_release}" ]; then
      echo "현재 release는 실패 산출물로 삭제하지 않습니다: ${failed_release}" >&2
      return 1
    fi
  fi
  if [ -n "${db_snapshot}" ]; then
    validate_deploy_snapshot "${db_snapshot}" || return 1
  fi

  if [ -n "${db_snapshot}" ]; then
    sudo rm -f -- "${db_snapshot}" "${db_snapshot}-journal" "${db_snapshot}-wal" \
      "${db_snapshot}-shm" "${db_snapshot}.deploy-in-progress" \
      "${db_snapshot}.deploy-failed" "${db_snapshot}.deploy-succeeded" || return 1
  fi
  if [ -n "${failed_release}" ]; then
    sudo rm -rf -- "${failed_release}" || return 1
  fi
}

acquire_deploy_lock() {
  local lock_file="${1:-/run/lock/quant-platform-deploy.lock}"
  local lock_owner

  command -v flock >/dev/null 2>&1 || {
    echo 'flock 명령이 없어 app 배포 잠금을 잡을 수 없습니다' >&2
    return 1
  }
  lock_owner="$(id -u):$(id -g)"
  sudo touch "${lock_file}"
  sudo chown "${lock_owner}" "${lock_file}"
  sudo chmod 0600 "${lock_file}"
  exec {DEPLOY_LOCK_FD}>"${lock_file}"
  if ! flock -n "${DEPLOY_LOCK_FD}"; then
    echo '다른 app 배포가 진행 중입니다 — 완료 후 다시 시도하세요' >&2
    return 75
  fi
}

mark_deploy_succeeded() {
  local release_directory="$1"
  local db_snapshot="$2"

  validate_release_directory "${release_directory}" || return 1
  if [ -n "${db_snapshot}" ]; then
    validate_deploy_snapshot "${db_snapshot}" || return 1
  fi
  if [ -n "${db_snapshot}" ]; then
    sudo rm -f -- "${db_snapshot}.deploy-in-progress" \
      "${db_snapshot}.deploy-failed" || return 1
  fi
  if ! sudo rm -f -- "${release_directory}/.deploy-in-progress" \
    "${release_directory}/.deploy-failed"; then
    if [ -n "${db_snapshot}" ]; then
      sudo touch "${db_snapshot}.deploy-in-progress" || true
    fi
    return 1
  fi
}

mark_deploy_failed() {
  local release_directory="$1"
  local db_snapshot="$2"
  local mark_status=0

  validate_release_directory "${release_directory}" || return 1
  if [ -n "${db_snapshot}" ]; then
    validate_deploy_snapshot "${db_snapshot}" || return 1
  fi
  if sudo touch "${release_directory}/.deploy-failed"; then
    sudo rm -f -- "${release_directory}/.deploy-in-progress" || mark_status=1
  else
    mark_status=1
  fi
  if [ -n "${db_snapshot}" ]; then
    if sudo touch "${db_snapshot}.deploy-failed"; then
      sudo rm -f -- "${db_snapshot}.deploy-in-progress" || mark_status=1
    else
      mark_status=1
    fi
  fi
  return "${mark_status}"
}

cleanup_remote_deploy() {
  local status="$?"
  local failed_release=""
  local failed_snapshot=""

  trap - EXIT
  rm -f -- "${REMOTE_ARCHIVE_PATH:-}" "${REMOTE_CHECKSUM_PATH:-}" || true

  if [ "${RELEASE_STAGING_CREATED:-0}" -eq 1 ]; then
    cleanup_failed_deploy_artifacts "${RELEASE_STAGING:-}" "" || true
  fi
  if [ "${SNAPSHOT_INCOMPLETE_OWNED:-0}" -eq 1 ]; then
    cleanup_incomplete_snapshot "${DB_SNAPSHOT_INCOMPLETE:-}" || true
  fi

  # 서비스 전환 전 실패는 운영 상태를 건드리지 않았으므로 이 시도가 만든 것만 지운다.
  # 전환 이후의 실패는 rollback_release의 readiness까지 성공한 경우에만 정리한다.
  if [ "${status}" -ne 0 ] && [ "${DEPLOY_PHASE:-pre-switch}" = pre-switch ]; then
    if [ "${RELEASE_PUBLISHED:-0}" -eq 1 ]; then
      failed_release="${RELEASE_DIR:-}"
    fi
    if [ "${SNAPSHOT_CREATED:-0}" -eq 1 ]; then
      failed_snapshot="${DB_SNAPSHOT:-}"
    fi
    if [ -n "${failed_release}" ] || [ -n "${failed_snapshot}" ]; then
      cleanup_failed_deploy_artifacts "${failed_release}" "${failed_snapshot}" || true
    fi
  fi

  exit "${status}"
}

rollback_release() {
  local previous_release="$1"
  local db_snapshot="$2"
  local db_path="$3"
  local rollback_ok=1
  local rollback_started_at

  sudo systemctl stop quant-platform || rollback_ok=0
  if [ "${rollback_ok}" -eq 1 ] && [ -n "${db_snapshot}" ]; then
    if sudo test -f "${db_snapshot}"; then
      if sudo cp "${db_snapshot}" "${db_path}" &&
        sudo rm -f "${db_path}-journal" "${db_path}-wal" "${db_path}-shm"; then
        echo 'DB를 배포 전 스냅샷으로 복원했습니다' >&2
      else
        rollback_ok=0
      fi
    else
      echo "롤백에 필요한 DB snapshot이 없습니다: ${db_snapshot}" >&2
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
  local failed_release="$3"
  local db_snapshot="$4"
  local db_path="$5"

  echo '기동 또는 readiness 실패 — 새 릴리스 진단을 수집한 뒤 롤백합니다' >&2
  print_service_diagnostics 'new release failed' "${deploy_started_at}"
  if [ -n "${previous_release}" ] && [ -d "${previous_release}" ]; then
    if rollback_release "${previous_release}" "${db_snapshot}" "${db_path}"; then
      if cleanup_failed_deploy_artifacts "${failed_release}" "${db_snapshot}"; then
        echo '자동 롤백 검증 후 실패한 release와 DB snapshot을 정리했습니다' >&2
      else
        echo '자동 롤백은 성공했지만 실패 산출물 정리는 완료하지 못했습니다' >&2
      fi
    else
      mark_deploy_failed "${failed_release}" "${db_snapshot}" || \
        echo '실패 산출물의 상태 마커를 갱신하지 못했습니다' >&2
      echo '자동 롤백 검증에 실패해 release와 DB snapshot을 보존합니다' >&2
    fi
  else
    mark_deploy_failed "${failed_release}" "${db_snapshot}" || \
      echo '실패 산출물의 상태 마커를 갱신하지 못했습니다' >&2
    echo '롤백할 이전 release가 없습니다 — 서비스 상태를 직접 확인하세요' >&2
  fi
  return 1
}

if [[ "${BASH_SOURCE[0]}" != "$0" ]]; then
  return 0
fi

if [ "$#" -ne 3 ]; then
  echo '사용법: deploy-app.sh <release-archive> <checksum-file> <release-name>' >&2
  exit 64
fi

REMOTE_ARCHIVE_PATH="$1"
REMOTE_CHECKSUM_PATH="$2"
RELEASE="$3"

case "${RELEASE}" in
  ''|.|..|*/*|*[!a-zA-Z0-9._-]*)
    echo "release 이름이 올바르지 않습니다: ${RELEASE}" >&2
    exit 64
    ;;
esac
case "${REMOTE_ARCHIVE_PATH}" in
  /tmp/quant-app-deploy.*/*) ;;
  *) echo "release archive 경로가 허용된 위치가 아닙니다: ${REMOTE_ARCHIVE_PATH}" >&2; exit 64 ;;
esac
case "${REMOTE_CHECKSUM_PATH}" in
  /tmp/quant-app-deploy.*/*) ;;
  *) echo "checksum 경로가 허용된 위치가 아닙니다: ${REMOTE_CHECKSUM_PATH}" >&2; exit 64 ;;
esac
[ "$(basename "${REMOTE_ARCHIVE_PATH}")" = "quant-platform-${RELEASE}.tar.gz" ] || {
  echo "release archive 이름이 release와 일치하지 않습니다: ${REMOTE_ARCHIVE_PATH}" >&2
  exit 64
}
[ "$(basename "${REMOTE_CHECKSUM_PATH}")" = "quant-platform-${RELEASE}.tar.gz.sha256" ] || {
  echo "checksum 이름이 release와 일치하지 않습니다: ${REMOTE_CHECKSUM_PATH}" >&2
  exit 64
}
[ -f "${REMOTE_ARCHIVE_PATH}" ] && [ -f "${REMOTE_CHECKSUM_PATH}" ] || {
  echo 'release archive 또는 checksum 파일이 없습니다' >&2
  exit 66
}

for required_command in flock sha256sum tar corepack sqlite3 systemctl systemd-run curl; do
  command -v "${required_command}" >/dev/null 2>&1 || {
    echo "필수 명령이 없습니다: ${required_command}" >&2
    exit 69
  }
done
sudo -n true >/dev/null 2>&1 || { echo '비대화형 sudo 권한이 필요합니다' >&2; exit 77; }

RELEASE_DIR="/opt/quant-platform/releases/${RELEASE}"
RELEASE_STAGING="/opt/quant-platform/releases/.incomplete-${RELEASE}"
DB_PATH="/var/lib/quant-platform/app.sqlite"
DB_SNAPSHOT="/var/lib/quant-platform/backups/pre-deploy-${RELEASE}.sqlite"
DB_SNAPSHOT_INCOMPLETE="/var/lib/quant-platform/backups/.pre-deploy-${RELEASE}.sqlite.incomplete"
KEEP_SUCCESSFUL_DEPLOYS=0
DEPLOY_DB_SNAPSHOT=""
DEPLOY_PHASE=pre-switch
RELEASE_STAGING_CREATED=0
RELEASE_PUBLISHED=0
SNAPSHOT_INCOMPLETE_OWNED=0
SNAPSHOT_CREATED=0

trap cleanup_remote_deploy EXIT
acquire_deploy_lock

EXPECTED_SHA="$(awk 'NR == 1 { print $1 }' "${REMOTE_CHECKSUM_PATH}")"
case "${EXPECTED_SHA}" in ''|*[!a-f0-9]*) echo 'release checksum 형식 오류' >&2; exit 1 ;; esac
[ "${#EXPECTED_SHA}" -eq 64 ] || { echo 'release checksum 길이 오류' >&2; exit 1; }
ACTUAL_SHA="$(sha256sum "${REMOTE_ARCHIVE_PATH}" | awk '{ print $1 }')"
[ "${ACTUAL_SHA}" = "${EXPECTED_SHA}" ] || { echo 'release archive checksum 불일치' >&2; exit 1; }

sudo mkdir -p /opt/quant-platform/releases /var/lib/quant-platform/backups
if sudo test -e "${RELEASE_DIR}" || sudo test -e "${RELEASE_STAGING}"; then
  echo "release 또는 staging 경로가 이미 존재합니다: ${RELEASE_DIR}" >&2
  exit 1
fi
sudo mkdir "${RELEASE_STAGING}"
RELEASE_STAGING_CREATED=1
sudo touch "${RELEASE_STAGING}/.deploy-in-progress"
sudo tar -xzf "${REMOTE_ARCHIVE_PATH}" -C "${RELEASE_STAGING}"
rm -f -- "${REMOTE_ARCHIVE_PATH}" "${REMOTE_CHECKSUM_PATH}"
cd "${RELEASE_STAGING}"
sudo corepack pnpm install --prod --frozen-lockfile

PREVIOUS_RELEASE="$(resolve_current_release)"

if sudo test -f "${DB_PATH}"; then
  if sudo test -e "${DB_SNAPSHOT}" || sudo test -e "${DB_SNAPSHOT_INCOMPLETE}"; then
    echo "DB snapshot 경로가 이미 존재합니다: ${DB_SNAPSHOT}" >&2
    exit 1
  fi
  sudo touch "${DB_SNAPSHOT}.deploy-in-progress"
  SNAPSHOT_CREATED=1
  SNAPSHOT_INCOMPLETE_OWNED=1
  sudo sqlite3 "${DB_PATH}" ".backup '${DB_SNAPSHOT_INCOMPLETE}'"
  sudo mv "${DB_SNAPSHOT_INCOMPLETE}" "${DB_SNAPSHOT}"
  SNAPSHOT_INCOMPLETE_OWNED=0
  DEPLOY_DB_SNAPSHOT="${DB_SNAPSHOT}"
fi

RELEASE_PUBLISHED=1
sudo mv "${RELEASE_STAGING}" "${RELEASE_DIR}"
RELEASE_STAGING_CREATED=0
cd "${RELEASE_DIR}"
if sudo ln -sfn "${RELEASE_DIR}" /opt/quant-platform/current && \
  SWITCHED_RELEASE="$(resolve_current_release)" && \
  [ "${SWITCHED_RELEASE}" = "${RELEASE_DIR}" ]; then
  DEPLOY_PHASE=switched
else
  echo "current release 전환을 검증하지 못했습니다: ${RELEASE_DIR}" >&2
  exit 1
fi

DEPLOY_FAILED=0
DEPLOY_ATTEMPT_STARTED_AT="$(date --iso-8601=seconds)"
sudo systemctl stop quant-platform || DEPLOY_FAILED=1

if [ "${DEPLOY_FAILED}" -eq 0 ]; then
  sudo systemd-run --quiet --pipe --wait --collect \
    --unit=quant-platform-db-prepare \
    --property=User=quant \
    --property=Group=quant \
    --property=EnvironmentFile=/etc/quant-platform/app.env \
    --property=WorkingDirectory=/opt/quant-platform/current \
    /usr/local/bin/node /opt/quant-platform/current/dist/server/cli.js db:prepare \
    || DEPLOY_FAILED=1
fi
if [ "${DEPLOY_FAILED}" -eq 0 ]; then
  sudo systemctl start quant-platform || DEPLOY_FAILED=1
fi
if [ "${DEPLOY_FAILED}" -eq 0 ]; then
  wait_for_ready || DEPLOY_FAILED=1
fi
if [ "${DEPLOY_FAILED}" -eq 0 ]; then
  mark_deploy_succeeded "${RELEASE_DIR}" "${DEPLOY_DB_SNAPSHOT}" || DEPLOY_FAILED=1
fi
if [ "${DEPLOY_FAILED}" -ne 0 ]; then
  handle_deploy_failure \
    "${DEPLOY_ATTEMPT_STARTED_AT}" \
    "${PREVIOUS_RELEASE}" \
    "${RELEASE_DIR}" \
    "${DEPLOY_DB_SNAPSHOT}" \
    "${DB_PATH}" || exit 1
fi
DEPLOY_PHASE=success

CURRENT_TARGET=""
if CURRENT_TARGET="$(resolve_current_release)" && [ "${CURRENT_TARGET}" = "${RELEASE_DIR}" ]; then
  SNAPSHOT_CLEANUP_OK=1
  if ! sudo find /var/lib/quant-platform/backups -mindepth 1 -maxdepth 1 -type f \
    -name 'pre-deploy-*.sqlite' -printf '%T@ %p\n' 2>/dev/null \
    | sort -nr \
    | while read -r _ snapshot; do
        if validate_deploy_snapshot "${snapshot}" && \
          is_normal_deploy_artifact \
            "${snapshot}.deploy-in-progress" "${snapshot}.deploy-failed"; then
          printf '%s\n' "${snapshot}"
        fi
      done \
    | awk -v keep="${KEEP_SUCCESSFUL_DEPLOYS}" 'NR > keep' \
    | while IFS= read -r snapshot; do
        if validate_deploy_snapshot "${snapshot}"; then
          sudo rm -f -- "${snapshot}" "${snapshot}-journal" "${snapshot}-wal" \
            "${snapshot}-shm" "${snapshot}.deploy-succeeded" || exit 1
        fi
      done; then
    SNAPSHOT_CLEANUP_OK=0
    echo '경고: 정상 DB snapshot 정리를 완료하지 못했습니다' >&2
  fi

  if [ "${SNAPSHOT_CLEANUP_OK}" -eq 1 ]; then
    if ! sudo find /opt/quant-platform/releases -mindepth 1 -maxdepth 1 -type d \
      ! -name '.incomplete-*' -printf '%T@ %p\n' 2>/dev/null \
      | sort -nr \
      | while read -r _ release_dir; do
          if [ "${release_dir}" != "${CURRENT_TARGET}" ] && \
            validate_release_directory "${release_dir}" && \
            is_normal_deploy_artifact \
              "${release_dir}/.deploy-in-progress" "${release_dir}/.deploy-failed"; then
            printf '%s\n' "${release_dir}"
          fi
        done \
      | awk -v keep="${KEEP_SUCCESSFUL_DEPLOYS}" 'NR > keep' \
      | while IFS= read -r release_dir; do
          if [ "${release_dir}" != "${CURRENT_TARGET}" ] && \
            validate_release_directory "${release_dir}"; then
            sudo rm -rf -- "${release_dir}" || exit 1
          fi
        done; then
      echo '경고: 과거 정상 release 정리를 완료하지 못했습니다' >&2
    fi
  else
    echo '경고: DB snapshot 정리 실패로 과거 release 정리도 건너뜁니다' >&2
  fi
else
  echo '경고: current release를 검증하지 못해 정상 snapshot/release 정리를 건너뜁니다' >&2
fi

echo "app release ${RELEASE} live"
