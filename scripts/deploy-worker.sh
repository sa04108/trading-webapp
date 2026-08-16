#!/usr/bin/env bash
# 공통 release archive를 Docker image로 포장해 원격 Worker 한 대에 배포한다.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=scripts/lib/remote-host.sh
source "${REPO_ROOT}/scripts/lib/remote-host.sh"
# shellcheck source=scripts/build-release.sh
source "${REPO_ROOT}/scripts/build-release.sh"
# shellcheck source=scripts/build-worker-image.sh
source "${REPO_ROOT}/scripts/build-worker-image.sh"

TARGET="${QP_WORKER_HOST:-}"
if [ -z "${TARGET}" ]; then read -rp "Worker 주소 [user@]host: " TARGET || true; fi
[ -n "${TARGET}" ] || { echo "QP_WORKER_HOST가 필요합니다" >&2; exit 1; }
case "${QP_FORCE_WORKER_DEPLOY:-0}" in 0|1) FORCE="${QP_FORCE_WORKER_DEPLOY:-0}" ;; *) echo "QP_FORCE_WORKER_DEPLOY는 0 또는 1이어야 합니다" >&2; exit 1 ;; esac
WORKER_MANIFEST="${REPO_ROOT}/infra/worker-host-manifest.json"
[ -f "${WORKER_MANIFEST}" ] || { echo "Worker 관리 manifest가 없습니다: ${WORKER_MANIFEST}" >&2; exit 1; }
WORKER_MANIFEST_SHA="$(sha256sum "${WORKER_MANIFEST}" | awk '{ print $1 }')"

remote_host_configure "${TARGET}"
remote_host_preflight
ssh "${REMOTE_SSH_OPTS[@]}" "${REMOTE_TARGET}" sh -s -- "${WORKER_MANIFEST_SHA}" <<'EOF'
set -eu
EXPECTED_MANIFEST_SHA="$1"
sudo docker version >/dev/null
sudo docker compose version >/dev/null
sudo test -f /etc/quant-platform/worker.env
sudo test -f /opt/quant-backtest-worker/compose.yaml
sudo test -f /opt/quant-backtest-worker/managed-paths.json || {
  echo 'Worker 관리 manifest가 없습니다. bootstrap-worker.sh를 다시 실행하세요.' >&2
  exit 1
}
ACTUAL_MANIFEST_SHA="$(sudo sha256sum /opt/quant-backtest-worker/managed-paths.json | awk '{ print $1 }')"
[ "${ACTUAL_MANIFEST_SHA}" = "${EXPECTED_MANIFEST_SHA}" ] || {
  echo 'Worker 관리 manifest가 현재 저장소와 다릅니다. bootstrap-worker.sh를 다시 실행하세요.' >&2
  exit 1
}
EOF

ARTIFACT_DIR=""
cleanup() {
  if [ -n "${REMOTE_DIR:-}" ]; then
    ssh "${REMOTE_SSH_OPTS[@]}" "${REMOTE_TARGET}" rm -rf -- "${REMOTE_DIR}" >/dev/null 2>&1 || true
  fi
  [ -z "${ARTIFACT_DIR}" ] || rm -rf "${ARTIFACT_DIR}"
}
trap cleanup EXIT

if [ -n "${QP_RELEASE_ARCHIVE:-}" ] || [ -n "${QP_RELEASE_CHECKSUM:-}" ]; then
  [ -n "${QP_RELEASE_ARCHIVE:-}" ] && [ -n "${QP_RELEASE_CHECKSUM:-}" ] || {
    echo "QP_RELEASE_ARCHIVE와 QP_RELEASE_CHECKSUM은 함께 지정해야 합니다" >&2
    exit 1
  }
  RELEASE_ARCHIVE="$(cd "$(dirname "${QP_RELEASE_ARCHIVE}")" && pwd)/$(basename "${QP_RELEASE_ARCHIVE}")"
  RELEASE_CHECKSUM="$(cd "$(dirname "${QP_RELEASE_CHECKSUM}")" && pwd)/$(basename "${QP_RELEASE_CHECKSUM}")"
  verify_release_checksum "${RELEASE_ARCHIVE}" "${RELEASE_CHECKSUM}"
  read_release_metadata "${RELEASE_ARCHIVE}"
  archive_name="$(basename "${RELEASE_ARCHIVE}")"
  case "${archive_name}" in
    quant-platform-*.tar.gz) RELEASE_NAME="${archive_name#quant-platform-}"; RELEASE_NAME="${RELEASE_NAME%.tar.gz}" ;;
    *) echo "release archive 이름은 quant-platform-<release>.tar.gz 형식이어야 합니다" >&2; exit 1 ;;
  esac
