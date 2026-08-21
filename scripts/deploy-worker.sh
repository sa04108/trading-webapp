#!/usr/bin/env bash
# deploy.mjs가 worker 노드에서 실행하는 Docker image transaction.
# 사용법: deploy-worker.sh <image-archive> <checksum-file> <compose-file> <image-ref> <git-sha> <manifest-sha>
set -euo pipefail

if [ "$#" -ne 6 ]; then
  echo '사용법: deploy-worker.sh <image-archive> <checksum-file> <compose-file> <image-ref> <git-sha> <manifest-sha>' >&2
  exit 64
fi

IMAGE_ARCHIVE="$1"
CHECKSUM_FILE="$2"
NEW_COMPOSE="$3"
NEW_IMAGE="$4"
EXPECTED_SHA="$5"
EXPECTED_MANIFEST_SHA="$6"
PROJECT_DIR=/opt/quant-backtest-worker
COMPOSE_FILE="${PROJECT_DIR}/compose.yaml"
COMPOSE_ENV="${PROJECT_DIR}/compose.env"
MANIFEST_FILE="${PROJECT_DIR}/managed-paths.json"
PREVIOUS_DIR="$(mktemp -d /tmp/quant-worker-rollback.XXXXXX)"
CONFIG_TMP=""

UPLOAD_INPUTS_VALIDATED=0
cleanup_local_state() {
  if [ -n "${CONFIG_TMP}" ]; then rm -f -- "${CONFIG_TMP}" || true; fi
  if [ "${UPLOAD_INPUTS_VALIDATED}" -eq 1 ]; then
    rm -f -- "${IMAGE_ARCHIVE}" "${CHECKSUM_FILE}" "${NEW_COMPOSE}" || true
  fi
  rm -rf -- "${PREVIOUS_DIR}"
}
trap cleanup_local_state EXIT

case "${IMAGE_ARCHIVE}" in
  /tmp/quant-worker-deploy.*/*) ;;
  *) echo "Worker image 경로가 허용된 위치가 아닙니다: ${IMAGE_ARCHIVE}" >&2; exit 64 ;;
esac
case "${CHECKSUM_FILE}" in
  /tmp/quant-worker-deploy.*/*) ;;
  *) echo "Worker checksum 경로가 허용된 위치가 아닙니다: ${CHECKSUM_FILE}" >&2; exit 64 ;;
esac
case "${NEW_COMPOSE}" in
  /tmp/quant-worker-deploy.*/*) ;;
  *) echo "Worker compose 경로가 허용된 위치가 아닙니다: ${NEW_COMPOSE}" >&2; exit 64 ;;
esac
case "${NEW_IMAGE}" in
  quant-platform-backtest-worker:*) NEW_IMAGE_TAG="${NEW_IMAGE#quant-platform-backtest-worker:}" ;;
  *) echo "Worker image ref가 올바르지 않습니다: ${NEW_IMAGE}" >&2; exit 64 ;;
esac
case "${NEW_IMAGE_TAG}" in
  ''|*/*|*[!a-zA-Z0-9._-]*)
    echo "Worker image tag가 올바르지 않습니다: ${NEW_IMAGE_TAG}" >&2
    exit 64
    ;;
