#!/usr/bin/env bash
# 서버 부트스트랩 — 새 호스트를 배포 가능 상태로 만든다
#
# 사용법: ./scripts/bootstrap-server.sh
#         서버 주소와 도메인을 순서대로 물어본다. 비대화형으로 돌리려면
#         환경변수를 미리 설정한다 — ssh config 는 필요하지 않다:
#
#         SSH_KEY=~/.ssh/your-key QP_SSH_USER=ubuntu QP_HOST=203.0.113.10 \
#           QP_DOMAIN=quant.example.com ./scripts/bootstrap-server.sh
#
#   QP_DOMAIN        서비스 도메인 (예: quant.example.com). A 레코드가 서버의 고정 공인
#                    IP 를 가리키고 있어야 한다 — Caddy 가 이 이름으로 인증서를 받는다.
#   QP_HOST          서버 주소, `[user@]host` 형식
#   QP_SSH_USER      로그인 사용자명. QP_HOST 에 `user@` 가 없을 때만 쓴다
#   QP_SSH_PORT      SSH 포트 (미지정이면 22)
#   SSH_KEY          개인키 경로. `~/` 로 시작하면 아래에서 $HOME 으로 펼친다
#   QP_SSH_JUMP      점프 호스트, `[user@]host[:port]` (ssh 의 ProxyJump)
#   QP_SSH_HOST_KEY  호스트키 확인: accept-new(기본) | yes | no
#   QP_SSH_OPTS      그 밖의 ssh 옵션을 그대로 (예: "-o ServerAliveInterval=30")
#
# ssh config 에 Host 항목을 만들어도 되지만, 만들지 않아도 되는 것이 요점이다 —
# 한 번 쓰고 버리는 인스턴스마다 로컬 설정 파일을 고치게 만들지 않는다.
#
# 이 스크립트는 로그인 사용자명을 가정하지 않는다 — 클라우드 이미지마다 다르고
# (ubuntu / admin / ec2-user), 자체 설치 호스트는 임의다. 스펙 §2.1 의 "애플리케이션과
# 도구는 특정 클라우드를 모른다" 를 따른다.
#
# 인증은 공개키만 지원한다. 비밀번호 인증을 넣지 않는 이유는 provision-server.sh 가
# PasswordAuthentication no 를 쓰기 때문이다 (스펙 §16·D-017) — 어떤 호스트에서든
# 프로비저닝이 끝나면 비밀번호로는 다시 들어올 수 없다. 한 실행에 ssh/scp 가 5회
# 호출되므로 매번 프롬프트가 뜨는 문제도 있고, sudo 확인은 어차피 passwordless
# sudo 를 요구한다. 퍼블릭 22 는 계속 열려 있으므로(D-017) 락아웃 걱정은 없다 —
# 키를 잃어도 클라우드 브라우저 SSH 콘솔로 들어갈 수 있다.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REMOTE_DIR=/tmp/quant-provision

# ── 입력은 로그 리다이렉트보다 먼저 받는다 ────────────────────────────────────
# tee 를 거치면 프롬프트가 버퍼링에 걸려 화면에 안 나타날 수 있다. 입력을 다 받은
# 뒤에 리다이렉트를 걸어 그 위험을 없앤다.
# read 뒤의 `|| true`: 비대화형 실행(stdin 이 /dev/null·닫힘)에서 read 는 EOF 로
# 비영점 종료한다. 그러면 set -e 가 여기서 스크립트를 죽여, 바로 아래의 사람이 읽을
# 안내가 실행되지 못하고 설명 없는 exit 1 만 남는다. 값의 유무 판단은 다음 줄에 맡긴다.
TARGET="${QP_HOST:-}"
if [ -z "${TARGET}" ]; then
  read -rp "서버 주소 입력(user@host): " TARGET || true
fi
[ -n "${TARGET}" ] || {
  echo "서버 주소가 필요합니다 — 비대화형이면 QP_HOST 로 지정하세요" >&2
  exit 1
}
# 사용자명은 주소에 붙여도 되고 따로 줘도 된다 — 주소가 IP 뿐인 CI·스크립트에서
# QP_HOST 를 조립하지 않아도 되게 한다. 둘 다 있으면 주소에 붙은 쪽이 이긴다.
if [ -n "${QP_SSH_USER:-}" ]; then
  case "${TARGET}" in
    *@*) echo "QP_SSH_USER 는 무시합니다 — 주소에 이미 사용자명이 있습니다: ${TARGET}" >&2 ;;
    *) TARGET="${QP_SSH_USER}@${TARGET}" ;;
  esac
