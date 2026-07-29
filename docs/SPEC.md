# Quant Trading Platform 구현·배포 명세

> **용도:** TypeScript 기반 퀀트 백테스트·자동매매 플랫폼의 구현·배포 명세 (프로젝트 헌법)  
> **기준일:** 2026-07-25 (전면 개정 2026-07-28 — D-001~D-017 반영)  
> **우선순위:** 백테스트 → Paper Trading → 소액 실거래  
> **실행 환경:** 고정 공인 IP를 제공하는 Linux 호스트 — 인프라 결정, 애플리케이션은 모름 (현재: AWS Lightsail 서울)  
> **증권사 연동:** REST 전용 어댑터 — 인프라 결정, 애플리케이션은 모름 (1차: 키움 REST API, 이후 토스)  
> **접근 방식:** 퍼블릭 도메인 + Caddy TLS, 비밀번호 + TOTP 2단계 — 웹은 조회 평면, 제어 조작은 SSH CLI (§2.6, D-017)  
> **프론트엔드:** React + shadcn/ui, 모바일 우선  
> **비용 목표:** 월 10 USD 미만

---

# 1. 프로젝트 목표

외부에서 휴대폰 브라우저로 서비스 도메인에 접속해 다음 작업을 수행할 수 있는 개인용 플랫폼을 만든다.

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

이 프로젝트는 공개 서비스가 아니다. **공개 회원가입은 만들지 않으며 사용자는 관리자 1명뿐이다.** 웹은 퍼블릭 도메인으로 노출되지만 조회 평면으로 권한이 제한되고(§2.6), 접근에는 비밀번호 + TOTP 2단계 인증이 필요하다(§16). 돈·전략·보안에 관한 조작은 웹에 존재하지 않는다 — SSH CLI 전용이다. (D-017)

---

# 2. 절대 원칙

## 2.1 애플리케이션은 인프라를 모른다

클라우드는 애플리케이션이 실행되는 공간일 뿐이다. 애플리케이션은 환경변수로 주입된 bind 주소·포트·파일 경로만 알고, 자신이 어느 클라우드·어느 호스트에서 실행되는지 모른다. 클라우드를 교체해도(다른 VPS, 온프레미스 포함) 인프라 장과 배포 스크립트만 수정하며 애플리케이션 코드는 변경하지 않는다.

애플리케이션의 도메인·애플리케이션 로직에는 다음 개념이 등장하면 안 된다.

- 특정 클라우드 벤더 (AWS, Lightsail 등)
- 서버 공인 IP
- 서비스 도메인
- Caddy
- UFW
- 클라우드 방화벽
- 휴대폰 접속 여부

애플리케이션은 단지 일반적인 프로세스 설정만 가진다.

```dotenv
APP_BIND_ADDRESS=127.0.0.1
APP_PORT=3000
```

네트워크 접근 정책은 인프라가 담당한다 — 도메인·프록시·방화벽 개념을 .env 에 넣지 않는다.

## 2.2 네트워크 책임