esac
case "${EXPECTED_SHA}" in ''|*[!a-f0-9]*) echo 'Worker Git SHA 형식 오류' >&2; exit 64 ;; esac
[ "${#EXPECTED_SHA}" -eq 40 ] || [ "${#EXPECTED_SHA}" -eq 64 ] || {
  echo 'Worker Git SHA 길이 오류' >&2
  exit 64
}
case "${EXPECTED_MANIFEST_SHA}" in ''|*[!a-f0-9]*) echo 'Worker manifest checksum 형식 오류' >&2; exit 64 ;; esac
[ "${#EXPECTED_MANIFEST_SHA}" -eq 64 ] || { echo 'Worker manifest checksum 길이 오류' >&2; exit 64; }
[ "$(basename "${IMAGE_ARCHIVE}")" = "quant-backtest-worker-${NEW_IMAGE_TAG}.tar" ] || {
  echo "Worker image archive 이름이 release와 일치하지 않습니다: ${IMAGE_ARCHIVE}" >&2
  exit 64
}
[ "$(basename "${CHECKSUM_FILE}")" = "quant-backtest-worker-${NEW_IMAGE_TAG}.tar.sha256" ] || {
  echo "Worker checksum 이름이 release와 일치하지 않습니다: ${CHECKSUM_FILE}" >&2
  exit 64
}
[ "$(basename "${NEW_COMPOSE}")" = compose.worker.yaml ] || {
  echo "Worker compose 파일 이름이 올바르지 않습니다: ${NEW_COMPOSE}" >&2
  exit 64
}
[ -f "${IMAGE_ARCHIVE}" ] && [ -f "${CHECKSUM_FILE}" ] && [ -f "${NEW_COMPOSE}" ] || {
  echo 'Worker 배포 입력 파일이 없습니다' >&2
  exit 66
}
UPLOAD_INPUTS_VALIDATED=1

for required_command in flock sha256sum docker; do
  command -v "${required_command}" >/dev/null 2>&1 || {
    echo "필수 명령이 없습니다: ${required_command}" >&2
    exit 69
  }
done
docker version >/dev/null
docker compose version >/dev/null
test -f /etc/quant-platform/worker.env
test -f "${COMPOSE_FILE}"
test -f "${MANIFEST_FILE}" || {
  echo 'Worker 관리 manifest가 없습니다. bootstrap-worker.sh를 다시 실행하세요.' >&2
  exit 1
}
ACTUAL_MANIFEST_SHA="$(sha256sum "${MANIFEST_FILE}" | awk '{ print $1 }')"
[ "${ACTUAL_MANIFEST_SHA}" = "${EXPECTED_MANIFEST_SHA}" ] || {
  echo 'Worker 관리 manifest가 현재 저장소와 다릅니다. bootstrap-worker.sh를 다시 실행하세요.' >&2
  exit 1
}

exec {DEPLOY_LOCK_FD}>/run/lock/quant-platform-worker-deploy.lock
if ! flock -n "${DEPLOY_LOCK_FD}"; then
  echo '다른 Worker 배포가 진행 중입니다 — 완료 후 다시 시도하세요' >&2
  exit 75
fi

compose() {
  docker compose --project-directory "${PROJECT_DIR}" --env-file "${COMPOSE_ENV}" \
    --file "${COMPOSE_FILE}" "$@"
}

probe_worker() {
  local attempt
  for attempt in 1 2 3 4 5; do
    if compose exec -T worker node /app/dist/workers/remote-backtest-supervisor.js --check; then
      return 0
    fi
    if [ "${attempt}" -lt 5 ]; then sleep 3; fi
  done
  return 1
}

cleanup_old_images() {
  local keep_image="$1"
  local image_ref
  local cleanup_status=0
  local image_refs
  if ! image_refs="$(docker image ls quant-platform-backtest-worker --format '{{.Repository}}:{{.Tag}}')"; then
    return 1
  fi
  while IFS= read -r image_ref; do
    case "${image_ref}" in
      quant-platform-backtest-worker:[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]-*)
        if [ "${image_ref}" != "${keep_image}" ]; then
          docker image rm "${image_ref}" >/dev/null 2>&1 || cleanup_status=1
        fi
        ;;
    esac
  done <<< "${image_refs}"
  return "${cleanup_status}"
}

CURRENT_IMAGE="$(docker inspect --format='{{.Config.Image}}' quant-backtest-worker 2>/dev/null || true)"
expected="$(awk 'NR == 1 { print $1 }' "${CHECKSUM_FILE}")"
case "${expected}" in ''|*[!a-f0-9]*) echo 'Worker image checksum 형식 오류' >&2; exit 1 ;; esac
[ "${#expected}" -eq 64 ] || { echo 'Worker image checksum 길이 오류' >&2; exit 1; }
actual="$(sha256sum "${IMAGE_ARCHIVE}" | awk '{ print $1 }')"
[ "${actual}" = "${expected}" ] || { echo 'Worker image checksum 불일치' >&2; exit 1; }

