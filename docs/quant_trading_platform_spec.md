# Quant Trading Platform 구현·배포 명세

> **용도:** Claude Fable 5에 전달할 TypeScript 기반 퀀트 백테스트·자동매매 플랫폼 구현 지침  
> **기준일:** 2026-07-25  
> **우선순위:** 백테스트 → Paper Trading → 소액 실거래  
> **실행 환경:** 고정 공인 IP를 제공하는 Linux 호스트 — 인프라 결정, 애플리케이션은 모름 (현재: AWS Lightsail 서울)  
> **증권사 연동:** REST 전용 어댑터 — 인프라 결정, 애플리케이션은 모름 (1차: 키움 REST API, 이후 토스)  
> **접근 방식:** 기존 WireGuard VPN 내부에서만 접근  
> **프론트엔드:** React + shadcn/ui, 모바일 우선  
> **비용 목표:** 월 10 USD 미만

---

# 1. 프로젝트 목표

외부에서 휴대폰으로 WireGuard VPN에 연결한 뒤 내부 웹 화면에서 다음 작업을 수행할 수 있는 개인용 플랫폼을 만든다.

1. 전략 선택
2. 전략 파라미터 입력
3. 데이터셋·종목·기간 선택
4. 초기 자본·수수료·세금·슬리피지 설정
5. 원격 서버에 백테스트 작업 제출
6. 대기·실행·완료·실패·취소 상태 확인
7. 자산 곡선, 낙폭, 성과 지표, 거래 내역 조회
8. 과거 실행 결과 복제·비교
9. 데이터 커버리지와 누락 구간 확인
10. 향후 동일 전략 코어를 Paper Trading과 실거래에 사용

이 프로젝트는 공개 서비스가 아니다. **퍼블릭 도메인, 퍼블릭 웹 포트, 공개 회원가입은 만들지 않는다.**

---

# 2. 절대 원칙

## 2.1 애플리케이션은 인프라를 모른다

클라우드는 애플리케이션이 실행되는 공간일 뿐이다. 애플리케이션은 환경변수로 주입된 bind 주소·포트·파일 경로만 알고, 자신이 어느 클라우드·어느 호스트에서 실행되는지 모른다. 클라우드를 교체해도(다른 VPS, 온프레미스 포함) 인프라 장과 배포 스크립트만 수정하며 애플리케이션 코드는 변경하지 않는다.

애플리케이션의 도메인·애플리케이션 로직에는 다음 개념이 등장하면 안 된다.

- WireGuard
- `wg0`
- VPN IP
- 특정 클라우드 벤더 (AWS, Lightsail 등)
- 서버 공인 IP
- Caddy
- UFW
- 클라우드 방화벽
- 휴대폰 접속 여부

애플리케이션은 단지 일반적인 프로세스 설정만 가진다.

```dotenv
APP_BIND_ADDRESS=127.0.0.1
APP_PORT=3000
```

WireGuard IP를 `.env`에 넣지 않는다. 네트워크 접근 정책은 인프라가 담당한다.

## 2.2 네트워크 책임

```text
Application
└─ 127.0.0.1:3000

Caddy
├─ WireGuard 사설 IP:443에서 Listen
├─ 내부 TLS 종료
└─ 127.0.0.1:3000으로 Reverse Proxy

UFW
├─ wg0의 443 허용
├─ wg0의 22 허용
└─ 나머지 인바운드 차단

Cloud Firewall (현재: Lightsail)
└─ 구축 완료 후 퍼블릭 인바운드 규칙 제거
```

## 2.3 모듈러 모놀리스

- 저장소 하나
- 제품 하나
- 릴리스 버전 하나
- 배포 아티팩트 하나
- 운영 서버 하나
- 메타데이터 DB 하나
- 내부 역할과 의존 방향은 엄격히 분리

마이크로서비스로 쪼개지 않는다. 다만 백테스트 계산은 HTTP 이벤트 루프와 메모리 장애를 분리하기 위해 **동일 아티팩트의 자식 프로세스**에서 실행한다.

## 2.4 애플리케이션은 특정 증권사를 모른다

전략·도메인·애플리케이션 계층에는 증권사 이름(키움, 토스 등)이 등장하지 않는다. 증권사 접근은 **REST 방식만** 사용한다. OCX·전용 프로그램·윈도우 브릿지 서버 등 비REST 채널을 전제로 한 코드는 만들지 않는다.

증권사별 차이는 infrastructure 계층의 REST 어댑터와 설정으로 흡수한다. 토큰 발급·캐싱·rate limit·backoff는 broker 모듈의 공통 REST 클라이언트가 담당하고, 증권사 어댑터는 이를 공유한다. 증권사 교체·추가는 어댑터 추가로 끝나야 하며 도메인·애플리케이션 코드 변경이 없어야 한다.

```text
Strategy Core
→ Order Intent
→ Execution Port
   ├─ SimulatedOrderExecutor
   ├─ PaperOrderExecutor
   └─ RestBrokerOrderExecutor   # 실거래 단계에서 추가, 증권사별 어댑터
```

## 2.5 임의 코드 실행 금지

웹 화면에서 전략 코드를 작성하거나 업로드하는 기능은 만들지 않는다.

금지:

- `eval`
- `new Function`
- 사용자 입력을 셸 명령으로 실행
- 동적 npm 설치
- 임의 TypeScript 업로드·실행
- 플러그인 zip 업로드

전략은 코드에 등록하고 검토·테스트·배포한다. UI에서는 검증된 파라미터만 변경한다.

---

# 3. MVP 범위

## 포함

- 단일 관리자 로그인
- TOTP 2단계 인증
- 모바일 대응 내부 웹 UI
- 등록 전략 목록
- 전략 파라미터 스키마
- 시간봉 백테스트
- 단일·복수 종목
- 지속성 작업 큐
- 동시 실행 1개
- 진행률·취소
- 재시작 후 작업 상태 복구
- Parquet 시장 데이터
- DuckDB 조회·분석
- SQLite 메타데이터
- CSV·Parquet 가져오기
- 증권사 REST 캔들 수집 어댑터 (1차: 키움 REST API)
- 자산 곡선·낙폭·월별 수익률
- 거래 내역·비용 내역
- 실행 재현 정보
- 감사 로그
- systemd 배포
- WireGuard 내부 접근
- Caddy 내부 TLS
- 선택적 S3 백업

