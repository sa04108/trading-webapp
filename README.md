# Quant Platform

개인용 퀀트 백테스트·자동매매 플랫폼 (모듈러 모놀리스). 명세는 [docs/quant_trading_platform_spec.md](docs/quant_trading_platform_spec.md), 계획은 [docs/PLAN.md](docs/PLAN.md), 결정 기록은 [docs/DECISIONS.md](docs/DECISIONS.md), 진행 상황은 [docs/IMPLEMENTATION_STATUS.md](docs/IMPLEMENTATION_STATUS.md) 참고.

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

접근은 Tailscale 사설망으로만 한다 — 앱은 `127.0.0.1:3000` 에만 바인딩하고 인터넷에
노출되지 않는다. TLS 종단과 인증서 발급·갱신은 `tailscale serve` 가 맡는다.

**증권사 API 트래픽은 반드시 이 Static IP 로 나가야 한다.** 증권사가 허용 출발 IP 를
등록제로 운영하기 때문이다. 부트스트랩이 `checkip.amazonaws.com` 결과를 출력하니
Static IP 와 일치하는지 확인하고, 이후 이 노드에 `tailscale set --exit-node=...` 를
걸지 않는다 — 아웃바운드가 조용히 우회되어 증권사 호출이 거부된다.

1GB 호스트의 운영 제약: 동시 백테스트 1개, DuckDB 1 thread·메모리 상한 384MB,
시간봉 사전 집계, 대규모 파라미터 sweep 금지.

WireGuard·Caddy 에서 Tailscale 로 옮긴 이유와 트레이드오프는
[docs/DECISIONS.md](docs/DECISIONS.md) 의 D-016 에 있다.

### tailnet 사전 설정 (계정에 1회)

1. Tailscale 계정 + 2FA
2. DNS 설정에서 **MagicDNS** 와 **HTTPS Certificates** 활성화
3. Access Controls(ACL)에 태그 정의: `"tagOwners": { "tag:server": ["autogroup:admin"] }`
4. 개발 PC·휴대폰을 tailnet 에 조인 (앱 설치 + 로그인)

### 서버 구축 (인스턴스마다)

1. 인스턴스 생성 — Lightsail 기준: Seoul → Linux/Unix → **OS Only** →
   Ubuntu 24.04 LTS → SSH 공개키 업로드 → Micro $7 → Static IP 연결
   (Static IP 는 증권사 허용 출발 IP 용도다. launch script 는 쓰지 않는다.)
2. Tailscale 콘솔에서 auth key 발급 — **pre-authorized ✅ / `tag:server` ✅ /
   ephemeral ❌** (태그가 노드 키 만료를 막는다)