fi
# ssh 는 `--` 를 받지 않으므로 `-` 로 시작하는 주소는 옵션으로 먹힌다 — 여기서 끊는다.
case "${TARGET}" in
  -* | *[[:space:]]*)
    echo "서버 주소 형식이 올바르지 않습니다: ${TARGET}" >&2
    exit 1
    ;;
esac

DOMAIN="${QP_DOMAIN:-}"
if [ -z "${DOMAIN}" ]; then
  read -rp "서비스 도메인 입력(예: quant.example.com): " DOMAIN || true
fi
[ -n "${DOMAIN}" ] || {
  echo "도메인이 필요합니다 — 비대화형이면 QP_DOMAIN 으로 지정하세요" >&2
  exit 1
}
# 이 값은 아래에서 원격 root 셸의 명령줄에 들어가고, provision-server.sh 안에서는 Caddyfile
# heredoc 으로 흘러간다. 호스트명 문법을 여기서 강제해 `;`·백틱·`$(...)`·공백이
# 명령이나 Caddy 지시자로 해석될 여지를 없앤다 (원격 실행 전에 막는 게 요점).
case "${DOMAIN}" in
  *[!a-zA-Z0-9.-]* | -* | .* | *. | *..*)
    echo "도메인 형식이 올바르지 않습니다: ${DOMAIN}" >&2
    echo "영문/숫자/./- 만 쓸 수 있습니다 (예: quant.example.com)" >&2
    exit 1
    ;;
esac
case "${DOMAIN}" in
  *.*) : ;;
  *) echo "도메인에 점이 없습니다: ${DOMAIN} — FQDN 을 입력하세요 (예: quant.example.com)" >&2
     exit 1 ;;
esac

# ── 여기서부터 모든 출력을 로그 파일에도 남긴다 ───────────────────────────────
# 화면에 의존하지 않는 것이 요점이다 — 터미널 종류·스크롤백 한도·창 크기와 무관하게
# 실행 기록이 남아야 한다.
# 파일명은 *.log 로 .gitignore 에 이미 걸려 있다. QP_LOG 로 경로를 바꿀 수 있다.
LOG="${QP_LOG:-${REPO_ROOT}/.logs/bootstrap-$(date -u +%Y%m%d-%H%M%S).log}"
mkdir -p "$(dirname "${LOG}")"
exec > >(tee "${LOG}") 2>&1
TEE_PID=$!

on_exit() {
  status=$?
  if [ "${status}" -ne 0 ]; then
    echo
    echo "실패 (exit ${status}). 로그: ${LOG}"
  fi
  # tee 가 마지막 줄까지 쓰도록 fd 를 닫고 기다린다 — 안 하면 끝이 잘릴 수 있다
  exec 1>&- 2>&-
  wait "${TEE_PID}" 2>/dev/null || true
  exit "${status}"
}
trap on_exit EXIT

echo "로그: ${LOG}"

# ── 접속 옵션을 환경변수에서 만든다 ──────────────────────────────────────────
# 포트와 점프 호스트를 -p / -J 가 아니라 -o 로 넘기는 이유: 같은 배열을 ssh 와 scp 에
# 함께 쓰기 때문이다. scp 의 포트 플래그는 -P 라서 -p 를 받지 못하지만 `-o Port=` 는
# 둘 다 받는다 — 배열 하나로 두 명령을 덮는 쪽이 어긋날 여지가 적다.
# ENV_HINT·SSH_FLAGS 는 실패 안내와 마지막 "다음 단계" 에서 이 실행에 쓴 조합을 그대로
# 물려주기 위한 문자열이다 (사람이 다시 조립하다 틀릴 이유를 없앤다).
SSH_OPTS=()
ENV_HINT=""
SSH_FLAGS=""

# QP_SSH_OPTS 를 맨 앞에 둔다 — ssh 는 같은 옵션이 여러 번 오면 "먼저 나온 값"을 쓰므로,
# 앞에 둬야 사용자가 아래 기본값(예: StrictHostKeyChecking)을 덮을 수 있다.
if [ -n "${QP_SSH_OPTS:-}" ]; then
  read -ra SSH_OPTS <<< "${QP_SSH_OPTS}"
  ENV_HINT="${ENV_HINT}QP_SSH_OPTS='${QP_SSH_OPTS}' "
