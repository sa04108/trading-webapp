# Quant Platform

개인용 퀀트 백테스트·자동매매 플랫폼 (모듈러 모놀리스). 명세는 [docs/SPEC.md](docs/SPEC.md), 신규 개발자 온보딩은 [docs/ONBOARDING.md](docs/ONBOARDING.md), 결정 기록은 [docs/DECISIONS.md](docs/DECISIONS.md), 진행 상황은 [docs/IMPLEMENTATION_STATUS.md](docs/IMPLEMENTATION_STATUS.md) 참고.

## 개발

```bash
pnpm install
pnpm dev        # Fastify API (127.0.0.1:3000)
pnpm dev:web    # Vite dev 서버 (API 프록시)
```

관리자 생성 (최초 1회):

```bash
pnpm cli admin:create
```

CSV 형식: `timestamp,open,high,low,close,volume` (timestamp 는 ISO 8601 UTC 또는 epoch ms). 1분봉은 가져올 때 KR 세션(09:00–15:30 KST) 기준 1시간봉으로 자동 집계된다.

재무전략이나 PER·ROE 유니버스 단계를 쓰는 백테스트는 준비(preparation) 단계가 DART 공시를
요청 기간과 최소 warm-up 만큼만 자동으로 수집한다 — CLI 로 미리 돌리는 절차는 없다.
`DART_API_KEY` 를 넣지 않으면 그 준비만 비활성이다(`infra/app.env.example` 참고). 일일
호출 한도에 닿아 대기하는 것은 실패가 아니라 다음 KST 날짜에 자동으로 이어진다. 준비
작업은 한 번에 하나만 돌고 서버가 재시작돼도 중단된 지점부터 이어지며, 취소해도 이미
저장한 종목 데이터는 지우지 않는다.

