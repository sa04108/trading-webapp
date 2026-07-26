#!/bin/sh
# 서버 프로비저닝 (설계: docs/superpowers/specs/2026-07-26-tailscale-provisioning-design.md).
# scripts/bootstrap.sh 가 업로드·실행한다. 직접 실행 시:
#   기본:   printf '%s\n' "$TS_AUTHKEY" | sudo sh provision.sh
#   하드닝: sudo sh provision.sh --harden   (tailnet 경유 SSH 검증 후에만!)
#
# POSIX sh 로만 쓴다 — bashism 금지. Lightsail launch script 가 dash 로 실행되어
# `set -o pipefail` 에 즉사한 전례가 있다 (2026-07-26). 이 파일은 launch script 가
# 아니지만 같은 규율을 유지한다: pipefail·brace expansion·[[ ]]·배열 금지.
#
# 멱등하다 — 모든 단계가 현재 상태를 확인하고 필요할 때만 변경한다.
set -eu

MODE="${1:-base}"
SELF_DIR="$(cd "$(dirname "$0")" && pwd)"

# 붙여넣기 전에 nodejs.org 의 현재 24.x LTS patch 로 갱신한다. SHA 는 자동 검증.
NODE_VERSION=v24.18.0

[ "$(id -u)" -eq 0 ] || { echo "root 로 실행해야 합니다 (sudo sh $0)" >&2; exit 1; }

# ─────────────────────────────────────────────── --harden (§25 UFW + §26 SSH)
if [ "${MODE}" = "--harden" ]; then
  echo "==> §25 UFW — tailscale0 만 허용"
  # 전제: bootstrap.sh 가 tailnet 경유 SSH 를 실증한 뒤에만 이 모드를 호출한다.
  # 여기서 퍼블릭 22 가 닫힌다 — Lightsail 브라우저 SSH 콘솔도 함께 죽는다.
  ufw default deny incoming
  ufw default allow outgoing
  ufw allow in on tailscale0 to any port 22 proto tcp
  # 443 은 tailscale serve 가 tailscaled 프로세스 안에서 종단하므로 tailscale0
  # 인바운드 패킷으로 나타나지 않는다고 판단해 열지 않는다. 실측에서 serve 접속이
  # 막히면 다음 줄을 추가한다 (설계 §10 실측 확인 항목):
  #   ufw allow in on tailscale0 to any port 443 proto tcp
  ufw --force enable
  ufw status verbose

  echo "==> §26 SSH 하드닝"
  cat > /etc/ssh/sshd_config.d/99-quant-hardening.conf <<'EOF'
PermitRootLogin no
PasswordAuthentication no
KbdInteractiveAuthentication no
PubkeyAuthentication yes
X11Forwarding no
MaxAuthTries 3
LoginGraceTime 30
EOF
  sshd -t
  # Ubuntu 의 유닛명은 sshd 가 아니라 ssh 다
  systemctl restart ssh
  echo "하드닝 완료"
  exit 0
fi

# ─────────────────────────────────────────────── 기본 모드
# auth key 는 stdin 첫 줄로 받는다 — argv 는 ps 와 셸 히스토리에 남는다 (deploy.sh 원칙).
# EOF/빈 줄이면 빈 값 — 이미 조인된 서버의 재실행에서는 키가 필요 없다.
IFS= read -r TS_AUTHKEY || TS_AUTHKEY=""

echo "==> §21 패키지·타임존·유저·디렉터리"
export DEBIAN_FRONTEND=noninteractive
# 첫 부팅 직후에는 unattended-upgrades 가 apt 락을 잡고 있을 수 있다 — 기다린다.
APT="apt-get -o DPkg::Lock::Timeout=600 -y"
$APT update
$APT full-upgrade
$APT install ca-certificates curl git jq openssl unzip xz-utils build-essential \
             python3 pkg-config sqlite3 ufw unattended-upgrades

timedatectl set-timezone UTC

id quant >/dev/null 2>&1 || useradd --system --home /var/lib/quant-platform \
  --create-home --shell /usr/sbin/nologin quant

# brace expansion 은 dash 에 없다 — 경로를 하나씩 적는다
mkdir -p \
  /opt/quant-platform/releases \
  /etc/quant-platform \
  /var/lib/quant-platform/market-data \
  /var/lib/quant-platform/imports \
  /var/lib/quant-platform/exports \
  /var/lib/quant-platform/temp \
  /var/lib/quant-platform/backups
chown -R quant:quant /var/lib/quant-platform
chown -R root:root /opt/quant-platform /etc/quant-platform
chmod 750 /etc/quant-platform

echo "==> §22 Node.js ${NODE_VERSION}"
if [ -x /usr/local/bin/node ] && [ "$(/usr/local/bin/node --version)" = "${NODE_VERSION}" ]; then
  echo "이미 설치됨 — 건너뜀"
