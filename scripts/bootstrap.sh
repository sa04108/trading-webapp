#!/usr/bin/env bash
# 서버 부트스트랩 — 새 인스턴스를 배포 가능 상태로 만든다 (설계 문서 §3·§4).
#
# 사용법: ./scripts/bootstrap.sh
#         서버 주소와 auth key 를 순서대로 물어본다. 비대화형으로 돌리려면
#         TS_HOST / TS_AUTHKEY / SSH_KEY 환경변수를 미리 설정한다.
#
#   TS_HOST    서버 주소. 첫 실행은 퍼블릭 IP, 하드닝 이후에는 tailnet FQDN 이어야 한다 —
#              UFW 가 퍼블릭 22 를 닫아서 그 경로로는 첫 명령(ssh)부터 죽는다.
#   TS_AUTHKEY Tailscale auth key. 이미 조인된 서버 재실행이면 비워도 된다.
#   SSH_KEY    개인키 경로. 지정하면 -i 로 넘긴다. 없으면 ~/.ssh/config 나
#              기본 이름 키(id_ed25519 등)에 의존한다.
#
# 순서가 락아웃 가드다: 기본 프로비저닝(퍼블릭 SSH) → tailnet 경유 SSH 를 "실제로"
# 검증 → 성공했을 때만 --harden(UFW 가 퍼블릭 22 를 닫는다). 스펙 §25 의
# "검증 전 차단 금지" 를 사람의 규율이 아니라 제어 흐름으로 강제한다.
# 전제: 이 PC 가 tailnet 에 조인돼 있어야 한다 (tailscale status 로 확인).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REMOTE_DIR=/tmp/quant-provision

HOST="${TS_HOST:-}"
if [ -z "${HOST}" ]; then
  read -rp "서버 주소 (첫 실행은 퍼블릭 IP, 하드닝 후에는 tailnet FQDN): " HOST
fi
[ -n "${HOST}" ] || { echo "서버 주소가 필요합니다" >&2; exit 1; }

if [ -z "${TS_AUTHKEY:-}" ]; then
  read -rsp "Tailscale auth key (재실행이면 Enter): " TS_AUTHKEY
  echo
fi

# 키 지정은 선택이다 — SSH_KEY 가 있으면 -i 로 넘기고, 없으면 ssh 의 평소 규칙
# (~/.ssh/config, 기본 이름 키)에 맡긴다. IdentitiesOnly 를 함께 켜는 이유는
# 하드닝이 MaxAuthTries 3 을 걸기 때문이다 — agent 에 등록된 키까지 순서대로
# 제시되면 맞는 키가 4번째가 되어 서버가 먼저 연결을 끊을 수 있다.
SSH_OPTS=()
if [ -n "${SSH_KEY:-}" ]; then
  [ -f "${SSH_KEY}" ] || { echo "SSH_KEY 파일이 없습니다: ${SSH_KEY}" >&2; exit 1; }
  SSH_OPTS=(-i "${SSH_KEY}" -o IdentitiesOnly=yes)
fi

