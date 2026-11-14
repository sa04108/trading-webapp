#!/bin/sh
# scripts/bootstrap.sh 가 업로드·실행한다. 직접 실행 시:
#   sudo sh provision.sh <도메인>
#
# 도메인의 A 레코드가 이 Traefik의 공개 진입점을 가리켜야 한다 — Traefik 이 그 이름으로
# Let's Encrypt 인증서를 받는다. 도메인은 비밀값이 아니므로 argv 로 받는다.
#
# POSIX sh 로만 쓴다 — bashism 금지. 클라우드의 first-boot 스크립트가 dash 로 실행되어
# `set -o pipefail` 에 즉사한 전례가 있다 (2026-07-26). 이 파일은 launch script 가
# 아니지만 같은 규율을 유지한다: pipefail·brace expansion·[[ ]]·배열 금지.
#
# 멱등하다 — 모든 단계가 현재 상태를 확인하고 필요할 때만 변경한다.
#
# D-016 의 2단계(--harden) 구조는 폐기됐다 (D-017): 퍼블릭 22 를 닫지 않으므로
# "되돌릴 수 없는 지점" 이 없고, 클라우드 브라우저 SSH 콘솔이 상시 out-of-band
# 경로다. 락아웃 가드가 필요 없어 단일 실행으로 충분하다.
set -eu

DOMAIN="${1:-}"
SELF_DIR="$(cd "$(dirname "$0")" && pwd)"

# CI·Agent 이미지와 같은 24.x LTS patch를 사용한다. SHA는 자동 검증한다.
NODE_VERSION=v24.22.2

[ "$(id -u)" -eq 0 ] || { echo "root 로 실행해야 합니다 (sudo sh $0 <도메인>)" >&2; exit 1; }
[ -n "${DOMAIN}" ] || {
  echo "사용법: sudo sh $0 <도메인>" >&2
  echo "도메인의 A 레코드가 Traefik의 공개 진입점을 가리키고 있어야 합니다." >&2
  exit 1
}
# 이 값은 아래에서 Traefik 설정 heredoc 으로 들어간다 — 호스트명 문법을 벗어난 입력이
# 두 번째 사이트 블록이나 임의 지시자로 해석되지 않게 여기서 막는다. bootstrap.sh 도
# 같은 검사를 하지만 이 파일은 직접 실행이 문서화돼 있으므로 스스로도 강제한다.
case "${DOMAIN}" in
  *[!a-zA-Z0-9.-]* | -* | .* | *. | *..*)
    echo "도메인 형식이 올바르지 않습니다: ${DOMAIN}" >&2
    exit 1
    ;;
esac
case "${DOMAIN}" in
  *.*) : ;;
  *) echo "도메인에 점이 없습니다: ${DOMAIN} — FQDN 이어야 합니다." >&2; exit 1 ;;
esac

# 네트워크는 외부 Traefik 스택이 관리한다. 호스트 변경 전에 필수 조건을 확인한다.
PROXY_NETWORK="${2:-infra-proxy}"
ENTRYPOINT="${3:-websecure}"
RESOLVER="${4:-letsencrypt}"
TRAEFIK_IP="${5:-}"
for value in "$PROXY_NETWORK" "$ENTRYPOINT" "$RESOLVER"; do
  case "$value" in ''|*[!a-zA-Z0-9_.-]*) echo "Traefik 설정 이름이 올바르지 않습니다" >&2; exit 1;; esac
done
case "$TRAEFIK_IP" in *[!0-9.]*) echo "Traefik IP는 IPv4 주소여야 합니다" >&2; exit 1;; esac
command -v docker >/dev/null 2>&1 || { echo "Docker 네트워크가 필요합니다" >&2; exit 1; }
NETWORK_INFO="$(docker network inspect "$PROXY_NETWORK" --format '{{.Driver}}{{range .IPAM.Config}}{{printf "\n%s %s" .Gateway .Subnet}}{{end}}')" || { echo "프록시 네트워크를 찾을 수 없습니다" >&2; exit 1; }
[ "$(printf '%s\n' "$NETWORK_INFO" | sed -n '1p')" = bridge ] || { echo "프록시 네트워크는 bridge여야 합니다" >&2; exit 1; }
NETWORK_PAIR="$(printf '%s\n' "$NETWORK_INFO" | awk 'NR > 1 && $1 ~ /^[0-9.]+$/ && $2 ~ /^[0-9.]+\/[0-9]+$/ {print $1, $2; exit}')"
# 자동 할당된 gateway는 network IPAM 출력에서 생략될 수 있어 연결된 컨테이너에서도 확인한다.
if [ -z "$NETWORK_PAIR" ]; then
  for container_id in $(docker network inspect "$PROXY_NETWORK" --format '{{range $id, $_ := .Containers}}{{$id}} {{end}}'); do
    peer_gateway="$(docker inspect "$container_id" --format "{{with index .NetworkSettings.Networks \"$PROXY_NETWORK\"}}{{.Gateway}}{{end}}" 2>/dev/null || true)"
    case "$peer_gateway" in ''|*[!0-9.]*) continue;; esac
    NETWORK_PAIR="$(printf '%s\n' "$NETWORK_INFO" | awk -v gateway="$peer_gateway" 'NR > 1 && $NF ~ /^[0-9.]+\/[0-9]+$/ {print gateway, $NF; exit}')"
    [ -z "$NETWORK_PAIR" ] || break
  done