```text
Application
└─ 127.0.0.1:3000

Caddy
├─ 퍼블릭 443에서 Listen (도메인, Let's Encrypt 자동 발급·갱신)
└─ 127.0.0.1:3000으로 Reverse Proxy

UFW
├─ 22 허용 (rate-limit) — 클라우드 브라우저 SSH 콘솔이 out-of-band 복구 경로
├─ 80 허용 (ACME·HTTPS 리다이렉트)
├─ 443 허용
└─ 나머지 인바운드 차단

Cloud Firewall (현재: Lightsail)
└─ TCP 22·80·443 만 허용
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

## 2.6 평면 분리

플랫폼(웹)은 조회 평면이다. 다음만 할 수 있다.

- 자동매매 결과·상태 조회
- 백테스트 생성·실행·취소
- 백테스트용 데이터 관리 (CSV 업로드, 증권사 데이터 동기화)
- 비상정지 — 자동매매를 **끄는 것만** 가능하다 (fail-safe)

SSH CLI는 제어 평면이다. 다음은 CLI로만 한다.

- 자동매매 전략 변경
- 주문·자금에 관한 직접 조작
- 자동매매 재개 (킬스위치 되켜기)
- TOTP 등록·재설정 등 보안 설정 변경

웹 API에 제어 평면 엔드포인트를 만들지 않는다. "웹에 없는 기능"이 방어선이므로,
편의를 이유로 제어 기능을 웹에 추가하는 것은 이 문서의 개정 사항이다.

실전 매매 도입 시 실전 신호가 읽는 데이터 경로와 플랫폼에서 쓰기 가능한 백테스트
데이터 경로를 분리한다. 분리 방식은 그 시점에 설계한다.

---

# 3. MVP 범위

## 포함

- 단일 관리자 로그인 (비밀번호 + TOTP 2단계 — D-017)
- 모바일 대응 웹 UI (조회 평면, §2.6)
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
- 도메인 + Caddy 퍼블릭 TLS (Let's Encrypt)
- 선택적 S3 백업

## 제외

- 공개 SaaS
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
- TOTP secret

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
│  │  ├─ cli.ts              # admin:create, totp:enroll — 제어 평면 (§2.6)
│  │  ├─ modules/
│  │  │  ├─ auth/
│  │  │  ├─ strategy/
│  │  │  ├─ market-data/
│  │  │  ├─ backtest/
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
│  │  ├─ lib/
│  │  └─ main.tsx
│  └─ shared/
│     └─ schemas/
│
├─ migrations/
├─ tests/
│  ├─ unit/
│  ├─ integration/
│  ├─ architecture/
│  └─ e2e/
├─ infra/
│  ├─ provision.sh           # 서버 프로비저닝 (§21~29 자동화, 멱등)
│  ├─ app.env.example
│  └─ systemd/
├─ scripts/
│  ├─ bootstrap.sh           # 개발 PC 에서 새 서버 셋업 (provision.sh 업로드·실행)
│  ├─ deploy.sh
│  ├─ backup.sh
│  └─ restore.sh
├─ docs/
│  ├─ SPEC.md                # 이 문서
│  ├─ ONBOARDING.md
│  ├─ PLAN.md
│  ├─ DECISIONS.md
│  └─ IMPLEMENTATION_STATUS.md
└─ README.md
```

`portfolio`·`risk` 모듈은 실거래 단계(§35)에서 추가한다 — 소비자 없는 코드를 미리 만들지 않는다 (D-009).

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
- Caddy·도메인·AWS 등 인프라 개념

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
│  └─ dataset=<datasetId>/          # 데이터셋 단위 물리 격리 — 다른 데이터셋의
│     ├─ market=KR/                 # 같은 심볼 import 와 섞이지 않는다
│     │  ├─ timeframe=1m/
│     │  │  └─ symbol=005930/year=2026/month=07/data.parquet
│     │  └─ timeframe=1h/
│     │     └─ symbol=005930/year=2026/data.parquet
│     └─ market=US/
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
- 백테스트 기본 소비는 사전 집계 1시간봉 — 요청이 `timeframe` 을 명시하면 1m 원본도
  소비할 수 있다 (D-026). 실행부가 전체 봉을 메모리에 올리므로 봉 수 상한(200만)을 둔다
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

datasets
dataset_versions
data_coverage
data_import_jobs

backtest_jobs
backtest_runs
backtest_metrics
backtest_equity_points
backtest_drawdown_points
backtest_trades
backtest_monthly_returns
backtest_symbol_metrics

audit_logs
__drizzle_migrations
```

전략 테이블(`strategies`·`strategy_versions`)은 만들지 않는다 — 전략은 코드
등록식 레지스트리가 유일한 출처다 (§2.5, D-009). 소비자 없는 테이블
(`application_settings`, `data_sync_jobs`)도 같은 이유로 없다 — 필요해지는
시점에 그 시점의 요구대로 신설한다.

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
POST /api/v1/auth/login          # 1단계 — 성공 시 TOTP_REQUIRED 또는 OK
POST /api/v1/auth/totp/verify    # 2단계 — TOTP/복구 코드, 성공 시 세션 회전 (§16)
POST /api/v1/auth/logout
GET  /api/v1/auth/me
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
  "strategyVersion": "1.2.0",
  "parameters": {
    "lookbackBars": 20,
    "atrPeriod": 14,
    "stopAtrMultiplier": 2,
    "riskPerTradePercent": 1
  },
  "datasetId": "kr-hourly-v1",
  "timeframe": "1h",
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
  "risk": {
    "maxPositions": 10
  },
  "execution": {
    "fillTiming": "NEXT_BAR_OPEN",
    "commissionProfileId": "kr-equity-default",
    "slippageProfileId": "fixed-5bps"
  },
  "randomSeed": 42
}
```

포지션 상한은 전략 파라미터가 아니라 요청의 `risk.maxPositions` 다 — 엔진의
리스크 제약(§9.2-6)이지 전략 로직의 입력이 아니기 때문이다 (D-012).

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

