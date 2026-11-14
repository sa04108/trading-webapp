#!/usr/bin/env bash
# Docker 기본 운영 경로. 설정은 셸로 실행하지 않으며 DB 백업·복원을 자동 수행하지 않는다.
set -euo pipefail
ROOT="${QUANT_SERVER_HOME:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
cd "$ROOT"
command="${1:-help}"
if (($#)); then shift; fi

compose() {
  docker compose --project-directory "$ROOT" --env-file "$ROOT/server.env" -f "$ROOT/compose.yaml" "$@"
}
active_compose() {
  if [[ -s .server-image ]]; then
    SERVER_IMAGE="$(cat .server-image)" compose "$@"
  else
    compose "$@"
  fi
}
lock_operation() {
  exec 9>.server-update.lock
  flock -n 9 || { echo '다른 서버 운영 명령이 진행 중입니다.' >&2; exit 1; }
}
require_config() {
  [[ -f server.env && -f app.env ]] || { echo '먼저 scripts/server.sh init을 실행하세요.' >&2; exit 1; }
  compose config --quiet
}
require_complete_update() {
  [[ ! -e .server-update-pending ]] || {
    echo '미완료 업데이트가 있습니다. 같은 후보로 update를 재실행하거나 DB·이미지 호환성을 수동 복구하세요.' >&2
    exit 1
  }
}
update() {
  lock_operation
  local requested="${1:-$(compose config --images server)}" candidate previous=''
  [[ "$requested" =~ ^[a-z0-9][a-zA-Z0-9./:@_-]+$ ]] || { echo '이미지 주소가 올바르지 않습니다.' >&2; return 1; }
  # 다운로드 실패는 기존 서비스를 중지시키지 않는다.
  docker pull "$requested"
  candidate="$(docker image inspect --format '{{index .RepoDigests 0}}' "$requested")"
  [[ "$candidate" =~ @sha256:[a-f0-9]{64}$ ]] || { echo '이미지 digest를 확인할 수 없습니다.' >&2; return 1; }
  if [[ -e .server-update-pending && "$(cat .server-update-pending)" != "$candidate" ]]; then
    echo '미완료 업데이트와 다른 이미지입니다. DB 호환성을 수동 복구하기 전에는 전환할 수 없습니다.' >&2
    return 1
  fi
  if [[ -s .server-image ]]; then previous="$(cat .server-image)"; fi
  active_compose stop
  # DB 변경 전 기록한다. 실패·전원 차단 뒤 이전 이미지를 자동 기동하지 못하게 한다.
  printf '%s\n' "$candidate" > .server-update-pending.tmp
  mv .server-update-pending.tmp .server-update-pending
  if ! SERVER_IMAGE="$candidate" compose run --rm --no-deps -T server node dist/server/cli.js db:prepare; then
    echo 'DB 준비에 실패했습니다. 서버는 중지 상태이며 자동 복원하지 않습니다.' >&2
    return 1
  fi
  if ! SERVER_IMAGE="$candidate" compose up -d --pull never --wait --wait-timeout 180; then
    SERVER_IMAGE="$candidate" compose stop || true
    echo '새 서버를 확인하지 못해 중지했습니다. 로그와 DB 호환성을 확인한 뒤 다시 업데이트하세요.' >&2
    return 1
  fi
  if [[ -n "$previous" && "$previous" != "$candidate" ]]; then
    printf '%s\n' "$previous" > .server-image.previous
  fi
  printf '%s\n' "$candidate" > .server-image.tmp
  mv .server-image.tmp .server-image
  rm .server-update-pending
  printf '실행 이미지: %s\n' "$candidate"
}

case "$command" in
  init)
    umask 077
    if [[ ! -e server.env ]]; then
      (set -o noclobber; cat server.env.example > server.env)
    fi
    if [[ ! -e app.env ]]; then
      secret="$(od -An -N48 -tx1 /dev/urandom | tr -d ' \n')"
      (set -o noclobber; { cat infra/server/app.env.example; printf '\nSESSION_SECRET=%s\n' "$secret"; } > app.env)
    fi
    echo 'server.env의 도메인과 app.env의 필요한 API 키를 설정하세요. 기존 설정은 유지했습니다.'
    ;;
  up|start)
    require_config
    if [[ -s .server-image ]]; then
      lock_operation
      require_complete_update
      active_compose up -d --wait --wait-timeout 180
    else
      update
    fi
    ;;
  update)
    require_config
    update "$@"
    ;;
  stop)
    require_config
    lock_operation
    active_compose stop
    ;;
  status)
    require_config
    active_compose ps
    ;;
  logs)
    require_config
    active_compose logs --tail 200 -f "$@"
    ;;
  cli)
    require_config
    lock_operation
    require_complete_update
    if [[ -n "$(active_compose ps --status running --services server)" ]]; then
      echo 'CLI 실행 전 scripts/server.sh stop으로 서버를 중지하세요.' >&2
      exit 1
    fi
    active_compose run --rm --no-deps server node dist/server/cli.js "$@"
    ;;
  help|--help|-h)
    echo '사용법: scripts/server.sh init | up | update [이미지] | stop | status | logs [서비스] | cli <명령>'
    echo 'systemd 배포: pnpm deploy:systemd (기존 deploy.env 사용)'
    ;;
  *) echo "알 수 없는 명령: $command" >&2; exit 64 ;;
esac
