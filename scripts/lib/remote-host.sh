#!/usr/bin/env bash
# bootstrap/deploy 스크립트가 공유하는 SSH 입력 검증과 옵션 조립.

remote_host_configure() {
  local raw_target="$1"
  REMOTE_TARGET="${raw_target}"
  [ -n "${REMOTE_TARGET}" ] || { echo "원격 호스트 주소가 필요합니다" >&2; return 1; }
  if [ -n "${SSH_USER:-}" ]; then
    case "${REMOTE_TARGET}" in
      *@*) echo "SSH_USER는 무시합니다 — 주소에 이미 사용자명이 있습니다: ${REMOTE_TARGET}" >&2 ;;
      *) REMOTE_TARGET="${SSH_USER}@${REMOTE_TARGET}" ;;
    esac
  fi
  case "${REMOTE_TARGET}" in
    -*|*[[:space:]]*) echo "원격 호스트 주소 형식이 올바르지 않습니다: ${REMOTE_TARGET}" >&2; return 1 ;;
  esac

  REMOTE_SSH_OPTS=()
  REMOTE_ENV_HINT=""
  if [ -n "${SSH_OPTS:-}" ]; then
    read -ra REMOTE_SSH_OPTS <<< "${SSH_OPTS}"
    REMOTE_ENV_HINT="${REMOTE_ENV_HINT}SSH_OPTS='${SSH_OPTS}' "
  fi
  if [ -n "${SSH_KEY:-}" ]; then
    case "${SSH_KEY}" in '~/'*) SSH_KEY="${HOME}/${SSH_KEY#'~/'}" ;; esac
    [ -f "${SSH_KEY}" ] || { echo "SSH_KEY 파일이 없습니다: ${SSH_KEY}" >&2; return 1; }
    REMOTE_SSH_OPTS+=(-i "${SSH_KEY}" -o IdentitiesOnly=yes)
    REMOTE_ENV_HINT="${REMOTE_ENV_HINT}SSH_KEY=${SSH_KEY} "
  fi
  if [ -n "${SSH_PORT:-}" ]; then
    case "${SSH_PORT}" in *[!0-9]*|'') echo "SSH_PORT는 숫자여야 합니다: ${SSH_PORT}" >&2; return 1 ;; esac
    REMOTE_SSH_OPTS+=(-o "Port=${SSH_PORT}")
    REMOTE_ENV_HINT="${REMOTE_ENV_HINT}SSH_PORT=${SSH_PORT} "
  fi
  if [ -n "${SSH_JUMP:-}" ]; then
    REMOTE_SSH_OPTS+=(-o "ProxyJump=${SSH_JUMP}")
    REMOTE_ENV_HINT="${REMOTE_ENV_HINT}SSH_JUMP=${SSH_JUMP} "
  fi
  case "${SSH_HOST_KEY:=accept-new}" in
    accept-new|yes|no) REMOTE_SSH_OPTS+=(-o "StrictHostKeyChecking=${SSH_HOST_KEY}") ;;
    *) echo "SSH_HOST_KEY는 accept-new | yes | no 중 하나입니다: ${SSH_HOST_KEY}" >&2; return 1 ;;
  esac
  if [ "${SSH_HOST_KEY}" != accept-new ]; then
    REMOTE_ENV_HINT="${REMOTE_ENV_HINT}SSH_HOST_KEY=${SSH_HOST_KEY} "
  fi
}

remote_host_preflight() {
  local error
  echo "==> SSH 접속 확인: ${REMOTE_TARGET}"
  if ! error="$(ssh "${REMOTE_SSH_OPTS[@]}" -o ConnectTimeout=15 -o BatchMode=yes "${REMOTE_TARGET}" true 2>&1)"; then
    echo "SSH 접속 실패: ${REMOTE_TARGET}" >&2
    printf '%s\n' "${error}" | sed 's/^/  /' >&2
    return 1
  fi
  ssh "${REMOTE_SSH_OPTS[@]}" "${REMOTE_TARGET}" sudo -n true >/dev/null || {
    echo "원격 계정에 비대화형 sudo 권한이 필요합니다: ${REMOTE_TARGET}" >&2
    return 1
  }
}