fi
[ -n "$NETWORK_PAIR" ] || { echo "프록시 네트워크의 IPv4 gateway/subnet이 필요합니다. 기존 Traefik을 먼저 연결하세요." >&2; exit 1; }
GATEWAY="${NETWORK_PAIR%% *}"
SUBNET="${NETWORK_PAIR#* }"
# Docker의 IPAM 값과 선택한 프록시 IP를 정수 범위까지 검사한다.
valid_ipv4() {
  printf '%s\n' "$1" | awk -F. 'NF != 4 {exit 1} {for (i=1;i<=4;i++) if ($i !~ /^[0-9]+$/ || $i > 255) exit 1}'
}
valid_ipv4 "$GATEWAY" && valid_ipv4 "${SUBNET%/*}" && [ "${SUBNET#*/}" -le 32 ] || { echo "네트워크 IPv4 설정이 올바르지 않습니다" >&2; exit 1; }
[ -z "$TRAEFIK_IP" ] || valid_ipv4 "$TRAEFIK_IP" || { echo "Traefik IPv4 주소가 올바르지 않습니다" >&2; exit 1; }

# 실행 중인 앱의 바인딩과 프록시 목적지가 서로 달라지는 부분 적용을 막는다.
if systemctl is-active --quiet quant-platform; then
  echo "기존 앱이 실행 중입니다. 초기 설정 변경은 유지보수 시간에 앱을 중지한 뒤 실행하세요." >&2
  echo "일반 앱 업데이트는 프로비저닝 대신 deploy:systemd를 사용하세요." >&2
  exit 1
fi

echo "필수 조건: 기존 Traefik의 file provider에 /etc/traefik/dynamic 디렉터리를 연결해야 합니다."

echo "==> 패키지·타임존·유저·디렉터리"
export DEBIAN_FRONTEND=noninteractive
# 첫 부팅 직후에는 unattended-upgrades 가 apt 락을 잡고 있을 수 있다 — 기다린다.
APT="apt-get -o DPkg::Lock::Timeout=600 -y"
$APT update
$APT full-upgrade
$APT install ca-certificates curl git jq openssl unzip xz-utils build-essential \
             python3 pkg-config sqlite3 util-linux ufw unattended-upgrades gnupg

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

echo "==> Node.js ${NODE_VERSION}"
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

echo "==> UFW — 22(rate-limit)·80·443"
# 퍼블릭 22 는 열어 둔다 (D-017): 클라우드 브라우저 SSH 콘솔이 out-of-band 복구
# 경로다. limit 는 소스 IP 당 30초에 6회 신규 연결로 제한해 브루트포스를 늦춘다 —
# 인증 자체는 아래 sshd 하드닝이 키 전용으로 막는다.
ufw default deny incoming
ufw default allow outgoing
ufw limit 22/tcp
ufw allow 80/tcp   # ACME HTTP-01 + HTTPS 리다이렉트
ufw allow 443/tcp
ufw allow from "$SUBNET" to "$GATEWAY" port 3000 proto tcp
ufw --force enable
ufw status verbose

echo "==> SSH 하드닝 (키 전용)"
SSHD_CONF=/etc/ssh/sshd_config.d/99-quant-hardening.conf
# 임시 파일에 쓰고 내용이 다를 때만 교체한다 (이 파일 헤더가 약속하는 멱등성).
# "교체할지" 와 "반영할지" 는 분리한다 — 아래 검증·reload 는 매번 돈다.
SSHD_TMP="$(mktemp)"
cat > "${SSHD_TMP}" <<'EOF'
PermitRootLogin no
PasswordAuthentication no
KbdInteractiveAuthentication no
PubkeyAuthentication yes
X11Forwarding no
MaxAuthTries 3
LoginGraceTime 30
EOF
if [ -f "${SSHD_CONF}" ] && cmp -s "${SSHD_TMP}" "${SSHD_CONF}"; then
  echo "설정 파일 변경 없음"
