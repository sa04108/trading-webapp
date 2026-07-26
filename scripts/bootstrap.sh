#!/usr/bin/env bash
# 서버 부트스트랩 — 새 호스트를 배포 가능 상태로 만든다 (설계 문서 §3·§4).
#
# 사용법: ./scripts/bootstrap.sh
#         서버 주소와 auth key 를 순서대로 물어본다. 비대화형으로 돌리려면
#         QP_HOST / TS_AUTHKEY / SSH_KEY 환경변수를 미리 설정한다.
#
#   QP_HOST    서버 주소, `[user@]host` 형식. 첫 실행은 퍼블릭 IP, 하드닝 이후에는
#              tailnet FQDN 이어야 한다 — UFW 가 퍼블릭 22 를 닫아서 그 경로로는
#              첫 명령(ssh)부터 죽는다. user 를 생략하면 ssh 의 규칙에 맡긴다
#              (~/.ssh/config 의 User, 없으면 로컬 사용자명).
#   TS_AUTHKEY Tailscale auth key. 이미 조인된 서버 재실행이면 비워도 된다.
#   SSH_KEY    개인키 경로. 지정하면 -i 로 넘긴다. 없으면 ~/.ssh/config 나
#              기본 이름 키(id_ed25519 등)에 의존한다.
#
# 이 스크립트는 로그인 사용자명을 가정하지 않는다 — 클라우드 이미지마다 다르고
# (ubuntu / admin / ec2-user), 자체 설치 호스트는 임의다. 스펙 §2.1 의 "애플리케이션과
# 도구는 특정 클라우드를 모른다" 를 따른다.
#
# 인증은 공개키만 지원한다. 비밀번호 인증을 넣지 않는 이유는 이 도구가
# --harden 단계에서 PasswordAuthentication no 를 직접 쓰기 때문이다 (스펙 §26) —
# 어떤 호스트에서든 프로비저닝이 끝나면 비밀번호로는 다시 들어올 수 없고,
# 재실행·배포 경로가 전부 막힌다. 한 실행에 ssh/scp 가 5~6회 호출되므로 매번
# 프롬프트가 뜨는 문제도 있고, 아래 sudo 확인은 어차피 passwordless sudo 를 요구한다.
#
# 순서가 락아웃 가드다: 기본 프로비저닝(퍼블릭 SSH) → tailnet 경유 SSH 를 "실제로"
# 검증 → 성공했을 때만 --harden(UFW 가 퍼블릭 22 를 닫는다). 스펙 §25 의
# "검증 전 차단 금지" 를 사람의 규율이 아니라 제어 흐름으로 강제한다.
# 전제: 이 PC 가 tailnet 에 조인돼 있어야 한다 (tailscale status 로 확인).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REMOTE_DIR=/tmp/quant-provision

# ── 입력은 로그 리다이렉트보다 먼저 받는다 ────────────────────────────────────
# tee 를 거치면 프롬프트가 버퍼링에 걸려 화면에 안 나타날 수 있다. 입력을 다 받은
# 뒤에 리다이렉트를 걸어 그 위험을 없앤다. 여기까지는 로그에 남지 않지만, 남길 것도
# 없다 — 사용자가 방금 타이핑한 값이고 auth key 는 애초에 기록하면 안 된다.
# read 뒤의 `|| true`: 비대화형 실행(stdin 이 /dev/null·닫힘)에서 read 는 EOF 로
# 비영점 종료한다. 그러면 set -e 가 여기서 스크립트를 죽여, 바로 아래의 사람이 읽을
# 안내가 실행되지 못하고 설명 없는 exit 1 만 남는다. 값의 유무 판단은 다음 줄에 맡긴다.
TARGET="${QP_HOST:-}"
if [ -z "${TARGET}" ]; then
  read -rp "서버 주소 [user@]host (첫 실행은 퍼블릭 IP, 하드닝 후에는 tailnet FQDN): " TARGET || true
fi
[ -n "${TARGET}" ] || {
  echo "서버 주소가 필요합니다 — 비대화형이면 QP_HOST 로 지정하세요" >&2
  exit 1
}

# 뒤에서 tailnet FQDN 으로 다시 붙을 때 같은 사용자를 이어 쓰기 위해 user 부분을 떼어둔다.
# user 를 안 적었으면 빈 문자열 — 그대로 ssh 의 기본 규칙에 맡긴다.
USER_PREFIX=""
case "${TARGET}" in
  *@*) USER_PREFIX="${TARGET%@*}@" ;;
