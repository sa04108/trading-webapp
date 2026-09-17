#!/usr/bin/env bash
# 단일 배포 진입점: 로컬 검증·전송과 원격 release transaction을 같은 파일에서 실행한다.
# 인자 없는 실행은 로컬 배포이며 --remote는 SSH로 호출하는 내부 단계다.
# 이 스크립트는 잠금, 서버·DB 전환, readiness, rollback과 산출물 정리를 담당한다.
# source하면 테스트 가능한 함수만 정의한다.
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
  sudo rm -f -- "${snapshot}" "${snapshot}-journal" "${snapshot}-wal" "${snapshot}-shm" "${snapshot}.data" "${snapshot}.json" \
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
      "${db_snapshot}-shm" "${db_snapshot}.data" "${db_snapshot}.json" "${db_snapshot}.deploy-in-progress" \
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
    echo 'flock 명령이 없어 배포 잠금을 잡을 수 없습니다' >&2
    return 1
  }
  lock_owner="$(id -u):$(id -g)"
  sudo touch "${lock_file}"
  sudo chown "${lock_owner}" "${lock_file}"
  sudo chmod 0600 "${lock_file}"
  exec {DEPLOY_LOCK_FD}>"${lock_file}"
  if ! flock -n "${DEPLOY_LOCK_FD}"; then
    echo '다른 배포가 진행 중입니다 — 완료 후 다시 시도하세요' >&2
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
  # 전환 이후의 실패는 통합 rollback readiness가 성공한 경우에만 정리한다.
  if [ "${status}" -ne 0 ] && [ "${DEPLOY_PHASE:-pre-switch}" = pre-switch ]; then
    if [ "${RELEASE_PUBLISHED:-0}" -eq 1 ]; then
      failed_release="${RELEASE_DIR:-}"
    fi
    if [ "${SNAPSHOT_CREATED:-0}" -eq 1 ]; then
      failed_snapshot="${DB_SNAPSHOT:-}"
    fi
    if [ "${SERVICE_STOPPED_BEFORE_SWITCH:-0}" -eq 1 ]; then
      sudo systemctl start quant-platform && wait_for_ready || echo '이전 서비스 재시작 실패' >&2
    fi
    if [ -n "${failed_release}" ] || [ -n "${failed_snapshot}" ]; then
      cleanup_failed_deploy_artifacts "${failed_release}" "${failed_snapshot}" || true
    fi
    if [ "${TRANSACTION_STATE_CREATED:-0}" -eq 1 ]; then
      validate_transaction_state_file "${TRANSACTION_STATE_FILE:-}" && \
        sudo rm -f -- "${TRANSACTION_STATE_FILE}" || true
    fi
  fi

  exit "${status}"
}

validate_transaction_state_file() {
  local state_file="$1"
  case "${state_file}" in
    /var/lib/quant-platform/deploy-transactions/*.state) ;;
    *) echo "배포 transaction 경로가 올바르지 않습니다: ${state_file}" >&2; return 1 ;;
  esac
}

transaction_state_file() {
  local release="$1"
  case "${release}" in
    ''|.|..|*/*|*[!a-zA-Z0-9._-]*)
      echo "release 이름이 올바르지 않습니다: ${release}" >&2
      return 1
      ;;
  esac
  printf '/var/lib/quant-platform/deploy-transactions/%s.state\n' "${release}"
}

write_transaction_state() {
  local release="$1"
  local previous_release="$2"
  local db_snapshot="$3"
  local db_existed="$4"
  local state_file
  local state_tmp
  state_file="$(transaction_state_file "${release}")" || return 1
  validate_transaction_state_file "${state_file}" || return 1
  [ -z "${previous_release}" ] || validate_release_directory "${previous_release}" || return 1
  [ -z "${db_snapshot}" ] || validate_deploy_snapshot "${db_snapshot}" || return 1
  [ "${db_existed}" = 0 ] || [ "${db_existed}" = 1 ] || return 1

  sudo mkdir -p /var/lib/quant-platform/deploy-transactions
  if sudo find /var/lib/quant-platform/deploy-transactions \
    -mindepth 1 -maxdepth 1 -type f -name '*.state' -print -quit | grep -q .; then
    echo '완료되지 않은 배포 transaction이 있습니다' >&2
    return 75
  fi
  state_tmp="$(mktemp)"
  printf '%s\n%s\n%s\n' "${previous_release}" "${db_snapshot}" "${db_existed}" > "${state_tmp}"
  if ! sudo install -m 0600 -o root -g root "${state_tmp}" "${state_file}"; then
    rm -f -- "${state_tmp}"
    return 1
  fi
  rm -f -- "${state_tmp}"
  TRANSACTION_STATE_FILE="${state_file}"
  TRANSACTION_STATE_CREATED=1
}

