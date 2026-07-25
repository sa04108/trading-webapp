# MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `docs/quant_trading_platform_spec.md`의 Phase 0~5 (MVP)를 구현한다 — 인증, 데이터 계층, 백테스트 엔진, 작업 큐, 결과 UI까지 단일 아티팩트 모듈러 모놀리스.

**Architecture:** Fastify 서버가 React 정적 파일과 `/api/v1`을 제공하고, 백테스트는 SQLite 큐에서 확보되어 동일 아티팩트의 자식 프로세스에서 실행된다. 시장 데이터는 Parquet + DuckDB, 메타데이터는 SQLite(WAL). 모듈 내부는 domain → application → infrastructure/presentation 의존 방향을 dependency-cruiser로 강제한다.

**Tech Stack:** Node 24(운영)/22(개발), TypeScript strict, Fastify 5, Zod 4, Pino, better-sqlite3 + Drizzle, @duckdb/node-api, argon2, otpauth, React 19 + Vite + shadcn/ui + Tailwind 4, TanStack Query/Table, Recharts, Vitest, Playwright, pnpm.

## Global Constraints (스펙 §2, §37 — 임의 변경 금지)

- 애플리케이션은 인프라를 모른다: bind는 `APP_BIND_ADDRESS=127.0.0.1`, `APP_PORT=3000`만
- 애플리케이션은 특정 증권사를 모른다: broker 접근은 REST 전용, 어댑터는 infrastructure에만
- 모듈러 모놀리스, 배포 아티팩트 1개, 동시 백테스트 1개
- 임의 코드 실행 금지 (`eval`, `new Function`, 동적 import 업로드 등)
- 백테스트 체결은 next-bar-open, look-ahead 금지, 동일 입력·seed → 동일 결과
- SQLite: WAL, foreign_keys ON, busy_timeout 5000; DuckDB: threads 1, memory_limit 384MB
- 도메인 계층 금지: Fastify/React/SQLite/DuckDB/HTTP/fs/process.env/증권사 DTO
- 완료 게이트: 각 Phase 종료 시 `pnpm lint && pnpm typecheck && pnpm test && pnpm build` 통과

---

