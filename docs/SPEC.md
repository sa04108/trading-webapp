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
- app 노드 공인 IP
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
- 운영 app 노드 하나
- 메타데이터 DB 하나
- 내부 역할과 의존 방향은 엄격히 분리

마이크로서비스로 쪼개지 않는다. 다만 백테스트 계산은 HTTP 이벤트 루프와 메모리 장애를
분리하기 위해 **동일 아티팩트의 자식 프로세스**에서 실행한다. 기본 local 모드는 서버
호스트에서 fork하고, 선택적 remote 모드는 별도 PC의 supervisor가 HTTPS lease를 받아
같은 child를 실행한다. 원격 worker도 별도 제품·DB가 아니라 같은 릴리스의 계산 배치다.

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
- 백테스트용 데이터 관리 (KRX 종목 마스터 동기화) — CSV 업로드·증권사 데이터 동기화는
  D-041 로 사라졌다
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
- 일봉 백테스트 — 봉은 KRX 일별매매 하나로 좁혔다 (D-041)
- 단일·복수 종목
- 지속성 작업 큐
- 동시 실행 1개
- 진행률·취소
- 재시작 후 작업 상태 복구
- SQLite 일봉 저장 (KRX 일별매매 수집)
- SQLite 재무 팩트 조회·분석 (D-054)
- SQLite 메타데이터
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
| Fact storage | SQLite (PIT long format, D-054) |
| Market data | SQLite (KRX 일별매매, D-041) |
| Password hashing | Argon2id |
| Test | Vitest |
| E2E | Playwright |
| Package manager | pnpm |
| Boundary check | dependency-cruiser |

2026-07-25 기준 Node.js 24는 LTS이고 Node.js 26은 Current다. 운영에는 Node.js 24 LTS 최신 패치를 사용한다.

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
         ├─ SQLite 일봉 조회 (KRX 일별매매, D-041)
         ├─ SQLite 재무 팩트 조회
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
    BACKTEST_JOB_ID: jobId,
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
│  ├─ provision-app.sh       # app 노드 프로비저닝 (§21~29 자동화, 멱등)
│  ├─ app.env.example
│  └─ systemd/
├─ scripts/
│  ├─ bootstrap-app.sh       # 개발 PC 에서 새 app 노드 셋업 (provision-app.sh 업로드·실행)
│  ├─ deploy.mjs             # deploy.env 기반 app/worker SSH/SCP 배포 조정
│  ├─ deploy-app.sh
│  └─ backup.sh
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

봉의 유일한 출처는 KRX 일별매매다 (`krx_daily_bars`, SQLite, §11).
`MarketDataSource` 포트는 D-041 로 사라졌다 — `fetchCandles`·`saveCandles`·
`getCoverage`도 증권사 봉 수집·CSV/Parquet 가져오기와 함께 없어졌다.
`CandleRepository`는 이제 읽기 전용이다. 쓰기는 `SymbolMasterService.ingestDate`가
종목 마스터 이벤트·coverage 갱신과 같은 트랜잭션에서 하는 것이 유일한 경로다.

```ts
export interface CandleRepository {
  getCandles(query: CandleQuery): AsyncIterable<Candle>;
  /** 저장된 봉의 시작 시각 목록 (coverage 계산용) */
  getTimestamps(market: Market, timeframe: Timeframe, symbol: string): Promise<number[]>;
}

export interface StockInfoSource {
  /** 코드 목록의 기본 정보 조회 — 증권사 어댑터에 남은 유일한 책임 (D-041) */
  getStockInfo(symbols: readonly string[]): Promise<StockInfoBatchResult>;
}
```

구현체:

```text
KrxDailyCandleRepository    # krx_daily_bars(SQLite) 읽기 전용
createTossStockInfoSource   # StockInfoSource 구현 (§13)
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

0. 이 시점까지 공시된 상장시점 팩트 흡수 (PIT 커서) — 전략 호출 전이어야 한다
1. 이전 시점의 대기 주문 체결
2. 현금·포지션 갱신
3. 평가금액 갱신
4. 현재까지 확정된 봉을 전략에 전달
5. 신규 주문 의도 생성
6. 리스크 검증
7. 다음 봉 체결 대기열 등록
8. 스냅샷·진행률 저장

0단계는 재무 팩트에만 적용된다. 자본변동(액면분할 등) 이벤트는 공시 접수일이 효력
발생일보다 최대 15개월 늦으므로 커서를 타지 않고, **효력 발생일 ≤ 현재 봉** 이라는
조건만으로 노출된다 — 이미 발생한 분할로 과거 가격을 보정하는 것은 look-ahead 가 아니다.

그 봉 시각에 효력이 발생한 자본변동이 있으면 1단계(대기 주문 체결)보다
먼저 조정을 적용한다(D-043).
조정 대상은 보유 포지션·대기 주문 수량·전략 가격 상태
(`stopLevel`·`highestClose`·`entryAtr`)다.
분할일 매도는 조정된 수량으로 체결돼야 한다.
분할 직후의 미조정 가격 상태는 허위 손절을 만들 수 있다.
수량 × 평균단가는 조정 전후로 보존된다.
단주 잔여는 내림 처리해 그 봉 시가로 환산한 뒤 현금에 더한다.
원본 봉 자체는 고치지 않는다.

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
universeRuleJson
scheduleHash
universeHash
universeJson
engineVersion
feeModelVersion
slippageModelVersion
randomSeed
gitCommitSha
startedAt
completedAt
```

`datasetId` 는 없다. 유니버스는 데이터셋이 아니라 규칙(`universeRuleJson`)으로
받는다. 제출 시점에 `UniverseRuleResolver` 가 리밸런스 날짜별 멤버십을 구성해
`scheduleHash` 에 남긴다.

이 설계는 데이터셋을 종목의 참조 집합으로 좁힌 D-034 위에, 유니버스 규칙을 얹은
후속 작업이다.

같은 입력·버전·seed는 같은 결과를 만들어야 한다.

봉·재무가 종목에 종속되고 데이터셋이 그것을 공유하므로(D-034), 데이터셋 버전
하나로는 실행 입력을 고정할 수 없다. 봉은 KRX 일별매매(`krx_daily_bars`) 하나가
유일한 출처라 버전 pin 대상이 아니다(D-041) — 재무만 종목별 버전을 갖는다.