else
  # 빌드 전에 같은 Git SHA가 이미 정상 실행 중인지 확인할 수 있도록 SHA를 먼저 읽는다.
  RELEASE_GIT_SHA="$(git -C "${REPO_ROOT}" rev-parse HEAD)"
  RELEASE_NAME=""
fi

case "${RELEASE_GIT_SHA}" in ''|*[!a-f0-9]*) echo "배포 Git SHA가 올바르지 않습니다" >&2; exit 1 ;; esac
CURRENT_SHA="$(ssh "${REMOTE_SSH_OPTS[@]}" "${REMOTE_TARGET}" \
  "sudo docker inspect --format='{{ index .Config.Labels \"org.opencontainers.image.revision\" }}' quant-backtest-worker 2>/dev/null || true")"
if [ "${FORCE}" = 0 ] && [ "${CURRENT_SHA}" = "${RELEASE_GIT_SHA}" ]; then
  echo "==> 동일 Git SHA 호환성 확인"
  if ssh "${REMOTE_SSH_OPTS[@]}" "${REMOTE_TARGET}" \
    sudo docker exec quant-backtest-worker node /app/dist/workers/remote-backtest-supervisor.js --check; then
    echo "Worker가 이미 ${RELEASE_GIT_SHA} release로 정상 실행 중입니다 — no-op"
    exit 0
  fi
  echo "동일 SHA Worker의 probe가 실패했습니다. 환경 파일과 서버 모드를 먼저 확인하세요." >&2
  exit 1
fi

if [ -z "${RELEASE_NAME}" ]; then
  ARTIFACT_DIR="$(mktemp -d)"
  build_release "${ARTIFACT_DIR}"
else
  ARTIFACT_DIR="$(mktemp -d)"
fi

build_worker_image \
  "${RELEASE_ARCHIVE}" "${RELEASE_CHECKSUM}" "${RELEASE_NAME}" "${ARTIFACT_DIR}"
verify_release_checksum "${WORKER_IMAGE_ARCHIVE}" "${WORKER_IMAGE_CHECKSUM}"

remote_dir_candidate="$(ssh "${REMOTE_SSH_OPTS[@]}" "${REMOTE_TARGET}" mktemp -d /tmp/quant-worker-deploy.XXXXXX)"
[[ "${remote_dir_candidate}" =~ ^/tmp/quant-worker-deploy\.[a-zA-Z0-9]+$ ]] || {
  echo "원격 임시 경로가 올바르지 않습니다" >&2
  exit 1
}
REMOTE_DIR="${remote_dir_candidate}"
echo "==> Worker image 업로드"
scp "${REMOTE_SSH_OPTS[@]}" \
  "${WORKER_IMAGE_ARCHIVE}" "${WORKER_IMAGE_CHECKSUM}" \
  "${REPO_ROOT}/infra/docker/compose.worker.yaml" \
  "${REMOTE_TARGET}:${REMOTE_DIR}/"

remote_image="${REMOTE_DIR}/$(basename "${WORKER_IMAGE_ARCHIVE}")"
remote_checksum="${REMOTE_DIR}/$(basename "${WORKER_IMAGE_CHECKSUM}")"
remote_compose="${REMOTE_DIR}/compose.worker.yaml"

echo "==> image 전환·호환성 probe"
ssh "${REMOTE_SSH_OPTS[@]}" "${REMOTE_TARGET}" sudo bash -s -- \
  "${remote_image}" "${remote_checksum}" "${remote_compose}" \
  "${WORKER_IMAGE_REF}" "${RELEASE_GIT_SHA}" <<'EOF'
set -euo pipefail
IMAGE_ARCHIVE="$1"
CHECKSUM_FILE="$2"
NEW_COMPOSE="$3"
NEW_IMAGE="$4"
EXPECTED_SHA="$5"
PROJECT_DIR=/opt/quant-backtest-worker
COMPOSE_FILE="${PROJECT_DIR}/compose.yaml"
COMPOSE_ENV="${PROJECT_DIR}/compose.env"
PREVIOUS_DIR="$(mktemp -d /tmp/quant-worker-rollback.XXXXXX)"
trap 'rm -rf "${PREVIOUS_DIR}"' EXIT