esac

if [ -z "${TS_AUTHKEY:-}" ]; then
  # EOF 도 "빈 키" 로 받는다 — 이미 조인된 서버 재실행은 키가 필요 없고(provision.sh 가
  # 판단한다), 비대화형 실행이 여기서 조용히 죽으면 원인을 찾을 수 없다.
  read -rsp "Tailscale auth key (재실행이면 Enter): " TS_AUTHKEY || TS_AUTHKEY=""
  echo
fi

# ── 여기서부터 모든 출력을 로그 파일에도 남긴다 ───────────────────────────────
# 화면에 의존하지 않는 것이 요점이다. 스크롤백 한도, 터미널 제어 시퀀스(pnpm·vitest
# 등이 진행 표시를 지우며 앞 줄까지 함께 지운다), 창 크기에 흔들리지 않는다.
# 파일명은 *.log 로 .gitignore 에 이미 걸려 있다. QP_LOG 로 경로를 바꿀 수 있다.
LOG="${QP_LOG:-${REPO_ROOT}/.logs/bootstrap-$(date -u +%Y%m%d-%H%M%S).log}"
mkdir -p "$(dirname "${LOG}")"
exec > >(tee "${LOG}") 2>&1
TEE_PID=$!

# 실패 지점이 여러 곳이라(SSH preflight·업로드·sudo·프로비저닝·하드닝) EXIT trap
# 하나로 묶는다 — 임시 파일 정리 trap 을 스크립트 중간에 걸면 그 앞의 실패는 안 걸린다.
on_exit() {
  status=$?
  if [ -n "${OUT:-}" ]; then rm -f "${OUT}"; fi
  if [ "${status}" -ne 0 ]; then
    echo
    echo "실패 (exit ${status}). 화면이 지워졌어도 전체 기록은 여기 있다:"
    echo "  ${LOG}"
  else
    echo
    echo "전체 로그: ${LOG}"
  fi
  # tee 가 마지막 줄까지 쓰도록 fd 를 닫고 기다린다 — 안 하면 끝이 잘릴 수 있다
  exec 1>&- 2>&-
  wait "${TEE_PID}" 2>/dev/null || true
  exit "${status}"
}
trap on_exit EXIT

echo "로그: ${LOG}"

# 키 지정은 선택이다 — SSH_KEY 가 있으면 -i 로 넘기고, 없으면 ssh 의 평소 규칙
# (~/.ssh/config, 기본 이름 키)에 맡긴다. IdentitiesOnly 를 함께 켜는 이유는
# 하드닝이 MaxAuthTries 3 을 걸기 때문이다 — agent 에 등록된 키까지 순서대로
# 제시되면 맞는 키가 4번째가 되어 서버가 먼저 연결을 끊을 수 있다.
SSH_OPTS=()
if [ -n "${SSH_KEY:-}" ]; then
  [ -f "${SSH_KEY}" ] || { echo "SSH_KEY 파일이 없습니다: ${SSH_KEY}" >&2; exit 1; }
  SSH_OPTS=(-i "${SSH_KEY}" -o IdentitiesOnly=yes)
fi