실행 입력은 소비한 `(종목, 버전, 해시)` 목록을 `universeJson` 에 남긴다. 그 집계
해시는 `universeHash` 에 남긴다. 워커는 실행 시점의 현재 버전과 비교해 변한 종목을
이름으로 경고한다.

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
- 종목 리밸런싱(리밸런스일·기준일·최초 구성 수·편입 수·편출 수)

종목 리밸런싱은 제출 시점에 고정한 멤버십 일정을 직전 일정과 비교한다. 첫 행은
최초 구성 종목 수를 표시한다. 이후 행은 현재 일정에만 있는 편입 수와 직전 일정에만
있는 편출 수를 표시하며, 변동 종목 수는 두 수의 합이다.

## 9.7 제출 검증

제출 시점에 유니버스 종목을 두 게이트가 검사한다. 하나는 재무 게이트다.
`requiresFundamentals` 전략이 재무 있는 종목을 하나도 못 찾으면 막는다.
다른 하나는 자본변동 게이트다(D-043). 이 절은 자본변동 게이트만 다룬다.

판정 단위는 종목별 **연도**다. 백테스트 기간이 걸치는 연도 전부가 그
종목의 자본변동 커버리지에 있어야 통과한다. 한 연도라도 없으면 그
종목은 자본변동을 아예 수집하지 않은 것으로 본다.

- **커버리지 없음 → 400.** 우회 수단을 두지 않는다. 수집하거나 돌리지
  않거나 둘 중 하나다.
- **gap 만 있음 → 통과, 이름으로 경고.** gap 은 수집은 했지만 DART 가
  답하지 못한 연도다. DART 가 못 답하는 종목은 대체로 상장폐지 종목이라,
  gap 까지 요구하면 생존편향 제거(D-041)와 충돌한다.
- **팩트 0건, gap 없음, 커버리지 있음 → 통과, 경고 없음.** 분할이 없었던
  것으로 확정된 상태다.

이 세 상태는 팩트 건수만으로 가를 수 없다.
팩트 0건은 세 상태 모두에서 나올 수 있다 — 수집했고 분할이 없었다,
수집했는데 DART 가 못 답했다, 아예 수집하지 않았다.
그래서 `symbol_facts_state` 가 자본변동 **수집 연도**와 **gap 연도**를
재무 커버리지와 별도 컬럼으로 담는다(§12).

자본변동만 받는 수집 경로가 따로 있다(§14). 재무 게이트가 재무를 따로
막고 안내하므로, 분할 보정만 필요한 전략에 재무 수집 비용을 물리지 않는다.

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
BACKTEST_EXECUTION_MODE=local
MAX_CONCURRENT_BACKTESTS=1
```

현 $7 Lightsail은 local 1을 유지한다. `BACKTEST_EXECUTION_MODE=remote`에서는 app이
계산 child를 만들지 않고 인증된 worker의 long-poll claim만 받는다. 이때 실제 병렬도는
각 worker의 `BACKTEST_WORKER_CONCURRENCY` 합이며 `MAX_CONCURRENT_BACKTESTS`는 적용되지
않는다. Worker는 app과 정확히 같은 Git SHA만 claim할 수 있다.

원격 claim은 원자적으로 attempt를 올리고 임대 token의 SHA-256과 만료 시각만 DB에 남긴다.
Worker는 heartbeat로 임대를 연장하고 진행률·취소 요청을 교환한다. 만료된 lease는 설정된
최대 attempt까지 `QUEUED`로 돌아가며, 마지막 만료는 `FAILED`가 된다. 늦게 온 이전
attempt의 heartbeat·결과는 모두 거부한다. 입력은 해당 job과 유니버스 종목에 필요한
행만 담은 SQLite snapshot이며 인증·세션·감사·다른 job은 포함하지 않는다. 결과 artifact는
크기·checksum·SQLite integrity·schema·행 타입을 검증하고 결과 import와 `COMPLETED`
전이를 한 app SQLite transaction으로 처리한다. 검증과 대량 행 import는 별도 app-side
child에서 직렬 실행해 Fastify 이벤트 루프를 막지 않는다.

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

자식 프로세스의 백테스트 실행은 better-sqlite3 기반이라 전부 동기다. 동기 코드는
이벤트 루프에 양보하지 않으므로, 원래는 2번 IPC 취소 요청이 계산이 끝나야 처리됐다.
엔진 루프(`runBacktestCancellable`)는 200봉마다 한 번 `setImmediate` 로 양보해 그
매크로태스크 경계를 만든다 — 취소가 실행 도중에도 닿는다(D-042). 자식 프로세스 밖에서
쓰는 동기 경로(`runBacktest`)는 이 양보를 넣지 않는다.

## 재시작 복구

app 시작 시 local 작업의 `STARTING`, `RUNNING`, `CANCELLING`을 검사한다. 대응 OS
프로세스가 없으면 `INTERRUPTED`로 바꾸고 자동 재실행하지 않는다. Remote lease는 app
재시작 뒤 worker가 heartbeat를 이어 갈 수 있으므로 만료 전에는 보존한다. remote에서
local 모드로 바꾸면 더는 갱신할 endpoint가 없는 활성 remote lease를 `INTERRUPTED`로 닫는다.

---

# 11. 데이터 저장

봉은 `app.sqlite` 의 `krx_daily_bars` 테이블에 있다 — 종목이 저장 단위이고 데이터셋은
참조만 갖는다 (D-034). 재무 팩트도 `facts` long-format 테이블에 PIT 이력을 보존한다
(D-054).

```text
/var/lib/quant-platform/
├─ app.sqlite                       # 일봉·재무 fact·coverage·메타데이터
├─ market-data/                     # 쓰기 가능 여부·디스크 여유 확인 기준 디렉터리
├─ imports/                         # 미사용 — CSV 가져오기가 D-041 로 사라졌다
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
- 실행부가 전체 봉을 메모리에 올리므로 봉 수 상한(200만)을 둔다 — 유일한 timeframe 인
  일봉만 소비한다 (D-041)
- 재무 fact 복합 PK: `(scope, key, field, period_key, as_of_ts_ms)`
- 공시 정정은 다른 `as_of_ts_ms` 행으로 보존

---

# 12. SQLite 스키마