expected="$(awk 'NR == 1 { print $1 }' "${CHECKSUM_FILE}")"
[[ "${expected}" =~ ^[a-f0-9]{64}$ ]] || { echo 'Worker image checksum 형식 오류' >&2; exit 1; }
actual="$(sha256sum "${IMAGE_ARCHIVE}" | awk '{ print $1 }')"
[ "${actual}" = "${expected}" ] || { echo 'Worker image checksum 불일치' >&2; exit 1; }

PREVIOUS_IMAGE="$(docker inspect --format='{{.Config.Image}}' quant-backtest-worker 2>/dev/null || true)"
[ ! -f "${COMPOSE_FILE}" ] || cp -p "${COMPOSE_FILE}" "${PREVIOUS_DIR}/compose.yaml"
[ ! -f "${COMPOSE_ENV}" ] || cp -p "${COMPOSE_ENV}" "${PREVIOUS_DIR}/compose.env"

docker image load --input "${IMAGE_ARCHIVE}"
ACTUAL_SHA="$(docker image inspect --format='{{ index .Config.Labels "org.opencontainers.image.revision" }}' "${NEW_IMAGE}")"
[ "${ACTUAL_SHA}" = "${EXPECTED_SHA}" ] || {
  echo "Worker image label SHA 불일치: ${ACTUAL_SHA}" >&2
  docker image rm "${NEW_IMAGE}" >/dev/null 2>&1 || true
  exit 1
}
install -m 0644 -o root -g root "${NEW_COMPOSE}" "${COMPOSE_FILE}"

umask 077
env_tmp="$(mktemp "${PROJECT_DIR}/compose.env.XXXXXX")"
printf 'QP_WORKER_IMAGE=%s\n' "${NEW_IMAGE}" > "${env_tmp}"
chown root:root "${env_tmp}"
chmod 0600 "${env_tmp}"
mv "${env_tmp}" "${COMPOSE_ENV}"

compose() {
  docker compose --project-directory "${PROJECT_DIR}" --env-file "${COMPOSE_ENV}" \
    --file "${COMPOSE_FILE}" "$@"
}
rollback() {
  echo '새 Worker가 준비되지 않아 이전 image로 롤백합니다' >&2
  compose logs --no-color --tail 100 worker >&2 || true
  if [ -n "${PREVIOUS_IMAGE}" ] && [ -f "${PREVIOUS_DIR}/compose.yaml" ] \
    && [ -f "${PREVIOUS_DIR}/compose.env" ]; then
    cp -p "${PREVIOUS_DIR}/compose.yaml" "${COMPOSE_FILE}"
    cp -p "${PREVIOUS_DIR}/compose.env" "${COMPOSE_ENV}"
    compose up -d --no-build --force-recreate worker
    for attempt in 1 2 3 4 5; do
      if compose exec -T worker node /app/dist/workers/remote-backtest-supervisor.js --check; then
        echo "이전 Worker image로 복구했습니다: ${PREVIOUS_IMAGE}" >&2
        return 0
      fi
      sleep 3
    done
    echo '이전 Worker image도 호환성 probe에 실패했습니다' >&2
  else
    compose down --remove-orphans || true
    echo '롤백할 이전 Worker image가 없습니다' >&2
  fi
  [ "${NEW_IMAGE}" = "${PREVIOUS_IMAGE}" ] \
    || docker image rm "${NEW_IMAGE}" >/dev/null 2>&1 || true
  return 1
}

if ! compose config --quiet; then
  rollback || true
  exit 1
fi
if ! compose up -d --no-build --force-recreate worker; then
  rollback || true
  exit 1
fi
READY=0
for attempt in 1 2 3 4 5; do
  if compose exec -T worker node /app/dist/workers/remote-backtest-supervisor.js --check; then
    READY=1
    break
  fi
  sleep 3
done
if [ "${READY}" -ne 1 ]; then
  rollback || true
  exit 1
fi

# 이 저장소의 release tag만 최근 3개 보존한다. 다른 image와 build cache는 건드리지 않는다.
old_tags="$(docker image ls quant-platform-backtest-worker --format '{{.Tag}}' \
  | grep -E '^[0-9]{8}-[0-9]{6}-[a-f0-9]+$' | sort -r | tail -n +4 || true)"
printf '%s\n' "${old_tags}" | while IFS= read -r old; do
      [ -z "${old}" ] || docker image rm "quant-platform-backtest-worker:${old}" >/dev/null 2>&1 || true
    done
echo "Worker release ${NEW_IMAGE} live"
EOF

echo "==> 완료"