read_transaction_state() {
  local release="$1"
  local state_file
  local -a state_lines=()
  state_file="$(transaction_state_file "${release}")" || return 1
  validate_transaction_state_file "${state_file}" || return 1
  sudo test -f "${state_file}" || return 1
  mapfile -t state_lines < <(sudo cat "${state_file}")
  [ "${#state_lines[@]}" -eq 3 ] || {
    echo "배포 transaction 상태가 손상됐습니다: ${state_file}" >&2
    return 1
  }
  TRANSACTION_PREVIOUS_RELEASE="${state_lines[0]}"
  TRANSACTION_DB_SNAPSHOT="${state_lines[1]}"
  TRANSACTION_DB_EXISTED="${state_lines[2]}"
  [ -z "${TRANSACTION_PREVIOUS_RELEASE}" ] || \
    validate_release_directory "${TRANSACTION_PREVIOUS_RELEASE}" || return 1
  [ -z "${TRANSACTION_DB_SNAPSHOT}" ] || \
    validate_deploy_snapshot "${TRANSACTION_DB_SNAPSHOT}" || return 1
  [ "${TRANSACTION_DB_EXISTED}" = 0 ] || [ "${TRANSACTION_DB_EXISTED}" = 1 ] || {
    echo "배포 transaction의 DB 상태가 올바르지 않습니다: ${state_file}" >&2
    return 1
  }
  TRANSACTION_STATE_FILE="${state_file}"
}

rollback_transaction() {
  local release="$1"
  local release_dir="/opt/quant-platform/releases/${release}"
  local current_release=""
  local rollback_ok=1
  local rollback_started_at
  local state_file
  state_file="$(transaction_state_file "${release}")" || return 1
  if ! sudo test -f "${state_file}"; then
    current_release="$(resolve_current_release)" || return 1
    if [ "${current_release}" = "${release_dir}" ]; then
      echo "현재 서버가 신규 release지만 rollback 상태가 없습니다: ${release}" >&2
      return 1
    fi
    echo "rollback 대상이 없습니다: ${release}" >&2
    return 0
  fi
  read_transaction_state "${release}" || return 1
  current_release="$(resolve_current_release)" || return 1
  if [ "${current_release}" != "${release_dir}" ]; then
    if [ "${current_release}" = "${TRANSACTION_PREVIOUS_RELEASE}" ]; then
      cleanup_failed_deploy_artifacts "${release_dir}" "${TRANSACTION_DB_SNAPSHOT}" || return 1
      sudo rm -f -- "${TRANSACTION_STATE_FILE}" "${TRANSACTION_STATE_FILE}.committed"
      return 0
    fi
    echo "현재 release가 transaction과 다릅니다: ${current_release}" >&2
    return 1
  fi

  echo '통합 배포 실패로 서버와 DB를 이전 상태로 롤백합니다' >&2
  sudo systemctl stop quant-platform || rollback_ok=0
  if [ "${rollback_ok}" -eq 1 ]; then
    if [ "${TRANSACTION_DB_EXISTED}" = 1 ]; then
      if [ -n "${TRANSACTION_DB_SNAPSHOT}" ] && sudo test -f "${TRANSACTION_DB_SNAPSHOT}" &&
        sudo env DATABASE_PATH=/var/lib/quant-platform/app.sqlite /usr/local/bin/node "${release_dir}/dist/server/cli.js" db:restore "${TRANSACTION_DB_SNAPSHOT}" &&
        sudo chown quant:quant /var/lib/quant-platform/app.sqlite &&
        { ! sudo test -f /var/lib/quant-platform/app.data.sqlite || sudo chown quant:quant /var/lib/quant-platform/app.data.sqlite; }; then
        echo 'DB를 배포 전 스냅샷으로 복원했습니다' >&2
      else
        rollback_ok=0
      fi
    else
      sudo rm -f /var/lib/quant-platform/app.sqlite \
        /var/lib/quant-platform/app.sqlite-journal \
        /var/lib/quant-platform/app.sqlite-wal \
        /var/lib/quant-platform/app.sqlite-shm \
        /var/lib/quant-platform/app.data.sqlite \
        /var/lib/quant-platform/app.data.sqlite-wal \
        /var/lib/quant-platform/app.data.sqlite-shm || rollback_ok=0
    fi
  fi
  if [ "${rollback_ok}" -eq 1 ]; then
    if [ -n "${TRANSACTION_PREVIOUS_RELEASE}" ]; then
      sudo ln -sfn "${TRANSACTION_PREVIOUS_RELEASE}" /opt/quant-platform/current || rollback_ok=0
    else
      sudo rm -f -- /opt/quant-platform/current || rollback_ok=0
    fi
  fi

  rollback_started_at="$(date --iso-8601=seconds)"
  if [ "${rollback_ok}" -eq 1 ]; then
    if [ -n "${TRANSACTION_PREVIOUS_RELEASE}" ]; then
      sudo systemctl restart quant-platform && wait_for_ready || rollback_ok=0
    elif sudo systemctl is-active --quiet quant-platform; then
      rollback_ok=0
    fi
  fi
  if [ "${rollback_ok}" -ne 1 ]; then
    echo "rollback failed for ${release}" >&2
    print_service_diagnostics 'integrated rollback failed' "${rollback_started_at}"
    mark_deploy_failed "${release_dir}" "${TRANSACTION_DB_SNAPSHOT}" || true
    return 1
  fi

  cleanup_failed_deploy_artifacts "${release_dir}" "${TRANSACTION_DB_SNAPSHOT}" || return 1
  sudo rm -f -- "${TRANSACTION_STATE_FILE}" "${TRANSACTION_STATE_FILE}.committed"
  echo "rollback completed for ${release}" >&2
}