```text
users
sessions
login_attempts
notifications

symbols
symbol_slices
symbol_coverage
symbol_facts_state
symbol_versions
krx_daily_bars

symbol_master_versions
symbol_master_storage_state
symbol_master_checkpoints             # legacy 이행용, ACTIVE 전환 후 비어 있음
symbol_master_checkpoint_symbols      # legacy 이행용, ACTIVE 전환 후 비어 있음
symbol_master_events                  # legacy 이행용, ACTIVE 전환 후 비어 있음
symbol_master_coverage
symbol_master_market_caps
symbol_master_trading_days

data_sync_jobs
corporate_action_sync_jobs

backtest_jobs
backtest_runs
backtest_metrics
backtest_equity_points
backtest_drawdown_points
backtest_trades
backtest_monthly_returns

audit_logs
__drizzle_migrations
```

전략 테이블(`strategies`·`strategy_versions`)은 만들지 않는다 — 전략은 코드
등록식 레지스트리가 유일한 출처다 (§2.5, D-009). `application_settings` 도 같은
이유로 없다 — 필요해지는 시점에 그 시점의 요구대로 신설한다.

`symbol_slices`·`symbol_coverage`·`data_sync_jobs`는 테이블이 남아 있지만 쓰는
코드가 없다(D-041). 가격 데이터 기능 제거로 증권사 봉 수집·CSV 가져오기가 사라지며
소비자를 잃었다. 스키마에서 실제로 지우는 것은 후속 계획이다.

`corporate_action_sync_jobs`는 `data_sync_jobs`와 다르다.
자본변동 일괄 수집 잡 전용으로 새로 만든 테이블이고 지금도 쓰인다(D-043).
`data_sync_jobs`를 재사용하지 않은 이유는 그 테이블이 CSV·증권사 봉·재무
단계를 다 담느라 컬럼 12개 중 대부분이 죽어 있기 때문이다. 종목 코드
목록·연도 범위·완료 종목 수·전체 종목 수를 담아 SSE 진행률에 쓴다(§14).

`symbol_facts_state`는 재무 커버리지(`coveredYearsJson`) 옆에 자본변동
전용 컬럼 둘을 더 갖는다(D-043). `actionCoveredYearsJson`은 자본변동을
수집한 연도이고 제출 게이트가 읽는다(§9.7). `actionGapYearsJson`은
DART 가 답하지 못해 gap 이 난 연도이고 위저드 경고가 읽는다.
두 컬럼은 `coveredYearsJson`과 분리돼 있다.
합쳐 두면 자본변동만 받은 종목을 재무 전략이 "데이터 있음"으로 오판한다.

봉의 유일한 출처는 `krx_daily_bars` 다. `SymbolMasterService.ingestDate`가 종목
마스터 SCD 버전·coverage 갱신과 같은 트랜잭션에서 쓴다.

종목 마스터는 날짜별 full universe를 입력으로 받되 `symbol_master_versions`에
종목 상태가 바뀐 관측일만 SCD Type 2 반개구간으로 저장한다. coverage·시총·거래일도
같은 수집 경로가 채운다. 기존 체크포인트·이벤트 테이블은 0012 이행 후 빈 legacy
구조로만 남고 신규 쓰기·조회에는 쓰이지 않는다.

`universe_snapshots`·`universe_snapshot_symbols`는 스키마에 없다.

D-040 이 설계한 저장 방식은 유니버스 규칙(`universeRule`, §9.5·§15)으로
대체됐다. 스냅샷을 저장하는 대신 제출 시점에 `UniverseRuleResolver` 가
종목 마스터에서 매번 다시 구성한다.

`symbols.standard_code`는 KRX 표준코드(ISIN)를 보존해 단축코드 재사용과 종목
변경을 구분한다.

`notifications`는 백테스트·데이터 동기화 알림을 전역으로 담는다 — 사용자가
한 명이라 사용자별로 나누지 않는다.

SQLite 설정:

```sql
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
```

계산 중 장시간 DB transaction을 유지하지 않는다.

---

# 13. 증권사 REST 데이터 어댑터

이 절의 원래 범위(증권사 REST 봉 수집)는 D-041 로 사라졌다. 봉의 유일한 출처는 KRX
일별매매(`krx_daily_bars`, §11)이고, 증권사 REST 는 더 이상 봉을 수집하지 않는다.

애플리케이션 코어는 `StockInfoSource` port만 안다. 증권사별 구현은 infrastructure
계층의 어댑터이며, 다음 전제를 공유한다.

- REST 전용 — OCX·전용 프로그램·윈도우 브릿지 서버를 전제로 한 코드는 만들지 않는다
- 토큰 기반 인증 (발급·캐싱·만료 전 재발급)
- 종목 이름 조회 — 백테스트 위저드·상세 화면의 표시용으로 남은 유일한 소비자다 (D-041)
- 주문·계좌 기능 (실거래 단계)
- 허용 IP 등록제 증권사 대응 — app 노드의 고정 공인 IP 사용

현재 구현은 토스증권 Open API 하나다 (`toss-stock-info-source.ts`). 어댑터 구현 순서는
외부 사정에 따른 인프라 결정이며 코어에 영향을 주지 않는다.

## 공통 REST 클라이언트

토큰·rate limit 처리는 개별 증권사 어댑터가 아니라 broker 모듈의 공통 REST 클라이언트가 담당하고, 모든 증권사 어댑터가 이를 공유한다.

- 토큰 발급·캐싱·만료 전 재발급
- API 그룹별 limiter
- 응답 헤더 반영
- 429에서 `Retry-After` 우선
- exponential backoff + jitter
- 동일 범위 요청 병합
- 중단 후 이어받기

봉 입력 어댑터 목록(증권사 REST API·CSV Import·Parquet Import)은 D-041 로 사라졌다.
과거 데이터 백필은 이제 KRX 재수집(`POST /symbol-master/backfill`)이 유일한 경로다.

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
GET  /api/v1/markets
GET  /api/v1/symbols
GET  /api/v1/symbols/info
POST /api/v1/symbols
POST /api/v1/symbols/remove