else
  install -m 644 -o root -g root "${SSHD_TMP}" "${SSHD_CONF}"
fi
rm -f "${SSHD_TMP}"

# sshd -t 는 privilege separation 디렉터리를 요구한다. 이건 systemd 가 ssh.service 의
# RuntimeDirectory 로 만들어 주는데, Ubuntu 24.04 처럼 소켓 활성화(ssh.socket)를 쓰면
# ssh.service 가 상주하지 않아 /run/sshd 가 아예 없다 — 접속은 멀쩡한데(연결마다
# sshd 가 새로 뜬다) 검증만 "Missing privilege separation directory" 로 죽는다.
[ -d /run/sshd ] || mkdir -p /run/sshd
chmod 0755 /run/sshd
sshd -t

# 반영은 파일 변경 여부와 무관하게 매번 보장한다. 이전 실행이 install 뒤 sshd -t 에서
# 죽으면 파일만 남는데, 그때 "내용이 같으니 건너뜀" 으로 처리하면 상주 데몬이 새 설정을
# 영영 읽지 않는다 — 재실행이 고쳐주지 못하는 상태가 된다. reload 는 기존 세션을 끊지
# 않고 설정만 다시 읽으므로 매번 돌려도 비용이 없다.
if systemctl is-active --quiet ssh.service; then
  # Ubuntu 의 유닛명은 sshd 가 아니라 ssh 다
  systemctl reload ssh.service || systemctl restart ssh.service
else
  # 소켓 활성화 경로: 연결마다 sshd 가 새로 떠 설정을 읽으므로 다음 연결부터 적용된다.
  # 소켓이 내려가 있으면 SSH 자체가 막히므로 그것만 보장한다.
  systemctl is-active --quiet ssh.socket || systemctl start ssh.socket
fi

echo "==> Traefik 파일 제공자 설정 — ${DOMAIN} → ${GATEWAY}:3000"
# Traefik 자체와 파일 제공자 마운트는 기존 스택에서 관리한다.
mkdir -p /etc/traefik/dynamic
TRAEFIK_TMP="$(mktemp)"
cat > "$TRAEFIK_TMP" <<EOF
http:
  routers:
    quant-platform:
      rule: "Host(\`${DOMAIN}\`)"
      entryPoints: ["${ENTRYPOINT}"]
      service: quant-platform
      tls:
        certResolver: "${RESOLVER}"
  services:
    quant-platform:
      loadBalancer:
        servers:
          - url: "http://${GATEWAY}:3000"
EOF
install -m 644 -o root -g root "$TRAEFIK_TMP" /etc/traefik/dynamic/quant-platform.yaml
rm -f "$TRAEFIK_TMP"

echo "==> 스왑 2GB (D-023)"
# RAM 1GB + 스왑 0 조합은 메모리 압박 시 OOM 킬러가 뜨기 전에 페이지 캐시 스래싱으로
# sshd 까지 마비시킨다 (2026-07-28 운영 장애). 스왑은 그 마비를 "느려짐"으로 강등시킨다.
if ! swapon --show --noheadings | grep -q .; then
  fallocate -l 2G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
  echo "스왑 2GB 활성화"
else
  echo "스왑 이미 존재 — 건너뜀"
fi

echo "==> app.env"
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

# 앱 비밀 파일은 그대로 두고 네트워크 값만 별도 파일로 덮어쓴다.
NETWORK_TMP="$(mktemp)"
printf 'APP_BIND_ADDRESS=%s\nAPP_PORT=3000\nTRUST_PROXY_LOOPBACK=false\nTRUST_PROXY_ADDRESSES=%s\n' "$GATEWAY" "$TRAEFIK_IP" > "$NETWORK_TMP"
install -m 600 -o root -g root "$NETWORK_TMP" /etc/quant-platform/network.env
rm -f "$NETWORK_TMP"

echo "==> systemd 유닛"
install -m 644 -o root -g root "${SELF_DIR}/quant-platform.service" \
  /etc/systemd/system/quant-platform.service
systemctl daemon-reload
# start 는 하지 않는다 — dist 가 아직 없다. 첫 기동은 deploy.sh 가 한다.
systemctl enable quant-platform

echo ""
echo "프로비저닝 완료: https://${DOMAIN}"