[ ! -f "${COMPOSE_FILE}" ] || cp -p "${COMPOSE_FILE}" "${PREVIOUS_DIR}/compose.yaml"
[ ! -f "${COMPOSE_ENV}" ] || cp -p "${COMPOSE_ENV}" "${PREVIOUS_DIR}/compose.env"

docker image load --input "${IMAGE_ARCHIVE}"
ACTUAL_SHA="$(docker image inspect --format='{{ index .Config.Labels "org.opencontainers.image.revision" }}' "${NEW_IMAGE}")"
if [ "${ACTUAL_SHA}" != "${EXPECTED_SHA}" ]; then
  echo "Worker image label SHA 불일치: ${ACTUAL_SHA}" >&2
  docker image rm "${NEW_IMAGE}" >/dev/null 2>&1 || true
  exit 1
fi

restore_previous_config() {
  if [ -f "${PREVIOUS_DIR}/compose.yaml" ] && [ -f "${PREVIOUS_DIR}/compose.env" ]; then
    cp -p "${PREVIOUS_DIR}/compose.yaml" "${COMPOSE_FILE}" && \
      cp -p "${PREVIOUS_DIR}/compose.env" "${COMPOSE_ENV}"
    return
  fi
  return 1
}

remove_failed_candidate() {
  if [ "${NEW_IMAGE}" != "${CURRENT_IMAGE}" ]; then
    docker image rm "${NEW_IMAGE}" >/dev/null 2>&1
  fi
}

write_candidate_config() {
  install -m 0644 -o root -g root "${NEW_COMPOSE}" "${COMPOSE_FILE}" || return 1
  umask 077
  CONFIG_TMP="$(mktemp "${PROJECT_DIR}/compose.env.XXXXXX")" || return 1
  printf 'QP_WORKER_IMAGE=%s\n' "${NEW_IMAGE}" > "${CONFIG_TMP}" || return 1
  chown root:root "${CONFIG_TMP}" || return 1
  chmod 0600 "${CONFIG_TMP}" || return 1
  mv "${CONFIG_TMP}" "${COMPOSE_ENV}" || return 1
  CONFIG_TMP=""
}

rollback() {
  echo '새 Worker가 준비되지 않아 이전 image로 롤백합니다' >&2
  compose logs --no-color --tail 100 worker >&2 || true
  if [ -n "${CURRENT_IMAGE}" ] && restore_previous_config; then
    if compose up -d --no-build --force-recreate worker && probe_worker; then
      remove_failed_candidate || \
        echo '경고: 롤백은 성공했지만 실패한 Worker image를 제거하지 못했습니다' >&2
      echo "이전 Worker image로 복구했습니다: ${CURRENT_IMAGE}" >&2
      return 0
    fi
    echo '이전 Worker image도 호환성 probe에 실패했습니다' >&2
  else
    compose down --remove-orphans || true
    echo '롤백할 이전 Worker image가 없습니다' >&2
  fi
  echo 'Worker 롤백 검증에 실패해 이전 image와 신규 image를 모두 보존합니다' >&2
  return 1
}

if ! write_candidate_config; then
  if restore_previous_config; then
    remove_failed_candidate || \
      echo '경고: 실패한 Worker image를 제거하지 못했습니다' >&2
  else
    echo '이전 Compose 설정을 복원하지 못해 신규 image를 복구 증거로 보존합니다' >&2
  fi
  echo 'Worker Compose 설정을 기록하지 못했습니다' >&2
  exit 1
fi
if ! compose config --quiet; then
  rollback || true
  exit 1
fi
if ! compose up -d --no-build --force-recreate worker; then
  rollback || true
  exit 1
fi
if ! probe_worker; then
  rollback || true
  exit 1
fi

cleanup_old_images "${NEW_IMAGE}" || \
  echo '경고: 과거 Worker image 정리를 완료하지 못했습니다' >&2
echo "worker release ${NEW_IMAGE} live"