fi

if [ -n "${SSH_KEY:-}" ]; then
  # 따옴표 안의 `~` 는 셸이 펼치지 않는다 (SSH_KEY="~/.ssh/x" 는 흔한 실수다)
  case "${SSH_KEY}" in
    '~/'*) SSH_KEY="${HOME}/${SSH_KEY#'~/'}" ;;
  esac
  [ -f "${SSH_KEY}" ] || { echo "SSH_KEY 파일이 없습니다: ${SSH_KEY}" >&2; exit 1; }
  # IdentitiesOnly 를 함께 켜는 이유는 하드닝이 MaxAuthTries 3 을 걸기 때문이다 —
  # agent 에 등록된 키까지 순서대로 제시되면 맞는 키가 4번째가 되어 서버가 먼저 끊는다.
  SSH_OPTS+=(-i "${SSH_KEY}" -o IdentitiesOnly=yes)
  ENV_HINT="${ENV_HINT}SSH_KEY=${SSH_KEY} "
  SSH_FLAGS="${SSH_FLAGS}-i ${SSH_KEY} "
fi

if [ -n "${QP_SSH_PORT:-}" ]; then
  case "${QP_SSH_PORT}" in
    '' | *[!0-9]*) echo "QP_SSH_PORT 는 숫자여야 합니다: ${QP_SSH_PORT}" >&2; exit 1 ;;
  esac
  SSH_OPTS+=(-o "Port=${QP_SSH_PORT}")
  ENV_HINT="${ENV_HINT}QP_SSH_PORT=${QP_SSH_PORT} "
  SSH_FLAGS="${SSH_FLAGS}-p ${QP_SSH_PORT} "
fi

if [ -n "${QP_SSH_JUMP:-}" ]; then
  SSH_OPTS+=(-o "ProxyJump=${QP_SSH_JUMP}")
  ENV_HINT="${ENV_HINT}QP_SSH_JUMP=${QP_SSH_JUMP} "
  SSH_FLAGS="${SSH_FLAGS}-J ${QP_SSH_JUMP} "
fi

# 호스트키 기본값을 accept-new 로 두는 이유: 접속 확인이 BatchMode 로 도는데, 처음 보는
# 호스트에서 ssh 의 기본값(ask)은 물어볼 TTY 가 없어 그냥 실패한다 — 그러면 "환경변수만
# 주면 한 번에" 가 성립하지 않고, 사람이 먼저 수동 ssh 로 지문을 수락하거나 ssh config 를
# 만들어야 한다. accept-new 는 그 수락(TOFU)을 그대로 하는 것이고, **바뀐** 호스트키는
# 여전히 거부한다 — 첫 접속 이후의 중간자는 잡힌다. 지문을 미리 아는 환경이라면 yes 로 조인다.
case "${QP_SSH_HOST_KEY:=accept-new}" in
  accept-new | yes | no) SSH_OPTS+=(-o "StrictHostKeyChecking=${QP_SSH_HOST_KEY}") ;;
  *) echo "QP_SSH_HOST_KEY 는 accept-new | yes | no 중 하나입니다: ${QP_SSH_HOST_KEY}" >&2; exit 1 ;;
esac
if [ "${QP_SSH_HOST_KEY}" != "accept-new" ]; then
  ENV_HINT="${ENV_HINT}QP_SSH_HOST_KEY=${QP_SSH_HOST_KEY} "
fi