## 검증 게이트

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm build
pnpm test:e2e   # Playwright (390×844 / 1440×900)
```

## 배포

애플리케이션은 클라우드·증권사를 모른다. 호스트 요구사항은 Ubuntu 24.04(또는 동등한
Linux), RAM 1GB 이상, 스토리지 40GB 이상, 고정 공인 IP, 월 10 USD 미만이다. 이걸
만족하면 어떤 VPS 로도 교체할 수 있다. 현재 선택은 AWS Lightsail 서울 Micro
($7/월, 2 vCPU / 1GB / 40GB)다.

플랫폼은 도메인 + Caddy(Let's Encrypt) 로 퍼블릭에 노출된다. 앱 자체는
`127.0.0.1:3000` 에만 바인딩하고 Caddy 가 앞에서 TLS 를 종단한다. 플랫폼은 조회
평면이라(스펙 §2.6 — 돈·전략·보안 조작은 SSH CLI 전용) 이 노출이 허용된다.
인증은 비밀번호 + TOTP 2단계다 (스펙 §16).

**증권사 API 트래픽은 반드시 이 고정 공인 IP 로 나가야 한다.** 증권사가 허용 출발
IP 를 등록제로 운영하기 때문이다. 프로비저닝이 아웃바운드 IP 를 조회해 출력하니
등록한 IP 와 일치하는지 확인한다. 조회는 공개 IP echo 서비스 몇 곳을 순서대로
시도한다(특정 업체에 묶지 않기 위해서다) — 다른 엔드포인트를 쓰려면
`OUTBOUND_IP_URL` 로 지정한다.

1GB 호스트의 운영 제약: 동시 백테스트 1개, 봉 수 상한 200만, 대규모 파라미터
sweep 금지.

배포 후 실행비용 표본은 `backtest:telemetry-report` CLI로 확인한다. 완료 10개, 입력
규모 3종, 최소·최대 4배 차이가 모이기 전에는 병렬도 추천을 내지 않으며, 표본이 충분해도
이 1GB 호스트의 동시성은 1로 유지한다. 운영용 `systemd-run` 전체 명령은 명세 §28.2에
있다.

### 별도 PC 원격 백테스트 worker

기본값은 그대로 `BACKTEST_EXECUTION_MODE=local`, `MAX_CONCURRENT_BACKTESTS=1`이다.
Lightsail에서 계산을 빼려면 서버를 `remote`로 바꾸고, 같은 릴리스 아티팩트를 별도 PC에
서 Docker Compose Worker image로 실행한다. Worker는 인바운드 포트를 열지 않고
서버 HTTPS로 작업을 long-poll한 뒤, job 전용 SQLite 입력을 받아 계산하고 결과 SQLite를
streaming 업로드한다. 서버와 worker의 Git SHA가 다르면 claim 자체가 거부된다.

설정 예시는 `infra/app.env.example`, `infra/worker.env.example`에 있다. Worker 호스트는
`scripts/bootstrap-worker.sh`로 Docker와 전용 경로만 준비한다. 이후 수동
`pnpm run deploy --target all`이 app과 worker에 같은 release를 배포하고 checksum 검증,
container 전환, 인증·SHA·protocol probe와 실패 rollback까지 수행한다.
호스트에 생성하는 경로와 보존 정책은
`/opt/quant-backtest-worker/managed-paths.json` manifest로 추적한다.
애플리케이션 systemd unit이나 fallback은 없다. 개발 PC에서는 worker env를 넣고
`pnpm worker:remote`로 직접 실행할 수 있다. 실제 원격 동시 실행 수는 worker별
`BACKTEST_WORKER_CONCURRENCY`로 조절하며 여러 worker PC도 같은 큐를 공유할 수 있다.
처음에는 1로 시작하고 `backtest:telemetry-report`의 메모리·시간 표본을 근거로 올린다.
remote 모드에서는 서버의 `MAX_CONCURRENT_BACKTESTS`는 사용되지 않는다.
배포·전환·장애 복구 순서는 [원격 worker 운영 문서](docs/REMOTE_WORKER_OPERATIONS.md)를 따른다.

Tailscale 에서 퍼블릭 + Caddy 로 옮긴 이유와 트레이드오프는
[docs/DECISIONS.md](docs/DECISIONS.md) 의 D-017 에 있다.

### 사전 준비 (1회)

1. 도메인 확보 — 서버의 고정 공인 IP 를 가리키는 A 레코드를 만든다.
2. 호스트 준비 — Ubuntu 24.04 LTS, 고정 공인 IP 연결, SSH 공개키 등록,
   passwordless sudo.

   AWS Lightsail 예: `Seoul → Linux/Unix → OS Only → Ubuntu 24.04 LTS →
   SSH 공개키 업로드 → Micro $7 → Static IP 연결`
3. 클라우드 방화벽은 TCP 22·80·443 만 허용한다 (IPv4·IPv6 각각 확인).
   퍼블릭 22 는 의도적으로 열어 둔다 — 클라우드 브라우저 SSH 콘솔이 out-of-band
   복구 경로다. UFW 의 `limit` 와 sshd 키 전용 인증이 브루트포스를 막는다.

### 서버 구축 (인스턴스마다)

```bash
./scripts/bootstrap-server.sh
```

서버 주소(`[user@]host`)와 도메인을 순서대로 물어본다. 비대화형은 환경변수로 지정한다 —
**`~/.ssh/config` 를 만들지 않아도 한 줄로 끝난다:**

```bash
SSH_KEY=~/.ssh/your-key QP_SSH_USER=ubuntu QP_HOST=203.0.113.10 \
  QP_DOMAIN=quant.example.com ./scripts/bootstrap-server.sh