## 제외

- 공개 SaaS
- 공개 도메인
- 다중 사용자
- 소셜 로그인
- RDS
- Redis
- NAT Gateway
- Kubernetes
- 로드밸런서
- WebSocket 실시간 틱 매매
- 머신러닝 학습
- 대규모 분산 파라미터 탐색
- MVP 단계 실거래 주문

---

# 4. 기술 스택

## 서버

| 구분 | 선택 |
|---|---|
| Runtime | Node.js 24 LTS |
| Language | TypeScript strict |
| HTTP | Fastify |
| Validation | Zod |
| Logging | Pino |
| Metadata DB | SQLite |
| SQLite | better-sqlite3 |
| Migration | Drizzle ORM |
| Analytical engine | DuckDB Node Neo |
| Market data | Parquet |
| Password hashing | Argon2id |
| Test | Vitest |
| E2E | Playwright |
| Package manager | pnpm |
| Boundary check | dependency-cruiser |

2026-07-25 기준 Node.js 24는 LTS이고 Node.js 26은 Current다. 운영에는 Node.js 24 LTS 최신 패치를 사용한다.

DuckDB는 deprecated Node 클라이언트가 아니라 다음 패키지를 사용한다.

```text
@duckdb/node-api
```

## 프론트엔드

| 구분 | 선택 |
|---|---|
| UI framework | React + Vite |
| Routing | React Router |
| UI components | shadcn/ui |
| CSS | Tailwind CSS |
| Server state | TanStack Query |
| Form | React Hook Form |
| Validation | Zod |
| Table | TanStack Table |
| Chart | Recharts |
| Icons | Lucide |
| Toast | Sonner |
| Date | date-fns |

프론트 결과물은 Fastify가 정적 파일로 제공한다. 프론트와 서버를 서로 다른 퍼블릭 서비스로 배포하지 않는다.

---

# 5. 런타임 구조

```text
quant-platform.service
└─ Main Process
   ├─ Fastify API
   ├─ React static files
   ├─ Authentication
   ├─ SQLite job queue
   ├─ Job orchestrator
   └─ child_process.fork()
      └─ Backtest Child Process
         ├─ DuckDB
         ├─ Parquet reader
         ├─ Strategy engine
         ├─ Simulated execution
         └─ Result writer
```

백테스트 계산을 Fastify 요청 처리 함수 안에서 직접 실행하지 않는다.

자식 프로세스에 부모의 전체 환경변수를 넘기지 않는다.

```ts
fork(workerPath, [jobId], {
  env: {
    NODE_ENV: config.nodeEnv,
    DATABASE_PATH: config.databasePath,
    DATA_ROOT: config.dataRoot,
    BACKTEST_JOB_ID: jobId,
    DUCKDB_THREADS: "1",
    DUCKDB_MEMORY_LIMIT: "384MB",
  },
  stdio: ["ignore", "pipe", "pipe", "ipc"],
});
```

자식 프로세스에 전달 금지:

- 증권사 app key·client secret
- 증권사 access token
- 계좌 식별자
- 관리자 세션 secret
- AWS access key
- WireGuard 키

---

# 6. 저장소 구조

```text
quant-platform/
├─ package.json
├─ pnpm-lock.yaml
├─ tsconfig.json
├─ vite.config.ts
├─ drizzle.config.ts
├─ components.json
│
├─ src/
│  ├─ server/
│  │  ├─ bootstrap/
│  │  │  ├─ config.ts
│  │  │  ├─ container.ts
│  │  │  ├─ server.ts
│  │  │  └─ main.ts
│  │  ├─ modules/
│  │  │  ├─ auth/
│  │  │  ├─ strategy/
│  │  │  ├─ market-data/
│  │  │  ├─ backtest/
│  │  │  ├─ portfolio/
│  │  │  ├─ risk/
│  │  │  ├─ broker/
│  │  │  ├─ audit/
│  │  │  └─ system/
│  │  └─ shared/
│  ├─ workers/
│  │  └─ backtest-child.ts
│  ├─ web/
│  │  ├─ app/
│  │  ├─ components/ui/
│  │  ├─ features/
│  │  │  ├─ auth/
│  │  │  ├─ dashboard/
│  │  │  ├─ backtests/
│  │  │  ├─ datasets/
│  │  │  └─ settings/
│  │  ├─ routes/
│  │  ├─ lib/
│  │  └─ main.tsx
│  └─ shared/
│     ├─ api-contracts/
│     └─ schemas/
│
├─ migrations/
├─ tests/
│  ├─ unit/
│  ├─ integration/
│  ├─ architecture/
│  └─ e2e/
├─ infra/
│  ├─ caddy/
│  ├─ systemd/
│  ├─ wireguard/
│  ├─ ufw/
│  └─ backup/
├─ scripts/
│  ├─ deploy.sh
│  ├─ backup.sh
│  └─ restore.sh
├─ PLAN.md
├─ DECISIONS.md
├─ IMPLEMENTATION_STATUS.md
└─ README.md
```

각 서버 모듈 내부 기본 구조:

```text
module/
├─ domain/
├─ application/
├─ infrastructure/
└─ presentation/
```

---

# 7. 의존성 규칙

```text
domain
↑
application
↑
infrastructure / presentation
↑
bootstrap composition root
```

## Domain 금지 사항

- Fastify
- React
- SQLite
- DuckDB
- HTTP
- 파일 시스템
- `process.env`
- 증권사 DTO (키움·토스 등)
- Caddy·WireGuard·AWS 개념

## Application 금지 사항

- 구체 DB 드라이버
- Fastify request/reply
- 구체 브로커 구현
- 운영 서버의 네트워크 구조

## CI 강제 규칙

- `domain → infrastructure` 금지
- `domain → presentation` 금지
- `application → presentation` 금지
- `strategy → broker adapter` 금지
- `backtest → broker order adapter` 금지
- 웹이 서버 내부 구현을 직접 import하는 것 금지

아키텍처 테스트:

```text
tests/architecture/module-boundaries.test.ts
```

---

# 8. 핵심 Port

## 시장 데이터