echo "==> SSH 접속 확인: ${TARGET}"
# 이 확인이 없으면 아래 ssh/scp 가 set -e 로 조용히 죽어, 실패 원인이 그 다음 단계를
# 가리킨다 — 실제로 그렇게 오진한 적이 있다.
# stderr 를 버리지 않고 그대로 보여준다 — "Permission denied" 와 "Host key verification
# failed" 는 처방이 전혀 다른데, 감추면 사용자가 그 구분을 할 수 없다.
if ! SSH_ERR="$(ssh "${SSH_OPTS[@]}" -o ConnectTimeout=15 -o BatchMode=yes "${TARGET}" true 2>&1)"; then
  {
    echo "SSH 접속 실패: ${TARGET}"
    echo
    printf '%s\n' "${SSH_ERR}" | sed 's/^/  /'
    echo
    # 키·사용자명 안내는 인증에서 막혔을 때만 낸다 — TCP 로 닿지도 않은 실패에
    # "키 후보" 를 늘어놓으면 엉뚱한 곳을 뒤지게 만든다.
    case "${SSH_ERR}" in
      *'denied'* | *'authentication'*)
        if [[ "${TARGET}" != *@* ]]; then
          echo "주소에 사용자명이 없다. ssh 가 로컬 사용자명으로 붙는다 — 의도한 계정이 아니면"
          echo "user@host 형식으로 주거나 QP_SSH_USER 로 지정하라."
          echo "(클라우드 이미지의 관례는 제각각이다: ubuntu / admin / ec2-user 등)"
          echo
        fi
        if [ -n "${SSH_KEY:-}" ]; then
          echo "지정한 키로 붙지 못했다: ${SSH_KEY}"
          echo "키에 passphrase 가 있으면 접속 확인(BatchMode)이 물어보지 못한다 —"
          echo "ssh-add ${SSH_KEY} 로 agent 에 올린 뒤 재실행하라."
        else
          # 키를 안 넘겼을 때가 가장 흔한 실패다 — ~/.ssh 에서 후보를 찾아
          # 그대로 복사해 쓸 수 있는 명령을 만들어 준다.
          echo "키를 지정하지 않았다. ssh 는 기본 이름 키(id_ed25519 등)만 시도한다 —"
          echo "다른 이름의 키(예: 클라우드 콘솔에서 내려받은 <name>.pem)는 시도조차 하지 않는다."
          CANDIDATES="$(ls -1 ~/.ssh/*.pem ~/.ssh/id_* 2>/dev/null | grep -v '\.pub$' || true)"
          if [ -n "${CANDIDATES}" ]; then
            echo
            echo "찾은 키 후보 — 하나를 골라 다시 실행하면 된다:"
            while IFS= read -r k; do
              [ -n "${k}" ] && echo "  SSH_KEY=${k} QP_HOST=${TARGET} ./scripts/bootstrap-server.sh"
            done <<< "${CANDIDATES}"
          else
            echo
            echo "~/.ssh 에서 키 후보를 찾지 못했다. 호스트에 등록한 공개키의 짝을 확인하거나,"
            echo "새로 만들어 등록하라: ssh-keygen -t ed25519 -f ~/.ssh/quant-platform"
          fi
        fi
        echo
        ;;
    esac
    echo "ssh config 없이 환경변수로 지정할 수 있는 것들:"
    echo "  QP_SSH_USER=ubuntu  QP_SSH_PORT=2222  SSH_KEY=~/.ssh/your-key"
    echo "  QP_SSH_JUMP=user@bastion  QP_SSH_HOST_KEY=yes  QP_SSH_OPTS='-o ...'"
    echo
    echo "원인 가르기: ssh -v ${SSH_FLAGS}${TARGET} true"
    echo "  Permission denied (publickey)  → 키가 없거나 틀렸다 (또는 사용자명이 다르다)"
    echo "  Host key verification failed   → 지문 확인 (QP_SSH_HOST_KEY, ssh-keyscan)"
    echo "  Connection timed out           → 방화벽에서 TCP ${QP_SSH_PORT:-22} 가 닫혀 있다"
    echo "  Connection refused             → sshd 가 그 포트에서 듣지 않는다 (QP_SSH_PORT)"
    echo "  Unprotected private key file   → 키 파일 권한 (Windows: icacls /inheritance:r /grant:r)"
  } >&2
  exit 1
fi

echo "==> 프로비저닝 파일 업로드"
ssh "${SSH_OPTS[@]}" "${TARGET}" "mkdir -p ${REMOTE_DIR}" \
  || { echo "원격 디렉터리 생성 실패: ${REMOTE_DIR}" >&2; exit 1; }
scp "${SSH_OPTS[@]}" "${REPO_ROOT}/infra/provision-server.sh" \
    "${REPO_ROOT}/infra/systemd/quant-platform.service" \
    "${REPO_ROOT}/infra/app.env.example" \
    "${TARGET}:${REMOTE_DIR}/" \
  || { echo "파일 업로드 실패 — ${REPO_ROOT}/infra 아래 3개 파일과 원격 디스크 여유를 확인하세요" >&2; exit 1; }