```

아래 저수준 접속 환경변수는 `bootstrap-server.sh`가 인식한다:

| 변수 | 뜻 |
| --- | --- |
| `QP_HOST` | 서버 주소, `[user@]host` |
| `QP_SSH_USER` | 로그인 사용자명 — `QP_HOST` 에 `user@` 가 없을 때만 쓴다 |
| `QP_SSH_PORT` | SSH 포트 (미지정이면 22) |
| `SSH_KEY` | 개인키 경로. `~/` 로 시작하면 스크립트가 펼친다 |
| `QP_SSH_JUMP` | 점프 호스트, `[user@]host[:port]` (ProxyJump) |
| `QP_SSH_HOST_KEY` | 호스트키 확인: `accept-new`(기본) \| `yes` \| `no` |
| `QP_SSH_OPTS` | 그 밖의 ssh 옵션 그대로 (예: `-o ServerAliveInterval=30`). 맨 앞에 붙으므로 위 기본값을 덮는다 |

포트·점프는 `-p`/`-J` 가 아니라 `-o Port=`·`-o ProxyJump=` 로 넘어간다 — 같은 옵션
배열을 `scp` 에도 쓰기 때문이다 (`scp` 의 포트 플래그는 `-P` 다).

호스트키 기본값이 `accept-new` 인 이유는 접속 확인이 `BatchMode` 로 돌기 때문이다 —
처음 보는 호스트에서 ssh 의 기본값(`ask`)은 물어볼 TTY 가 없어 그냥 실패하고, 그러면
"환경변수만 주면 한 번에" 가 성립하지 않는다. `accept-new` 는 사람이 프롬프트에서 하는
수락(TOFU)과 같고, **바뀐** 호스트키는 여전히 거부한다. 지문을 미리 아는 환경이라면
`QP_SSH_HOST_KEY=yes` 로 조이고 `ssh-keyscan` 으로 `known_hosts` 에 넣는다.

**서버 주소는 `[user@]host` 형식이다.** 로그인 사용자명은 호스트마다 다르므로
(클라우드 이미지 관례가 `ubuntu`·`admin`·`ec2-user` 등으로 갈리고 자체 설치는 임의)
스크립트가 가정하지 않는다. 둘 다 생략하면 로컬 사용자명이 쓰인다.

**인증은 공개키만 지원한다.** 프로비저닝이 sshd 에 `PasswordAuthentication no` 를
쓰므로 비밀번호로는 들어올 수 없다. 키는 `SSH_KEY=~/.ssh/your-key` 로 넘긴다 (키에
passphrase 가 있으면 `ssh-add` 로 agent 에 먼저 올린다 — 접속 확인이 `BatchMode` 라
물어보지 못한다). 키를 잃어도 클라우드 브라우저 SSH 콘솔로 들어갈 수 있다.

`~/.ssh/config` 에 `Host` 항목을 만들어 써도 된다 — 만들지 **않아도** 된다는 것이
요점이다. 한 번 쓰고 버리는 인스턴스마다 로컬 설정 파일을 고치지 않아도 된다.

**`sudo` 는 비밀번호 없이 되어야 한다** — `provision-server.sh` 가 root 로 돌아야 하고
프롬프트에 답할 TTY 가 없다.

`infra/provision-server.sh` 는 멱등한 단일 실행이다:

- apt 갱신·업그레이드, 빌드 도구 (`build-essential`·`python3`·`pkg-config` —
  better-sqlite3·argon2가 네이티브 모듈이라 서버에서 컴파일된다),
  `sqlite3` CLI, `jq`·`openssl`·`ufw`·`unattended-upgrades`
- 서버 시간대 UTC 고정, `quant` 시스템 유저(nologin), 디렉터리 트리
- Node.js 24 (nodejs.org 타르볼, SHA256 검증, `/opt/node` 심링크)
- UFW: 인바운드 기본 거부 + 22(rate-limit)·80·443 허용
- sshd 하드닝: `PermitRootLogin no`, `PasswordAuthentication no`,
  `KbdInteractiveAuthentication no`, `MaxAuthTries 3`, `LoginGraceTime 30`,
  `X11Forwarding no`
- Caddy (공식 apt repo): `<도메인> → 127.0.0.1:3000` 리버스 프록시, Let's
  Encrypt 발급·갱신 자동. 보안 헤더·압축은 앱이 담당하므로 Caddy 는 프록시만 한다
- `/etc/quant-platform/app.env` 생성 — `SESSION_SECRET` 은 서버에서 만든다.
  **파일이 이미 있으면 절대 덮지 않는다** (덮으면 기존 세션이 전부 무효화된다)
- systemd 유닛 설치 후 `enable` — `start` 는 하지 않는다 (첫 기동은 통합 배포)

마지막에 bootstrap 이 개발 PC 시점에서 `https://<도메인>` 의 TLS 응답을 확인한다 —
앱 배포 전에는 502 가 정상이다.

