#!/usr/bin/env bash
# 공통 release archive를 Linux/amd64 Docker Worker image와 전송용 tar로 포장한다.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=scripts/build-release.sh
source "${REPO_ROOT}/scripts/build-release.sh"

build_worker_image() {
  local archive="$1"
  local checksum_file="$2"
  local release_name="$3"
  local output_dir="$4"
  local context image_ref

  case "${release_name}" in
    ''|*[!a-zA-Z0-9._-]*) echo "Worker release 이름이 올바르지 않습니다: ${release_name}" >&2; return 1 ;;
  esac
  command -v docker >/dev/null 2>&1 || { echo "로컬 Docker CLI가 필요합니다" >&2; return 1; }
  docker info >/dev/null 2>&1 || { echo "로컬 Docker daemon에 연결할 수 없습니다" >&2; return 1; }
  verify_release_checksum "${archive}" "${checksum_file}"
  read_release_metadata "${archive}"

  mkdir -p "${output_dir}"
  output_dir="$(cd "${output_dir}" && pwd)"
  context="$(mktemp -d)"
  if ! tar -xzf "${archive}" -C "${context}" \
    || ! cp "${REPO_ROOT}/infra/docker/worker-entrypoint.sh" "${context}/worker-entrypoint.sh"; then
    rm -rf "${context}"
    return 1
  fi

  image_ref="quant-platform-backtest-worker:${release_name}"
  echo "==> Worker image 생성: ${image_ref}"
  if ! docker buildx build \
      --platform linux/amd64 \
      --load \
      --file "${REPO_ROOT}/infra/docker/backtest-worker.Dockerfile" \
      --build-arg "BUILD_GIT_SHA=${RELEASE_GIT_SHA}" \
      --build-arg "BUILD_CREATED_AT=${RELEASE_BUILT_AT}" \
      --build-arg "BUILD_RELEASE=${release_name}" \
      --tag "${image_ref}" \
      "${context}"; then
    rm -rf "${context}"
    return 1
  fi
  rm -rf "${context}"

  WORKER_IMAGE_REF="${image_ref}"
  WORKER_IMAGE_ARCHIVE="${output_dir}/quant-backtest-worker-${release_name}.tar"
  WORKER_IMAGE_CHECKSUM="${WORKER_IMAGE_ARCHIVE}.sha256"
  if ! docker image save --output "${WORKER_IMAGE_ARCHIVE}" "${image_ref}"; then
    rm -f "${WORKER_IMAGE_ARCHIVE}"
    return 1
  fi
  printf '%s  %s\n' "$(sha256sum "${WORKER_IMAGE_ARCHIVE}" | awk '{ print $1 }')" \
    "$(basename "${WORKER_IMAGE_ARCHIVE}")" > "${WORKER_IMAGE_CHECKSUM}"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  [ "$#" -eq 4 ] || {
    echo "사용법: $0 <release-archive> <checksum> <release-name> <output-dir>" >&2
    exit 1
  }
  build_worker_image "$1" "$2" "$3" "$4"
  printf 'WORKER_IMAGE_REF=%q\nWORKER_IMAGE_ARCHIVE=%q\nWORKER_IMAGE_CHECKSUM=%q\n' \
    "${WORKER_IMAGE_REF}" "${WORKER_IMAGE_ARCHIVE}" "${WORKER_IMAGE_CHECKSUM}"
fi