verify_current_release() {
  local release="$1"
  local release_dir="/opt/quant-platform/releases/${release}"
  local current_release
  current_release="$(resolve_current_release)" || return 1
  [ "${current_release}" = "${release_dir}" ] || {
    echo "현재 release가 준비된 release와 다릅니다: ${current_release}" >&2
    return 1
  }
}

verify_prepared_release() {
  local release="$1"
  read_transaction_state "${release}" || {
    echo "배포 transaction이 없습니다: ${release}" >&2
    return 1
  }
  verify_current_release "${release}" || return 1
  wait_for_ready
}

cleanup_successful_artifacts() {
  local release_dir="$1"
  local current_target=""
  local snapshot_cleanup_ok=1
  current_target="$(resolve_current_release)" || return 1
  if [ "${current_target}" != "${release_dir}" ]; then
    echo "current release가 commit된 release와 다릅니다: ${current_target}" >&2
    return 1
  fi

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
            "${snapshot}-shm" "${snapshot}.data" "${snapshot}.json" "${snapshot}.deploy-succeeded" || exit 1
        fi
      done; then
    snapshot_cleanup_ok=0
    echo '경고: 정상 DB snapshot 정리를 완료하지 못했습니다' >&2
  fi

  if [ "${snapshot_cleanup_ok}" -eq 1 ]; then
    if ! sudo find /opt/quant-platform/releases -mindepth 1 -maxdepth 1 -type d \
      ! -name '.incomplete-*' -printf '%T@ %p\n' 2>/dev/null \
      | sort -nr \
      | while read -r _ old_release_dir; do
          if [ "${old_release_dir}" != "${current_target}" ] && \
            validate_release_directory "${old_release_dir}" && \
            is_normal_deploy_artifact \
              "${old_release_dir}/.deploy-in-progress" \
              "${old_release_dir}/.deploy-failed"; then
            printf '%s\n' "${old_release_dir}"
          fi
        done \
      | awk -v keep="${KEEP_SUCCESSFUL_DEPLOYS}" 'NR > keep' \
      | while IFS= read -r old_release_dir; do
          if [ "${old_release_dir}" != "${current_target}" ] && \
            validate_release_directory "${old_release_dir}"; then
            sudo rm -rf -- "${old_release_dir}" || exit 1
          fi
        done; then
      echo '경고: 과거 정상 release 정리를 완료하지 못했습니다' >&2
    fi
  else
    echo '경고: DB snapshot 정리 실패로 과거 release 정리도 건너뜁니다' >&2
  fi
}