echo "==> SSH 접속 확인: ${TARGET}"
# 이 확인이 없으면 아래 ssh/scp 가 set -e 로 조용히 죽어, 실패 원인이 그 다음 단계
# (auth key 입력 직후처럼) 엉뚱한 곳을 가리킨다 — 실제로 그렇게 오진한 적이 있다.
ssh "${SSH_OPTS[@]}" -o ConnectTimeout=15 -o BatchMode=yes "${TARGET}" true 2>/dev/null || {
  {
    echo "SSH 접속 실패: ${TARGET}"
    echo
    if [ -z "${USER_PREFIX}" ]; then
      echo "주소에 사용자명이 없다. ssh 가 ~/.ssh/config 의 User 나 로컬 사용자명을 쓴다 —"
      echo "의도한 계정이 아니면 user@host 형식으로 다시 지정하라."
      echo "(클라우드 이미지의 관례는 제각각이다: ubuntu / admin / ec2-user 등)"
      echo
    fi
    if [ -n "${SSH_KEY:-}" ]; then
      echo "지정한 키로 붙지 못했다: ${SSH_KEY}"
    else
      # 키를 안 넘겼을 때가 가장 흔한 실패다 — ~/.ssh 에서 후보를 찾아
      # 그대로 복사해 쓸 수 있는 명령을 만들어 준다.
      echo "키를 지정하지 않았다. ssh 는 ~/.ssh/config 나 기본 이름 키만 시도한다 —"
      echo "다른 이름의 키(예: 클라우드 콘솔에서 내려받은 <name>.pem)는 시도조차 하지 않는다."
      CANDIDATES="$(ls -1 ~/.ssh/*.pem ~/.ssh/id_* 2>/dev/null | grep -v '\.pub$' || true)"
      if [ -n "${CANDIDATES}" ]; then
        echo
        echo "찾은 키 후보 — 하나를 골라 다시 실행하면 된다:"
        while IFS= read -r k; do
          [ -n "${k}" ] && echo "  SSH_KEY=${k} ./scripts/bootstrap.sh"
        done <<< "${CANDIDATES}"
      else
        echo
        echo "~/.ssh 에서 키 후보를 찾지 못했다. 호스트에 등록한 공개키의 짝을 확인하거나,"
        echo "새로 만들어 등록하라: ssh-keygen -t ed25519 -f ~/.ssh/quant-platform"
      fi
      echo
      echo "매번 지정하지 않으려면 ~/.ssh/config 에 등록해도 된다:"
      echo "  Host ${TARGET##*@} quant-platform.*.ts.net"
      echo "    User <로그인 사용자명>"
      echo "    IdentityFile ~/.ssh/<your-key>"
      echo "    IdentitiesOnly yes"
    fi
    echo
    echo "원인 가르기: ssh -v ${SSH_KEY:+-i ${SSH_KEY} }${TARGET} true"
    echo "  Permission denied (publickey) → 키가 없거나 틀렸다 (또는 사용자명이 다르다)"
    echo "  Connection timed out          → 방화벽에서 TCP 22 가 닫혀 있다"
    echo "  Unprotected private key file  → 키 파일 권한 (Windows: icacls /inheritance:r /grant:r)"
  } >&2
  exit 1
}

echo "==> 프로비저닝 파일 업로드"
ssh "${SSH_OPTS[@]}" "${TARGET}" "mkdir -p ${REMOTE_DIR}" \
  || { echo "원격 디렉터리 생성 실패: ${REMOTE_DIR}" >&2; exit 1; }
scp "${SSH_OPTS[@]}" "${REPO_ROOT}/infra/provision.sh" \
    "${REPO_ROOT}/infra/systemd/quant-platform.service" \
    "${REPO_ROOT}/infra/app.env.example" \
    "${TARGET}:${REMOTE_DIR}/" \
  || { echo "파일 업로드 실패 — ${REPO_ROOT}/infra 아래 3개 파일과 원격 디스크 여유를 확인하세요" >&2; exit 1; }

# provision.sh 는 root 로 돌아야 하고, 다음 단계는 TTY 없이 파이프로 붙는다.
# sudo 가 비밀번호를 물으면 그 프롬프트에 답할 방법이 없으므로 여기서 먼저 분명하게
# 실패시킨다. passwordless sudo 는 이 도구의 전제다 (클라우드 이미지는 보통 그렇게
# 오지만, 자체 설치 호스트라면 직접 설정해야 한다).
ssh "${SSH_OPTS[@]}" "${TARGET}" "sudo -n true" \
  || { echo "sudo 에 비밀번호가 필요합니다 — 이 계정에 passwordless sudo 를 설정한 뒤 재실행하세요" >&2; exit 1; }

echo "==> 기본 프로비저닝 (§21·22·23·28·29)"
OUT="$(mktemp)"   # 정리는 위의 on_exit 가 맡는다
# 키는 stdin 으로 — argv·원격 히스토리에 남기지 않는다
printf '%s\n' "${TS_AUTHKEY}" \
  | ssh "${SSH_OPTS[@]}" "${TARGET}" "sudo sh ${REMOTE_DIR}/provision.sh" \
  | tee "${OUT}"

# pipeline 이 매치 실패로 비어있는 값을 낼 때 grep 의 실패 종료 코드가 `set -e` 로
# 대입문 자체를 즉사시켜, 바로 아래의 사람이 읽을 에러 메시지가 실행되지 못하고
# 조용히 exit 1 만 남는 문제가 있었다 — `|| true` 로 대입의 성공 여부를 무의미하게
# 만들고, 값의 유무 판단은 다음 줄의 `-n` 검사에 전적으로 맡긴다.
# `-f2-` 사용: 값에 `=` 가 들어가도(예: base64 뒤에 `=` 패딩) 잘리지 않는다.
FQDN="$(grep '^FQDN=' "${OUT}" | tail -1 | cut -d= -f2-)" || true
[ -n "${FQDN}" ] || { echo "출력에서 FQDN= 마커를 찾지 못했습니다" >&2; exit 1; }

