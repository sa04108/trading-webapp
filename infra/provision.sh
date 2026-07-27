#!/bin/sh
# 서버 프로비저닝 (설계: docs/superpowers/specs/2026-07-27-platform-readonly-constitution-design.md).
# scripts/bootstrap.sh 가 업로드·실행한다. 직접 실행 시:
#   sudo sh provision.sh <도메인>
#
# 도메인의 A 레코드가 이 서버의 고정 공인 IP 를 가리켜야 한다 — Caddy 가 그 이름으로
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

# 붙여넣기 전에 nodejs.org 의 현재 24.x LTS patch 로 갱신한다. SHA 는 자동 검증.
NODE_VERSION=v24.18.0

[ "$(id -u)" -eq 0 ] || { echo "root 로 실행해야 합니다 (sudo sh $0 <도메인>)" >&2; exit 1; }
[ -n "${DOMAIN}" ] || {
  echo "사용법: sudo sh $0 <도메인>" >&2
  echo "도메인의 A 레코드가 이 서버의 고정 공인 IP 를 가리키고 있어야 합니다." >&2
  exit 1
}

echo "==> 패키지·타임존·유저·디렉터리"
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

echo "==> 고정 아웃바운드 IP 확인 (정보성)"
# 증권사 API 트래픽은 이 호스트의 고정 공인 IP 로 나가야 한다(§18) — 증권사가 허용
# 출발 IP 를 등록제로 운영하기 때문이다. 실패해도 프로비저닝을 죽이지 않는다 — 일시적
# 네트워크 문제로 배포 자체가 막히면 안 되므로 참고용으로만 쓴다.
#
# 특정 업체에 묶지 않는다 (스펙 §2.1): OUTBOUND_IP_URL 로 원하는 엔드포인트를 지정할 수
# 있고(사내 서비스도 가능), 미지정이면 아래 목록을 순서대로 시도해 첫 성공을 쓴다.
# --max-time: 아웃바운드가 막힌 호스트에서 curl 의 기본 연결 타임아웃(300초)까지
# 프로비저닝이 멈춘 것처럼 보이지 않게 한다.
OUTBOUND_IP="확인 실패"
# 아래 ${...} 는 여러 URL 을 순회하기 위해 의도적으로 인용하지 않는다 (단어 분리 필요)
for url in ${OUTBOUND_IP_URL:-https://ifconfig.me/ip https://icanhazip.com https://api.ipify.org}; do
  ip="$(curl -4 -fsS --max-time 10 "${url}" 2>/dev/null | tr -d '[:space:]' || true)"
  # HTML 에러 페이지 등을 IP 로 오인하지 않게 숫자·점만 허용한다
  case "${ip}" in
    ''|*[!0-9.]*) : ;;
    *) OUTBOUND_IP="${ip}"; break ;;
  esac
done
echo "아웃바운드 IP: ${OUTBOUND_IP} — 증권사에 등록한 고정 공인 IP 와 일치해야 한다"

echo "==> DNS 확인 — ${DOMAIN}"
RESOLVED="$(getent ahostsv4 "${DOMAIN}" 2>/dev/null | awk '{print $1; exit}' || true)"
[ -n "${RESOLVED}" ] || {
  echo "${DOMAIN} 이 해석되지 않습니다 — A 레코드를 만들고 전파를 기다린 뒤 재실행하세요." >&2
  exit 1
}
if [ "${OUTBOUND_IP}" != "확인 실패" ] && [ "${RESOLVED}" != "${OUTBOUND_IP}" ]; then
  # 하드 실패로 두지 않는 이유: 아웃바운드 확인 자체가 best-effort 라 NAT 구성에 따라
  # 어긋날 수 있다. 진짜 판정은 아래 인증서 발급 확인이 한다.
  echo "경고: ${DOMAIN} → ${RESOLVED} 인데 아웃바운드 IP 는 ${OUTBOUND_IP} 다." >&2
  echo "A 레코드가 다른 곳을 가리키면 인증서 발급이 실패한다." >&2
fi

echo "==> UFW — 22(rate-limit)·80·443"
# 퍼블릭 22 는 열어 둔다 (D-017): 클라우드 브라우저 SSH 콘솔이 out-of-band 복구
# 경로다. limit 는 소스 IP 당 30초에 6회 신규 연결로 제한해 브루트포스를 늦춘다 —
# 인증 자체는 아래 sshd 하드닝이 키 전용으로 막는다.
ufw default deny incoming
ufw default allow outgoing
ufw limit 22/tcp
ufw allow 80/tcp   # ACME HTTP-01 + HTTPS 리다이렉트
ufw allow 443/tcp
ufw --force enable
ufw status verbose

echo "==> SSH 하드닝 (키 전용)"
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

echo "==> Caddy — ${DOMAIN} → 127.0.0.1:3000"
# 공식 apt repo 로 설치한다 — unattended-upgrades 가 보안 패치를 함께 관리한다.
if ! command -v caddy >/dev/null 2>&1; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
    | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
    > /etc/apt/sources.list.d/caddy-stable.list
  $APT update
  $APT install caddy
fi

# HSTS·보안 헤더·압축은 앱이 담당한다 (D-016 에서 이관) — Caddy 는 프록시만 한다.
cat > /etc/caddy/Caddyfile <<EOF
${DOMAIN} {
	reverse_proxy 127.0.0.1:3000
}
EOF
caddy validate --config /etc/caddy/Caddyfile
systemctl enable caddy
systemctl restart caddy

echo "==> 인증서 발급 확인 (최대 90초)"
# 앱 배포 전이므로 502 가 정상이다 — TLS 응답이 온다는 것 자체가 발급 성공이다.
# 자기 자신의 공인 IP 로의 hairpin 접속이 막히는 호스트가 있어 실패해도 죽이지 않는다.
# 확정 판정은 bootstrap.sh 가 개발 PC(외부 시점)에서 한다.
CODE=000
i=0
while [ "${i}" -lt 18 ]; do
  CODE="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 5 "https://${DOMAIN}/" 2>/dev/null || echo 000)"
  [ "${CODE}" != "000" ] && break
  i=$((i + 1))
  sleep 5
done
if [ "${CODE}" = "000" ]; then
  echo "경고: https://${DOMAIN} 의 TLS 응답을 서버 안에서 확인하지 못했다." >&2
  echo "hairpin NAT 제약일 수 있다 — 외부에서 접속해 보고, 안 되면: journalctl -u caddy" >&2
else
  echo "TLS 응답 확인 (HTTP ${CODE} — 앱 배포 전에는 502 가 정상)"
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

echo "==> systemd 유닛"
install -m 644 -o root -g root "${SELF_DIR}/quant-platform.service" \
  /etc/systemd/system/quant-platform.service
systemctl daemon-reload
# start 는 하지 않는다 — dist 가 아직 없다. 첫 기동은 deploy.sh 가 한다.
systemctl enable quant-platform

echo ""
echo "프로비저닝 완료: https://${DOMAIN}"