echo "==> SSH 접속 확인: ubuntu@${HOST}"
# 이 확인이 없으면 아래 ssh/scp 가 set -e 로 조용히 죽어, 실패 원인이 그 다음 단계
# (auth key 입력 직후처럼) 엉뚱한 곳을 가리킨다 — 실제로 그렇게 오진한 적이 있다.
ssh "${SSH_OPTS[@]}" -o ConnectTimeout=15 -o BatchMode=yes "ubuntu@${HOST}" true 2>/dev/null || {
  {
    echo "SSH 접속 실패: ubuntu@${HOST}"
    echo
    if [ -n "${SSH_KEY:-}" ]; then
      echo "지정한 키로 붙지 못했다: ${SSH_KEY}"
    else
      # 키를 안 넘겼을 때가 가장 흔한 실패다 — ~/.ssh 에서 후보를 찾아
      # 그대로 복사해 쓸 수 있는 명령을 만들어 준다.
      echo "키를 지정하지 않았다. ssh 는 ~/.ssh/config 나 기본 이름 키만 시도한다 —"
      echo "Lightsail 이 내려준 <name>.pem 처럼 다른 이름의 키는 시도조차 하지 않는다."
      CANDIDATES="$(ls -1 ~/.ssh/*.pem ~/.ssh/id_* 2>/dev/null | grep -v '\.pub$' || true)"
      if [ -n "${CANDIDATES}" ]; then
        echo
        echo "찾은 키 후보 — 하나를 골라 다시 실행하면 된다:"
        while IFS= read -r k; do
          [ -n "${k}" ] && echo "  SSH_KEY=${k} ./scripts/bootstrap.sh"
        done <<< "${CANDIDATES}"
      else
        echo
        echo "~/.ssh 에서 키 후보를 찾지 못했다. Lightsail 콘솔에서 .pem 을 내려받거나"
        echo "인스턴스에 등록한 공개키의 짝을 확인하세요."
      fi
      echo
      echo "매번 지정하지 않으려면 ~/.ssh/config 에 등록해도 된다:"
      echo "  Host ${HOST} quant-platform.*.ts.net"
      echo "    User ubuntu"
      echo "    IdentityFile ~/.ssh/<your-key>.pem"
      echo "    IdentitiesOnly yes"
    fi
    echo
    echo "원인 가르기: ssh -v ${SSH_KEY:+-i ${SSH_KEY} }ubuntu@${HOST} true"
    echo "  Permission denied (publickey) → 키가 없거나 틀렸다"
    echo "  Connection timed out          → 클라우드 방화벽에서 TCP 22 가 닫혀 있다"
    echo "  Unprotected private key file  → 키 파일 권한 (Windows: icacls /inheritance:r /grant:r)"
  } >&2
  exit 1
}

echo "==> 프로비저닝 파일 업로드"
ssh "${SSH_OPTS[@]}" "ubuntu@${HOST}" "mkdir -p ${REMOTE_DIR}" \
  || { echo "원격 디렉터리 생성 실패: ${REMOTE_DIR}" >&2; exit 1; }
scp "${SSH_OPTS[@]}" "${REPO_ROOT}/infra/provision.sh" \
    "${REPO_ROOT}/infra/systemd/quant-platform.service" \
    "${REPO_ROOT}/infra/app.env.example" \
    "ubuntu@${HOST}:${REMOTE_DIR}/" \
  || { echo "파일 업로드 실패 — ${REPO_ROOT}/infra 아래 3개 파일과 원격 디스크 여유를 확인하세요" >&2; exit 1; }

# TTY 없이 파이프로 붙는 다음 단계는 sudo 가 비밀번호를 물으면 auth key 줄을
# 비밀번호 시도로 먹어버린다. Lightsail Ubuntu 이미지는 ubuntu 에 NOPASSWD sudo 를
# 주므로 보통은 문제가 안 되지만, 그렇지 않은 이미지에서는 여기서 먼저 분명하게 실패시킨다.
ssh "${SSH_OPTS[@]}" "ubuntu@${HOST}" "sudo -n true" \
  || { echo "sudo 에 비밀번호가 필요합니다 — ubuntu 사용자에 NOPASSWD sudo 를 설정한 뒤 재실행하세요" >&2; exit 1; }

echo "==> 기본 프로비저닝 (§21·22·23·28·29)"
OUT="$(mktemp)"
trap 'rm -f "${OUT}"' EXIT
# 키는 stdin 으로 — argv·원격 히스토리에 남기지 않는다
printf '%s\n' "${TS_AUTHKEY}" \
  | ssh "${SSH_OPTS[@]}" "ubuntu@${HOST}" "sudo sh ${REMOTE_DIR}/provision.sh" \
  | tee "${OUT}"

# pipeline 이 매치 실패로 비어있는 값을 낼 때 grep 의 실패 종료 코드가 `set -e` 로
# 대입문 자체를 즉사시켜, 바로 아래의 사람이 읽을 에러 메시지가 실행되지 못하고
# 조용히 exit 1 만 남는 문제가 있었다 — `|| true` 로 대입의 성공 여부를 무의미하게
# 만들고, 값의 유무 판단은 다음 줄의 `-n` 검사에 전적으로 맡긴다.
# `-f2-` 사용: 값에 `=` 가 들어가도(예: base64 뒤에 `=` 패딩) 잘리지 않는다.
FQDN="$(grep '^FQDN=' "${OUT}" | tail -1 | cut -d= -f2-)" || true
[ -n "${FQDN}" ] || { echo "출력에서 FQDN= 마커를 찾지 못했습니다" >&2; exit 1; }

