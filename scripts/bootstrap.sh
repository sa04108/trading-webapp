#!/usr/bin/env bash
# 서버 부트스트랩 — 새 인스턴스를 배포 가능 상태로 만든다 (설계 문서 §3·§4).
# 사용법: TS_AUTHKEY=tskey-... ./scripts/bootstrap.sh <public-ip>
#         (TS_AUTHKEY 미설정이면 프롬프트. 이미 조인된 서버 재실행이면 Enter 로 생략)
#
# 순서가 락아웃 가드다: 기본 프로비저닝(퍼블릭 SSH) → tailnet 경유 SSH 를 "실제로"
# 검증 → 성공했을 때만 --harden(UFW 가 퍼블릭 22 를 닫는다). 스펙 §25 의
# "검증 전 차단 금지" 를 사람의 규율이 아니라 제어 흐름으로 강제한다.
# 전제: 이 PC 가 tailnet 에 조인돼 있어야 한다 (tailscale status 로 확인).
set -euo pipefail

HOST="${1:?usage: bootstrap.sh <public-ip-or-host>}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REMOTE_DIR=/tmp/quant-provision

if [ -z "${TS_AUTHKEY:-}" ]; then
  read -rsp "Tailscale auth key (재실행이면 Enter): " TS_AUTHKEY
  echo
fi

echo "==> 프로비저닝 파일 업로드"
ssh "ubuntu@${HOST}" "mkdir -p ${REMOTE_DIR}"
scp "${REPO_ROOT}/infra/provision.sh" \
    "${REPO_ROOT}/infra/systemd/quant-platform.service" \
    "${REPO_ROOT}/infra/app.env.example" \
    "ubuntu@${HOST}:${REMOTE_DIR}/"

echo "==> 기본 프로비저닝 (§21·22·23·28·29)"
OUT="$(mktemp)"
trap 'rm -f "${OUT}"' EXIT
# 키는 stdin 으로 — argv·원격 히스토리에 남기지 않는다
printf '%s\n' "${TS_AUTHKEY}" \
  | ssh "ubuntu@${HOST}" "sudo sh ${REMOTE_DIR}/provision.sh" \
  | tee "${OUT}"

FQDN="$(grep '^FQDN=' "${OUT}" | tail -1 | cut -d= -f2)"
[ -n "${FQDN}" ] || { echo "출력에서 FQDN= 마커를 찾지 못했습니다" >&2; exit 1; }

echo "==> tailnet 경유 SSH 검증: ${FQDN}"
if ssh -o ConnectTimeout=15 -o BatchMode=yes "ubuntu@${FQDN}" true; then
  echo "==> 하드닝 (§25 UFW + §26 SSH) — 퍼블릭 22 가 닫힌다"
  ssh "ubuntu@${FQDN}" "sudo sh ${REMOTE_DIR}/provision.sh --harden"
else
  cat >&2 <<MSG
경고: tailnet 경유 SSH 실패 — 하드닝을 건너뜁니다. 퍼블릭 SSH 는 살아 있습니다.
  1) 이 PC 가 tailnet 에 있는지 확인: tailscale status
  2) 해결 후 하드닝만 재실행:
     ssh ubuntu@${FQDN} sudo sh ${REMOTE_DIR}/provision.sh --harden
MSG
  exit 1
fi

cat <<MSG

부트스트랩 완료: https://${FQDN}

다음 단계:
  1) 첫 배포:      ./scripts/deploy.sh ${FQDN}
  2) 관리자 생성 (1회, 서버에서):
     ssh ubuntu@${FQDN}
     sudo systemd-run --pty --uid=quant --gid=quant \\
       --property=EnvironmentFile=/etc/quant-platform/app.env \\
       --working-directory=/opt/quant-platform/current \\
       /usr/local/bin/node /opt/quant-platform/current/dist/server/cli.js admin:create
  3) (선택) Lightsail Networking 에서 TCP 22 제거 — UFW 심층방어
MSG