## Phase 0 — 기반

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`(없음—단일 패키지), `tsconfig.json`, `tsconfig.server.json`, `tsconfig.web.json`, `eslint.config.js`, `vite.config.ts`, `vitest.config.ts`, `playwright.config.ts`, `.dependency-cruiser.cjs`, `drizzle.config.ts`, `components.json`
- Create: `src/server/bootstrap/config.ts` — Zod 기반 env 검증 (`AppConfig`)
- Create: `src/server/bootstrap/container.ts` — 수동 DI 컨테이너 (`createContainer(config)`)
- Create: `src/server/bootstrap/server.ts` — Fastify 인스턴스 조립 (`buildServer(container)`)
- Create: `src/server/bootstrap/main.ts` — 엔트리포인트
- Create: `src/server/modules/system/presentation/health-routes.ts` — `/api/v1/health/live|ready`, `/api/v1/system/info`
- Create: `src/web/main.tsx`, `src/web/app/app.tsx`, `index.html` — Vite 셸
- Test: `tests/architecture/module-boundaries.test.ts` — dependency-cruiser 규칙 실행
- Test: `tests/unit/config.test.ts` — env 검증 성공/실패

**Interfaces (Produces):**
- `AppConfig` = `{ nodeEnv, bindAddress, port, databasePath, dataRoot, importRoot, exportRoot, tempRoot, maxConcurrentBacktests, duckdbThreads, duckdbMemoryLimit, sessionSecret, sessionIdleTimeoutSeconds, sessionAbsoluteTimeoutSeconds, logLevel, liveTradingEnabled }`
- `Container` = `{ config, logger, db, ...서비스들 }` — 이후 Phase가 서비스 추가
- 검증: `pnpm dev`로 서버 기동, `GET /api/v1/health/live` 200

## Phase 1 — 인증·UI Shell

**Files:**
- Create: `migrations/0000_*.sql` (drizzle 생성) — users, sessions, login_attempts, audit_logs, application_settings
- Create: `src/server/modules/auth/domain/` — `User`, `Session` 타입, 세션 만료 정책(순수 함수)
- Create: `src/server/modules/auth/application/auth-service.ts` — `login(username, password, totp)`, `logout(sessionId)`, `verifySession(sessionId)` (idle 12h/절대 7d, 로그인 시 세션 회전)
- Create: `src/server/modules/auth/infrastructure/` — `argon2-password-hasher.ts`, `otpauth-totp.ts`, `sqlite-user-repository.ts`, `sqlite-session-repository.ts`, `sqlite-login-attempt-repository.ts`
- Create: `src/server/modules/auth/presentation/auth-routes.ts` — §14 인증 4종 + 로그인 rate limit(login_attempts 기반)
- Create: `src/server/modules/audit/` — `AuditLogService.record(event, detail)` + SQLite repo
- Create: `src/server/cli.ts` — `admin:create` (사용자명·비밀번호 입력, TOTP secret 생성, otpauth URI 출력, 복구 코드 hash 저장)
- Create: `src/server/shared/security-headers.ts` — CSP, nosniff, DENY, no-referrer; Origin==Host 검사 훅(CSRF)
- Create: `src/web/features/auth/` — 로그인 화면(사용자명/비밀번호/TOTP, 서버 연결 상태)
- Create: `src/web/app/shell.tsx` — 모바일 하단 내비(대시보드/백테스트/데이터/설정) + 데스크톱 사이드바, 라이트·다크 테마
- Create: `src/web/lib/api-client.ts` — fetch 래퍼(credentials, 401 → 로그인 리다이렉트)
- Test: unit(세션 만료 정책, TOTP 검증, 비밀번호 해시 왕복), integration(로그인 성공/실패/rate limit/세션 만료, Origin 검사)

**Interfaces (Produces):**
- Fastify `preHandler` `requireAuth` — 이후 모든 보호 라우트가 사용
- `auditLog.record(actor, event, payloadJson)` — 이후 Phase가 호출
- Pino redaction 목록 §16 적용

## Phase 2 — 데이터

**Files:**
- Create: `src/server/modules/market-data/domain/` — `Candle`, `Timeframe`, `CandleQuery`, `DataCoverage`, 시간봉 집계 순수 함수 `aggregateToHourly(candles, session)` (세션 경계 기준)
- Create: `src/server/modules/market-data/application/` — `ImportCandlesUseCase`, `GetCoverageUseCase`, `SyncDatasetUseCase`, port `CandleRepository`, `MarketDataSource` (§8 시그니처 그대로)
- Create: `src/server/modules/market-data/infrastructure/duckdb-service.ts` — 연결 풀(threads=1, memory_limit) 
- Create: `src/server/modules/market-data/infrastructure/parquet-candle-repository.ts` — hive 파티션 (`market=/timeframe=/symbol=/year=[/month=]`) 읽기/쓰기(COPY TO), idempotent upsert(파티션 재작성)
- Create: `src/server/modules/market-data/infrastructure/csv-market-data-source.ts`, `parquet-import-data-source.ts`
- Create: `src/server/modules/broker/infrastructure/rest-client.ts` — 공통 REST 클라이언트(토큰 캐싱, 그룹별 rate limiter, 429 Retry-After, backoff+jitter)
- Create: `src/server/modules/broker/infrastructure/kiwoom/kiwoom-market-data-source.ts` — `MarketDataSource` 구현(자격증명 없으면 비활성)
- Create: `src/server/modules/market-data/presentation/dataset-routes.ts` — §14 데이터 6종, datasets/dataset_versions/data_coverage/data_import_jobs 테이블
- Create: `src/web/features/datasets/` — 데이터셋 목록, coverage 표시, CSV 업로드(크기 제한·포맷 검증)
- Test: unit(시간봉 집계—세션 경계·중복·누락, coverage 계산), integration(CSV→Parquet→조회 왕복, idempotent 재수집)

**Interfaces (Produces):**
- `CandleRepository.getCandles(query): AsyncIterable<Candle>` — Phase 3 엔진이 소비
- `Candle` = `{ symbol, market, timeframe, ts(UTC epoch ms), open, high, low, close, volume }`

## Phase 3 — 백테스트 엔진

**Files:**
- Create: `src/server/modules/backtest/domain/` — `Portfolio`, `Position`, `OrderIntent`, `Fill`, `FeeModel`, `SlippageModel`, `simulateFill(order, nextBar, costProfile)` (next-bar-open), 이벤트 루프 `runBacktest(input, candleFeed, strategy)` §9.2 순서, `metrics.ts` §9.6 전체 지표, `equity-series.ts`, `seeded-rng.ts`(mulberry32)
- Create: `src/server/modules/strategy/domain/strategy.ts` — §8 `TradingStrategy` 인터페이스
- Create: `src/server/modules/strategy/application/strategy-registry.ts` — 코드 등록식 레지스트리
- Create: `src/server/modules/strategy/strategies/hourly-breakout.ts` — §32 파라미터 스키마 + 돌파 로직(ATR 스톱, 리스크 기반 사이징)
- Create: `src/shared/schemas/backtest-request.ts` — §15 요청 Zod 스키마 (웹·서버 공유)
- Test: unit — 체결(next-bar-open, 슬리피지/수수료/세금, 호가단위 반올림, 현금 부족 거부), MDD/수익률/Sharpe/Sortino/월별, 파라미터 검증
- Test: look-ahead — 미래 급등 fixture에서 급등 전 신호 없음
- Test: determinism — 동일 seed·데이터 2회 실행 → 거래·자산곡선·지표 hash 동일

**Interfaces (Produces):**
- `runBacktest(request: BacktestRequest, feed: AsyncIterable<Candle>, strategy, hooks: { onProgress, shouldCancel }): Promise<BacktestResult>`
- `BacktestResult` = `{ metrics, equityPoints[], drawdownPoints[], trades[], monthlyReturns[], symbolMetrics[], warnings[] }`

## Phase 4 — 작업 큐

**Files:**
- Create: migrations — backtest_jobs, backtest_runs, backtest_metrics, backtest_equity_points, backtest_drawdown_points, backtest_trades, backtest_monthly_returns, backtest_symbol_metrics
- Create: `src/server/modules/backtest/application/job-queue.ts` — §10 상태 머신, `BEGIN IMMEDIATE` claim SQL 그대로
- Create: `src/server/modules/backtest/application/job-orchestrator.ts` — polling loop(concurrency 1), fork(§5 env 화이트리스트), IPC 진행률 수신, 취소 시퀀스(IPC→SIGTERM→SIGKILL), 시작 시 고아 작업 `INTERRUPTED` 처리
- Create: `src/workers/backtest-child.ts` — jobId 수신 → 데이터 로드(DuckDB) → `runBacktest` → 결과 청크 저장 → IPC 진행률
- Create: `src/server/modules/backtest/presentation/backtest-routes.ts` — §14 백테스트 9종, SSE `/events` + polling fallback
- Test: integration — claim 원자성, cancel 전이, 프로세스 부재 시 INTERRUPTED 복구, SSE 스트림, 완료 후 결과 행 존재

**Interfaces (Produces):**
- IPC 메시지: `{ type: 'progress', processedBars, totalBars, currentSymbol } | { type: 'cancelled' } | { type: 'completed' } | { type: 'failed', reason }`
- 재현성 메타데이터 §9.5 컬럼을 backtest_runs에 저장

## Phase 5 — 결과 UI

**Files:**
- Create: `src/web/features/backtests/new-backtest-wizard.tsx` — 6단계 모바일 위저드(전략→데이터·종목→기간→자본·비용→검토→실행)
- Create: `src/web/features/backtests/backtest-list.tsx`, `backtest-detail.tsx` — 상태 Badge, Progress(SSE→polling fallback), 취소, 실패 이유
- Create: `src/web/features/backtests/result-*.tsx` — 지표 카드 6종, 자산 곡선/Drawdown/월별 수익률/종목별 성과 차트(서버 다운샘플 ~1000pt), 거래 내역 테이블(필터), 파라미터·재현 정보·경고 표시, clone/export
- Create: `src/web/features/dashboard/` — 실행 중 작업, 최근 결과, 데이터 상태, 디스크/서버 상태, 빠른 백테스트
- Create: `src/server/.../results-routes.ts` 내 다운샘플(LTTB) 적용
- Test: E2E(Playwright, 390×844 + 1440×900) — 로그인→백테스트 생성→완료→결과 조회→clone→로그아웃 스모크

## 검증 명령 (전 Phase 공통 게이트)

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm build
```
