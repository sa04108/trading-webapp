#!/usr/bin/env bash
# 개발 PC에서 검증·빌드·업로드하고, 같은 파일을 서버에서 한 번 실행해 배포한다.
# 사용법: ./scripts/deploy.sh (저장소 루트의 deploy.env 사용)
# --remote는 내부 호출용이다. 배포 조정에 Node나 별도 진입점은 사용하지 않는다.
set -euo pipefail

error() { printf '%s\n' "$*" >&2; }

# deploy.env는 데이터다. source/eval하지 않으며 한 줄 값과 바깥 따옴표만 읽는다.
read_settings() {
  local file="$1" line name value quote tail
  HOST= SSH_USER= SSH_KEY= SSH_PORT= SSH_JUMP= SSH_HOST_KEY= SSH_OPTS=
  [ -f "$file" ] || { error "배포 환경 파일이 없습니다: $file"; return 1; }
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line%$'\r'}"
    line="${line#"${line%%[![:space:]]*}"}"
    [[ -z "$line" || "$line" == \#* ]] && continue
    line="${line#export }"
    [[ "$line" =~ ^([A-Za-z_][A-Za-z0-9_]*)[[:space:]]*=(.*)$ ]] || {
      error 'deploy.env는 KEY=value 형식이어야 합니다'; return 1;
    }
    name="${BASH_REMATCH[1]}" value="${BASH_REMATCH[2]}"
    case "$name" in HOST|SSH_USER|SSH_KEY|SSH_PORT|SSH_JUMP|SSH_HOST_KEY|SSH_OPTS) ;; *) continue ;; esac
    value="${value#"${value%%[![:space:]]*}"}"
    quote="${value:0:1}"
    if [[ "$quote" == "'" || "$quote" == '"' ]]; then
      value="${value:1}"
      [[ "$value" == *"$quote"* ]] || { error "$name: 닫히지 않은 따옴표"; return 1; }
      tail="${value#*"$quote"}"
      value="${value%%"$quote"*}"
      [[ "$tail" =~ ^[[:space:]]*(#.*)?$ ]] || { error "$name: 따옴표 뒤에 잘못된 값"; return 1; }
    else
      value="${value%%#*}"
    fi
    value="${value%"${value##*[![:space:]]}"}"
    printf -v "$name" '%s' "$value"
  done < "$file"
}

# SSH_OPTS의 인용된 공백을 보존하되 셸 확장이나 명령 실행은 하지 않는다.
split_ssh_options() {
  local text="$1" char word='' quote='' escaped=0 started=0 i
  SSH_ARGS=()
  for ((i=0; i<${#text}; i++)); do
    char="${text:i:1}"
    if ((escaped)); then word+="$char"; escaped=0; started=1
    elif [[ "$quote" == "'" ]]; then
      if [[ "$char" == "'" ]]; then quote=''; else word+="$char"; fi
    elif [[ "$char" == '\' ]]; then escaped=1; started=1
    elif [[ -n "$quote" ]]; then
      if [[ "$char" == "$quote" ]]; then quote=''; else word+="$char"; fi
    elif [[ "$char" == "'" || "$char" == '"' ]]; then quote="$char"; started=1
    elif [[ "$char" == [[:space:]] ]]; then
      if ((started)); then SSH_ARGS+=("$word"); word=''; started=0; fi
    else word+="$char"; started=1
    fi
  done
  [[ -z "$quote" && "$escaped" == 0 ]] || { error 'SSH_OPTS의 따옴표 또는 escape가 닫히지 않았습니다'; return 1; }
  if ((started)); then SSH_ARGS+=("$word"); fi
}

configure_ssh() {
  local host embedded_user=''
  [[ -n "$HOST" && "$HOST" != -* && "$HOST" != *[[:space:]]* ]] || { error 'HOST가 필요하거나 형식이 올바르지 않습니다'; return 1; }
  host="$HOST"
  if [[ "$HOST" == *@* ]]; then embedded_user="${HOST%@*}"; host="${HOST##*@}"; fi
  [[ -n "$host" && "$host" != -* && "$embedded_user" != -* && "$embedded_user" != *@* ]] || { error 'HOST 형식이 올바르지 않습니다'; return 1; }
  [[ "$SSH_USER" != -* && "$SSH_USER" != *[@[:space:]]* ]] || { error 'SSH_USER 형식이 올바르지 않습니다'; return 1; }
  [[ -z "$embedded_user" || -z "$SSH_USER" || "$embedded_user" == "$SSH_USER" ]] || { error 'HOST 사용자와 SSH_USER가 다릅니다'; return 1; }
  TARGET="$HOST"
  if [[ "$HOST" != *@* && -n "$SSH_USER" ]]; then TARGET="$SSH_USER@$HOST"; fi
  split_ssh_options "$SSH_OPTS"
  if [[ -n "$SSH_KEY" ]]; then
    SSH_KEY="${SSH_KEY/#\~\//$HOME/}"
    [ -f "$SSH_KEY" ] || { error "SSH_KEY 파일이 없습니다: $SSH_KEY"; return 1; }
    SSH_ARGS+=(-i "$SSH_KEY" -o IdentitiesOnly=yes)
  fi
  if [[ -n "$SSH_PORT" ]]; then
    [[ "$SSH_PORT" =~ ^[0-9]{1,5}$ ]] && ((10#$SSH_PORT >= 1 && 10#$SSH_PORT <= 65535)) || { error 'SSH_PORT가 올바르지 않습니다'; return 1; }
    SSH_ARGS+=(-o "Port=$SSH_PORT")
  fi
  if [[ -n "$SSH_JUMP" ]]; then
    [[ "$SSH_JUMP" != -* && "$SSH_JUMP" != *[[:space:]]* ]] || { error 'SSH_JUMP 형식이 올바르지 않습니다'; return 1; }
    SSH_ARGS+=(-o "ProxyJump=$SSH_JUMP")
  fi
  case "${SSH_HOST_KEY:=accept-new}" in accept-new|yes|no) ;; *) error 'SSH_HOST_KEY는 accept-new | yes | no 중 하나입니다'; return 1 ;; esac
  SSH_ARGS+=(-o "StrictHostKeyChecking=$SSH_HOST_KEY" -o ServerAliveInterval=15 -o ServerAliveCountMax=3)
}

local_exit() {
  local status=$?
  trap - EXIT
  if [[ -n "${REMOTE_DIR:-}" ]]; then
    ssh "${SSH_ARGS[@]}" -o ConnectTimeout=15 -o BatchMode=yes "$TARGET" \
      "rm -rf -- '$REMOTE_DIR'" || echo '경고: 원격 업로드 임시파일 정리에 실패했습니다' >&2
  fi
  if [[ -n "${ARTIFACT_DIR:-}" ]]; then rm -rf -- "$ARTIFACT_DIR" || echo '경고: 로컬 임시파일 정리에 실패했습니다' >&2; fi
  if ((status)); then echo "실패 (exit $status). 로그: $LOG"; fi
  exec 1>&- 2>&-
  wait "$TEE_PID" 2>/dev/null || true
  exit "$status"
}

local_deploy() {
  local repo_root archive checksum release remote_dir
  local -a archives
  [[ "$(uname -s)" == Linux ]] || { error '배포는 Linux에서 실행하세요'; return 1; }
  repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  cd "$repo_root"
  LOG="${LOG:-$repo_root/.logs/deploy-$(date -u +%Y%m%d-%H%M%S).log}"
  mkdir -p "$(dirname "$LOG")"
  exec > >(tee "$LOG") 2>&1
  TEE_PID=$!
  ARTIFACT_DIR='' REMOTE_DIR=''
  trap local_exit EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  trap 'exit 129' HUP
  echo "로그: $LOG"
  read_settings "$repo_root/deploy.env"
  configure_ssh
  echo "==> SSH 접속 확인: $TARGET"
  ssh "${SSH_ARGS[@]}" -o ConnectTimeout=15 -o BatchMode=yes "$TARGET" '
    set -eu
    for cmd in bash flock sha256sum tar corepack sqlite3 systemctl systemd-run curl; do command -v "$cmd" >/dev/null; done
    sudo -n true
    sudo -n test -f /etc/quant-platform/app.env
    sudo -n test -f /etc/systemd/system/quant-platform.service
  '
  ARTIFACT_DIR="$(mktemp -d "${TMPDIR:-/tmp}/quant-build.XXXXXX")"
  echo '==> 운영 서버와 Linux 클라이언트 검증·패키징'
  bash "$repo_root/scripts/build-release.sh" "$ARTIFACT_DIR"
  archives=("$ARTIFACT_DIR"/quant-platform-*.tar.gz)
  [[ ${#archives[@]} == 1 && -f "${archives[0]}" ]] || { error 'release archive가 없거나 여러 개입니다'; return 1; }
  archive="${archives[0]}"; checksum="$archive.sha256"
  release="${archive##*/quant-platform-}"; release="${release%.tar.gz}"
  [[ "$release" =~ ^[0-9]{8}-[0-9]{6}-[a-f0-9]{7}$ && -f "$checksum" ]] || { error 'release 이름 또는 checksum 파일이 올바르지 않습니다'; return 1; }
  remote_dir="$(ssh "${SSH_ARGS[@]}" "$TARGET" 'mktemp -d /tmp/quant-deploy.XXXXXX')"
  [[ "$remote_dir" =~ ^/tmp/quant-deploy\.[a-zA-Z0-9]+$ ]] || { error '원격 임시 경로가 올바르지 않습니다'; return 1; }
  REMOTE_DIR="$remote_dir"
  echo '==> 업로드 및 릴리스 전환'
  scp "${SSH_ARGS[@]}" "$archive" "$checksum" "$repo_root/scripts/deploy.sh" "$TARGET:$REMOTE_DIR/"
  # 모든 경로 조각은 위의 고정 형식 검사로 제한했다. 표준 입력은 원격 프로세스에 남긴다.
  ssh "${SSH_ARGS[@]}" "$TARGET" \
    "bash '$REMOTE_DIR/deploy.sh' --remote '$REMOTE_DIR/${archive##*/}' '$REMOTE_DIR/${checksum##*/}' '$release'"
  echo "==> 완료: $release"
}

wait_for_ready() {
  local attempt
  for ((attempt=1; attempt<=60; attempt++)); do
    if curl -fsS http://127.0.0.1:3000/api/v1/health/ready >/dev/null 2>&1; then return 0; fi
    if ((attempt<60)); then sleep 2; fi
  done
  return 1
}

print_service_diagnostics() {
  echo '==> service diagnostics' >&2
  readlink -f /opt/quant-platform/current >&2 || true
  sudo systemctl show quant-platform --no-pager \
    --property=ActiveState,SubState,Result,ExecMainCode,ExecMainStatus,NRestarts >&2 || true
  sudo systemctl status quant-platform --no-pager -l >&2 || true
  sudo journalctl -u quant-platform --since "$DEPLOY_STARTED_AT" --no-pager -o short-iso >&2 || true
}

validate_release_directory() {
  [[ "$1" =~ ^/opt/quant-platform/releases/[a-zA-Z0-9._-]+$ && "${1##*/}" != . && "${1##*/}" != .. ]] || {
    error "release 경로가 올바르지 않습니다: $1"; return 1;
  }
}

resolve_current_release() {
  local link="${1:-/opt/quant-platform/current}" resolved
  if resolved="$(readlink -e "$link")" && [[ -n "$resolved" ]]; then
    validate_release_directory "$resolved" || return 1
    printf '%s\n' "$resolved"
  elif [[ -e "$link" || -L "$link" ]]; then
    error 'current release 경로를 안전하게 해석할 수 없습니다'; return 1
  fi
}

remove_snapshot() {
  local snapshot="$1"
  [[ "$snapshot" =~ ^/var/lib/quant-platform/backups/\.?pre-deploy-[a-zA-Z0-9._-]+\.sqlite(\.incomplete)?$ ]] || { error 'DB snapshot 경로가 올바르지 않습니다'; return 1; }
  sudo rm -f -- "$snapshot" "$snapshot.data" "$snapshot.json" "$snapshot-journal" "$snapshot-wal" "$snapshot-shm" \
    "$snapshot.deploy-in-progress" "$snapshot.deploy-failed" "$snapshot.deploy-succeeded"
}

remove_failed_release() {
  local directory="$1" current
  validate_release_directory "$directory" || return 1
  current="$(resolve_current_release)" || return 1
  [[ "$current" != "$directory" ]] || { error '현재 release는 실패 산출물로 삭제하지 않습니다'; return 1; }
  sudo rm -rf -- "$directory"
}

rollback_release() {
  echo '배포 실패로 코드와 DB를 이전 상태로 롤백합니다' >&2
  sudo systemctl stop quant-platform || return 1
  if ((DB_EXISTED)); then
    sudo test -f "$DB_SNAPSHOT" && sudo test -f "$DB_SNAPSHOT.data" && sudo test -f "$DB_SNAPSHOT.json" || return 1
    sudo env DATABASE_PATH="$DB_PATH" /usr/local/bin/node "$RELEASE_DIR/dist/server/cli.js" db:restore "$DB_SNAPSHOT" || return 1
    sudo chown quant:quant "$DB_PATH" /var/lib/quant-platform/app.data.sqlite || return 1
  else
    sudo rm -f -- "$DB_PATH" "$DB_PATH-journal" "$DB_PATH-wal" "$DB_PATH-shm" \
      /var/lib/quant-platform/app.data.sqlite /var/lib/quant-platform/app.data.sqlite-wal /var/lib/quant-platform/app.data.sqlite-shm || return 1
  fi
  if [[ -n "$PREVIOUS_RELEASE" ]]; then
    sudo ln -sfn "$PREVIOUS_RELEASE" /opt/quant-platform/current || return 1
    [[ "$(resolve_current_release)" == "$PREVIOUS_RELEASE" ]] || return 1
    sudo systemctl start quant-platform && wait_for_ready || return 1
  else
    sudo rm -f -- /opt/quant-platform/current || return 1
  fi
  echo '코드·DB 롤백 검증 완료' >&2
}

remote_exit() {
  local status=$? recovered=1
  trap - EXIT
  if ((status && !COMMITTED)); then
    print_service_diagnostics
    if ((SWITCH_ATTEMPTED)); then
      rollback_release || recovered=0
    elif ((SERVICE_STOPPED)); then
      sudo systemctl start quant-platform && wait_for_ready || recovered=0
    fi
    if ((recovered)); then
      # 백업 정리가 실패하면 코드도 보존해 복구 자료의 짝을 깨뜨리지 않는다.
      if ((SNAPSHOT_OWNED)); then remove_snapshot "$DB_SNAPSHOT" || recovered=0; fi
      if ((recovered && RELEASE_OWNED)); then remove_failed_release "$RELEASE_DIR" || recovered=0; fi
    fi
    if ((!recovered)); then
      if ((RELEASE_OWNED)); then sudo touch "$RELEASE_DIR/.deploy-failed" || true; fi
      if ((SNAPSHOT_OWNED)); then sudo touch "$DB_SNAPSHOT.deploy-failed" || true; fi
      echo '복원 또는 정리 실패 — release와 DB snapshot을 보존합니다' >&2
    fi
  fi
  if ((STAGING_OWNED)); then remove_failed_release "$RELEASE_STAGING" || true; fi
  if ((SNAPSHOT_OWNED)); then remove_snapshot "$DB_SNAPSHOT_INCOMPLETE" || true; fi
  rm -f -- "$REMOTE_ARCHIVE" "$REMOTE_CHECKSUM" || true
  exit "$status"
}

cleanup_successful_artifacts() {
  local snapshots releases file current
  current="$(resolve_current_release)" || return 1
  [[ "$current" == "$RELEASE_DIR" ]] || { error 'current release가 배포된 release와 다릅니다'; return 1; }
  # 기존 보존 개수는 0이다. current와 복구 마커가 있는 파일은 절대 지우지 않는다.
  snapshots="$(sudo find /var/lib/quant-platform/backups -maxdepth 1 -type f -name 'pre-deploy-*.sqlite')" || return 1
  while IFS= read -r file; do
    [[ -n "$file" ]] || continue
    if sudo test ! -e "$file.deploy-in-progress" && sudo test ! -e "$file.deploy-failed"; then remove_snapshot "$file" || return 1; fi
  done <<< "$snapshots"
  releases="$(sudo find /opt/quant-platform/releases -mindepth 1 -maxdepth 1 -type d ! -name '.incomplete-*')" || return 1
  while IFS= read -r file; do
    [[ -n "$file" && "$file" != "$current" ]] || continue
    if sudo test ! -e "$file/.deploy-in-progress" && sudo test ! -e "$file/.deploy-failed"; then remove_failed_release "$file" || return 1; fi
  done <<< "$releases"
}

remote_deploy() {
  [[ $# == 3 ]] || { error '내부 호출: --remote <archive> <checksum> <release>'; return 64; }
  local release="$3" expected actual unfinished existing
  REMOTE_ARCHIVE="$1" REMOTE_CHECKSUM="$2"
  [[ "$release" =~ ^[0-9]{8}-[0-9]{6}-[a-f0-9]{7}$ && "${1%/*}" =~ ^/tmp/quant-deploy\.[a-zA-Z0-9]+$ && "$2" == "$1.sha256" && "${1##*/}" == "quant-platform-$release.tar.gz" ]] || { error '원격 배포 경로 또는 release 이름이 올바르지 않습니다'; return 64; }
  [[ -f "$REMOTE_ARCHIVE" && -f "$REMOTE_CHECKSUM" ]] || { error 'release archive 또는 checksum 파일이 없습니다'; return 66; }
  sudo -n true
  # 전체 원격 실행 동안 같은 잠금을 잡는다. 단계별 SSH 조정과 transaction 상태 파일은 필요 없다.
  sudo touch /run/lock/quant-platform-deploy.lock
  sudo chown "$(id -u):$(id -g)" /run/lock/quant-platform-deploy.lock
  sudo chmod 0600 /run/lock/quant-platform-deploy.lock
  exec {DEPLOY_LOCK_FD}>/run/lock/quant-platform-deploy.lock
  flock -n "$DEPLOY_LOCK_FD" || { error '다른 배포가 진행 중입니다'; return 75; }
  RELEASE_DIR="/opt/quant-platform/releases/$release"
  RELEASE_STAGING="/opt/quant-platform/releases/.incomplete-$release"
  DB_PATH=/var/lib/quant-platform/app.sqlite
  DB_SNAPSHOT="/var/lib/quant-platform/backups/pre-deploy-$release.sqlite"
  DB_SNAPSHOT_INCOMPLETE="/var/lib/quant-platform/backups/.pre-deploy-$release.sqlite.incomplete"
  PREVIOUS_RELEASE='' DB_EXISTED=0 SERVICE_STOPPED=0 SWITCH_ATTEMPTED=0 COMMITTED=0
  STAGING_OWNED=0 RELEASE_OWNED=0 SNAPSHOT_OWNED=0
  DEPLOY_STARTED_AT="$(date --iso-8601=seconds)"
  trap remote_exit EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  trap 'exit 129' HUP
  # 이전 방식의 미완료 배포를 새 실행으로 덮지 않는다.
  if sudo test -d /var/lib/quant-platform/deploy-transactions; then
    unfinished="$(sudo find /var/lib/quant-platform/deploy-transactions -maxdepth 1 -name '*.state' -print -quit)"
    [[ -z "$unfinished" ]] || { error '이전 배포 transaction을 먼저 복구하세요'; return 75; }
  fi
  PREVIOUS_RELEASE="$(resolve_current_release)"
  if [[ -n "$PREVIOUS_RELEASE" ]]; then
    sudo test ! -e "$PREVIOUS_RELEASE/.deploy-in-progress" && sudo test ! -e "$PREVIOUS_RELEASE/.deploy-failed" || { error '현재 release의 미완료 배포를 먼저 복구하세요'; return 75; }
  fi
  expected="$(awk 'NR == 1 { print $1 }' "$REMOTE_CHECKSUM")"
  [[ "$expected" =~ ^[a-fA-F0-9]{64}$ ]] || { error 'release checksum 형식 오류'; return 1; }
  actual="$(sha256sum "$REMOTE_ARCHIVE")"; actual="${actual%% *}"
  [[ "${expected,,}" == "$actual" ]] || { error 'release archive checksum 불일치'; return 1; }
  sudo mkdir -p /opt/quant-platform/releases /var/lib/quant-platform/backups
  for existing in "$RELEASE_DIR" "$RELEASE_STAGING" "$DB_SNAPSHOT"{,.data,.json,.deploy-in-progress,.deploy-failed} "$DB_SNAPSHOT_INCOMPLETE"{,.data,.json}; do
    sudo test ! -e "$existing" && sudo test ! -L "$existing" || { error "배포 경로가 이미 존재합니다: $existing"; return 1; }
  done
  sudo mkdir "$RELEASE_STAGING"; STAGING_OWNED=1
  sudo touch "$RELEASE_STAGING/.deploy-in-progress"
  sudo tar -xzf "$REMOTE_ARCHIVE" -C "$RELEASE_STAGING"
  (cd "$RELEASE_STAGING"; sudo corepack pnpm install --prod --frozen-lockfile)
  echo "이전 릴리스: ${PREVIOUS_RELEASE:-없음}"
  if sudo test ! -f "$DB_PATH" && sudo test -f /var/lib/quant-platform/app.data.sqlite; then
    error '운영 DB 없이 계산 DB만 있습니다 — DB 세트를 먼저 복구하세요'; return 1
  fi
  SERVICE_STOPPED=1
  sudo systemctl stop quant-platform
  if sudo test -f "$DB_PATH"; then
    DB_EXISTED=1
    sudo touch "$DB_SNAPSHOT.deploy-in-progress"; SNAPSHOT_OWNED=1
    echo "DB 백업: $DB_SNAPSHOT"
    sudo env DATABASE_PATH="$DB_PATH" /usr/local/bin/node "$RELEASE_STAGING/dist/server/cli.js" db:backup "$DB_SNAPSHOT_INCOMPLETE"
    sudo mv "$DB_SNAPSHOT_INCOMPLETE.data" "$DB_SNAPSHOT.data"
    sudo mv "$DB_SNAPSHOT_INCOMPLETE.json" "$DB_SNAPSHOT.json"
    sudo mv "$DB_SNAPSHOT_INCOMPLETE" "$DB_SNAPSHOT"
  fi
  sudo mv "$RELEASE_STAGING" "$RELEASE_DIR"; STAGING_OWNED=0; RELEASE_OWNED=1
  SWITCH_ATTEMPTED=1
  sudo ln -sfn "$RELEASE_DIR" /opt/quant-platform/current
  [[ "$(resolve_current_release)" == "$RELEASE_DIR" ]] || { error 'current release 전환을 검증하지 못했습니다'; return 1; }
  sudo systemd-run --quiet --pipe --wait --collect \
    --unit=quant-platform-db-prepare --property=Type=oneshot \
    --property=User=quant --property=Group=quant \
    --property=EnvironmentFile=/etc/quant-platform/app.env \
    --property=WorkingDirectory=/opt/quant-platform/current \
    /usr/local/bin/node /opt/quant-platform/current/dist/server/cli.js db:prepare
  sudo systemctl start quant-platform
  wait_for_ready
  sudo rm -f -- "$RELEASE_DIR/.deploy-in-progress"
  if ((SNAPSHOT_OWNED)); then sudo rm -f -- "$DB_SNAPSHOT.deploy-in-progress"; fi
  COMMITTED=1
  # 서비스가 검증된 이후 보존 이력 정리 실패만으로 정상 배포를 되돌리지 않는다.
  cleanup_successful_artifacts || echo '경고: 정상 snapshot/release 정리를 완료하지 못했습니다' >&2
  echo "release $release live"
}

if [[ "${BASH_SOURCE[0]}" != "$0" ]]; then return 0; fi
if [[ "${1:-}" == --remote ]]; then
  shift
  remote_deploy "$@"
else
  [[ $# == 0 ]] || { echo '사용법: ./scripts/deploy.sh' >&2; exit 64; }
  local_deploy
fi