if [[ "${BASH_SOURCE[0]}" != "$0" ]]; then
  return 0
fi

# 설정 파싱과 SSH 인용 규칙을 바꾸지 않도록 로컬 조정 코드는 Node로 실행한다.
# 원격 단계에서는 이 블록을 건너뛰며 같은 파일의 아래 transaction만 실행한다.
if [[ "${1:-}" != "--remote" ]]; then
  node --input-type=module --eval "$(cat <<'DEPLOY_LOCAL_NODE'
// 수동 배포 진입점: build는 로컬에서, 전송은 SSH/SCP로, 전환은 노드 로컬 transaction으로 수행한다.

import { spawnSync } from "node:child_process";
import { error as logError, log } from "node:console";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { parseEnv } from "node:util";

const SCRIPT_PATH = path.resolve(process.argv[1]);
const SCRIPT_DIR = path.dirname(SCRIPT_PATH);
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");
const DEPLOY_ENV_FILE = path.join(REPO_ROOT, "deploy.env");
const PREFLIGHT = [
  "set -eu",
  "for command_name in bash flock sqlite3 corepack systemctl systemd-run curl; do",
  '  command -v "${command_name}" >/dev/null',
  "done",
  "sudo -n true",
  "sudo -n test -f /etc/quant-platform/app.env",
  "sudo -n test -f /etc/systemd/system/quant-platform.service",
].join("\n");

class DeployError extends Error {
  constructor(message, exitCode = 1) {
    super(message);
    this.exitCode = exitCode;
  }
}

function readDeploySettings() {
  if (!existsSync(DEPLOY_ENV_FILE)) {
    throw new DeployError(
      `배포 환경 파일이 없습니다: ${DEPLOY_ENV_FILE}\n` +
        "프로젝트 루트에서 cp deploy.env.example deploy.env 후 값을 채우세요.",
    );
  }
  try {
    return parseEnv(readFileSync(DEPLOY_ENV_FILE, "utf8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new DeployError(`deploy.env를 읽을 수 없습니다: ${message}`);
  }
}

function setting(settings, name) {
  return settings[name]?.trim() ?? "";
}

function expandHome(value) {
  return value.startsWith("~/") ? path.join(homedir(), value.slice(2)) : value;
}

function splitSshOptions(value, variableName) {
  const options = [];
  let option = "";
  let quote = null;
  let escaped = false;
  let started = false;

  for (const character of value) {
    if (escaped) {
      option += character;
      escaped = false;
      started = true;
      continue;
    }
    if (quote === "'") {
      if (character === "'") quote = null;
      else option += character;
      started = true;
      continue;
    }
    if (quote === '"') {
      if (character === '"') quote = null;
      else if (character === "\\") escaped = true;
      else option += character;
      started = true;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      started = true;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      started = true;
      continue;
    }
    if (/\s/.test(character)) {
      if (started) {
        options.push(option);
        option = "";
        started = false;
      }
      continue;
    }
    option += character;
    started = true;
  }

  if (escaped || quote !== null) {
    throw new DeployError(
      `${variableName}의 따옴표 또는 escape가 닫히지 않았습니다`,
    );
  }
  if (started) options.push(option);
  return options;
}

function readConnection(settings) {
  const rawHost = setting(settings, `HOST`);
  if (!rawHost) {
    throw new DeployError(`deploy.env의 HOST가 필요합니다`);
  }
  if (rawHost.startsWith("-") || /\s/.test(rawHost)) {
    throw new DeployError(
      `HOST 형식이 올바르지 않습니다: ${rawHost}`,
    );
  }

  const at = rawHost.lastIndexOf("@");
  const embeddedUser = at > 0 ? rawHost.slice(0, at) : "";
  const host = at > 0 ? rawHost.slice(at + 1) : rawHost;
  const configuredUser = setting(settings, `SSH_USER`);
  if (!host || host.startsWith("-") || /\s/.test(host)) {
    throw new DeployError(
      `HOST 형식이 올바르지 않습니다: ${rawHost}`,
    );
  }
  if (
    configuredUser &&
    (configuredUser.startsWith("-") || /[@\s]/.test(configuredUser))
  ) {
    throw new DeployError(
      `SSH_USER 형식이 올바르지 않습니다: ${configuredUser}`,
    );
  }
  if (embeddedUser && configuredUser && embeddedUser !== configuredUser) {
    throw new DeployError(
      `HOST 사용자와 SSH_USER가 다릅니다`,
    );
  }
  const remoteTarget =
    embeddedUser || !configuredUser ? rawHost : `${configuredUser}@${rawHost}`;

  const extraOptions = setting(settings, `SSH_OPTS`);
  const sshOptions = extraOptions
    ? splitSshOptions(extraOptions, `SSH_OPTS`)
    : [];
  const key = setting(settings, `SSH_KEY`);
  if (key) {
    const expandedKey = expandHome(key);
    if (!existsSync(expandedKey)) {
      throw new DeployError(
        `SSH_KEY 파일이 없습니다: ${expandedKey}`,
      );
    }
    sshOptions.push("-i", expandedKey, "-o", "IdentitiesOnly=yes");
  }

  const port = setting(settings, `SSH_PORT`);
  if (port) {
    if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65_535) {
      throw new DeployError(`SSH_PORT가 올바르지 않습니다: ${port}`);
    }
    sshOptions.push("-o", `Port=${port}`);
  }

  const jump = setting(settings, `SSH_JUMP`);
  if (jump) {
    if (jump.startsWith("-") || /\s/.test(jump)) {
      throw new DeployError(
        `SSH_JUMP 형식이 올바르지 않습니다: ${jump}`,
      );
    }
    sshOptions.push("-o", `ProxyJump=${jump}`);
  }

  const hostKey = setting(settings, `SSH_HOST_KEY`) || "accept-new";
  if (!["accept-new", "yes", "no"].includes(hostKey)) {
    throw new DeployError(
      `SSH_HOST_KEY는 accept-new | yes | no 중 하나여야 합니다`,
    );
  }
  sshOptions.push("-o", `StrictHostKeyChecking=${hostKey}`);
  sshOptions.push(
    "-o",
    "ServerAliveInterval=15",
    "-o",
    "ServerAliveCountMax=3",
  );

  return { remoteTarget, sshOptions };
}

function commandFailure(command, result) {
  const suffix = result.signal ? ` (${result.signal})` : "";
  const stderr = typeof result.stderr === "string" ? result.stderr.trim() : "";
  return (
    `${command}가 종료 코드 ${result.status ?? 1}${suffix}로 실패했습니다` +
    (stderr ? `\n${stderr}` : "")
  );
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: REPO_ROOT,
    env: process.env,
    stdio: options.quiet ? ["ignore", "ignore", "inherit"] : "inherit",
  });
  if (result.error)
    throw new DeployError(`${command} 실행 실패: ${result.error.message}`);
  if (result.status !== 0) {
    throw new DeployError(commandFailure(command, result), result.status ?? 1);
  }
}