else
  cd /tmp
  NODE_FILE="node-${NODE_VERSION}-linux-x64.tar.xz"
  curl -fsSLO "https://nodejs.org/dist/${NODE_VERSION}/${NODE_FILE}"
  curl -fsSLO "https://nodejs.org/dist/${NODE_VERSION}/SHASUMS256.txt"
  # grep 과 sha256sum 을 파이프로 잇지 않는다 — pipefail 없이는 grep 의 빈손을 셸이 못 본다
  grep " ${NODE_FILE}\$" SHASUMS256.txt > node.sha256
  sha256sum -c node.sha256
  mkdir -p "/opt/node-${NODE_VERSION}"
  tar -xJf "${NODE_FILE}" -C "/opt/node-${NODE_VERSION}" --strip-components=1
  rm -f "${NODE_FILE}" SHASUMS256.txt node.sha256
  # 심볼릭 링크 전환 — patch 업그레이드는 /opt/node 만 다시 걸면 끝난다
  ln -sfn "/opt/node-${NODE_VERSION}" /opt/node
  for bin in node npm npx corepack; do
    ln -sfn "/opt/node/bin/${bin}" "/usr/local/bin/${bin}"
  done
  corepack enable
fi
node --version

echo "==> §23 Tailscale"
# Tailscale 공식 설치 절차를 그대로 쓴다. 위 Node 설치와 달리 파이프를 허용하는 이유:
# 검증할 체크섬이 애초에 공개돼 있지 않고(설치 스크립트가 서명 검증을 자체 수행한다),
# curl 이 실패하면 바로 다음 `tailscale status`/`tailscale up` 이 command not found 로
# 죽어 조용히 넘어가지 않는다. Node 쪽은 SHA 검증이 파이프에 가려지는 게 문제였다.
command -v tailscale >/dev/null 2>&1 || curl -fsSL https://tailscale.com/install.sh | sh

BACKEND_STATE="$(tailscale status --json 2>/dev/null | jq -r '.BackendState' || echo "NoState")"
if [ "${BACKEND_STATE}" = "Running" ]; then
  echo "이미 tailnet 에 조인됨 — 건너뜀"
else
  [ -n "${TS_AUTHKEY}" ] || {
    echo "조인이 필요한데 auth key 가 없습니다. Tailscale 콘솔에서 발급하세요:" >&2
    echo "  pre-authorized ✅ / tag:server ✅ / ephemeral ❌" >&2
    exit 1
  }
  # 키를 argv 에 노출하지 않는다 — root 전용 임시 파일로 전달
  umask 077
  KEY_FILE="$(mktemp)"
  printf '%s' "${TS_AUTHKEY}" > "${KEY_FILE}"
  # tag:server 가 노드 키 만료를 막는다 — 태그 없이 조인하면 몇 달 뒤
  # 헤드리스 서버가 조용히 tailnet 에서 떨어진다 (설계 §6-3)
  tailscale up --authkey "file:${KEY_FILE}" \
    --hostname quant-platform --advertise-tags=tag:server
  rm -f "${KEY_FILE}"
fi

# 이름을 가정하지 않는다 — 동명 노드가 있으면 quant-platform-1 처럼 접미사가 붙는다
FQDN="$(tailscale status --json | jq -r '.Self.DNSName' | sed 's/\.$//')"
[ -n "${FQDN}" ] && [ "${FQDN}" != "null" ] || { echo "FQDN 조회 실패" >&2; exit 1; }

echo "==> tailscale serve — 443 → 127.0.0.1:3000 (인증서 발급·갱신 포함)"
tailscale serve --bg --https=443 http://127.0.0.1:3000

echo "==> §28 app.env"
if [ -f /etc/quant-platform/app.env ]; then
  # 절대 덮지 않는다 — SESSION_SECRET 이 바뀌면 기존 세션이 전부 무효화된다
  echo "이미 존재 — 건너뜀"
else
  SECRET="$(openssl rand -base64 48 | tr -d '\n')"
  # base64 는 +/= 를 포함할 수 있으므로 sed 구분자는 # (base64 알파벳 밖)
  sed "s#<48_BYTE_RANDOM_VALUE>#${SECRET}#" "${SELF_DIR}/app.env.example" \
    > /etc/quant-platform/app.env
  chown root:root /etc/quant-platform/app.env
  chmod 600 /etc/quant-platform/app.env
fi

echo "==> §29 systemd 유닛"
install -m 644 -o root -g root "${SELF_DIR}/quant-platform.service" \
  /etc/systemd/system/quant-platform.service
systemctl daemon-reload
# start 는 하지 않는다 — dist 가 아직 없다. 첫 기동은 deploy.sh 가 한다.
systemctl enable quant-platform

echo ""
echo "기본 프로비저닝 완료. 다음: bootstrap.sh 가 tailnet SSH 검증 후 --harden 실행."
# bootstrap.sh 가 이 마커를 grep 한다 — 형식을 바꾸면 함께 바꿔야 한다
echo "FQDN=${FQDN}"