## 2단계 인증 (TOTP)

- 비밀번호 검증 후 TOTP 6자리 코드를 요구한다 (RFC 6238, 30초 주기, ±1 창)
- TOTP 등록·재설정은 서버 CLI에서만 한다 (`totp:enroll`) — 웹 세션 탈취로
  2단계 인증을 바꿔치기하는 경로를 차단한다 (§2.6)
- TOTP secret은 등록 시 1회만 표시하고 재노출하지 않는다
- 복구 코드 8개 (각 1회용, Argon2 해시 저장) — TOTP 분실 시 대체 경로
- TOTP 검증 실패는 로그인 실패 잠금(5회/15분)에 합산한다
- TOTP 검증 성공 시 세션 ID를 회전한다
- TOTP 미등록 계정은 비밀번호만으로 로그인된다 — 퍼블릭 노출 전에만 허용되는
  과도기 상태이며, 서버가 부팅 시 경고한다

## 세션

- 서버 저장 세션
- 로그인 후 세션 ID 회전
- `HttpOnly`
- `Secure`
- `SameSite=Strict`
- 유휴 만료 12시간
- 절대 만료 7일

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
token
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

- 1단계: 사용자 이름·비밀번호
- 2단계: TOTP 6자리 코드 또는 복구 코드 (`autocomplete="one-time-code"`)
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

이 요구사항을 만족하면 어떤 클라우드·VPS로도 교체할 수 있으며, 교체 시 인프라 장(§18~31)과 배포 스크립트만 수정한다.

추가 전제: 서비스 도메인 1개 — A 레코드가 서버의 고정 공인 IP 를 가리켜야 한다 (§23).

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

> §21~29 는 `infra/provision.sh` 가 단일 명령으로 자동화한다 (멱등 — 몇 번을
> 실행해도 결과가 같다). 개발 PC 에서는 `scripts/bootstrap.sh` 가 이 파일을
> 업로드·실행한다. 아래는 그 스크립트가 하는 일의 명세다.

```bash
sudo apt update
sudo apt full-upgrade -y

sudo apt install -y \
  ca-certificates \
  curl \
  git \
  jq \
  openssl \
  unzip \
  xz-utils \
  build-essential \
  python3 \
  pkg-config \
  sqlite3 \
  ufw \
  unattended-upgrades \
  gnupg
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

# 23. 퍼블릭 노출·도메인

> 이 장은 D-017 로 전면 교체됐다. 이전 모델(WireGuard 사설망 → D-016 에서
> Tailscale)은 폐기됐고, 그 이유와 트레이드오프는 DECISIONS.md 의 D-016·D-017 에
> 있다. 요지: 플랫폼의 권한을 조회 평면으로 줄이는 대신(§2.6) 노출을 허용한다.

전제:

- 서비스 도메인의 A 레코드가 이 서버의 고정 공인 IP 를 가리킨다. provision.sh 가
  프로비저닝 시작 시 해석을 확인하고, 아니면 중단한다.
- TLS 는 Caddy 가 Let's Encrypt 로 자동 발급·갱신한다 (§27). 도메인은 CT 로그에
  공개된다 — 퍼블릭 서비스 전제이므로 무해하다.

**고정 아웃바운드 IP**: 증권사 API 요청은 서버의 고정 공인 IP 로 나가야 한다
(허용 IP 등록제 대응). provision.sh 가 아웃바운드 IP 를 조회해 정보성으로
출력한다 — 증권사에 등록한 IP 와 일치해야 한다.

검증:

```bash
curl -4 https://checkip.amazonaws.com    # 결과가 Static IP 여야 한다
```

---

# 24. 클라우드 방화벽

클라우드(현재: Lightsail Networking)에서 **TCP 22·80·443 만 허용**하고 나머지는
제거한다 (기본 생성 규칙에 다른 포트가 있으면 삭제). IPv4 와 IPv6 를 각각
확인한다.

- 22: SSH — 퍼블릭으로 유지한다. 클라우드 브라우저 SSH 콘솔이 퍼블릭 22 를
  쓰므로, 이것이 키 분실 시의 out-of-band 복구 경로다 (D-017)
- 80: ACME HTTP-01 ·HTTPS 리다이렉트
- 443: HTTPS

---

# 25. UFW

```bash
sudo ufw default deny incoming
sudo ufw default allow outgoing

sudo ufw limit 22/tcp     # rate-limit — 브루트포스 감속 (인증 차단은 §26 이 담당)
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp

sudo ufw enable
sudo ufw status verbose
```

3000 은 열지 않는다 — 앱은 `127.0.0.1` 에만 bind 하므로 규칙 자체가 필요 없다.

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

퍼블릭 22 가 열려 있으므로 봇의 비밀번호 추측 시도가 상시로 들어온다 — 위
설정(`PasswordAuthentication no`)이 그 공격 부류 전체를 무효화한다. 이 하드닝은
클라우드 브라우저 SSH 콘솔을 막지 않는다 — 브라우저 SSH 는 키 인증이다 (D-017).

---

# 27. Caddy 퍼블릭 TLS

공식 Caddy apt repo 로 설치한다 — unattended-upgrades 가 보안 패치를 함께
관리한다.

`/etc/caddy/Caddyfile`:

```caddy
<도메인> {
    reverse_proxy 127.0.0.1:3000
}
```

Caddy 는 리버스 프록시 역할만 한다. Let's Encrypt 발급·갱신은 자동이다.
HSTS·보안 헤더는 앱(`SECURITY_HEADERS`)이, 압축은 `@fastify/compress` 가
담당하므로 Caddy 에 중복 설정하지 않는다 (D-016 에서 이관).

앱은 `TRUST_PROXY_LOOPBACK=true` 로 127.0.0.1 의 프록시 헤더만 신뢰한다 —
감사 로그의 `request.ip` 가 실제 클라이언트 IP 가 된다.

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

provision.sh 가 이 파일을 생성하며 `SESSION_SECRET` 은 서버에서 만든다.
**파일이 이미 있으면 절대 덮지 않는다** — SESSION_SECRET 이 바뀌면 기존 세션이
전부 무효화된다.

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

배포 순서 (`scripts/deploy.sh` 가 자동화):

1. 개발 PC에서 lint·typecheck·test·build
2. tar 생성
3. 서버로 scp
4. 새 release 디렉터리에 압축 해제
5. production dependency 설치
6. **SQLite 스냅샷 생성** — 재시작(=마이그레이션 적용) 직전 (D-010)
7. migration
8. `current` symlink 원자적 교체
9. systemd restart
10. health check
11. 실패 시 이전 release 와 **DB 스냅샷을 함께** rollback (D-010 — 코드만
    되돌리면 이전 코드가 새 스키마를 만나 죽는 "명목상 롤백"이 된다)

추가 규칙:

- 배포 스크립트는 비밀값을 command line argument 로 노출하지 않는다
- 파괴적 스키마 변경(컬럼·테이블 삭제)은 코드가 참조를 끊은 **다음** 릴리스에
  싣는다 (expand-contract, D-010)
- 스냅샷은 성공 배포 후에도 최근 5개를 보존하고, release 디렉터리는 회전시켜
  디스크를 묶는다

---

# 31. 백업

백업 대상:

- SQLite
- 결과 메타데이터
- 결과 export
- 데이터셋·엔진 버전 정보

백업 제외:

- 캔들 Parquet 전체 (D-019) — 1m/1d 는 증권사 재수집, 1h 는 1분봉 집계로 재생성
- 증권사 API secret
- 세션 secret (`app.env`)
- 관리자 비밀번호
- AWS secret key

로컬 백업 보관은 일수가 아니라 **총 용량**으로 제한한다 (`BACKUP_MAX_TOTAL_MB`,
기본 10240) — 호스트 디스크가 40GB 고정이므로 제약이 용량이면 정책도 용량이다
(D-013). 30일 lifecycle 은 S3 규칙이다.

S3를 사용할 경우:

- Block Public Access
- Versioning
- 기본 암호화
- 특정 bucket prefix만 허용하는 최소 IAM
- 30일 lifecycle
- 월 1회 복원 테스트

애플리케이션 프로세스에 AWS 키를 제공하지 않는다. 백업 스크립트 또는 별도 제한 사용자만 접근한다.

---

# 32. 등록 전략

`StrategyRegistry` 는 코드로 등록된 전략 세 개를 담는다 (§2.5). UI 는 검증된
파라미터만 바꾼다 — 전략 자체는 코드 리뷰·테스트를 거쳐 배포된다.

## 시간봉 돌파 (hourly-breakout)

엔진 검증용 기준 전략. 전략의 수익성을 약속하는 것이 아니라 백테스트 엔진의
정확성·재현성을 검증하기 위한 것이다.

```ts
const HourlyBreakoutParameters = z.object({
  lookbackBars: z.number().int().min(2).max(200),
  atrPeriod: z.number().int().min(2).max(100),
  stopAtrMultiplier: z.number().positive().max(20),
  takeProfitAtrMultiplier: z.number().positive().max(50).optional(),
  riskPerTradePercent: z.number().positive().max(5),
});
```

`maxPositions` 는 전략 파라미터가 아니다 — 요청의 `risk.maxPositions` 로 받는다
(§15, D-012). 현재 전략 버전은 1.2.0 이다. 봉만 사용하며 재무 데이터를 요구하지
않는다 (`requiresFundamentals` 미설정).

## 횡단면 모멘텀 (cross-sectional-momentum)

유니버스 전 종목의 12-1개월(형성 기간에서 최근 구간을 제외) 수익률을 랭킹해
상위 N 을 동일가중 보유한다. 액면분할 등 자본변동 이벤트가 수집된 데이터셋에서는
신호 계산 시 가격을 보정한다 — 체결가 자체는 항상 실제 거래 가격이다. 봉만
사용하며 재무 데이터를 요구하지 않는다.

## 밸류·퀄리티 랭킹 (value-quality-rank)

이익수익률(TTM EBIT / EV)과 자본수익률(TTM EBIT / 투입자본) 순위를 합산해 상위
N 을 동일가중 보유한다. `requiresFundamentals: true` 로 선언되어 있어, 상장시점
재무(point-in-time 팩트 저장소, `pnpm cli facts:sync` 로 DART 공시를 수집)가
수집되지 않은 데이터셋에 제출하면 422 로 거부된다 — 실행 후 "거래 0건" 으로
끝나 원인을 알 수 없는 상태를 막기 위해서다.

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
- kill switch — 웹에서는 **끄기만** 가능, 재개는 CLI 전용 (§2.6, D-017)
- 재부팅 후 자동 실거래 재개 금지
- 수동 arm (CLI)

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

- 관리자 CLI (admin:create, totp:enroll)
- Argon2id
- 로그인 (비밀번호 + TOTP 2단계)
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
- 도메인 + Caddy (Let's Encrypt)
- UFW (22 rate-limit / 80 / 443)
- sshd 하드닝 (키 전용)
- systemd
- deploy/rollback (bootstrap.sh · provision.sh · deploy.sh)

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
docs/PLAN.md
docs/DECISIONS.md
docs/IMPLEMENTATION_STATUS.md
```

