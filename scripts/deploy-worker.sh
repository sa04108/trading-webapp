#!/usr/bin/env bash
# deploy.mjs가 worker 노드에서 실행하는 단계형 Docker image transaction.
set -euo pipefail

PROJECT_DIR=/opt/quant-backtest-worker
COMPOSE_FILE="${PROJECT_DIR}/compose.yaml"
COMPOSE_ENV="${PROJECT_DIR}/compose.env"
MANIFEST_FILE="${PROJECT_DIR}/managed-paths.json"
TRANSACTION_ROOT="${PROJECT_DIR}/deploy-transactions"
CONFIG_TMP=""
UPLOAD_INPUTS_VALIDATED=0

cleanup_local_state() {
  if [ -n "${CONFIG_TMP}" ]; then rm -f -- "${CONFIG_TMP}" || true; fi
  if [ "${UPLOAD_INPUTS_VALIDATED}" -eq 1 ]; then
    rm -f -- "${IMAGE_ARCHIVE:-}" "${CHECKSUM_FILE:-}" "${NEW_COMPOSE:-}" || true
  fi
}
trap cleanup_local_state EXIT

validate_release_name() {
  local release="$1"
  case "${release}" in
    ''|.|..|*/*|*[!a-zA-Z0-9._-]*)
      echo "Worker release 이름이 올바르지 않습니다: ${release}" >&2
      return 1
      ;;
  esac
}

transaction_directory() {
  local release="$1"
  validate_release_name "${release}" || return 1
  printf '%s/%s\n' "${TRANSACTION_ROOT}" "${release}"
}

acquire_deploy_lock() {
  command -v flock >/dev/null 2>&1 || {
    echo 'flock 명령이 없어 Worker 배포 잠금을 잡을 수 없습니다' >&2
    return 1
  }
  exec {DEPLOY_LOCK_FD}>/run/lock/quant-platform-worker-deploy.lock
  if ! flock -n "${DEPLOY_LOCK_FD}"; then
    echo '다른 Worker 배포가 진행 중입니다 — 완료 후 다시 시도하세요' >&2
    return 75
  fi
}

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

read_previous_image() {
  local transaction_dir="$1"
  [ -f "${transaction_dir}/previous-image" ] || {
    echo "Worker rollback 상태가 없습니다: ${transaction_dir}/previous-image" >&2
    return 1
  }
  cat "${transaction_dir}/previous-image"
}

restore_previous_config() {
  local transaction_dir="$1"
  [ -f "${transaction_dir}/compose.yaml" ] || return 1
  cp -p "${transaction_dir}/compose.yaml" "${COMPOSE_FILE}" || return 1
  if [ -f "${transaction_dir}/compose.env" ]; then
    cp -p "${transaction_dir}/compose.env" "${COMPOSE_ENV}" || return 1
  else
    rm -f -- "${COMPOSE_ENV}" || return 1
  fi
}

remove_candidate_image() {
  local candidate_image="$1"
  local previous_image="$2"
  if [ "${candidate_image}" != "${previous_image}" ]; then
    docker image rm "${candidate_image}" >/dev/null 2>&1
  fi
}

rollback_transaction() {
  local release="$1"
  local transaction_dir
  local previous_image
  local candidate_image="quant-platform-backtest-worker:${release}"
  local live_image
  transaction_dir="$(transaction_directory "${release}")" || return 1
  if [ ! -d "${transaction_dir}" ]; then
    live_image="$(docker inspect --format='{{.Config.Image}}' quant-backtest-worker 2>/dev/null || true)"
    if [ "${live_image}" = "${candidate_image}" ]; then
      echo "현재 Worker가 신규 image지만 rollback 상태가 없습니다: ${candidate_image}" >&2
      return 1
    fi
    echo "Worker rollback 대상이 없습니다: ${release}" >&2
    return 0
  fi
  previous_image="$(read_previous_image "${transaction_dir}")" || return 1

  echo '통합 배포 실패로 Worker를 이전 상태로 롤백합니다' >&2
  compose logs --no-color --tail 100 worker >&2 || true
  if [ -n "${previous_image}" ]; then
    if restore_previous_config "${transaction_dir}" &&
      compose up -d --no-build --force-recreate worker && probe_worker; then
      remove_candidate_image "${candidate_image}" "${previous_image}" || \
        echo '경고: 롤백은 성공했지만 실패한 Worker image를 제거하지 못했습니다' >&2
      rm -rf -- "${transaction_dir}"
      echo "이전 Worker image로 복구했습니다: ${previous_image}" >&2
      return 0
    fi
    echo '이전 Worker image도 호환성 probe에 실패했습니다' >&2
  else
    if { [ ! -f "${COMPOSE_ENV}" ] || compose down --remove-orphans; } &&
      restore_previous_config "${transaction_dir}"; then
      remove_candidate_image "${candidate_image}" "" || \
        echo '경고: 실패한 Worker image를 제거하지 못했습니다' >&2
      rm -rf -- "${transaction_dir}"
      echo 'Worker를 배포 전 미기동 상태로 복구했습니다' >&2
      return 0
    fi
    echo 'Worker 미기동 상태로 복구하지 못했습니다' >&2
  fi
  echo 'Worker 롤백 검증에 실패해 이전 image와 신규 image를 모두 보존합니다' >&2
  return 1
}

verify_prepared_worker() {
  local release="$1"
  local transaction_dir
  local expected_image="quant-platform-backtest-worker:${release}"
  local live_image
  transaction_dir="$(transaction_directory "${release}")" || return 1
  [ -d "${transaction_dir}" ] || {
    echo "Worker 배포 transaction이 없습니다: ${release}" >&2
    return 1
  }
  live_image="$(docker inspect --format='{{.Config.Image}}' quant-backtest-worker 2>/dev/null || true)"
  [ "${live_image}" = "${expected_image}" ] || {
    echo "실행 중 Worker image가 준비된 release와 다릅니다: ${live_image}" >&2
    return 1
  }
  probe_worker
}

write_candidate_config() {
  local new_compose="$1"
  local new_image="$2"
  install -m 0644 -o root -g root "${new_compose}" "${COMPOSE_FILE}" || return 1
  umask 077
  CONFIG_TMP="$(mktemp "${PROJECT_DIR}/compose.env.XXXXXX")" || return 1
  printf 'QP_WORKER_IMAGE=%s\n' "${new_image}" > "${CONFIG_TMP}" || return 1
  chown root:root "${CONFIG_TMP}" || return 1
  chmod 0600 "${CONFIG_TMP}" || return 1
  mv "${CONFIG_TMP}" "${COMPOSE_ENV}" || return 1
  CONFIG_TMP=""
}

prepare_worker() {
  local transaction_dir
  local current_image
  local expected
  local actual
  local actual_sha
  local actual_manifest_sha

  for required_command in flock sha256sum docker; do
    command -v "${required_command}" >/dev/null 2>&1 || {
      echo "필수 명령이 없습니다: ${required_command}" >&2
      return 69
    }
  done
  docker version >/dev/null
  docker compose version >/dev/null
  test -f /etc/quant-platform/worker.env
  test -f "${COMPOSE_FILE}"
  test -f "${MANIFEST_FILE}" || {
    echo 'Worker 관리 manifest가 없습니다. bootstrap-worker.sh를 다시 실행하세요.' >&2
    return 1
  }
  actual_manifest_sha="$(sha256sum "${MANIFEST_FILE}" | awk '{ print $1 }')"
  [ "${actual_manifest_sha}" = "${EXPECTED_MANIFEST_SHA}" ] || {
    echo 'Worker 관리 manifest가 현재 저장소와 다릅니다. bootstrap-worker.sh를 다시 실행하세요.' >&2
    return 1
  }

  acquire_deploy_lock
  mkdir -p "${TRANSACTION_ROOT}"
  if find "${TRANSACTION_ROOT}" -mindepth 1 -maxdepth 1 -type d -print -quit | grep -q .; then
    echo '완료되지 않은 Worker 배포 transaction이 있습니다' >&2
    return 75
  fi
  transaction_dir="$(transaction_directory "${RELEASE}")" || return 1

  expected="$(awk 'NR == 1 { print $1 }' "${CHECKSUM_FILE}")"
  case "${expected}" in ''|*[!a-f0-9]*) echo 'Worker image checksum 형식 오류' >&2; return 1 ;; esac
  [ "${#expected}" -eq 64 ] || { echo 'Worker image checksum 길이 오류' >&2; return 1; }
  actual="$(sha256sum "${IMAGE_ARCHIVE}" | awk '{ print $1 }')"
  [ "${actual}" = "${expected}" ] || { echo 'Worker image checksum 불일치' >&2; return 1; }

  if ! docker image load --input "${IMAGE_ARCHIVE}"; then
    return 1
  fi
  actual_sha="$(docker image inspect --format='{{ index .Config.Labels "org.opencontainers.image.revision" }}' "${NEW_IMAGE}")"
  if [ "${actual_sha}" != "${EXPECTED_SHA}" ]; then
    echo "Worker image label SHA 불일치: ${actual_sha}" >&2
    docker image rm "${NEW_IMAGE}" >/dev/null 2>&1 || true
    return 1
  fi

  current_image="$(docker inspect --format='{{.Config.Image}}' quant-backtest-worker 2>/dev/null || true)"
  if ! mkdir "${transaction_dir}" ||
    ! printf '%s\n' "${current_image}" > "${transaction_dir}/previous-image" ||
    ! cp -p "${COMPOSE_FILE}" "${transaction_dir}/compose.yaml" ||
    { [ -f "${COMPOSE_ENV}" ] && ! cp -p "${COMPOSE_ENV}" "${transaction_dir}/compose.env"; }; then
    rm -rf -- "${transaction_dir}"
    remove_candidate_image "${NEW_IMAGE}" "${current_image}" || true
    return 1
  fi
  if ! write_candidate_config "${NEW_COMPOSE}" "${NEW_IMAGE}" ||
    ! compose config --quiet ||
    ! compose up -d --no-build --force-recreate worker ||
    ! probe_worker; then
    rollback_transaction "${RELEASE}" || true
    return 1
  fi

  echo "worker release ${NEW_IMAGE} prepared"
}

if [[ "${BASH_SOURCE[0]}" != "$0" ]]; then
  return 0
fi

PHASE="${1:-}"
case "${PHASE}" in
  prepare)
    [ "$#" -eq 7 ] || {
      echo '사용법: deploy-worker.sh prepare <image-archive> <checksum-file> <compose-file> <image-ref> <git-sha> <manifest-sha>' >&2
      exit 64
    }
    IMAGE_ARCHIVE="$2"
    CHECKSUM_FILE="$3"
    NEW_COMPOSE="$4"
    NEW_IMAGE="$5"
    EXPECTED_SHA="$6"
    EXPECTED_MANIFEST_SHA="$7"
    case "${NEW_IMAGE}" in
      quant-platform-backtest-worker:*) RELEASE="${NEW_IMAGE#quant-platform-backtest-worker:}" ;;
      *) echo "Worker image ref가 올바르지 않습니다: ${NEW_IMAGE}" >&2; exit 64 ;;
    esac
    validate_release_name "${RELEASE}" || exit 64
    case "${IMAGE_ARCHIVE}" in /tmp/quant-worker-deploy.*/*) ;; *) echo "Worker image 경로가 허용된 위치가 아닙니다: ${IMAGE_ARCHIVE}" >&2; exit 64 ;; esac
    case "${CHECKSUM_FILE}" in /tmp/quant-worker-deploy.*/*) ;; *) echo "Worker checksum 경로가 허용된 위치가 아닙니다: ${CHECKSUM_FILE}" >&2; exit 64 ;; esac
    case "${NEW_COMPOSE}" in /tmp/quant-worker-deploy.*/*) ;; *) echo "Worker compose 경로가 허용된 위치가 아닙니다: ${NEW_COMPOSE}" >&2; exit 64 ;; esac
    case "${EXPECTED_SHA}" in ''|*[!a-f0-9]*) echo 'Worker Git SHA 형식 오류' >&2; exit 64 ;; esac
    [ "${#EXPECTED_SHA}" -eq 40 ] || [ "${#EXPECTED_SHA}" -eq 64 ] || { echo 'Worker Git SHA 길이 오류' >&2; exit 64; }
    case "${EXPECTED_MANIFEST_SHA}" in ''|*[!a-f0-9]*) echo 'Worker manifest checksum 형식 오류' >&2; exit 64 ;; esac
    [ "${#EXPECTED_MANIFEST_SHA}" -eq 64 ] || { echo 'Worker manifest checksum 길이 오류' >&2; exit 64; }
    [ "$(basename "${IMAGE_ARCHIVE}")" = "quant-backtest-worker-${RELEASE}.tar" ] || { echo 'Worker image archive 이름이 release와 일치하지 않습니다' >&2; exit 64; }
    [ "$(basename "${CHECKSUM_FILE}")" = "quant-backtest-worker-${RELEASE}.tar.sha256" ] || { echo 'Worker checksum 이름이 release와 일치하지 않습니다' >&2; exit 64; }
    [ "$(basename "${NEW_COMPOSE}")" = compose.worker.yaml ] || { echo 'Worker compose 파일 이름이 올바르지 않습니다' >&2; exit 64; }
    [ -f "${IMAGE_ARCHIVE}" ] && [ -f "${CHECKSUM_FILE}" ] && [ -f "${NEW_COMPOSE}" ] || { echo 'Worker 배포 입력 파일이 없습니다' >&2; exit 66; }
    UPLOAD_INPUTS_VALIDATED=1
    prepare_worker
    ;;
  verify|commit|rollback|finalize)
    [ "$#" -eq 2 ] || { echo "사용법: deploy-worker.sh ${PHASE} <release-name>" >&2; exit 64; }
    RELEASE="$2"
    validate_release_name "${RELEASE}" || exit 64
    for required_command in flock docker; do
      command -v "${required_command}" >/dev/null 2>&1 || { echo "필수 명령이 없습니다: ${required_command}" >&2; exit 69; }
    done
    acquire_deploy_lock
    case "${PHASE}" in
      verify)
        verify_prepared_worker "${RELEASE}"
        echo "worker release ${RELEASE} verified"
        ;;
      commit)
        verify_prepared_worker "${RELEASE}"
        touch "$(transaction_directory "${RELEASE}")/committed"
        echo "worker release ${RELEASE} committed"
        ;;
      rollback)
        rollback_transaction "${RELEASE}"
        ;;
      finalize)
        transaction_dir="$(transaction_directory "${RELEASE}")"
        [ -f "${transaction_dir}/committed" ] || {
          echo "Worker 배포가 commit되지 않았습니다: ${RELEASE}" >&2
          exit 1
        }
        cleanup_old_images "quant-platform-backtest-worker:${RELEASE}" || \
          echo '경고: 과거 Worker image 정리를 완료하지 못했습니다' >&2
        rm -rf -- "${transaction_dir}"
        echo "worker release ${RELEASE} live"
        ;;
    esac
    ;;
  *)
    echo 'deploy-worker.sh는 deploy.mjs 내부 transaction에서만 호출합니다' >&2
    exit 64
    ;;
esac
