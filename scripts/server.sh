#!/usr/bin/env bash
# config.env 한 곳에서 Docker 운영 설정을 읽는다. DB 백업·복원은 자동 수행하지 않는다.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# 배포 구성은 실행한 릴리스에서, 설정·잠금·이미지 기록은 운영 디렉터리에서 읽는다.
RELEASE_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ROOT="${DEPLOY_PATH:-$RELEASE_ROOT}"
cd "$ROOT"
ROOT="$PWD"
source "$SCRIPT_DIR/lib/server-config.sh"
command="${1:-help}"
if (($#)); then shift; fi
RENDER_DIR=''
cleanup() { if [[ -n "$RENDER_DIR" ]]; then rm -rf -- "$RENDER_DIR"; fi; }
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

lock_operation() {
  exec 9>.server-update.lock
  flock -n 9 || { echo '다른 서버 운영 명령이 진행 중입니다.' >&2; exit 1; }
}
prepare_config() {
  read_server_config "$ROOT/config.env"
  umask 077
  [[ ! -L .server-runtime ]] || { echo '.server-runtime은 심볼릭 링크일 수 없습니다.' >&2; return 1; }
  mkdir -p .server-runtime
  chmod 700 .server-runtime
  RENDER_DIR="$(mktemp -d "$ROOT/.server-runtime/run.XXXXXX")"
  render_app_config "$RENDER_DIR/app.env"
  compose config --quiet
}
compose_image() {
  local image="$1"
  shift
  # 외부 셸과 .env가 운영 원본을 덮어쓰지 못하게 모든 Compose 입력을 명시한다.
  # API 키는 인자나 label에 싣지 않고 권한이 제한된 앱 전용 파일로만 전달한다.
  env DOMAIN="${SETTINGS[DOMAIN]}" SERVER_IMAGE="$image" \
    SERVER_CPUS="${SETTINGS[SERVER_CPUS]}" SERVER_MEMORY="${SETTINGS[SERVER_MEMORY]}" \
    TRAEFIK_NETWORK="${SETTINGS[TRAEFIK_NETWORK]}" \
    TRAEFIK_HTTPS_ENTRYPOINT="${SETTINGS[TRAEFIK_HTTPS_ENTRYPOINT]}" \
    TRAEFIK_CERT_RESOLVER="${SETTINGS[TRAEFIK_CERT_RESOLVER]}" \
    TRAEFIK_TRUSTED_IPS="${SETTINGS[TRAEFIK_TRUSTED_IPS]}" \
    APP_ENV_FILE="$RENDER_DIR/app.env" COMPOSE_DISABLE_ENV_FILE=true \
    docker compose --project-directory "$ROOT" --project-name quant-platform --env-file /dev/null -f "$RELEASE_ROOT/compose.yaml" "$@"
}
compose() { compose_image "${SETTINGS[SERVER_IMAGE]}" "$@"; }
active_image() {
  if [[ -s .server-image ]]; then cat .server-image; else printf '%s\n' "${SETTINGS[SERVER_IMAGE]}"; fi
}
validate_app() {
  # 앱 스키마를 그대로 사용하며 컨테이너 안에서도 DB를 열지 않는다.
  compose_image "$1" run --pull never --rm --no-deps --label traefik.enable=false -T server node --input-type=module -e '
    import {loadConfig} from "./dist/server/bootstrap/config.js";
    import {agentContainerImage} from "./dist/server/modules/agents/infrastructure/agent-windows-installer.js";
    try { loadConfig(); agentContainerImage(); console.log("앱 설정 검증 완료 (비밀값 생략)"); }
    catch (error) { console.error(error.message); process.exit(1); }
  '
}
require_complete_update() {
  [[ ! -e .server-update-pending ]] || {
    echo '미완료 업데이트가 있습니다. 같은 후보로 update를 재실행하거나 DB·이미지 호환성을 수동 복구하세요.' >&2
    exit 1
  }
}
server_containers() {
  docker ps "$@" --filter label=com.docker.compose.project=quant-platform \
    --filter label=com.docker.compose.service=server --filter label=com.docker.compose.oneoff=False
}
stop_server() {
  local listing
  local -a ids=()
  listing="$(server_containers --all --format '{{.ID}}')"
  if [[ -n "$listing" ]]; then
    mapfile -t ids <<< "$listing"
    docker stop --timeout 120 "${ids[@]}"
  fi
}
update() {
  local requested="${1:-${SETTINGS[SERVER_IMAGE]}}" candidate pending previous=''
  [[ "$requested" =~ ^[a-z0-9][a-zA-Z0-9./:@_-]+$ ]] || { echo '이미지 주소가 올바르지 않습니다.' >&2; return 1; }
  # 로컬 이미지 ID로 고정하여 별칭 변경과 레지스트리 다운로드를 차단한다.
  candidate="$(docker image inspect --format '{{.Id}}' "$requested")" || { echo '로컬 이미지를 찾을 수 없습니다.' >&2; return 1; }
  [[ "$candidate" =~ ^sha256:[a-f0-9]{64}$ ]] || { echo '로컬 이미지 ID를 확인할 수 없습니다.' >&2; return 1; }
  if [[ -e .server-update-pending ]]; then
    pending="$(docker image inspect --format '{{.Id}}' "$(cat .server-update-pending)")" || {
      echo '미완료 업데이트의 로컬 이미지를 확인할 수 없습니다.' >&2; return 1;
    }
    if [[ "$pending" != "$candidate" ]]; then
      echo '미완료 업데이트와 다른 이미지입니다. DB 호환성을 수동 복구하기 전에는 전환할 수 없습니다.' >&2
      return 1
    fi
  fi
  validate_app "$candidate"
  if [[ -s .server-image ]]; then previous="$(cat .server-image)"; fi
  stop_server
  # DB 변경 전 기록한다. 실패·전원 차단 뒤 이전 이미지를 자동 기동하지 못하게 한다.
  printf '%s\n' "$candidate" > .server-update-pending.tmp
  mv .server-update-pending.tmp .server-update-pending
  if ! compose_image "$candidate" run --pull never --rm --no-deps --label traefik.enable=false -T server node dist/server/cli.js db:prepare; then
    echo 'DB 준비에 실패했습니다. 서버는 중지 상태이며 자동 복원하지 않습니다.' >&2
    return 1
  fi
  if ! compose_image "$candidate" up -d --pull never --wait --wait-timeout 180; then
    stop_server || true
    echo '새 서버를 확인하지 못해 중지했습니다. 로그와 DB 호환성을 확인한 뒤 다시 업데이트하세요.' >&2
    return 1
  fi
  if [[ -n "$previous" && "$previous" != "$candidate" ]]; then printf '%s\n' "$previous" > .server-image.previous; fi
  printf '%s\n' "$candidate" > .server-image.tmp
  mv .server-image.tmp .server-image
  rm .server-update-pending
  printf '실행 이미지: %s\n' "$candidate"
}

case "$command" in
  init)
    lock_operation
    umask 077
    if [[ -e config.env ]]; then
      echo '기존 config.env를 유지했습니다.'
    else
      if [[ -e server.env || -e app.env ]]; then
        echo '기존 server.env/app.env의 값과 SESSION_SECRET을 config.env로 옮기세요. 새 비밀값을 생성하지 않았습니다.' >&2
        exit 1
      fi
      secret="$(od -An -N48 -tx1 /dev/urandom | tr -d ' \n')"
      (set -o noclobber; { cat "$RELEASE_ROOT/config.env.example"; printf '\nSESSION_SECRET=%s\n' "$secret"; } > config.env)
      echo 'config.env를 생성했습니다. 이 파일에서 도메인과 필요한 API 키를 설정하세요.'
    fi
    ;;
  validate)
    prepare_config
    validate_app "$(active_image)"
    echo 'config.env 검증 완료. 실행 중인 서버와 DB는 변경하지 않았습니다.'
    ;;
  up|start)
    lock_operation
    require_complete_update
    prepare_config
    if [[ -s .server-image ]]; then
      validate_app "$(active_image)"
      compose_image "$(active_image)" up -d --pull never --wait --wait-timeout 180
    else
      update
    fi
    ;;
  update)
    lock_operation
    prepare_config
    update "$@"
    ;;
  stop)
    lock_operation
    stop_server
    ;;
  status)
    server_containers --all --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}'
    ;;
  logs)
    [[ $# == 0 || ( $# == 1 && "$1" == server ) ]] || { echo '사용법: scripts/server.sh logs [server]' >&2; exit 64; }
    ids="$(server_containers --all --format '{{.ID}}')"
    [[ -n "$ids" ]] || { echo '서버 컨테이너가 없습니다.' >&2; exit 1; }
    docker logs --tail 200 -f "${ids%%$'\n'*}"
    ;;
  cli)
    lock_operation
    require_complete_update
    if [[ -n "$(server_containers --format '{{.ID}}')" ]]; then
      echo 'CLI 실행 전 scripts/server.sh stop으로 서버를 중지하세요.' >&2; exit 1
    fi
    prepare_config
    compose_image "$(active_image)" run --pull never --rm --no-deps --label traefik.enable=false server node dist/server/cli.js "$@"
    ;;
  help|--help|-h)
    echo '사용법: scripts/server.sh init | validate | up | update [이미지] | stop | status | logs [server] | cli <명령>'
    echo '운영 설정은 config.env 한 곳에서 관리합니다.'
    ;;
  *) echo "알 수 없는 명령: $command" >&2; exit 64 ;;
esac