```ts
export interface CandleRepository {
  getCandles(query: CandleQuery): AsyncIterable<Candle>;
  getCoverage(query: CoverageQuery): Promise<DataCoverage>;
  saveCandles(candles: readonly Candle[]): Promise<void>;
}

export interface MarketDataSource {
  fetchCandles(request: FetchCandleRequest): Promise<FetchCandleResult>;
}
```

구현체:

```text
ParquetCandleRepository
RestBrokerMarketDataSource   # 증권사별 어댑터, 1차: Kiwoom
CsvMarketDataSource
ParquetImportDataSource
```

## 전략

```ts
export interface TradingStrategy<TParameters, TState> {
  readonly id: string;
  readonly version: string;
  readonly parameterSchema: z.ZodType<TParameters>;

  initialize(context: StrategyInitializeContext): TState;

  onBars(
    context: StrategyBarContext,
    state: TState,
    parameters: TParameters,
  ): StrategyDecision;
}
```

## 주문 실행

```ts
export interface OrderExecutionPort {
  submit(order: OrderIntent): Promise<OrderSubmissionResult>;
  cancel(orderId: OrderId): Promise<OrderCancellationResult>;
}
```

구현체:

```text
SimulatedOrderExecutor
PaperOrderExecutor
RestBrokerOrderExecutor  # MVP 이후, 증권사별 어댑터
```

---

# 9. 백테스트 정확성

## 9.1 기본 체결 규칙

```text
시간 t 봉 마감
→ t 봉까지의 데이터로 신호 생성
→ 주문 의도 생성
→ 다음 거래 가능 봉 t+1 시가에서 체결
→ 수수료·세금·슬리피지 반영
```

`t` 봉 종가를 확인한 뒤 동일 종가에 체결하는 look-ahead 구현을 기본값으로 사용하지 않는다.

## 9.2 이벤트 순서

1. 이전 시점의 대기 주문 체결
2. 현금·포지션 갱신
3. 평가금액 갱신
4. 현재까지 확정된 봉을 전략에 전달
5. 신규 주문 의도 생성
6. 리스크 검증
7. 다음 봉 체결 대기열 등록
8. 스냅샷·진행률 저장

## 9.3 비용 모델

설정 가능해야 한다.

- 매수 수수료
- 매도 수수료
- 매도 관련 세금
- 고정 슬리피지
- 비율 슬리피지
- 최소 호가 단위
- 최소 주문 수량
- 환전 비용

수수료·세율은 영구 하드코딩하지 않는다. 시장·기간·증권사별 프로파일과 버전으로 관리한다.

## 9.4 편향·데이터 문제

- Look-ahead bias
- Survivorship bias
- 미래 구성 종목 소급 적용
- 액면분할
- 배당·권리락
- 상장폐지
- 거래정지
- 중복·누락 봉
- 거래소 시간대
- 장 휴일·조기 폐장
- 유동성 부족

MVP에서 해결하지 못한 한계는 결과 화면에 명시한다.

## 9.5 재현성 메타데이터

```text
strategyId
strategyVersion
strategySourceHash
parameterJson
datasetId
datasetVersion
datasetHash
engineVersion
feeModelVersion
slippageModelVersion
randomSeed
gitCommitSha
startedAt
completedAt
```

같은 입력·버전·seed는 같은 결과를 만들어야 한다.

## 9.6 필수 지표

- 초기·최종 자본
- 누적 수익률
- CAGR
- 최대 낙폭·낙폭 기간
- 변동성
- Sharpe
- Sortino
- Calmar
- 승률
- Profit factor
- 평균 이익·손실
- 최대 연속 승·패
- 거래 횟수
- 평균 보유 시간
- 최대 동시 포지션
- 수수료·세금·슬리피지 총액
- 월별 수익률
- 종목별 성과

---

# 10. 작업 큐

## 상태

```ts
type BacktestJobStatus =
  | "QUEUED"
  | "STARTING"
  | "RUNNING"
  | "CANCELLING"
  | "CANCELLED"
  | "COMPLETED"
  | "FAILED"
  | "INTERRUPTED";
```

## 동시 실행

```dotenv
MAX_CONCURRENT_BACKTESTS=1
```

## SQLite 작업 확보

```sql
BEGIN IMMEDIATE;

UPDATE backtest_jobs
SET
  status = 'STARTING',
  started_at = CURRENT_TIMESTAMP,
  worker_id = :workerId
WHERE id = (
  SELECT id
  FROM backtest_jobs
  WHERE status = 'QUEUED'
  ORDER BY created_at ASC
  LIMIT 1
)
RETURNING *;

COMMIT;
```

## 취소

1. DB 상태 `CANCELLING`
2. IPC 정상 종료 요청
3. 유예 후 `SIGTERM`
4. 추가 유예 후 `SIGKILL`
5. 임시 파일 삭제
6. `CANCELLED` 확정

## 재시작 복구

서버 시작 시 `STARTING`, `RUNNING`, `CANCELLING` 작업을 검사한다. 대응 OS 프로세스가 없으면 `INTERRUPTED`로 바꾼다. 자동 재실행은 하지 않고 사용자가 복제·재실행한다.

---

# 11. 데이터 저장

```text
/var/lib/quant-platform/
├─ app.sqlite
├─ market-data/
│  ├─ market=KR/
│  │  ├─ timeframe=1m/
│  │  │  └─ symbol=005930/year=2026/month=07/data.parquet
│  │  └─ timeframe=1h/
│  │     └─ symbol=005930/year=2026/data.parquet
│  └─ market=US/
├─ imports/
├─ exports/
├─ temp/
└─ backups/
```

원칙:

- UTC timestamp 저장
- 거래소 현지 시간·세션 정보 보존
- 원본은 수정하지 않음
- 보정 여부 기록
- 중복 수집 idempotent
- 백테스트는 사전 집계 1시간봉 우선
- 너무 작은 Parquet 조각 방지
- 1분봉은 필요 시 S3 아카이브

DuckDB 기본 제한:

```sql
SET threads = 1;
SET memory_limit = '384MB';
```

---

# 12. SQLite 스키마

```text
users
sessions
login_attempts

strategies
strategy_versions

datasets
dataset_versions
data_coverage
data_import_jobs
data_sync_jobs

backtest_jobs
backtest_runs
backtest_metrics
backtest_equity_points
backtest_drawdown_points
backtest_trades
backtest_monthly_returns
backtest_symbol_metrics

audit_logs
application_settings
schema_migrations
```

