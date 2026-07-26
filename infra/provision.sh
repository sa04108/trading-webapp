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
  # §25 전제조건: tailscale 이 실제로 Running 이어야 tailscale0 로 22 를 제한해도
  # 락아웃이 아니다. bootstrap.sh 의 tailnet SSH 실증(충분조건)과는 별개로, 이
  # 파일 자체도 필요조건을 강제한다 — 설계문서 "tailscale status 가 Running 일
  # 때만 적용" 요구를 주석이 아니라 게이트로 구현 (bootstrap.sh 를 대체하지 않음).
  BACKEND_STATE="$(tailscale status --json 2>/dev/null | jq -r '.BackendState' || echo "NoState")"
  [ "${BACKEND_STATE}" = "Running" ] || {
    echo "tailscale 이 Running 상태가 아닙니다 (현재: ${BACKEND_STATE}) — 하드닝을 거부합니다." >&2
    echo "먼저 기본 모드로 tailnet 에 조인한 뒤 --harden 을 다시 실행하세요." >&2
    exit 1
  }

  # D-016 §6-3: Running 만으로는 부족하다 — 운영자가 디버깅 중 손으로 tailscale up 을
  # 태그 없이 돌렸을 수 있다(이 파일 헤더가 직접 실행을 문서화한다). 태그 없는 조인은
  # 지금은 멀쩡히 동작하지만 노드 키가 만료되면(약 180일) tailscaled 가 NeedsLogin 으로
  # 떨어지고, 그때는 퍼블릭 22 가 이미 닫혀 있어 들어갈 방법이 없다(락아웃, 무경고).
  # 되돌릴 수 없는 UFW 적용 직전에 태그 소유를 실제로 확인한다.
  tailscale status --json 2>/dev/null | jq -e '(.Self.Tags // []) | index("tag:server")' >/dev/null 2>&1 || {
    echo "노드가 tag:server 로 태그되지 않았습니다 — 노드 키가 만료되면 락아웃입니다." >&2
    echo "tailscale 콘솔에서 노드를 삭제하고 tag:server 키로 다시 조인하세요." >&2
    exit 1
  }

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
# 하드닝 후 재실행은 tailnet SSH 가 유일한 경로다. full-upgrade 가 tailscale
# 패키지를 올리면 tailscaled 재시작으로 tailscale0 이 잠깐 내려가 이 세션이 SIGHUP 으로
# 끊길 수 있다 — 락아웃은 아니다(UFW·sshd 무관, tailscaled 는 돌아온다) 그저 재실행이
# 한 번 더 필요할 수 있다는 뜻이니, 설명 없이 멈춘 것처럼 보이면 다시 실행하라.
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
  echo "이미 설치됨 — 다운로드·압축 해제는 건너뜀"
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
fi
# 버전 검사 밖에서 매번 실행한다 — ln -sfn·corepack enable 은 이미 멱등하므로,
# 이전 실행이 corepack enable 전에 죽어 /usr/local/bin/node 만 만들어진 상태로
# 재실행돼도 (버전 검사가 참이 되어 else 를 건너뛰어도) 나머지가 복구된다
for bin in node npm npx corepack; do
  ln -sfn "/opt/node/bin/${bin}" "/usr/local/bin/${bin}"
done
corepack enable
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
  # tailscale up 이 실패하면 set -e 로 즉시 종료된다 — trap 없이는 rm -f 가 실행되지
  # 않고 평문 키 파일이 /tmp 에 남는다. 모든 종료 경로에서 지우도록 trap 을 건다.
  # POSIX 셸은 트랩되지 않은 시그널로 죽으면 EXIT 트랩을 실행하지 않는다 — 이
  # 스크립트를 실어 나르는 bootstrap.sh 의 ssh 채널이 Ctrl-C 로 끊기면 여기서
  # SIGHUP 을 받는 게 현실적인 중단 경로이므로 EXIT 외에 HUP·INT·TERM 도 잡는다
  trap 'rm -f "${KEY_FILE}"' EXIT HUP INT TERM
  printf '%s' "${TS_AUTHKEY}" > "${KEY_FILE}"
  # tag:server 가 노드 키 만료를 막는다 — 태그 없이 조인하면 몇 달 뒤
  # 헤드리스 서버가 조용히 tailnet 에서 떨어진다 (설계 §6-3)
  # §18/§23: 증권사 API 아웃바운드는 Lightsail Static IP 로만 나가야 한다 — 이 노드에
  # exit-node 를 걸지 않는다. `tailscale set --exit-node=...` 는 이 불변식을 조용히
  # 우회시키는, WireGuard 에는 없었던 새 경로다.
  tailscale up --authkey "file:${KEY_FILE}" \
    --hostname quant-platform --advertise-tags=tag:server
  rm -f "${KEY_FILE}"
  # 성공 경로에서는 trap 을 해제한다 — 이후 실패가 이미 지워진 경로를 다시
  # 건드리지 않게 하고, 뒤 단계에 다른 EXIT trap 이 필요해질 때 충돌을 막는다
  trap - EXIT HUP INT TERM
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
  # sed 로 치환하면 비밀값이 별도 프로세스(sed)의 argv 로 넘어가 호출 동안
  # /proc/<pid>/cmdline·ps 에 노출된다 — printf 는 빌트인이라 노출되지 않는다.
  # 목적지 파일에 바로 쓰지 않고 임시 파일에 완성한 뒤 mv 로 원자적 교체한다.
  # 중간에 실패(디스크 꽉 참·시그널)해도 잘린 app.env 가 생기지 않는다 — 잘린 파일이
  # 생기면 위 "이미 존재 — 건너뜀" 이 그 상태를 영구 고착시키고 재실행도 못 고친다.
  umask 077
  TMP_ENV="$(mktemp)"
  grep -v '^SESSION_SECRET=' "${SELF_DIR}/app.env.example" > "${TMP_ENV}"
  printf 'SESSION_SECRET=%s\n' "${SECRET}" >> "${TMP_ENV}"
  chown root:root "${TMP_ENV}" && chmod 600 "${TMP_ENV}"
  mv "${TMP_ENV}" /etc/quant-platform/app.env
fi

echo "==> §29 systemd 유닛"
install -m 644 -o root -g root "${SELF_DIR}/quant-platform.service" \
  /etc/systemd/system/quant-platform.service
systemctl daemon-reload
# start 는 하지 않는다 — dist 가 아직 없다. 첫 기동은 deploy.sh 가 한다.
systemctl enable quant-platform

echo "==> §18/§23 고정 아웃바운드 IP 확인 (정보성)"
# 증권사 API 트래픽은 이 Lightsail Static IP 로 나가야 한다(§18/§23). 실패해도 프로비저닝을
# 죽이지 않는다 — 일시적 네트워크 문제로 배포 자체가 막히면 안 되므로 참고용으로만 쓴다.
OUTBOUND_IP="$(curl -4 -fsS https://checkip.amazonaws.com 2>/dev/null || echo "확인 실패")"
echo "아웃바운드 IP: ${OUTBOUND_IP} — 증권사에 등록한 Static IP 와 일치해야 한다"

echo ""
echo "기본 프로비저닝 완료. 다음: bootstrap.sh 가 tailnet SSH 검증 후 --harden 실행."
# bootstrap.sh 가 이 마커를 grep 한다 — 형식을 바꾸면 함께 바꿔야 한다
echo "FQDN=${FQDN}"