3. 부트스트랩 (auth key 는 프롬프트가 화면에 표시하지 않고 물어본다):

   ```bash
   ./scripts/bootstrap.sh <public-ip>
   ```

   `infra/provision.sh` 를 서버로 올려 두 단계로 실행한다. 멱등하므로 몇 번을 돌려도
   결과가 같다.

   **1단계 (퍼블릭 SSH 경유)**
   - apt 갱신·업그레이드, 빌드 도구 설치 (`build-essential`·`python3`·`pkg-config` —
     better-sqlite3·argon2·DuckDB 가 네이티브 모듈이라 서버에서 컴파일된다),
     `sqlite3` CLI (배포 전 DB 스냅샷과 백업이 쓴다), `jq`·`openssl`·`ufw`·
     `unattended-upgrades`
   - 서버 시간대를 UTC 로 고정 (표시 계층에서 KST 로 변환한다)
   - `quant` 시스템 유저(nologin) 와 `/opt/quant-platform`·`/etc/quant-platform`·
     `/var/lib/quant-platform/{market-data,imports,exports,temp,backups}` 생성
   - Node.js 24 를 nodejs.org 타르볼로 설치 (SHA256 검증 후 `/opt/node` 심링크),
     `corepack` 활성화
   - Tailscale 설치·조인 (`--advertise-tags=tag:server`), MagicDNS 이름 확정
   - `tailscale serve` 로 443 → `127.0.0.1:3000` 프록시 + 인증서 발급·갱신
   - `/etc/quant-platform/app.env` 생성 — `SESSION_SECRET` 은 서버에서 만든다.
     **파일이 이미 있으면 절대 덮지 않는다** (덮으면 기존 세션이 전부 무효화된다)
   - systemd 유닛 설치 후 `enable` — `start` 는 하지 않는다 (아직 `dist` 가 없다.
     첫 기동은 `deploy.sh` 가 한다)

   **락아웃 가드** — 여기서 스크립트가 tailnet 경유 SSH 를 **실제로 시도**한다.
   성공했을 때만 2단계로 넘어간다. 실패하면 경고와 함께 멈추고 퍼블릭 SSH 는 살아 있다.

   **2단계 (tailnet 경유, 검증 후에만)**
   - 되돌릴 수 없는 단계 직전에 노드가 `tag:server` 로 태그됐는지 확인한다.
     태그 없이 조인한 노드는 지금은 멀쩡하지만 노드 키가 만료되면(약 180일)
     tailnet 에서 떨어지고, 그때는 퍼블릭 22 가 닫혀 있어 들어갈 방법이 없다
   - UFW: 인바운드 기본 거부, 아웃바운드 허용, `tailscale0` 의 22 만 허용.
     **여기서 퍼블릭 22 가 닫히고 Lightsail 브라우저 SSH 콘솔도 함께 죽는다**
   - SSH 하드닝: `PermitRootLogin no`, `PasswordAuthentication no`,
     `KbdInteractiveAuthentication no`, `MaxAuthTries 3`, `LoginGraceTime 30`,
     `X11Forwarding no` (`sshd -t` 로 검증한 뒤 재시작)
   - 하드닝 후 새 연결로 tailnet SSH 를 한 번 더 확인한다

   스크립트 자동화 등으로 env var 가 꼭 필요하면 `TS_AUTHKEY=tskey-...
   ./scripts/bootstrap.sh <ip>` 도 되지만, 이 형태는 셸 히스토리에 평문으로 남는다 —
   앞에 공백을 두거나(`HISTCONTROL=ignorespace`) 실행 뒤 히스토리에서 지울 것.

   **하드닝 후 재실행은 퍼블릭 IP 가 아니라 FQDN 으로 한다**
   (`./scripts/bootstrap.sh quant-platform.<tailnet>.ts.net`, 완료 메시지에 그대로
   나온다) — UFW 가 퍼블릭 22 를 닫아서 그 경로로는 첫 명령부터 실패한다. 드물게
   재실행이 `apt full-upgrade` 도중 tailnet 세션이 끊겨 멈춘 것처럼 보일 수 있는데
   (tailscale 패키지 갱신이 tailscaled 를 재시작시킨다), 락아웃이 아니니 한 번 더
   실행하면 된다.
4. 첫 배포와 관리자 생성 (정확한 명령은 bootstrap 출력에 나온다):

   ```bash
   ./scripts/deploy.sh <fqdn>    # 검증 게이트 → 릴리스 전환 → health check → 실패 시 자동 롤백
   ```

5. (선택) 클라우드 방화벽 정리 — Lightsail Networking 에서 TCP 22·80·443·3000 과
   UDP 51820 을 제거하고, **IPv4 와 IPv6 를 각각** 확인한다. Lightsail OS-Only
   Ubuntu 기본값이 22 와 80 을 퍼블릭에 열어 두기 때문이다. UFW 가 이미 막고 있고
   그 포트에서 듣는 것도 없으므로 실질 효과는 없다 — 심층방어이자 포트 스캔 표면을
   줄이는 정리다.

접속: `https://<fqdn>` — 인증서는 자동 발급·갱신된다 (`tailscale serve`).
휴대폰은 Tailscale 앱 로그인 외에 설치할 것이 없다.

## 구조

```
src/server/modules/{auth,strategy,market-data,backtest,broker,audit,system}
src/workers/backtest-child.ts   # 백테스트 자식 프로세스
src/web                          # React + shadcn/ui (모바일 우선)
src/shared                       # 웹·서버 공유 스키마
```

전략은 코드로 등록한다 (`src/server/modules/strategy/strategies/`). UI 는 전략을 만들거나 수정하지 못하고, 등록된 전략의 검증된 파라미터만 바꿀 수 있다 — 임의 코드가 UI 를 통해 실행되는 경로를 두지 않는다.