echo "==> tailnet 경유 SSH 검증: ${FQDN}"
# StrictHostKeyChecking=accept-new: ${FQDN} 는 이 PC 가 처음 접속하는 이름이라
# (HOST 와 다른 known_hosts 항목) BatchMode=yes 하의 기본값(ask)이면 비대화형으로
# 즉시 실패한다. 첫 접속을 자동 신뢰해도 되는 이유는 이 이름이 tailnet 안에서만
# 해석되고 Tailscale 자체가 노드 신원을 인증하기 때문 — 다만 "바뀐" 키(재접속 시
# 불일치, MITM 의심)는 accept-new 에서도 여전히 거부된다. StrictHostKeyChecking=no
# 는 그 거부까지 없애버리므로 쓰지 않는다.
if ssh "${SSH_OPTS[@]}" -o ConnectTimeout=15 -o BatchMode=yes -o StrictHostKeyChecking=accept-new \
       "ubuntu@${FQDN}" true; then
  echo "==> 하드닝 (§25 UFW + §26 SSH) — 퍼블릭 22 가 닫힌다"
  ssh "${SSH_OPTS[@]}" "ubuntu@${FQDN}" "sudo sh ${REMOTE_DIR}/provision.sh --harden"

  # harden 의 ssh 가 접근이 증명된 마지막 순간이다. UFW 규칙이 실제 사용 경로와
  # 어긋나거나(예: IPv6) sshd 가 안 돌아오면 퍼블릭 22 도 닫히고 브라우저 콘솔도 죽은
  # 뒤에야 알게 된다 — 새 연결로 즉시 재검증해 그 순간 크게 알린다.
  echo "==> 하드닝 후 재확인 — 새 연결로 tailnet SSH 재검증"
  ssh "${SSH_OPTS[@]}" -o ConnectTimeout=15 -o BatchMode=yes "ubuntu@${FQDN}" true \
    || { echo "하드닝 후 tailnet SSH 가 끊겼습니다 — 즉시 확인하세요" >&2; exit 1; }
else
  cat >&2 <<MSG
경고: tailnet 경유 SSH 실패 — 하드닝을 건너뜁니다. 퍼블릭 SSH 는 살아 있습니다.
  가능한 원인:
    1) 이 PC 가 tailnet 에 없음 — 확인: tailscale status
    2) 호스트 키 검증 실패 — known_hosts 충돌(키가 바뀐 경우만; 최초 접속은 자동 수락됨)
  해결 후 하드닝만 재실행:
     ssh ${SSH_KEY:+-i ${SSH_KEY} }ubuntu@${FQDN} sudo sh ${REMOTE_DIR}/provision.sh --harden
MSG
  exit 1
fi

cat <<MSG

부트스트랩 완료: https://${FQDN}

다음 단계:
  1) 첫 배포:      ${SSH_KEY:+SSH_KEY=${SSH_KEY} }./scripts/deploy.sh ${FQDN}
  2) 관리자 생성 (1회, 서버에서):
     ssh ${SSH_KEY:+-i ${SSH_KEY} }ubuntu@${FQDN}
     sudo systemd-run --pty --uid=quant --gid=quant \\
       --property=EnvironmentFile=/etc/quant-platform/app.env \\
       --working-directory=/opt/quant-platform/current \\
       /usr/local/bin/node /opt/quant-platform/current/dist/server/cli.js admin:create
  3) (선택) Lightsail Networking 에서 TCP 22 제거 — UFW 심층방어

참고: 이 스크립트를 다시 실행할 일이 있으면 서버 주소를 퍼블릭 IP 가 아니라 FQDN 으로
      입력하라 — 하드닝이 퍼블릭 22 를 닫아서 그 경로는 첫 명령부터 실패한다.
      비대화형으로 돌리려면: ${SSH_KEY:+SSH_KEY=${SSH_KEY} }TS_HOST=${FQDN} ./scripts/bootstrap.sh
MSG