SQLite 설정:

```sql
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
```

계산 중 장시간 DB transaction을 유지하지 않는다.

---

# 13. 증권사 REST 데이터 어댑터

애플리케이션 코어는 `MarketDataSource` port만 안다. 증권사별 구현은 infrastructure 계층의 어댑터이며, 다음 전제를 공유한다.

- REST 전용 — OCX·전용 프로그램·윈도우 브릿지 서버를 전제로 한 코드는 만들지 않는다
- 토큰 기반 인증 (발급·캐싱·만료 전 재발급)
- 1분봉·일봉 수집
- 주문·계좌 기능 (실거래 단계)
- 허용 IP 등록제 증권사 대응 — 서버의 고정 공인 IP 사용

어댑터 구현 순서는 외부 사정에 따른 인프라 결정이며 코어에 영향을 주지 않는다.

1. 키움증권 REST API — 1차 어댑터
2. 토스증권 Open API — 사전신청 승인 후 추가

## 시간봉 집계

시간봉은 1분봉으로 생성한다.

```text
open   = 첫 1분봉 open
high   = high 최댓값
low    = low 최솟값
close  = 마지막 1분봉 close
volume = volume 합
```

거래소 세션 경계를 기준으로 집계한다. Unix timestamp의 단순 60분 bucket만 사용하지 않는다.

## 공통 REST 클라이언트

토큰·rate limit 처리는 개별 증권사 어댑터가 아니라 broker 모듈의 공통 REST 클라이언트가 담당하고, 모든 증권사 어댑터가 이를 공유한다.

- 토큰 발급·캐싱·만료 전 재발급
- API 그룹별 limiter
- 응답 헤더 반영
- 429에서 `Retry-After` 우선
- exponential backoff + jitter
- 동일 범위 요청 병합
- 중단 후 이어받기

과거 데이터가 부족할 수 있으므로 입력 어댑터는 최소 다음을 지원한다.

```text
증권사 REST API
CSV Import
Parquet Import
```

---

# 14. HTTP API

Prefix:

```text
/api/v1
```

## 인증

```http
POST /api/v1/auth/login
POST /api/v1/auth/logout
GET  /api/v1/auth/me
POST /api/v1/auth/totp/verify
```

## 전략

```http
GET /api/v1/strategies
GET /api/v1/strategies/:strategyId
GET /api/v1/strategies/:strategyId/schema
```

## 데이터

```http
GET  /api/v1/datasets
GET  /api/v1/datasets/:datasetId
GET  /api/v1/datasets/:datasetId/coverage
POST /api/v1/datasets/import
POST /api/v1/datasets/sync
GET  /api/v1/data-jobs/:jobId
```

## 백테스트

```http
POST   /api/v1/backtests
GET    /api/v1/backtests
GET    /api/v1/backtests/:id
POST   /api/v1/backtests/:id/cancel
POST   /api/v1/backtests/:id/clone
DELETE /api/v1/backtests/:id
GET    /api/v1/backtests/:id/events
GET    /api/v1/backtests/:id/trades
GET    /api/v1/backtests/:id/export
```

진행률은 SSE를 기본으로 한다. 연결이 끊기면 polling으로 fallback한다.

## 상태

```http
GET /api/v1/health/live
GET /api/v1/health/ready
GET /api/v1/system/info
```

`system/info`에서 비밀값·민감 경로를 반환하지 않는다.

---

# 15. 백테스트 요청 예시

```json
{
  "strategyId": "hourly-breakout",
  "strategyVersion": "1.0.0",
  "parameters": {
    "lookbackBars": 20,
    "atrPeriod": 14,
    "stopAtrMultiplier": 2,
    "riskPerTradePercent": 1
  },
  "datasetId": "kr-hourly-v1",
  "universe": {
    "type": "SYMBOLS",
    "symbols": ["005930", "000660"]
  },
  "period": {
    "from": "2023-01-01",
    "to": "2026-06-30"
  },
  "capital": {
    "initialCash": 10000000,
    "currency": "KRW"
  },
  "execution": {
    "fillTiming": "NEXT_BAR_OPEN",
    "commissionProfileId": "kr-equity-default",
    "slippageProfileId": "fixed-5bps"
  },
  "randomSeed": 42
}
```

---

# 16. 애플리케이션 보안

## 관리자

- 관리자 1명
- 공개 회원가입 없음
- 관리자 생성은 서버 CLI에서만
- 기본 `admin` 계정 강제 금지

```bash
node dist/server/cli.js admin:create
```

## 비밀번호

- Argon2id
- 최소 14자 권장
- 평문 저장·로그 금지
- 환경변수에 관리자 평문 비밀번호 저장 금지

## 세션

- 서버 저장 세션
- 로그인 후 세션 ID 회전
- `HttpOnly`
- `Secure`
- `SameSite=Strict`
- 유휴 만료 12시간
- 절대 만료 7일

## TOTP

- 비밀번호 + TOTP
- 복구 코드 hash 저장
- 설정 완료 후 TOTP secret 재노출 금지

## HTTP

- CSRF 방어
- CORS 기본 비활성화
- Origin 고정
- CSP
- `X-Content-Type-Options: nosniff`
- `X-Frame-Options: DENY`
- `Referrer-Policy: no-referrer`
- 로그인 rate limit
- 파일 크기 제한
- 파일의 실제 포맷 검증
- stack trace 미노출

Pino redaction:

```text
authorization
cookie
set-cookie
client_secret
access_token
appkey
appsecret
accountNumber
password
totp
recoveryCode
awsSecretAccessKey
```

---

# 17. 프론트엔드 디자인

## 스타일

shadcn/ui 계열의 절제된 운영 도구 스타일을 사용한다.

원하는 느낌:

- neutral/zinc 기반
- 데이터 중심
- 금융 앱처럼 신뢰감 있음
- 개발 도구처럼 명확함
- 과장된 장식 없음
- 라이트·다크 모드

피할 것:

- 네온 트레이딩 터미널
- 과도한 그라데이션
- glassmorphism 남용
- 움직이는 배경
- 의미 없는 애니메이션
- 작은 터치 영역

색상만으로 수익·손실을 표현하지 않는다. 부호, 아이콘, 텍스트를 같이 사용한다.

