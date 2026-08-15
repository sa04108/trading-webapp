#!/bin/sh
set -eu

# --check는 실행 중 컨테이너의 `docker compose exec`로 호출하므로 여기에는 오지 않는다.
# 실제 supervisor만 work-root를 독점한다. 열린 fd의 flock은 SIGKILL에도 커널이 회수한다.
LOCK_PATH="${BACKTEST_WORK_ROOT}/.supervisor.lock"
exec 9>"${LOCK_PATH}"
if ! flock -n 9; then
  echo "BACKTEST_WORK_ROOT가 다른 supervisor에서 사용 중입니다: ${BACKTEST_WORK_ROOT}" >&2
  exit 1
fi

# 셸을 남기지 않아 Docker의 SIGTERM이 Node supervisor로 직접 전달된다.
exec "$@"