- `docs/PLAN.md`: 파일 단위 작업 계획
- `docs/DECISIONS.md`: 명세 밖 선택과 이유
- `docs/IMPLEMENTATION_STATUS.md`: 완료·진행·미완료

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
- 네트워크(도메인·프록시·방화벽) awareness는 infra only
- 클라우드 awareness는 infra only
- 증권사 awareness는 infra only, 접근은 REST 전용
- 평면 분리 — 웹에 제어 평면 엔드포인트 금지 (§2.6)
- SQLite + Parquet + DuckDB
- concurrency 1
- arbitrary strategy code 금지
- live trading disabled
- shadcn/ui mobile-first

명세 변경이 필요하면 구현 전에 `docs/DECISIONS.md`에 다음을 기록한다.

- 변경 내용
- 이유
- 대안
- 보안 영향
- 비용 영향
- 마이그레이션 영향

---

# 38. 완료 기준

## 보안

- 3000 은 외부에서 접근 불가 — 앱은 `127.0.0.1:3000`만 Listen
- 443 은 도메인으로만 유효한 TLS 응답 (Let's Encrypt)
- 22 는 키 인증만 수락 (비밀번호 인증 거부)
- 도메인·애플리케이션 계층에 인프라 개념 문자열 없음 (§2.1)
- 로그인 필요 — 비밀번호 + TOTP 2단계, TOTP 등록·재설정은 CLI 전용
- 웹에 제어 평면 엔드포인트 없음 (§2.6)
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

Access model
└─ 평면 분리 (D-017): 웹 = 조회 평면 (퍼블릭 도메인 + 비밀번호+TOTP),
   제어 조작 = SSH CLI 전용

Reverse proxy
└─ Caddy, 도메인:443, Let's Encrypt 자동 발급·갱신

Public inbound
└─ TCP 22 (SSH, 키 전용) · 80 (ACME) · 443 (HTTPS)

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

Network awareness
└─ Infrastructure only — 도메인·Caddy·UFW·클라우드는 infra/·scripts/ 만 안다
```