# tailnet 경유로 붙을 때도 처음 지정한 사용자를 그대로 이어 쓴다
TAILNET_TARGET="${USER_PREFIX}${FQDN}"

echo "==> tailnet 경유 SSH 검증: ${TAILNET_TARGET}"
# StrictHostKeyChecking=accept-new: FQDN 은 이 PC 가 처음 접속하는 이름이라
# (첫 주소와 다른 known_hosts 항목) BatchMode=yes 하의 기본값(ask)이면 비대화형으로
# 즉시 실패한다. 첫 접속을 자동 신뢰해도 되는 이유는 이 이름이 tailnet 안에서만
# 해석되고 Tailscale 자체가 노드 신원을 인증하기 때문 — 다만 "바뀐" 키(재접속 시
# 불일치, MITM 의심)는 accept-new 에서도 여전히 거부된다. StrictHostKeyChecking=no
# 는 그 거부까지 없애버리므로 쓰지 않는다.
if ssh "${SSH_OPTS[@]}" -o ConnectTimeout=15 -o BatchMode=yes -o StrictHostKeyChecking=accept-new \
       "${TAILNET_TARGET}" true; then
  echo "==> 하드닝 (§25 UFW + §26 SSH) — 퍼블릭 22 가 닫힌다"
  ssh "${SSH_OPTS[@]}" "${TAILNET_TARGET}" "sudo sh ${REMOTE_DIR}/provision.sh --harden"

  # harden 의 ssh 가 접근이 증명된 마지막 순간이다. UFW 규칙이 실제 사용 경로와
  # 어긋나거나(예: IPv6) sshd 가 안 돌아오면 퍼블릭 22 도 닫히고 콘솔 경로도 죽은
  # 뒤에야 알게 된다 — 새 연결로 즉시 재검증해 그 순간 크게 알린다.
  echo "==> 하드닝 후 재확인 — 새 연결로 tailnet SSH 재검증"
  ssh "${SSH_OPTS[@]}" -o ConnectTimeout=15 -o BatchMode=yes "${TAILNET_TARGET}" true \
    || { echo "하드닝 후 tailnet SSH 가 끊겼습니다 — 즉시 확인하세요" >&2; exit 1; }
else
  cat >&2 <<MSG
경고: tailnet 경유 SSH 실패 — 하드닝을 건너뜁니다. 퍼블릭 SSH 는 살아 있습니다.
  가능한 원인:
    1) 이 PC 가 tailnet 에 없음 — 확인: tailscale status
    2) 호스트 키 검증 실패 — known_hosts 충돌(키가 바뀐 경우만; 최초 접속은 자동 수락됨)
  해결 후 하드닝만 재실행:
     ssh ${SSH_KEY:+-i ${SSH_KEY} }${TAILNET_TARGET} sudo sh ${REMOTE_DIR}/provision.sh --harden
MSG
  exit 1
fi

cat <<MSG

부트스트랩 완료: https://${FQDN}

다음 단계:
  1) 첫 배포:      ${SSH_KEY:+SSH_KEY=${SSH_KEY} }QP_HOST=${TAILNET_TARGET} ./scripts/deploy.sh
  2) 관리자 생성 (1회, 서버에서):
     ssh ${SSH_KEY:+-i ${SSH_KEY} }${TAILNET_TARGET}
     sudo systemd-run --pty --uid=quant --gid=quant \\
       --property=EnvironmentFile=/etc/quant-platform/app.env \\
       --working-directory=/opt/quant-platform/current \\
       /usr/local/bin/node /opt/quant-platform/current/dist/server/cli.js admin:create
  3) (선택) 클라우드 방화벽에서 퍼블릭 TCP 22 제거 — UFW 가 이미 막는 것의 심층방어

참고: 이 스크립트를 다시 실행할 일이 있으면 서버 주소를 퍼블릭 IP 가 아니라 FQDN 으로
      입력하라 — 하드닝이 퍼블릭 22 를 닫아서 그 경로는 첫 명령부터 실패한다.
      비대화형으로 돌리려면: ${SSH_KEY:+SSH_KEY=${SSH_KEY} }QP_HOST=${TAILNET_TARGET} ./scripts/bootstrap.sh
MSG