GET  /api/v1/symbol-master/universe
GET  /api/v1/symbol-master/coverage
GET  /api/v1/symbol-master/events
POST /api/v1/symbol-master/sync
POST /api/v1/symbol-master/backfill
```

라우트가 `datasets` 가 아니라 `symbols`·`symbol-master` 인 이유는 종목을 1급
객체로 바꾼 D-034 다.

`import`·`sync`·`data-jobs` 엔드포인트는 그 뒤 D-041 로 사라졌다 — CSV 가져오기·
증권사 봉 동기화 자체가 없어졌다. 봉 수집은 이제 KRX 동기화(`symbol-master/sync`·
`symbol-master/backfill`)뿐이다.

## 자본변동 수집

```http
POST /api/v1/facts/corporate-action-sync-plan
POST /api/v1/facts/corporate-action-sync-jobs
GET  /api/v1/facts/corporate-action-sync-jobs/:id
POST /api/v1/facts/corporate-action-sync-jobs/:id/cancel
GET  /api/v1/facts/corporate-action-sync-jobs/:id/events
```

§9.7 제출 게이트가 자본변동 커버리지 없는 종목을 막았을 때 위저드가 이
경로로 일괄 수집을 건다(D-043). `sync-plan`은 잡을 만들지 않고 예상
호출·시간만 미리 계산한다. `sync-jobs`는 실제 잡을 만들어 큐에 넣는다.
진행률은 `events`가 SSE로 흘린다 — 백테스트 진행률(`/backtests/:id/events`)
과 같은 골격이다. 재무는 이 경로로 받지 않는다. `FactSyncService`가
`fetchFinancials`를 건너뛰고 자본변동만 받는 경로를 별도로 노출한다.

## 백테스트

```http
GET    /api/v1/backtests/profiles
POST   /api/v1/backtests/universe-preview
POST   /api/v1/backtests
GET    /api/v1/backtests
GET    /api/v1/backtests/:id
POST   /api/v1/backtests/:id/cancel
POST   /api/v1/backtests/:id/clone
POST   /api/v1/backtests/:id/clone-configured
POST   /api/v1/backtests/:id/clone-random-seeds
GET    /api/v1/backtests/:id/clone-draft
GET    /api/v1/backtest-clone-batches
GET    /api/v1/backtest-clone-batches/:id
POST   /api/v1/backtest-clone-batches/:id/cancel
DELETE /api/v1/backtest-clone-batches/:id
DELETE /api/v1/backtests/:id
GET    /api/v1/backtests/:id/trades
GET    /api/v1/backtests/:id/series
GET    /api/v1/backtests/:id/export
GET    /api/v1/backtests/:id/events
```

진행률은 SSE를 기본으로 한다. 연결이 끊기면 polling으로 fallback한다.

`clone-draft`는 현재 전략 버전의 완료된 준비 결과와 원본 job의 고정 리밸런스 일정
hash가 같고 원본 유니버스·출처·벤치마크 pin이 모두 파싱·hash 검증을 통과하면
`reusablePreview`를 반환한다. `clone-configured`는 기간·유니버스 규칙·전략·전략
파라미터가 그대로일 때 이 일정과 pin을 재사용한다. 원본 pin이 없거나 손상됐으면 현재
데이터로 조용히 대체하지 않고 `PREVIEW_REQUIRED`로 새 미리보기를 강제한다. 자본·비용·
벤치마크·보유 상한·난수 시드 변경은 유니버스 미리보기를 무효화하지 않지만 요청 자체의
정적 검증은 계속한다.

`clone-random-seeds`는 `{ "count": 1..100 }`을 받아 서로 다른 uint32 시드를 가진 묶음을
만든다. 묶음 item은 먼저 영속화하고 실제 백테스트 job은 `MAX_QUEUED_BACKTESTS`의 빈
슬롯만큼만 순차 생성한다. 따라서 100개 실험도 일반 대기열 상한을 우회하지 않는다.
seed 묶음의 자식 job에서는 다시 `clone-random-seeds`를 호출할 수 없고 원본 백테스트로
돌아가야 한다. 중첩 묶음은 같은 설정의 seed 표본을 다시 감싸 계보와 삭제 수명만
복잡하게 만들기 때문이다.
취소하면 묶음은 먼저 `CANCELLING`이 되어 새 승격을 막고, 실행 중인 자식이 모두 종료된
뒤에만 `CANCELLED`와 완료 시각을 확정한다. 자식별 종료 알림은 만들지 않고 묶음이
`COMPLETED`·`FAILED`·`CANCELLED`로 확정될 때 결과 수를 집계한 알림 한 건만 만든다.
상세 화면은 완료된 실행만 대상으로 평균·중앙·최고·최저 수익률과 평균 MDD를 집계하고,
수익률과 Sharpe의 표본 표준편차를 `n-1`로 계산한다. Sharpe가 `null`인 실행은 Sharpe
분포에서만 제외하며, 이 편차는 가격 경로의 Monte Carlo가 아니라 동률·동시 주문의 seed
순서 민감성을 뜻한다.
목록에서는 난수 실험을 별도 종류로 분리하지 않고 `sourceJobId`가 가리키는 원본
백테스트 카드 아래에 들여써서 표시한다. 종료된 실험은 단독 삭제할 수 있고, 원본
백테스트를 삭제하면 그 원본에서 만든 모든 난수 실험과 자식 job·결과도 같은 트랜잭션에서
삭제한다. 실행 중인 실험이나 자식 job이 하나라도 있으면 삭제를 거부하고 취소 완료를
먼저 요구한다.
`GET /backtest-clone-batches`는 기본 50개 백테스트 페이지 밖 원본도 표시할 수 있도록
응답의 `sourceJobs`에 현재 묶음들이 참조하는 원본 job 요약을 중복 없이 함께 반환한다.
과거 버전에서 이미 중첩 묶음이 생겼다면 삭제 시 후손 묶음을 재귀적으로 포함하며, 활성
후손이 하나라도 있으면 전체 삭제를 거부한다.

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
  "strategyId": "range-breakout",
  "parameters": {
    "lookbackBars": 20,
    "atrPeriod": 14,
    "stopAtrMultiplier": 2,
    "trailAtrMultiplier": 2,
    "riskPerTradePercent": 1,
    "maxPositionWeightPercent": 20
  },
  "universeRule": {
    "markets": ["KOSPI"],
    "stages": [{ "criterion": "MARKET_CAP", "direction": "HIGH", "limit": 10 }],
    "rebalanceInterval": { "unit": "MONTH", "value": 1 }
  },
  "timeframe": "1d",
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

`randomSeed`는 엔진이 실제 소비하는 unsigned 32-bit 정수 범위
`0..4,294,967,295`만 허용한다.

포지션 상한은 전략 파라미터가 아니라 요청의 `risk.maxPositions` 다 — 엔진의
리스크 제약(§9.2-6)이지 전략 로직의 입력이 아니기 때문이다 (D-012).

`universeRule` 은 개별 종목을 직접 고르지 않는다. 시장(`markets`)·정렬 단계
(`stages`, 최대 6단계 — 시가총액·거래량·거래대금·PER·ROE·가격 변동을 순서대로 적용해
좁힌다)·리밸런스 주기(`rebalanceInterval`)를 규칙으로 받는다(스펙 2026-08-09,
순서형 유니버스 파이프라인).

각 단계는 기준(`criterion`), 방향(`direction`: `HIGH` 또는 `LOW`), 선별 수(`limit`)를
저장한다. 화면은 기준에 맞는 방향 문구를 표시한다. 시가총액·거래량·거래대금은 상위/하위,
PER는 낮음/높음, ROE는 높음/낮음, 가격 변동은 급상승/급하락으로 표시한다. 가격 변동의
내부 기준 식별자는 기존 `DECLINE`을 유지한다.

`datasetId`·`universe` 필드를 대신하는 이유는 §9.5 를 본다.

`timeframe` 은 이제 `'1d'` 고정 선택값이다 — KRX 일봉이 유일한 출처라 다른 값을
받지 않는다 (D-041).

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

단계 이동은 하단의 `이전`·`다음` 과 상단의 단계 버튼 두 가지다. 상단 버튼은 원하는
단계로 바로 뛴다 — 뒤로는 제한이 없고, 앞으로는 지나칠 단계가 모두 통과했을 때만,
그것도 `검토` 까지다. `실행` 은 점프 대상이 아니다: 제출 버튼이 있는 화면에는
`검토` 에서 `다음` 을 눌러서만 들어온다.

잠긴 단계 버튼은 `disabled` 로 죽이지 않고 `aria-disabled` 로 표시한다. 눌렀을 때
이동하지 않는 대신 무엇을 먼저 마쳐야 하는지 오류 영역에 문장으로 띄운다 (§17).

전략 카드는 그 전략이 재무를 보는지 배지로 밝힌다 — 「재무 필요」 또는 「봉 데이터만」
둘 중 하나가 **모든 카드에** 붙고, 고른 카드는 무엇이 신호에 개입하는지 한 줄로 풀어
쓴다. 검토 단계에도 같은 배지를 둔다: 제출 직전이 재무 개입을 알아차릴 마지막 지점이다.
배지 없음을 「봉 전용」으로 읽게 두지 않는 이유와 필드가 없는 응답에서 배지를 침묵시키는
이유는 D-032 에 있다.

데이터셋 카드(2단계)는 짝이 되는 표기를 쓴다 — 「재무 있음」·「재무 없음」 배지와
「마지막 수집 N일 전」이다. 1단계에서 「재무 필요」를 본 사용자가 2단계에서 「재무 없음」을
보면 제출 전에 조합이 어긋난 것을 알아차린다 (D-033). 재무는 **있고 없음만** 표시한다:
종목별·연도별 충족도는 카드가 답할 질문이 아니다. 묵음 판정 문턱은 두지 않는다 — 경과
시간만 보여 주고 동기화 여부는 사용자가 정한다.

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

하단:

- 거래 내역
- 종목 리밸런싱
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

추가 전제: 서비스 도메인 1개 — A 레코드가 app 노드의 고정 공인 IP 를 가리켜야 한다 (§23).

현재 선택은 AWS Lightsail 서울이다. 2026-07 기준 공식 Lightsail Linux public IPv4 플랜:

| 플랜 | vCPU | RAM | SSD | 월 비용 |
|---|---:|---:|---:|---:|
| Nano | 2 | 0.5GB | 20GB | $5 |
| Micro | 2 | 1GB | 40GB | $7 |
| Small | 2 | 2GB | 60GB | $12 |

월 10달러 미만 목표에는 **$7 Micro 플랜**을 사용한다.

제약:

- 백테스트 자식 프로세스 동시 실행 1개
- 봉 수 상한 200만 (§11) — 일봉만 소비하므로 사전 집계가 필요 없다 (D-041)
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
- 안정적인 app 노드 식별

웹 포트를 여는 용도가 아니다.

---

# 21. 초기 Ubuntu 설정

> §21~29 는 `infra/provision-app.sh` 가 단일 명령으로 자동화한다 (멱등 — 몇 번을
> 실행해도 결과가 같다). 개발 PC 에서는 `scripts/bootstrap-app.sh` 가 이 파일을
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
  util-linux \
  ufw \
  unattended-upgrades \
  gnupg
```