## 레이아웃

모바일:

```text
Top App Bar
Content
Bottom Navigation
```

하단 메뉴:

```text
대시보드
백테스트
데이터
설정
```

데스크톱:

```text
Sidebar
Header
Content
```

## 화면

### 로그인

- 사용자 이름
- 비밀번호
- TOTP
- 서버 연결 상태
- 회원가입 링크 없음

### 대시보드

- 실행 중 작업
- 최근 결과
- 데이터 최신 상태
- 디스크 상태
- 서버 상태
- 빠른 백테스트

### 새 백테스트

모바일 Wizard:

```text
1. 전략
2. 데이터·종목
3. 기간
4. 자본·비용
5. 검토
6. 실행
```

### 작업 상세

- 상태 Badge
- Progress
- 처리 종목
- 처리 봉 수
- 경과 시간
- 취소
- 실패 이유

### 결과

상단 카드:

- 누적 수익률
- CAGR
- MDD
- Sharpe
- 승률
- 거래 수

차트:

1. 자산 곡선
2. 기준 지수 비교
3. Drawdown
4. 월별 수익률
5. 종목별 성과

하단:

- 거래 내역
- 파라미터
- 데이터·엔진 버전
- 비용 모델
- 재현 정보
- 경고·한계

## 주요 shadcn 컴포넌트

```text
Button
Card
Badge
Alert
Dialog
Drawer
Sheet
Tabs
Table
Form
Input
Select
Combobox
Command
Calendar
Popover
Progress
Skeleton
Separator
DropdownMenu
Tooltip
Sidebar
Sonner
ScrollArea
Collapsible
Accordion
```

모바일 입력은 Dialog보다 Drawer를 우선 고려한다.

## 접근성

- 터치 영역 최소 44px
- 모든 입력에 Label
- 키보드 탐색
- 명확한 focus ring
- 색맹 고려
- 차트 텍스트 요약
- ARIA live progress
- 오류를 Toast로만 전달하지 않음

---

# 18. 실행 호스트 요구사항·비용

클라우드 선택은 인프라 결정이다. 애플리케이션은 실행 호스트를 모른다. 호스트 요구사항:

- Ubuntu 24.04 LTS 또는 동등한 Linux
- RAM 1GB 이상, 스토리지 40GB 이상
- 고정 공인 IP (허용 IP 등록제 증권사 대응)
- 월 10 USD 미만

이 요구사항을 만족하면 어떤 클라우드·VPS로도 교체할 수 있으며, 교체 시 인프라 장(18~27)과 배포 스크립트만 수정한다.

현재 선택은 AWS Lightsail 서울이다. 2026-07 기준 공식 Lightsail Linux public IPv4 플랜:

| 플랜 | vCPU | RAM | SSD | 월 비용 |
|---|---:|---:|---:|---:|
| Nano | 2 | 0.5GB | 20GB | $5 |
| Micro | 2 | 1GB | 40GB | $7 |
| Small | 2 | 2GB | 60GB | $12 |

월 10달러 미만 목표에는 **$7 Micro 플랜**을 사용한다.

제약:

- 동시 백테스트 1개
- DuckDB 1 thread
- 메모리 제한 384MB
- 시간봉 사전 집계
- 대규모 sweep 금지

Static IP는 인스턴스에 연결된 상태에서는 별도 비용이 없다. 연결하지 않은 Static IP는 과금될 수 있으므로 사용하지 않는 IP는 삭제한다.

AWS Budget에 월 9달러 알림을 설정한다.

---

# 19. AWS 계정 설정

1. Root MFA 활성화
2. Root access key 삭제
3. 관리 IAM 사용자 또는 IAM Identity Center 사용
4. 관리 계정 MFA
5. Billing 알림
6. 서울 리전 `ap-northeast-2`
7. S3 사용 시 Block Public Access

---

# 20. Lightsail 생성

AWS Console:

```text
Lightsail
→ Create instance
→ Region: Seoul
→ Platform: Linux/Unix
→ Blueprint: OS Only
→ Ubuntu 24.04 LTS
→ Plan: Micro 1GB / $7 public IPv4
→ Name: quant-platform
```

Static IP:

```text
Lightsail
→ Networking
→ Create static IP
→ quant-platform 인스턴스에 연결
```

Static IP 용도:

- 증권사 API 허용 출발 IP (허용 IP 등록제 대응)
- 안정적인 서버 식별

웹 포트를 여는 용도가 아니다.

---

# 21. 초기 Ubuntu 설정

```bash
sudo apt update
sudo apt full-upgrade -y

sudo apt install -y \
  ca-certificates \
  curl \
  git \
  jq \
  unzip \
  xz-utils \
  build-essential \
  python3 \
  pkg-config \
  sqlite3 \
  wireguard \
  ufw \
  unattended-upgrades
```

서버 시간대:

```bash
sudo timedatectl set-timezone UTC
```

표시 계층에서 KST로 변환한다.

서비스 사용자:

```bash
sudo useradd \
  --system \
  --home /var/lib/quant-platform \
  --create-home \
  --shell /usr/sbin/nologin \
  quant

sudo mkdir -p \
  /opt/quant-platform/releases \
  /etc/quant-platform \
  /var/lib/quant-platform/market-data \
  /var/lib/quant-platform/imports \
  /var/lib/quant-platform/exports \
  /var/lib/quant-platform/temp \
  /var/lib/quant-platform/backups

sudo chown -R quant:quant /var/lib/quant-platform
sudo chown -R root:root /opt/quant-platform /etc/quant-platform
sudo chmod 750 /etc/quant-platform
```

---

# 22. Node.js 설치

운영 시점의 Node.js 24 최신 LTS patch를 사용한다. 문서 기준 최신 LTS는 v24.18.0이다.