### 첫 배포와 계정

프로젝트 루트의 Ansible inventory 예제를 복사해 app과 선택적 worker 접속 정보를 채운다.
실제 inventory는 Git에서 제외되며 SSH config는 선택 사항이다. inventory의
`ansible_host`·`ansible_user`·`ansible_ssh_private_key_file`을 직접 사용할 수 있다.

```bash
cp ansible/inventory.example.yml ansible/inventory.yml
python3 -m venv .venv-ansible
.venv-ansible/bin/pip install -r ansible/requirements.txt
export PATH="$(pwd)/.venv-ansible/bin:$PATH"
```

배포는 자동으로 시작되지 않는다. 무인자 실행은 inventory의 `worker` 그룹에 호스트가
있으면 app과 worker를, 없으면 app만 선택한다. 명시적 `all`은 양쪽 호스트가 모두 있어야
하며 두 preflight를 먼저 통과한 뒤 공통 release를 한 번만 생성한다.

```bash
pnpm run deploy
pnpm run deploy --target app
pnpm run deploy --target worker
pnpm run deploy --target all
```

다른 inventory는 Ansible 표준 환경변수로 지정한다.

```bash
ANSIBLE_INVENTORY=/secure/production.yml pnpm run deploy
```

`app`과 `worker`는 inventory group 이름으로 고정한다. 프로젝트 CLI의 `--target`은
배포 component를 명시적으로 제한하고 내부에서 Ansible `--limit`으로 변환된다. worker가
선택되면 실행 중 image의 Git SHA와 관계없이 새 image를 검증하고 container를 재생성한다.

Ansible은 격리된 로컬 venv에서만 실행되고 노드에는 상주 agent를 설치하지 않는다.
버전은 `ansible/requirements.txt`에 고정한다.

배포 후 서버에서 관리자 생성과 TOTP 등록을 순서대로 한다 (정확한 명령은 bootstrap
출력에 나온다):

```bash
pnpm cli admin:create   # 실제로는 systemd-run 래핑 — bootstrap 출력 참고
pnpm cli totp:enroll    # 퍼블릭 노출 전 필수 (D-017) — 미등록이면 부팅 경고
```

TOTP 등록·재발급은 CLI 에서만 할 수 있다 — 웹 세션이 탈취돼도 2단계 인증을
바꿔치기할 수 없다 (스펙 §2.6).

접속: `https://<도메인>` — 인증서는 자동 발급·갱신된다 (Caddy).

## 구조

```
src/server/modules/{auth,strategy,market-data,backtest,broker,audit,system}
src/workers/backtest-child.ts              # 실제 백테스트 계산 자식 프로세스
src/workers/remote-backtest-supervisor.ts  # 원격 lease/heartbeat/업로드 supervisor
src/web                          # React + shadcn/ui (모바일 우선)
src/shared                       # 웹·서버 공유 스키마
```

전략은 코드로 등록한다 (`src/server/modules/strategy/strategies/`). UI 는 전략을 만들거나 수정하지 못하고, 등록된 전략의 검증된 파라미터만 바꿀 수 있다 — 임의 코드가 UI 를 통해 실행되는 경로를 두지 않는다.