function capture(command, args) {
  const result = spawnSync(command, args, {
    cwd: REPO_ROOT,
    env: process.env,
    encoding: "utf8",
  });
  if (result.error)
    throw new DeployError(`${command} 실행 실패: ${result.error.message}`);
  if (result.status !== 0) {
    throw new DeployError(commandFailure(command, result), result.status ?? 1);
  }
  return result.stdout.trim();
}

function sshArguments(connection, options = {}) {
  return [
    ...connection.sshOptions,
    ...(options.batch
      ? ["-o", "ConnectTimeout=15", "-o", "BatchMode=yes"]
      : []),
    connection.remoteTarget,
  ];
}

function shellQuote(value) {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function runRemoteBash(connection, script, args = [], options = {}) {
  const remoteCommand = [
    "/bin/bash",
    "-c",
    shellQuote(script),
    "deploy-remote",
    ...args.map(shellQuote),
  ].join(" ");
  run("ssh", [...sshArguments(connection, options), remoteCommand], options);
}

function preflight(connection) {
  runRemoteBash(connection, PREFLIGHT, [], { batch: true, quiet: true });
}

function validateRemoteDirectory(remoteDirectory) {
  const pattern = /^\/tmp\/quant-deploy\.[a-zA-Z0-9]+$/;
  if (!pattern.test(remoteDirectory)) {
    throw new DeployError(
      `원격 임시 경로가 올바르지 않습니다: ${remoteDirectory}`,
    );
  }
}

function createRemoteDirectory(connection) {
  const template = "/tmp/quant-deploy.XXXXXX";
  const remoteDirectory = capture("ssh", [
    ...sshArguments(connection),
    `mktemp -d ${template}`,
  ]);
  validateRemoteDirectory(remoteDirectory);
  return remoteDirectory;
}

function removeRemoteDirectory(connection, remoteDirectory) {
  validateRemoteDirectory(remoteDirectory);
  run(
    "ssh",
    [
      ...sshArguments(connection),
      `/bin/rm -rf -- ${shellQuote(remoteDirectory)}`,
    ],
    { quiet: true },
  );
}

function upload(connection, files, remoteDirectory) {
  run("scp", [
    ...connection.sshOptions,
    ...files,
    `${connection.remoteTarget}:${remoteDirectory}/`,
  ]);
}

function stageFiles(connection, files) {
  const remoteDirectory = createRemoteDirectory(connection);
  try {
    upload(connection, files, remoteDirectory);
  } catch (error) {
    try {
      removeRemoteDirectory(connection, remoteDirectory);
    } catch (cleanupError) {
      const message =
        cleanupError instanceof Error
          ? cleanupError.message
          : String(cleanupError);
      logError(
        `업로드 실패 후 임시 디렉터리 정리도 실패했습니다: ${message}`,
      );
    }
    throw error;
  }
  return remoteDirectory;
}

function stageDeployment(
  connection,
  releaseArchive,
  releaseChecksum,
  releaseName,
) {
  const remoteDirectory = stageFiles(connection, [
    releaseArchive,
    releaseChecksum,
    SCRIPT_PATH,
  ]);
  return {
    connection,
    releaseName,
    remoteDirectory,
    remoteArchive: path.posix.join(
      remoteDirectory,
      path.basename(releaseArchive),
    ),
    remoteChecksum: path.posix.join(
      remoteDirectory,
      path.basename(releaseChecksum),
    ),
    remoteScript: path.posix.join(remoteDirectory, "deploy.sh"),
  };
}

function runPhase(deployment, phase) {
  const args =
    phase === "prepare"
      ? [
          phase,
          deployment.remoteArchive,
          deployment.remoteChecksum,
          deployment.releaseName,
        ]
      : [phase, deployment.releaseName];
  const command = [
    "/bin/bash",
    shellQuote(deployment.remoteScript),
    "--remote",
    ...args.map(shellQuote),
  ].join(" ");
  run("ssh", [...sshArguments(deployment.connection), command]);
}

function readReleaseMetadata(metadataFile, artifactDirectory) {
  let metadata;
  try {
    metadata = JSON.parse(readFileSync(metadataFile, "utf8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new DeployError(`release metadata를 읽을 수 없습니다: ${message}`);
  }
  if (
    metadata === null ||
    typeof metadata !== "object" ||
    Array.isArray(metadata)
  ) {
    throw new DeployError("release metadata 형식이 올바르지 않습니다");
  }
  const { releaseName, gitSha } = metadata;
  if (
    typeof releaseName !== "string" ||
    !/^\d{8}-\d{6}-[a-f0-9]{7}$/.test(releaseName)
  ) {
    throw new DeployError("release metadata의 releaseName이 올바르지 않습니다");
  }
  if (
    typeof gitSha !== "string" ||
    !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(gitSha)
  ) {
    throw new DeployError("release metadata의 gitSha가 올바르지 않습니다");
  }
  const releaseArchive = path.join(
    artifactDirectory,
    `quant-platform-${releaseName}.tar.gz`,
  );
  const releaseChecksum = `${releaseArchive}.sha256`;
  if (!existsSync(releaseArchive) || !existsSync(releaseChecksum)) {
    throw new DeployError(
      "release metadata가 가리키는 archive 또는 checksum이 없습니다",
    );
  }
  return { releaseArchive, releaseChecksum, releaseName, gitSha };
}

function main() {
  if (process.platform !== "linux")
    throw new DeployError("배포는 Linux에서 실행하세요");
  const settings = readDeploySettings();
  const connection = readConnection(settings);
  const artifactDirectory = mkdtempSync(path.join(tmpdir(), "quant-deploy-"));
  let deployment = null;
  let attempted = false;
  let committed = false;
  try {
    preflight(connection);
    const metadataFile = path.join(artifactDirectory, "release-metadata.json");
    log("==> 운영 서버와 Linux 클라이언트 검증·패키징");
    run("bash", [
      path.join(SCRIPT_DIR, "build-release.sh"),
      artifactDirectory,
      metadataFile,
    ]);
    const release = readReleaseMetadata(metadataFile, artifactDirectory);
    deployment = stageDeployment(
      connection,
      release.releaseArchive,
      release.releaseChecksum,
      release.releaseName,
    );
    attempted = true;
    runPhase(deployment, "prepare");
    runPhase(deployment, "verify");
    runPhase(deployment, "commit");
    committed = true;
    runPhase(deployment, "finalize");
    log(`==> 서버와 다운로드 클라이언트 게시 완료: ${release.releaseName}`);
  } catch (error) {
    if (attempted && !committed && deployment) {
      try {
        runPhase(deployment, "rollback");
      } catch (rollbackError) {
        throw new DeployError(
          `${error.message}\n서버·DB 복원 실패: ${rollbackError.message}`,
        );
      }
    }
    throw error;
  } finally {
    if (deployment) {
      try {
        removeRemoteDirectory(connection, deployment.remoteDirectory);
      } catch (error) {
        logError(`배포 임시 파일 정리 실패: ${error.message}`);
      }
    }
    rmSync(artifactDirectory, { recursive: true, force: true });
  }
}

try {
  main();
} catch (error) {
  const deployError =
    error instanceof DeployError
      ? error
      : new DeployError(error instanceof Error ? error.message : String(error));
  logError(deployError.message);
  process.exitCode = deployError.exitCode;
}
DEPLOY_LOCAL_NODE
)" "${BASH_SOURCE[0]}" "$@"
  exit "$?"
fi
shift

KEEP_SUCCESSFUL_DEPLOYS=0
PHASE="${1:-}"

case "${PHASE}" in
  prepare)
    [ "$#" -eq 4 ] || {
      echo '사용법: deploy.sh --remote prepare <release-archive> <checksum-file> <release-name>' >&2
      exit 64
    }
    REMOTE_ARCHIVE_PATH="$2"
    REMOTE_CHECKSUM_PATH="$3"
    RELEASE="$4"
    case "${RELEASE}" in
      ''|.|..|*/*|*[!a-zA-Z0-9._-]*)
        echo "release 이름이 올바르지 않습니다: ${RELEASE}" >&2
        exit 64
        ;;
    esac
    case "${REMOTE_ARCHIVE_PATH}" in
      /tmp/quant-deploy.*/*) ;;
      *) echo "release archive 경로가 허용된 위치가 아닙니다: ${REMOTE_ARCHIVE_PATH}" >&2; exit 64 ;;
    esac
    case "${REMOTE_CHECKSUM_PATH}" in
      /tmp/quant-deploy.*/*) ;;
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
    SERVICE_STOPPED_BEFORE_SWITCH=0
    DEPLOY_DB_SNAPSHOT=""
    DEPLOY_PHASE=pre-switch
    RELEASE_STAGING_CREATED=0
    RELEASE_PUBLISHED=0
    SNAPSHOT_INCOMPLETE_OWNED=0
    SNAPSHOT_CREATED=0
    TRANSACTION_STATE_CREATED=0
    TRANSACTION_STATE_FILE=""

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
    DB_EXISTED=0
    sudo systemctl stop quant-platform
    SERVICE_STOPPED_BEFORE_SWITCH=1
    if sudo test -f "${DB_PATH}"; then
      DB_EXISTED=1
      if sudo test -e "${DB_SNAPSHOT}" || sudo test -e "${DB_SNAPSHOT_INCOMPLETE}"; then
        echo "DB snapshot 경로가 이미 존재합니다: ${DB_SNAPSHOT}" >&2
        exit 1
      fi
      sudo touch "${DB_SNAPSHOT}.deploy-in-progress"
      SNAPSHOT_CREATED=1
      SNAPSHOT_INCOMPLETE_OWNED=1
      sudo env DATABASE_PATH="${DB_PATH}" /usr/local/bin/node "${RELEASE_STAGING}/dist/server/cli.js" db:backup "${DB_SNAPSHOT_INCOMPLETE}"
      if sudo test -f "${DB_SNAPSHOT_INCOMPLETE}.data"; then
        sudo mv "${DB_SNAPSHOT_INCOMPLETE}.data" "${DB_SNAPSHOT}.data"
      fi
      sudo mv "${DB_SNAPSHOT_INCOMPLETE}.json" "${DB_SNAPSHOT}.json"
      sudo mv "${DB_SNAPSHOT_INCOMPLETE}" "${DB_SNAPSHOT}"
      SNAPSHOT_INCOMPLETE_OWNED=0
      DEPLOY_DB_SNAPSHOT="${DB_SNAPSHOT}"
    fi

    RELEASE_PUBLISHED=1
    sudo mv "${RELEASE_STAGING}" "${RELEASE_DIR}"
    RELEASE_STAGING_CREATED=0
    write_transaction_state \
      "${RELEASE}" "${PREVIOUS_RELEASE}" "${DEPLOY_DB_SNAPSHOT}" "${DB_EXISTED}"
    cd "${RELEASE_DIR}"
    DEPLOY_PHASE=switching
    if sudo ln -sfn "${RELEASE_DIR}" /opt/quant-platform/current &&
      SWITCHED_RELEASE="$(resolve_current_release)" &&
      [ "${SWITCHED_RELEASE}" = "${RELEASE_DIR}" ]; then
      DEPLOY_PHASE=switched
    else
      echo "current release 전환을 검증하지 못했습니다: ${RELEASE_DIR}" >&2
      rollback_transaction "${RELEASE}" || \
        echo '서버 전환 실패 후 rollback에도 실패했습니다' >&2
      exit 1
    fi

    DEPLOY_FAILED=0
    DEPLOY_ATTEMPT_STARTED_AT="$(date --iso-8601=seconds)"
    sudo systemctl stop quant-platform || DEPLOY_FAILED=1
    if [ "${DEPLOY_FAILED}" -eq 0 ]; then
      sudo systemd-run --quiet --pipe --wait --collect \
        --unit=quant-platform-db-prepare \
        --property=Type=oneshot \
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
    if [ "${DEPLOY_FAILED}" -ne 0 ]; then
      echo '서버 기동 또는 readiness 실패 — 진단 후 통합 rollback을 실행합니다' >&2
      print_service_diagnostics 'new release failed' "${DEPLOY_ATTEMPT_STARTED_AT}"
      if ! rollback_transaction "${RELEASE}"; then
        echo '자동 rollback에 실패해 release와 DB snapshot을 보존합니다' >&2
      fi
      exit 1
    fi
    DEPLOY_PHASE=prepared
    echo "release ${RELEASE} prepared"
    ;;
  verify|commit|rollback|finalize)
    [ "$#" -eq 2 ] || {
      echo "사용법: deploy.sh --remote ${PHASE} <release-name>" >&2
      exit 64
    }
    RELEASE="$2"
    transaction_state_file "${RELEASE}" >/dev/null || exit 64
    for required_command in flock systemctl curl; do
      command -v "${required_command}" >/dev/null 2>&1 || {
        echo "필수 명령이 없습니다: ${required_command}" >&2
        exit 69
      }
    done
    sudo -n true >/dev/null 2>&1 || { echo '비대화형 sudo 권한이 필요합니다' >&2; exit 77; }
    acquire_deploy_lock
    case "${PHASE}" in
      verify)
        verify_prepared_release "${RELEASE}"
        echo "release ${RELEASE} verified"
        ;;
      commit)
        verify_prepared_release "${RELEASE}"
        RELEASE_DIR="/opt/quant-platform/releases/${RELEASE}"
        mark_deploy_succeeded "${RELEASE_DIR}" "${TRANSACTION_DB_SNAPSHOT}"
        sudo touch "${TRANSACTION_STATE_FILE}.committed"
        echo "release ${RELEASE} committed"
        ;;
      rollback)
        rollback_transaction "${RELEASE}"
        ;;
      finalize)
        read_transaction_state "${RELEASE}"
        sudo test -f "${TRANSACTION_STATE_FILE}.committed" || {
          echo "배포가 commit되지 않았습니다: ${RELEASE}" >&2
          exit 1
        }
        verify_current_release "${RELEASE}"
        RELEASE_DIR="/opt/quant-platform/releases/${RELEASE}"
        cleanup_successful_artifacts "${RELEASE_DIR}"
        validate_transaction_state_file "${TRANSACTION_STATE_FILE}"
        sudo rm -f -- "${TRANSACTION_STATE_FILE}" "${TRANSACTION_STATE_FILE}.committed"
        echo "release ${RELEASE} live"
        ;;
    esac
    ;;
  *)
    echo 'deploy.sh --remote에는 prepare/verify/commit/finalize/rollback 단계가 필요합니다' >&2
    exit 64
    ;;
esac