app 노드 시간대:

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

- 서비스 도메인의 A 레코드가 app 노드의 고정 공인 IP 를 가리킨다. provision-app.sh 가
  프로비저닝 시작 시 해석을 확인하고, 아니면 중단한다.
- TLS 는 Caddy 가 Let's Encrypt 로 자동 발급·갱신한다 (§27). 도메인은 CT 로그에
  공개된다 — 퍼블릭 서비스 전제이므로 무해하다.

**고정 아웃바운드 IP**: 증권사 API 요청은 app 노드의 고정 공인 IP 로 나가야 한다
(허용 IP 등록제 대응). provision-app.sh 가 아웃바운드 IP 를 조회해 정보성으로
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
BACKTEST_EXECUTION_MODE=local
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

provision-app.sh 가 이 파일을 생성하며 `SESSION_SECRET` 은 app 노드에서 만든다.
**파일이 이미 있으면 절대 덮지 않는다** — SESSION_SECRET 이 바뀌면 기존 세션이
전부 무효화된다.

전체 항목은 `infra/app.env.example` 이 기준이다 (증권사·DART 자격 증명 포함).
별도 worker 설정은 `infra/worker.env.example`, 실행 경계는
`infra/docker/compose.worker.yaml`과 `infra/docker/backtest-worker.Dockerfile`이 기준이다.
Worker는 Docker Compose 전용이며 애플리케이션 systemd fallback은 없다. app과 worker는
같은 `BACKTEST_WORKER_TOKEN`과 한 번 만든 공통 archive의 동일한 릴리스 SHA를 사용한다.