# provision-server.sh 는 root 로 돌아야 하고, TTY 없이 붙는다. sudo 가 비밀번호를 물으면
# 답할 방법이 없으므로 여기서 먼저 분명하게 실패시킨다. passwordless sudo 는 이
# 도구의 전제다 (클라우드 이미지는 보통 그렇게 오지만, 자체 설치 호스트라면 직접
# 설정해야 한다).
ssh "${SSH_OPTS[@]}" "${TARGET}" "sudo -n true" \
  || { echo "sudo 에 비밀번호가 필요합니다 — 이 계정에 passwordless sudo 를 설정한 뒤 재실행하세요" >&2; exit 1; }

echo "==> 프로비저닝 (패키지·Node·UFW·sshd·Caddy·app.env·systemd)"
# 원격 셸이 한 번 더 파싱하므로 인용한다 — 위 검증과 이중 방어다
ssh "${SSH_OPTS[@]}" "${TARGET}" "sudo sh ${REMOTE_DIR}/provision-server.sh '${DOMAIN}'"

# provision-server.sh 가 sshd 를 재시작했다 — 새 연결로 즉시 재검증해 하드닝이 SSH 를
# 깨뜨렸다면 지금 크게 알린다 (퍼블릭 22 는 열려 있으므로 락아웃은 아니고,
# 최악의 경우에도 클라우드 브라우저 SSH 콘솔이 남는다).
echo "==> 프로비저닝 후 SSH 재검증"
ssh "${SSH_OPTS[@]}" -o ConnectTimeout=15 -o BatchMode=yes "${TARGET}" true \
  || { echo "프로비저닝 후 SSH 재접속 실패 — 클라우드 브라우저 SSH 콘솔로 확인하세요" >&2; exit 1; }

# 인증서의 확정 판정은 여기다 — 서버 안(hairpin 제약 가능)이 아니라 외부 시점.
echo "==> HTTPS 검증: https://${DOMAIN}"
# `|| echo 000` 을 쓰지 않는다 — 실패해도 curl 이 -w 로 이미 "000" 을 찍으므로
# 두 값이 이어붙어 "000000" 이 되고, 그러면 아래 비교가 영영 거짓이라 이 게이트가
# 항상 통과한다. `|| true` 는 set -e 만 막고 출력은 curl 것 하나로 남긴다.
CODE="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 15 "https://${DOMAIN}/" || true)"
if [ "${CODE}" = "000" ] || [ -z "${CODE}" ]; then
  echo "https://${DOMAIN} 에 TLS 로 접속하지 못했습니다." >&2
  echo "  - A 레코드가 서버 고정 IP 를 가리키는지, DNS 전파가 끝났는지 확인" >&2
  echo "  - 클라우드 방화벽에서 TCP 80·443 이 열려 있는지 확인" >&2
  echo "  - 서버에서: journalctl -u caddy --no-pager -n 50" >&2
  exit 1
fi
echo "TLS 응답 확인 (HTTP ${CODE} — 앱 배포 전에는 502 가 정상)"

cat <<MSG

부트스트랩 완료: https://${DOMAIN}

다음 단계:
  1) deploy.env 작성 후 첫 배포: pnpm run deploy
  2) 관리자 생성 + TOTP 등록 (서버에서, 순서대로):
     ssh ${SSH_FLAGS}${TARGET}
     sudo systemd-run --pty --uid=quant --gid=quant \\
       --property=EnvironmentFile=/etc/quant-platform/app.env \\
       --working-directory=/opt/quant-platform/current \\
       /usr/local/bin/node /opt/quant-platform/current/dist/server/cli.js admin:create
     sudo systemd-run --pty --uid=quant --gid=quant \\
       --property=EnvironmentFile=/etc/quant-platform/app.env \\
       --working-directory=/opt/quant-platform/current \\
       /usr/local/bin/node /opt/quant-platform/current/dist/server/cli.js totp:enroll
     TOTP 등록은 퍼블릭 노출 전 필수다 (D-017) — 미등록이면 서버가 부팅 경고를 남긴다.
  3) 클라우드 방화벽은 TCP 22·80·443 만 허용한다 (IPv4·IPv6 각각 확인)
MSG
