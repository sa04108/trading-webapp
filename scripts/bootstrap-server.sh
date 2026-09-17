#!/usr/bin/env bash
# 운영 서버 부트스트랩의 canonical 진입점.
# 기존 bootstrap-app.sh는 호환성을 위해 남겨 두고, 새 문서/자동화는 이 파일을 사용한다.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ -n "${SERVER_HOST:-}" ]; then
  export APP_HOST="${SERVER_HOST}"
elif [ -n "${APP_HOST:-}" ]; then
  echo "경고: APP_HOST는 deprecated입니다. SERVER_HOST를 사용하세요." >&2
else
  # 기존 구현의 대화형 입력을 그대로 사용한다.
  unset APP_HOST 2>/dev/null || true
fi

exec "${SCRIPT_DIR}/bootstrap-app.sh" "$@"
