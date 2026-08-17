#!/bin/sh
# Docker 전용 원격 백테스트 Worker 호스트를 멱등하게 준비한다.
set -eu

SELF_DIR="$(cd "$(dirname "$0")" && pwd)"
ENV_SOURCE="${1:-}"
REPLACE_ENV="${2:-0}"
MANIFEST_SOURCE="${SELF_DIR}/worker-host-manifest.json"

[ "$(id -u)" -eq 0 ] || { echo "root로 실행해야 합니다" >&2; exit 1; }
[ -f "${ENV_SOURCE}" ] || { echo "업로드된 worker env 파일이 없습니다" >&2; exit 1; }
[ -f "${MANIFEST_SOURCE}" ] || { echo "Worker 관리 manifest가 없습니다" >&2; exit 1; }
[ "${REPLACE_ENV}" = 0 ] || [ "${REPLACE_ENV}" = 1 ] || {
  echo "replace-env 값은 0 또는 1이어야 합니다" >&2
  exit 1
}

[ -r /etc/os-release ] || { echo "지원 OS를 확인할 수 없습니다" >&2; exit 1; }
. /etc/os-release
case "${ID}" in ubuntu|debian) : ;; *) echo "Ubuntu/Debian만 지원합니다: ${ID}" >&2; exit 1 ;; esac
[ "$(dpkg --print-architecture)" = amd64 ] || {
  echo "v1 Worker image는 amd64 호스트만 지원합니다" >&2
  exit 1
}

export DEBIAN_FRONTEND=noninteractive
APT="apt-get -o DPkg::Lock::Timeout=600 -y"
echo "==> Docker Engine·Compose 설치"
$APT update
$APT install ca-certificates curl gnupg
install -m 0755 -d /etc/apt/keyrings
tmp_key="$(mktemp /tmp/quant-worker-docker-key.XXXXXX)"
curl -fsSL "https://download.docker.com/linux/${ID}/gpg" -o "${tmp_key}"
if [ ! -f /etc/apt/keyrings/docker.asc ] || ! cmp -s "${tmp_key}" /etc/apt/keyrings/docker.asc; then
  install -m 0644 -o root -g root "${tmp_key}" /etc/apt/keyrings/docker.asc
fi
rm -f "${tmp_key}"
docker_source_tmp="$(mktemp /tmp/quant-worker-docker-source.XXXXXX)"
printf 'Types: deb\nURIs: https://download.docker.com/linux/%s\nSuites: %s\nComponents: stable\nArchitectures: amd64\nSigned-By: /etc/apt/keyrings/docker.asc\n' \
  "${ID}" "${VERSION_CODENAME}" > "${docker_source_tmp}"
if [ ! -f /etc/apt/sources.list.d/docker.sources ] \
  || ! cmp -s "${docker_source_tmp}" /etc/apt/sources.list.d/docker.sources; then
  install -m 0644 -o root -g root "${docker_source_tmp}" /etc/apt/sources.list.d/docker.sources
fi
rm -f "${docker_source_tmp}"
$APT update
$APT install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
systemctl enable --now docker
docker version >/dev/null
docker compose version >/dev/null

echo "==> Worker 전용 경로·Compose 설정"
install -d -m 0755 -o root -g root /opt/quant-backtest-worker /etc/quant-platform
install -d -m 0700 -o 10001 -g 10001 /var/lib/quant-backtest-worker

install_worker_env() {
  env_tmp="$(mktemp /etc/quant-platform/worker.env.XXXXXX)"
  if ! install -m 0600 -o root -g root "${ENV_SOURCE}" "${env_tmp}"; then
    rm -f "${env_tmp}"
    return 1
  fi
  if ! mv "${env_tmp}" /etc/quant-platform/worker.env; then
    rm -f "${env_tmp}"
    return 1
  fi
}

backup_worker_env() {
  backup_tmp="$(mktemp /etc/quant-platform/worker.env.bak.XXXXXX)"
  if ! install -m 0600 -o root -g root /etc/quant-platform/worker.env "${backup_tmp}"; then
    rm -f "${backup_tmp}"
    return 1
  fi
  if ! mv "${backup_tmp}" /etc/quant-platform/worker.env.bak; then
    rm -f "${backup_tmp}"
    return 1
  fi
}

install_worker_manifest() {
  manifest_tmp="$(mktemp /opt/quant-backtest-worker/managed-paths.json.XXXXXX)"
  if ! install -m 0644 -o root -g root "${MANIFEST_SOURCE}" "${manifest_tmp}"; then
    rm -f "${manifest_tmp}"
    return 1
  fi
  if ! mv "${manifest_tmp}" /opt/quant-backtest-worker/managed-paths.json; then
    rm -f "${manifest_tmp}"
    return 1
  fi
}

if [ -f /etc/quant-platform/worker.env ]; then
  if cmp -s "${ENV_SOURCE}" /etc/quant-platform/worker.env; then
    chown root:root /etc/quant-platform/worker.env
    chmod 0600 /etc/quant-platform/worker.env
    echo "worker.env 변경 없음"
  elif [ "${REPLACE_ENV}" = 1 ]; then
    backup_worker_env
    find /etc/quant-platform -maxdepth 1 -type f -name 'worker.env.*.bak' -delete
    install_worker_env
    echo "기존 worker.env 백업: /etc/quant-platform/worker.env.bak"
  else
    echo "기존 /etc/quant-platform/worker.env가 달라 보존했습니다." >&2
    echo "교체하려면 QP_REPLACE_WORKER_ENV=1로 bootstrap을 다시 실행하세요." >&2
    exit 1
  fi
else
  install_worker_env
fi
install -m 0644 -o root -g root "${SELF_DIR}/compose.worker.yaml" \
  /opt/quant-backtest-worker/compose.yaml
install_worker_manifest

# 첫 image를 배포하기 전에는 Compose를 시작하지 않는다.
echo "Worker 호스트 준비 완료 — 첫 deploy-worker.sh 실행을 기다립니다"