## 28.1 값을 바꾼 뒤

```bash
sudo install -m 600 -o root -g root /etc/quant-platform/app.env{,.bak}
sudo nano /etc/quant-platform/app.env
sudo systemctl restart quant-platform
sudo systemctl is-active quant-platform
```

`systemctl daemon-reload` 로는 반영되지 않는다 — 그건 유닛 파일이 바뀔 때고,
`EnvironmentFile` 은 **서비스 기동 시점**에 읽힌다. reload 도 부족하고 restart 가
필요하다.

세 가지 함정:

- systemd 의 env 파싱은 셸이 아니다. `export` 를 쓰지 말고, 값에 따옴표를 붙이지
  말고, `$VAR` 확장을 기대하지 말 것.
- **빈 값과 미설정은 다르다.** `DART_API_KEY=` 처럼 빈 값을 두면 zod 의 `min(1)` 이
  거부해 `ConfigError` 로 부팅이 실패한다. 줄을 아예 넣지 않으면 정상 부팅하고 해당
  기능만 비활성이다. 그래서 restart 뒤 `is-active` 확인이 절차의 일부다.
- `TOSS_CLIENT_ID`/`TOSS_CLIENT_SECRET` 은 둘 다 설정하거나 둘 다 비워야 한다.
  한쪽만 있으면 부팅이 `ConfigError` 로 실패한다 (반쪽 자격 증명은 "설정했다고
  믿었는데 비활성" 인 상태를 만들기 때문에 의도적으로 즉시 실패시킨다).

## 28.2 운영에서 CLI 실행

CLI 는 별도 프로세스이고 `app.env` 를 **자동으로 읽지 않는다**. `admin:create`·
`totp:enroll` **모두** systemd 와 같은 환경으로 띄워야 한다 — 자격 증명이 필요한
명령만이 아니다:

```bash
sudo systemd-run --uid=quant --gid=quant --pty --wait \
  --working-directory=/opt/quant-platform/current \
  --property=EnvironmentFile=/etc/quant-platform/app.env \
  /usr/local/bin/node /opt/quant-platform/current/dist/server/cli.js \
  totp:enroll
```

네 부분이 각각 다른 사고를 막는다:

- `EnvironmentFile` — CLI 는 `loadConfig()` 로 `process.env` 를 그대로 읽고,
  `DATABASE_PATH` 의 기본값은 **상대경로** `./data/app.sqlite` 다. 이걸 빼면
  `admin:create` 가 `/var/lib/quant-platform/app.sqlite` 가 아닌 엉뚱한 파일에
  계정을 만들고, 로그인 화면에는 "존재하지 않는 사용자" 만 남는다. `NODE_ENV` 도
  `production` 이 아니게 되어 프로덕션 가드가 풀린다. `DART_API_KEY` 유무와
  무관하게 필요하다.
- `--uid=quant --gid=quant` — SQLite 는 `-wal`·`-shm` 을 새로 만든다. root 로 돌리면
  quant 소유 디렉터리에 root 소유 파일이 남아 서비스가 `SQLITE_READONLY` 로 죽는다.
- `--pty` — CLI 는 대화형(비밀번호 프롬프트)이고, 무엇보다 `totp:enroll` 은 base32
  secret 과 복구 코드를 stdout 에 찍는다. systemd-run 의 기본값(detach +
  stdout→journal)으로 돌리면 그 값이 **journald 에 영구 기록**되어 §16 의 secret
  재노출 금지가 무의미해진다. `--pty` 는 출력을 실행자의 터미널로만 보낸다.
  대가는 SSH 가 끊기면 죽는 것이다 (아래 `tmux` 항목).
- `--working-directory` — 유닛의 `WorkingDirectory` 와 같게 맞춘다. `--same-dir` 은
  실행 위치에 의존하므로 쓰지 않는다.

`app.env` 를 셸에서 export 해 넘기는 방식은 키가 `ps` 에 잠깐 노출되므로 쓰지 않는다.
`app.env` 는 `chmod 600 root:root` 라서 quant 는 읽을 수도 없다 — 파일 경로만 넘기고
실제로 여는 것은 PID 1 이라는 점이 systemd-run 을 쓰는 이유다.

백테스트 실행비용 보고서는 대화형 secret을 출력하지 않으므로 `--pty` 대신 `--pipe`로
현재 터미널에 받는다. 서비스가 실행 중이어도 SQLite를 읽기 전용으로 열며 DB를 변경하지
않는다.

```bash
sudo systemd-run --uid=quant --gid=quant --pipe --wait --collect \
  --working-directory=/opt/quant-platform/current \
  --property=EnvironmentFile=/etc/quant-platform/app.env \
  /usr/local/bin/node /opt/quant-platform/current/dist/server/cli.js \
  backtest:telemetry-report --since-days 30
```

전용 worker 후보를 검토할 때만 OS·controller 몫을 이미 제외한 worker 전용 예산을
`--worker-budget-mib <MiB>`로 넣는다. 현 Lightsail의 640MiB `MemoryMax`를 그대로 넣으면
웹 부모 프로세스 몫을 두 번 쓸 수 있으므로 금지한다. 자동 처리용 원문은
`--format json`, 감사 이벤트가 1,000건보다 많으면 `--limit`을 늘린다.

## 28.3 재무·자본변동 자동 수집

DART 재무·자본변동 수집은 CLI 명령이 아니다(D-049). 재무전략이나 PER·ROE 유니버스
단계를 쓰는 백테스트를 준비(preparation)할 때 서버가 필요한 만큼만 자동으로
수집한다.

- `DART_API_KEY` 는 재무전략 또는 PER·ROE 단계의 preview 를 준비할 때만 필요하다.
- 수집 범위는 요청한 기간과 최소 warm-up 뿐이다 — 연도·종목을 지정해 미리 돌리는
  절차는 없다.
- 일일 호출 한도(40,000건, rate limiter 120ms 간격)에 닿아 대기하는 것은 실패가
  아니다. 다음 KST 날짜가 되면 자동으로 이어서 수집한다.
- 준비 작업은 한 번에 하나만 돈다. 서버가 재시작돼도 중단된 지점부터 이어진다.
- 준비를 취소해도 그때까지 저장한 종목 데이터는 지우지 않는다.

---

# 29. systemd

`/etc/systemd/system/quant-platform.service` — 실물은 `infra/systemd/quant-platform.service`
가 기준이다 (provision-app.sh 가 그 파일을 설치한다). 아래는 사본이므로 값을 바꿀 때는
리포의 유닛 파일을 먼저 고칠 것:

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
ExecStart=/usr/local/bin/node /opt/quant-platform/current/dist/server/bootstrap/main.js
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
# 909MB 박스에서 앱이 555MB 만 써도 시스템(sshd·journald·caddy)이 질식했다
# (2026-07-28 장애, D-023). MemoryHigh 에서 먼저 회수 압박을 걸어 Max 도달 전에
# 스왑·캐시로 밀어내고, 캡도 시스템 몫 ~270MB 를 남기는 선까지 내린다.
MemoryHigh=512M
MemoryMax=640M
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

app 전환 순서 (`scripts/deploy.mjs`와 `scripts/deploy-app.sh`가 수행):

1. 개발 PC에서 lint·typecheck·test·build
2. tar 생성
3. deploy.mjs가 app 노드의 시도별 임시 디렉터리로 archive와 checksum을 SCP 업로드
4. app 배포 전역 `flock` 획득 후 checksum 검증
5. `.incomplete-<release>` staging 디렉터리에 상태 마커를 만들고 압축 해제
6. staging에서 production dependency 설치
7. **SQLite 스냅샷 생성** — incomplete 파일에 완성한 뒤 최종 이름으로 교체 (D-010)
8. staging을 release 최종 경로로 옮기고 `current` symlink 원자적 교체
9. systemd stop 후 `db:prepare` migration
10. systemd start
11. health check
12. 실패 시 이전 release와 **DB 스냅샷을 함께** rollback하고 readiness 재검증
    (D-010 — 코드만 되돌리면 이전 코드가 새 스키마를 만나 죽는 "명목상 롤백"이 된다)

추가 규칙:

- 배포 스크립트는 비밀값을 command line argument 로 노출하지 않는다
- 현재 제품 단계에서는 파괴적 스키마 변경도 허용하고 배포 전 snapshot으로 코드·DB를
  함께 롤백한다. expand-contract는 스키마 안정화와 디스크 여유 확보 뒤 재검토한다
  (D-010, D-063)
- 서비스 전환 전 실패 산출물은 즉시 지운다. 전환 후에는 rollback readiness가
  성공한 경우에만 실패 release와 snapshot을 지우며, rollback 실패 시 수동 복구를
  위해 보존한다
- 마커가 없는 기존·성공 산출물은 보존하지 않는다(보존 개수 `0` 하드코딩).
  과거 정상 release(current 제외)와 정상 snapshot은 항상 같은 개수로 회전시키며,
  `in-progress`와 `failed` 산출물은 정상 보존 개수에서 제외한다
- 각 노드의 전환 transaction은 non-blocking `flock`으로 직렬화하고 동시 실행을 즉시 실패시킨다

---

# 31. 백업

백업 대상:

- SQLite
- 결과 메타데이터
- 결과 export
- 데이터셋·엔진 버전 정보

일봉은 이제 `app.sqlite` 안에 있어(D-041) 별도 캔들 백업 제외 규칙이 필요 없다.
D-019 가 두던 캔들 Parquet 제외 규칙의 전제(증권사 재수집·1분봉 집계 재생성)가
함께 사라졌다.

백업 제외:

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
- 월 1회 격리 복구 테스트 (Phase 7 disaster runbook)

애플리케이션 프로세스에 AWS 키를 제공하지 않는다. 백업 스크립트 또는 별도 제한 사용자만 접근한다.

독립 복원 스크립트는 두지 않는다. 현재 `backup.sh` 는 백업 생성만 담당하며, SQLite 와
exports 의 복구 절차·무결성 검사·실패 시 원복은 Phase 7 disaster runbook 에서 함께
설계하고 격리 환경에서 검증한다 (D-031).

---

# 32. 등록 전략

`StrategyRegistry` 는 코드로 등록된 전략 다섯 개를 담는다 (§2.5). UI 는 검증된
파라미터만 바꾼다 — 전략 자체는 코드 리뷰·테스트를 거쳐 배포된다.

## 전고점 돌파 (range-breakout)

직전 N개 봉이 만든 고가 상단을 종가가 넘어서면 사고, 추적 손절·익절·보유 상한으로
판다. 창은 전부 봉 수 기준이라 봉 주기가 달라져도 같은 로직이 돈다. 지금은 일봉만
남아 그 일반성이 겉으로 드러나지 않는다 (D-041).

```ts
const RangeBreakoutParameters = z.object({
  lookbackBars: z.number().int().min(2).max(200),
  atrPeriod: z.number().int().min(2).max(100),
  stopAtrMultiplier: z.number().positive().max(20),
  trailAtrMultiplier: z.number().positive().max(20),
  takeProfitAtrMultiplier: z.number().positive().max(50).optional(),
  maxHoldBars: z.number().int().min(1).max(10_000).optional(),
  riskPerTradePercent: z.number().positive().max(5),
  maxPositionWeightPercent: z.number().min(1).max(100),
});
```

`maxPositions` 는 전략 파라미터가 아니다 — 요청의 `risk.maxPositions` 로 받는다
(§15, D-012). 현재 전략 버전은 2.0.0 이다. 봉만 사용하며 재무 데이터를 요구하지
않는다 (`requiresFundamentals` 미설정).

전신은 `hourly-breakout`("시간봉 돌파", v1.2.0) 이다 — 이름이 시간봉에 묶여 있었으나
로직은 처음부터 봉 수 기반이었고, 손절·익절만 있어 추세 이익을 되돌려주었으며,
돌파 기준선을 봉마다 전체 이력에서 다시 구해 1분봉 구간을 완주할 수 없었다 (D-028).
과거 `hourly-breakout` 실행은 화면에서 원본 id 로 표시된다.

손절·익절은 **종가**로만 판정하고 다음 봉 시가에 체결한다 — 장중에 손절선을 뚫었다가
종가가 회복한 봉은 청산되지 않으므로 실제 스톱 주문보다 낙관적이다
(`docs/reviews/BACKTEST_BIAS_REVIEW.md` B-008). 등록 전략 전체에 공통이다.

## 횡단면 모멘텀 (cross-sectional-momentum)

유니버스 전 종목의 과거 수익률을 랭킹해 상위 N 을 동일가중 보유한다. 수익률 구간은
`skipDays` 를 뺀 **그 앞** `formationDays` 다 — 구간이 짧아지는 것이 아니라 뒤로
밀린다. 기본값(252 + 21봉)이면 약 13개월 전부터 1개월 전까지의 12개월 수익률이고,
학계에서 12-1 모멘텀이라 부르는 형태다. 액면분할 등 자본변동 이벤트가 수집된 데이터셋에서는
신호 계산 시 가격을 보정한다 — 체결가 자체는 항상 실제 거래 가격이다. 봉만
사용하며 재무 데이터를 요구하지 않는다. 동일가중은 최초 편입 때만 적용하는 것이 아니라
공유 리밸런싱 일정이 활성화될 때마다 다시 맞춘다. 탈락 종목과 초과 비중을 먼저 매도하고,
다음 봉에서 기존 보유분을 포함한 목표 종목의 부족 비중을 채운다. 현재 버전은 2.2.0이다.

## 밸류·퀄리티 랭킹 (value-quality-rank)

이익수익률(TTM EBIT / EV)과 자본수익률(TTM EBIT / 투입자본) 순위를 합산해 상위
N 을 동일가중 보유한다. `requiresFundamentals: true` 로 선언되어 있어, 상장시점
재무(point-in-time 팩트 저장소, 백테스트 준비 단계가 DART 공시를 자동 수집한다,
§28.3)가 하나도 없는 유니버스에 제출하면 422 로 거부된다 — 실행 후 "거래 0건"
으로 끝나 원인을 알 수 없는 상태를 막기 위해서다. 횡단면 모멘텀과 같은 2단계
동일가중 재조정을 공유하며 현재 버전은 2.2.0이다.

## EMA 추세 스위치 (ema-trend-switch)

단기·장기 EMA 간격이 임계%를 넘은 종목을 사고, 추적 손절·추세 반전·보유 상한으로
판다. 상관은 종목쌍마다 둘에 공통인 최근 봉으로 계산하며, 이력이 부족한 쌍은 각각
단독 그룹으로 남긴다. 그룹은 현재 활성 멤버십 기준으로 만들고 멤버십 변화나 새 종목의
워밍업 완료 때 갱신한다. 활성 멤버십은 당일 매수 가능 집합과 분리하므로, 거래정지된 보유
종목도 그룹 선점을 유지한다. 따라서 짧은 이력·미래 편입 종목 하나가 전체 진입을 막지
않고, 거래정지 때문에 역상관 짝을 추가 매수하지도 않는다.
마지막 활성 유니버스가 워밍업을 끝내지 못하면 필요 봉 수와 확보 최대 봉 수를 결과 경고에
남긴다. 현재 버전은 1.0.2다. 봉만 사용하며 재무제표를 요구하지 않는다
(`requiresFundamentals` 미설정). 다만 액면분할 보정을 위한 자본변동 이력은 준비한다.

## RSI 되돌림 (rsi-reversion)

RSI 과매도에 사서 RSI 회복에 판다. 스톱은 고정(추적 아님) — 되돌림 전략은 진입 후
흔들림을 견뎌야 한다. 상관 그룹·수량 산정·보유 상한은 `ema-trend-switch` 와 같은
부품을 쓰며, 활성 멤버십·종목쌍별 워밍업·완료 경고 규칙도 같다. 현재 버전은 1.0.2다.
봉만 사용하며 재무제표를 요구하지 않는다 (`requiresFundamentals` 미설정). 다만
액면분할 보정을 위한 자본변동 이력은 준비한다.

---

# 33. 테스트

## Unit

- Candle
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
- SQLite fact repository
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
- 데이터 동기화 — CSV 가져오기는 D-041 로 사라졌다
- 설정 변경
- 향후 실거래 arm·disarm
- 향후 주문

백테스트 종료 감사 기록(`backtest.finished`)에는 child가 측정한 실행 telemetry를 포함한다.

- 결과: `COMPLETED | FAILED | CANCELLED`, 실패한 단계 `LOAD | RUN | PERSIST`
- 단계별·전체 소요 시간
- child 프로세스 peak RSS(bytes)
- 입력 봉·팩트·종목 수
- 결과 테이블 행 수와 SQLite page/index overhead를 제외한 논리 payload 근사치

계측을 위해 결과 전체를 추가로 직렬화하지 않는다. local 모드의 운영 호스트는 1GB RAM이고
웹과 child가 같은 640MB systemd cgroup을 공유하므로 `MAX_CONCURRENT_BACKTESTS=1`을
유지한다. remote 모드의 전용 worker 병렬도는 그 호스트의 telemetry와 메모리 예산으로
별도로 정한다(D-059, D-060).

용량 산정은 `backtest:telemetry-report`로 한다. 최소 완료 표본 10개, 입력 규모 3종,
최소·최대 입력 행 수 4배 차이가 필요하다. 최소 구성은 작은 부하·평소 부하·허용 상한에
가까운 부하를 각각 여러 seed로 실행하는 것이다. 표본 gate를 통과해도 현 Lightsail
동시성은 1이다. 보고서의 worker 계획 메모리는 완료 실행의 p95 peak RSS에 25% 여유를
더한 값이다. 전용 worker 병렬도는 worker 전용 메모리 예산으로 계산한 상한과 CPU 슬롯 중
작은 값으로 결정한다. seed shard
표시는 p95 실행시간으로 순차 15분 이내(최대 25개)를 맞춘 계획 후보일 뿐, 원격 재시도
정책을 구현할 때 최종 확정한다.

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
- SQLite 일봉 (KRX 일별매매 수집, D-041)
- SQLite 재무 팩트 (D-054)
- coverage
- 누락 탐지
- 증권사 REST 어댑터 (종목 이름 조회, D-041)

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
- deploy/rollback (bootstrap-app.sh · provision-app.sh · deploy-app.sh)

## Phase 7 — 운영

- S3 backup
- disk/memory guard
- alert
- disaster runbook (백업 복구·격리 복구 테스트 포함)

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
- SQLite 일봉 + PIT 재무 팩트
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
- 백업 생성·재해복구 절차 검증
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
└─ SQLite, KRX 일별매매 하나가 유일한 출처 (D-041)

Analytics
└─ SQLite PIT 재무 팩트 (D-054)

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
