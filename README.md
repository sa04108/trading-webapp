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

## 배포 (스펙 §18~§31, D-016)

애플리케이션은 클라우드·증권사를 모른다. 요구사항: Ubuntu 24.04, RAM 1GB+, 고정
공인 IP (현재: AWS Lightsail Seoul, Micro $7). 접근은 Tailscale 사설망으로만 한다 —
앱은 인터넷에 노출되지 않는다.

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
3. 부트스트랩:

   ```bash
   TS_AUTHKEY=tskey-... ./scripts/bootstrap.sh <public-ip>
   ```

   §21~§29 를 멱등하게 수행한다. tailnet 경유 SSH 가 **실증된 뒤에만** UFW·SSH
   하드닝이 적용된다 (락아웃 가드). 실패 시 퍼블릭 SSH 는 살아 있다.
4. 첫 배포와 관리자 생성 (정확한 명령은 bootstrap 출력에 나온다):

   ```bash
   ./scripts/deploy.sh <fqdn>    # 검증 게이트 → 릴리스 전환 → health check → 실패 시 자동 롤백
   ```

5. (선택) Lightsail Networking 에서 TCP 22 제거 — UFW 가 이미 막는 것의 심층방어

접속: `https://<fqdn>` — 인증서는 자동 발급·갱신된다 (`tailscale serve`).
휴대폰은 Tailscale 앱 로그인 외에 설치할 것이 없다.

## 구조

```
src/server/modules/{auth,strategy,market-data,backtest,broker,audit,system}
src/workers/backtest-child.ts   # 백테스트 자식 프로세스
src/web                          # React + shadcn/ui (모바일 우선)
src/shared                       # 웹·서버 공유 스키마
```

전략은 코드로 등록한다 (`src/server/modules/strategy/strategies/`). UI 에서는 검증된 파라미터만 변경할 수 있다 (스펙 §2.5).