```bash
cd /tmp

NODE_VERSION=v24.18.0
NODE_FILE=node-${NODE_VERSION}-linux-x64.tar.xz

curl -fsSLO "https://nodejs.org/dist/${NODE_VERSION}/${NODE_FILE}"
curl -fsSLO "https://nodejs.org/dist/${NODE_VERSION}/SHASUMS256.txt"

grep " ${NODE_FILE}$" SHASUMS256.txt | sha256sum -c -

sudo mkdir -p "/opt/node-${NODE_VERSION}"
sudo tar -xJf "${NODE_FILE}" \
  -C "/opt/node-${NODE_VERSION}" \
  --strip-components=1

sudo ln -sfn "/opt/node-${NODE_VERSION}" /opt/node
sudo ln -sfn /opt/node/bin/node /usr/local/bin/node
sudo ln -sfn /opt/node/bin/npm /usr/local/bin/npm
sudo ln -sfn /opt/node/bin/npx /usr/local/bin/npx
sudo ln -sfn /opt/node/bin/corepack /usr/local/bin/corepack

sudo corepack enable
node --version
```

`package.json`에서 pnpm과 Node 범위를 고정한다.

```json
{
  "packageManager": "pnpm@<PINNED_VERSION>",
  "engines": {
    "node": ">=24 <25"
  }
}
```

---

# 23. WireGuard 연결

Lightsail을 기존 WireGuard 서버의 client peer로 참여시킨다.

중요: 증권사 API 요청은 서버의 고정 공인 IP로 나가야 한다. Lightsail의 `AllowedIPs`에 `0.0.0.0/0`을 넣지 않는다.

예시:

```text
VPN network: 10.20.0.0/24
Lightsail:    10.20.0.15/32
```

키 생성:

```bash
sudo install -m 700 -d /etc/wireguard
umask 077
wg genkey | sudo tee /etc/wireguard/private.key >/dev/null
sudo cat /etc/wireguard/private.key | wg pubkey | \
  sudo tee /etc/wireguard/public.key >/dev/null
sudo cat /etc/wireguard/public.key
```

`/etc/wireguard/wg0.conf`:

```ini
[Interface]
Address = 10.20.0.15/32
PrivateKey = <LIGHTSAIL_PRIVATE_KEY>

[Peer]
PublicKey = <EXISTING_WIREGUARD_SERVER_PUBLIC_KEY>
Endpoint = <EXISTING_WIREGUARD_ENDPOINT>:51820
AllowedIPs = 10.20.0.0/24
PersistentKeepalive = 25
```

```bash
sudo chmod 600 /etc/wireguard/wg0.conf
sudo systemctl enable --now wg-quick@wg0
sudo wg show
```

기존 WireGuard 서버에 peer 추가:

```ini
[Peer]
PublicKey = <LIGHTSAIL_PUBLIC_KEY>
AllowedIPs = 10.20.0.15/32
```

휴대폰 peer는 `10.20.0.15/32` 또는 VPN 대역을 라우팅한다.

검증:

```bash
curl -4 https://checkip.amazonaws.com
```

결과가 Lightsail Static IP여야 한다.

---

# 24. 퍼블릭 방화벽 마감

WireGuard 내부 SSH가 성공한 뒤 Lightsail Networking에서 제거:

- TCP 22
- TCP 80
- TCP 443
- TCP 3000
- UDP 51820

Lightsail이 기존 WireGuard 서버로 아웃바운드 연결하므로 Lightsail에 WireGuard 포트를 열 필요가 없다.

IPv4와 IPv6 방화벽을 각각 확인한다.

---

# 25. UFW

```bash
sudo ufw default deny incoming
sudo ufw default allow outgoing

sudo ufw allow in on wg0 to any port 22 proto tcp
sudo ufw allow in on wg0 to any port 443 proto tcp

sudo ufw deny 80/tcp
sudo ufw deny 3000/tcp

sudo ufw enable
sudo ufw status verbose
```

WireGuard SSH가 검증되기 전에 현재 퍼블릭 SSH 세션을 차단하지 않는다.

---

# 26. SSH 보안

`/etc/ssh/sshd_config.d/99-quant-hardening.conf`:

```text
PermitRootLogin no
PasswordAuthentication no
KbdInteractiveAuthentication no
PubkeyAuthentication yes
X11Forwarding no
MaxAuthTries 3
LoginGraceTime 30
```

```bash
sudo sshd -t
sudo systemctl restart ssh
```

---

# 27. Caddy 내부 TLS

공식 Caddy Ubuntu 설치 절차를 사용한다.

`/etc/caddy/Caddyfile`:

```caddy
https://10.20.0.15 {
    bind 10.20.0.15
    tls internal

    encode zstd gzip

    header {
        Strict-Transport-Security "max-age=31536000"
        X-Content-Type-Options "nosniff"
        X-Frame-Options "DENY"
        Referrer-Policy "no-referrer"
        -Server
    }

    reverse_proxy 127.0.0.1:3000
}
```

내부 DNS가 있으면 `https://quant.internal` 사용 가능.

Caddy만 WireGuard 시작 순서를 안다.

```bash
sudo systemctl edit caddy
```

```ini
[Unit]
After=wg-quick@wg0.service
Requires=wg-quick@wg0.service
```

애플리케이션 systemd unit에는 WireGuard 의존성을 넣지 않는다.

`tls internal` 사용 시 Caddy Root CA의 **공개 인증서**만 휴대폰에 설치한다. CA private key를 복사하지 않는다.

---

# 28. 애플리케이션 환경 파일

`/etc/quant-platform/app.env`:

```dotenv
NODE_ENV=production

APP_BIND_ADDRESS=127.0.0.1
APP_PORT=3000

DATABASE_PATH=/var/lib/quant-platform/app.sqlite
DATA_ROOT=/var/lib/quant-platform/market-data
IMPORT_ROOT=/var/lib/quant-platform/imports
EXPORT_ROOT=/var/lib/quant-platform/exports
TEMP_ROOT=/var/lib/quant-platform/temp

MAX_CONCURRENT_BACKTESTS=1
DUCKDB_THREADS=1
DUCKDB_MEMORY_LIMIT=384MB

SESSION_SECRET=<48_BYTE_RANDOM_VALUE>
SESSION_IDLE_TIMEOUT_SECONDS=43200
SESSION_ABSOLUTE_TIMEOUT_SECONDS=604800

LOG_LEVEL=info
TRUST_PROXY_LOOPBACK=true

LIVE_TRADING_ENABLED=false
```

```bash
openssl rand -base64 48
sudo chown root:root /etc/quant-platform/app.env
sudo chmod 600 /etc/quant-platform/app.env
```

---

# 29. systemd

`/etc/systemd/system/quant-platform.service`:

