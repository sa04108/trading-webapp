#!/usr/bin/env bash
# 웹/API 서버와 Docker Worker가 공유하는 검증된 release archive를 한 번 만든다.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

require_clean_worktree() {
  if [ -n "$(git -C "${REPO_ROOT}" status --porcelain --untracked-files=normal)" ]; then
    echo "작업 트리가 깨끗하지 않아 릴리스를 만들 수 없습니다. 변경을 커밋하거나 제거하세요." >&2
    git -C "${REPO_ROOT}" status --short >&2
    return 1
  fi
}

verify_release_checksum() {
  local archive="$1"
  local checksum_file="$2"
  local expected actual
  [ -f "${archive}" ] || { echo "release archive가 없습니다: ${archive}" >&2; return 1; }
  [ -f "${checksum_file}" ] || { echo "checksum 파일이 없습니다: ${checksum_file}" >&2; return 1; }
  expected="$(awk 'NR == 1 { print $1 }' "${checksum_file}")"
  [[ "${expected}" =~ ^[a-f0-9]{64}$ ]] || {
    echo "checksum 파일의 SHA-256 형식이 올바르지 않습니다: ${checksum_file}" >&2
    return 1
  }
  actual="$(sha256sum "${archive}" | awk '{ print $1 }')"
  [ "${actual}" = "${expected}" ] || {
    echo "release archive checksum이 일치하지 않습니다: ${archive}" >&2
    return 1
  }
}

read_release_metadata() {
  local archive="$1"
  local scratch
  scratch="$(mktemp)"
  if ! tar -xOzf "${archive}" dist/build-info.json > "${scratch}"; then
    rm -f "${scratch}"
    echo "release archive에 dist/build-info.json이 없습니다" >&2
    return 1
  fi
  if ! RELEASE_GIT_SHA="$(node -e "const p=JSON.parse(require('node:fs').readFileSync(process.argv[1],'utf8')); process.stdout.write(String(p.gitSha??''))" "${scratch}")" \
    || ! RELEASE_BUILT_AT="$(node -e "const p=JSON.parse(require('node:fs').readFileSync(process.argv[1],'utf8')); process.stdout.write(String(p.builtAt??''))" "${scratch}")"; then
    rm -f "${scratch}"
    echo "release build-info.json을 읽을 수 없습니다" >&2
    return 1
  fi
  rm -f "${scratch}"
  case "${RELEASE_GIT_SHA}" in
    *[!a-f0-9]*|'') echo "build-info.json의 gitSha가 올바르지 않습니다" >&2; return 1 ;;
  esac
  [ "${#RELEASE_GIT_SHA}" -eq 40 ] || [ "${#RELEASE_GIT_SHA}" -eq 64 ] || {
    echo "build-info.json의 gitSha 길이가 올바르지 않습니다" >&2
    return 1
  }
  [[ "${RELEASE_BUILT_AT}" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]] || {
    echo "build-info.json의 builtAt 형식이 올바르지 않습니다" >&2
    return 1
  }
}

build_release() {
  local output_dir="${1:-${REPO_ROOT}}"
  local release
  require_clean_worktree
  mkdir -p "${output_dir}"
  output_dir="$(cd "${output_dir}" && pwd)"
  RELEASE_GIT_SHA="$(git -C "${REPO_ROOT}" rev-parse HEAD)"
  release="$(date -u +%Y%m%d-%H%M%S)-$(git -C "${REPO_ROOT}" rev-parse --short HEAD)"
  RELEASE_NAME="${release}"
  RELEASE_ARCHIVE="${output_dir}/quant-platform-${release}.tar.gz"
  RELEASE_CHECKSUM="${RELEASE_ARCHIVE}.sha256"

  echo "==> 검증 게이트"
  (
    cd "${REPO_ROOT}"
    pnpm install --frozen-lockfile
    pnpm lint
    pnpm typecheck
    pnpm test
    pnpm build
  )
  require_clean_worktree

  RELEASE_BUILT_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  printf '{"gitSha":"%s","builtAt":"%s"}\n' \
    "${RELEASE_GIT_SHA}" "${RELEASE_BUILT_AT}" > "${REPO_ROOT}/dist/build-info.json"

  echo "==> 공통 release archive 생성: ${RELEASE_ARCHIVE}"
  tar -C "${REPO_ROOT}" -czf "${RELEASE_ARCHIVE}" \
    dist migrations package.json pnpm-lock.yaml pnpm-workspace.yaml
  printf '%s  %s\n' "$(sha256sum "${RELEASE_ARCHIVE}" | awk '{ print $1 }')" \
    "$(basename "${RELEASE_ARCHIVE}")" > "${RELEASE_CHECKSUM}"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  output_dir="${1:-${REPO_ROOT}}"
  build_release "${output_dir}"
  printf 'RELEASE_NAME=%q\nRELEASE_GIT_SHA=%q\nRELEASE_ARCHIVE=%q\nRELEASE_CHECKSUM=%q\n' \
    "${RELEASE_NAME}" "${RELEASE_GIT_SHA}" "${RELEASE_ARCHIVE}" "${RELEASE_CHECKSUM}"
fi