```ini
[Unit]
Description=Quant Trading Platform
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=quant
Group=quant
WorkingDirectory=/opt/quant-platform/current
EnvironmentFile=/etc/quant-platform/app.env
ExecStart=/usr/local/bin/node /opt/quant-platform/current/dist/server/main.js
Restart=on-failure
RestartSec=5
TimeoutStopSec=30

NoNewPrivileges=true
PrivateTmp=true
PrivateDevices=true
ProtectSystem=strict
ProtectHome=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
ProtectClock=true
ProtectHostname=true
RestrictSUIDSGID=true
LockPersonality=true
CapabilityBoundingSet=
AmbientCapabilities=
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
ReadWritePaths=/var/lib/quant-platform
ReadOnlyPaths=/opt/quant-platform/current

LimitNOFILE=65536
MemoryMax=768M
TasksMax=256

StandardOutput=journal
StandardError=journal
SyslogIdentifier=quant-platform

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable quant-platform
sudo systemctl start quant-platform
sudo systemctl status quant-platform
journalctl -u quant-platform -f
```

---

# 30. 빌드·배포

빌드:

```bash
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

결과:

```text
dist/
├─ server/
├─ workers/
└─ public/
```

릴리스 구조:

```text
/opt/quant-platform/
├─ releases/
│  ├─ 20260725-120000-abcdef1/
│  └─ 20260726-090000-bcdefa2/
└─ current -> releases/20260726-090000-bcdefa2
```

배포 순서:

1. 개발 PC에서 lint·typecheck·test·build
2. tar 생성
3. WireGuard IP로 scp
4. 새 release 디렉터리에 압축 해제
5. production dependency 설치
6. migration
7. `current` symlink 원자적 교체
8. systemd restart
9. health check
10. 실패 시 이전 release로 rollback

배포 스크립트는 비밀값을 command line argument로 노출하지 않는다.

---

# 31. 백업

백업 대상:

- SQLite
- 결과 메타데이터
- 시간봉 Parquet
- 결과 export
- 데이터셋·엔진 버전 정보

백업 제외:

- WireGuard private key
- 증권사 API secret
- 세션 secret
- 관리자 비밀번호
- AWS secret key

S3를 사용할 경우:

- Block Public Access
- Versioning
- 기본 암호화
- 특정 bucket prefix만 허용하는 최소 IAM
- 30일 lifecycle
- 월 1회 복원 테스트

애플리케이션 프로세스에 AWS 키를 제공하지 않는다. 백업 스크립트 또는 별도 제한 사용자만 접근한다.

---

# 32. 첫 전략

엔진 검증용 시간봉 돌파 전략을 먼저 만든다.

```ts
const HourlyBreakoutParameters = z.object({
  lookbackBars: z.number().int().min(2).max(200),
  atrPeriod: z.number().int().min(2).max(100),
  stopAtrMultiplier: z.number().positive().max(20),
  takeProfitAtrMultiplier: z.number().positive().max(50).optional(),
  riskPerTradePercent: z.number().positive().max(5),
  maxPositions: z.number().int().min(1).max(20),
});
```

전략의 수익성을 약속하는 것이 아니라 백테스트 엔진의 정확성·재현성을 검증하는 기준 전략이다.

---

# 33. 테스트

## Unit

- Candle
- 시간봉 집계
- 주문 체결
- 수수료·세금·슬리피지
- 현금 부족
- 포지션
- MDD
- 수익률
- 파라미터 검증
- 시간대

## Look-ahead 방지

미래 급등 fixture를 만들고 급등 이전에 신호가 발생하지 않음을 검증한다.

## Determinism

같은 seed·데이터로 두 번 실행했을 때 거래, 자산 곡선, 지표 hash가 같아야 한다.

## Integration

- SQLite migration
- job claim
- cancel
- 프로세스 중단 복구
- Parquet
- DuckDB
- 로그인·세션 만료
- SSE

## E2E

Playwright viewport:

```text
390 x 844
1440 x 900
```

흐름:

1. 로그인
2. 백테스트 생성
3. 작업 제출
4. 완료
5. 결과 조회
6. 거래 필터
7. clone
8. 로그아웃

---

# 34. 관측성

구조화 JSON 로그:

```json
{
  "level": "info",
  "module": "backtest",
  "event": "backtest.completed",
  "jobId": "bt_01J...",
  "durationMs": 18342
}
```

감사 로그 대상:

- 로그인 성공·실패
- 로그아웃
- TOTP 변경
- 백테스트 생성·취소
- 데이터 가져오기·동기화
- 설정 변경
- 향후 실거래 arm·disarm
- 향후 주문

대시보드 상태:

- 앱 버전
- Git commit
- uptime
- DB 크기
- 데이터 크기
- 남은 디스크
- free memory
- queue 길이
- 실행 중 job
- 최근 데이터 동기화
- 최근 백업

리소스 임계치 미달 시 신규 백테스트를 거부한다.

---

# 35. 향후 실거래 확장

단계:

```text
Backtest
→ Out-of-sample
→ Walk-forward
→ 실제 시세 Paper Trading
→ 극소액 실거래
→ 제한적 확대
```

MVP에서:

```dotenv
LIVE_TRADING_ENABLED=false
```

실거래 단계에서는 같은 저장소·아티팩트를 유지하되 운영 역할을 분리한다.

```text
quant-platform-web.service
quant-platform-live.service
```

`quant-platform-live`만 증권사 주문 자격 증명을 가진다. 이것은 마이크로서비스 전환이 아니라 동일 모듈러 모놀리스의 OS 권한 분리다.

실거래 필수 안전장치:

- 계좌 allowlist
- 종목 allowlist
- 주문당 최대 금액
- 종목당 최대 보유액
- 일일 최대 주문 횟수
- 일일 최대 손실
- idempotency key
- stale data 차단
- clock drift 검사
- 미체결·보유 수량 재동기화
- kill switch
- 재부팅 후 자동 실거래 재개 금지
- 수동 arm

---

# 36. 구현 단계

## Phase 0 — 기반

- TypeScript strict
- Fastify
- React/Vite
- shadcn/ui
- Vitest
- Playwright
- lint/typecheck/build
- dependency boundary
- config validation
- health endpoint

## Phase 1 — 인증·UI shell

- 관리자 CLI
- Argon2id
- 로그인
- TOTP
- 세션
- 모바일 navigation
- 데스크톱 sidebar
- 테마
- 감사 로그

## Phase 2 — 데이터

- Candle domain
- Parquet repository
- DuckDB
- CSV/Parquet import
- coverage
- 누락 탐지
- 시간봉 집계
- 증권사 REST 데이터 어댑터 (1차: 키움)

## Phase 3 — 엔진

- Portfolio
- Position
- Order intent
- simulated execution
- fee/slippage
- event loop
- metric calculator
- determinism
- look-ahead tests

## Phase 4 — 작업 큐

- SQLite queue
- child process
- IPC progress
- cancel
- timeout
- restart recovery
- concurrency 1

## Phase 5 — 결과 UI

- metrics
- equity
- drawdown
- monthly returns
- trade table
- parameter summary
- reproducibility metadata
- export

## Phase 6 — 인프라 (현재: AWS Lightsail)

- Lightsail
- Static IP
- WireGuard
- UFW
- Caddy
- internal TLS
- systemd
- deploy/rollback

## Phase 7 — 운영

- S3 backup
- restore test
- disk/memory guard
- alert
- disaster runbook

## Phase 8 — Paper Trading

- 실제 시세
- 가상 주문
- 장 운영 시간
- 재시작 복구
- 백테스트 비교

## Phase 9 — Live

사용자의 별도 승인 전 구현하지 않는다.

---

# 37. Claude Fable 5 작업 규칙

Claude는 구현 전에 다음을 만든다.

```text
PLAN.md
DECISIONS.md
IMPLEMENTATION_STATUS.md
```

- `PLAN.md`: 파일 단위 작업 계획
- `DECISIONS.md`: 명세 밖 선택과 이유
- `IMPLEMENTATION_STATUS.md`: 완료·진행·미완료

각 단계 완료 전 실행:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

실패한 상태로 다음 단계에 가지 않는다.

Claude가 임의로 변경하면 안 되는 결정:

- Modular Monolith
- localhost application bind
- WireGuard awareness는 infra only
- 클라우드 awareness는 infra only
- 증권사 awareness는 infra only, 접근은 REST 전용
- public web port 없음
- SQLite + Parquet + DuckDB
- concurrency 1
- arbitrary strategy code 금지
- live trading disabled
- shadcn/ui mobile-first

명세 변경이 필요하면 구현 전에 `DECISIONS.md`에 다음을 기록한다.

- 변경 내용
- 이유
- 대안
- 보안 영향
- 비용 영향
- 마이그레이션 영향

---

# 38. 완료 기준

## 보안

- 공인 IP의 80·443·3000 접근 실패
- VPN IP의 443 접근 성공
- 앱은 `127.0.0.1:3000`만 Listen
- 도메인·애플리케이션 계층에 WireGuard 문자열 없음
- 로그인·TOTP 필요
- 안전한 cookie
- 로그에 secret 없음
- 임의 코드 실행 없음

확인:

```bash
sudo ss -lntup
sudo ufw status verbose
```

## 백테스트

- 동일 입력 재현
- 미래 봉 접근 테스트 통과
- 다음 봉 체결
- 비용 반영
- 데이터 버전 저장
- 취소 가능
- 재시작 상태 보존
- 동시 실행 1개
- 모바일 브라우저를 닫아도 계속 실행
- 결과·거래 표시

## 모바일

- 390px에서 핵심 화면 가로 스크롤 없음
- 휴대폰에서 전 과정 가능
- 44px 터치 영역
- 진행률·취소 가능
- 차트 툴팁 사용 가능

## 운영

- systemd 자동 시작
- 장애 재시작
- 로그 확인
- backup/restore 검증
- 리소스 부족 시 신규 작업 차단
- 이전 release rollback

---

# 39. 공식 참고 자료

- [AWS Lightsail Pricing](https://aws.amazon.com/lightsail/pricing/)
- [Lightsail Instance Bundles](https://docs.aws.amazon.com/lightsail/latest/userguide/amazon-lightsail-bundles.html)
- [Lightsail Static IP](https://docs.aws.amazon.com/lightsail/latest/userguide/understanding-static-ip-addresses-in-amazon-lightsail.html)
- [Lightsail Firewall](https://docs.aws.amazon.com/lightsail/latest/userguide/understanding-firewall-and-port-mappings-in-amazon-lightsail.html)
- [WireGuard Quick Start](https://www.wireguard.com/quickstart/)
- [Ubuntu Firewall](https://ubuntu.com/server/docs/security-firewall/)
- [Caddy Installation](https://caddyserver.com/docs/install)
- [Caddy TLS](https://caddyserver.com/docs/caddyfile/directives/tls)
- [Node.js Releases](https://nodejs.org/en/about/previous-releases)
- [DuckDB Node Neo](https://duckdb.org/docs/current/clients/node_neo/overview)
- [Fastify TypeScript](https://fastify.dev/docs/latest/Reference/TypeScript/)
- [shadcn/ui Vite](https://ui.shadcn.com/docs/installation/vite)
- [키움 REST API](https://openapi.kiwoom.com/)
- [토스증권 Open API](https://developers.tossinvest.com/docs)
- [Claude Fable 5](https://www.anthropic.com/claude/fable)

---

# 40. 최종 고정 결정

```text
Cloud
└─ 애플리케이션은 모름, infra only
   현재: AWS Lightsail Seoul, $7 Micro

Application
└─ TypeScript Modular Monolith

Application bind
└─ 127.0.0.1:3000

Remote access
└─ Existing WireGuard only

Reverse proxy
└─ Caddy on WireGuard IP:443

Public inbound
└─ None

Frontend
└─ React + Vite + shadcn/ui, mobile-first

Metadata
└─ SQLite WAL

Market data
└─ Parquet

Analytics
└─ DuckDB Node Neo

Backtest isolation
└─ Child process from same artifact

Queue
└─ SQLite persistent queue, concurrency 1

Strategy
└─ Precompiled registry + validated parameters

Broker
└─ Port/Adapter, REST 전용, 애플리케이션은 특정 증권사를 모름
   1차 어댑터: 키움 REST API, 이후 토스

Arbitrary code
└─ Prohibited

Live trading
└─ Disabled until separately approved

WireGuard awareness
└─ Infrastructure only
```
