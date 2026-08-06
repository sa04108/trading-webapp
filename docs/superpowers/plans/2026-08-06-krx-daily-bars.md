# KRX 일봉 적재 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** KRX 일별매매 응답의 OHLCV 를 적재해 상장폐지 종목까지 포함한 일봉을 확보하고, 백테스트가 생존편향 없이 돌게 한다.

**Architecture:** KRX 는 날짜당 전 종목을 준다(date-major). 기존 캔들 저장소는 종목별 parquet 파티션이라(symbol-major) 증분 쓰기가 종목 수만큼의 read-merge-write 를 부른다. 그래서 일봉은 SQLite 테이블에 append 하고, 읽기에서만 두 저장소를 합친다. 규칙은 하나다 — **1일봉은 KRX 테이블 우선, 분봉·시간봉은 기존 parquet**.

**Tech Stack:** Fastify, Drizzle(SQLite), DuckDB/parquet(기존), zod, vitest, playwright.

## 배경 (실측)

`scripts/krx-smoke.ts` 를 운영 키로 돌려 확인했다. 일별매매정보 응답 필드:

```
ACC_TRDVAL, ACC_TRDVOL, BAS_DD, CMPPREVDD_PRC, FLUC_RT, ISU_CD, ISU_NM,
LIST_SHRS, MKTCAP, MKT_NM, SECT_TP_NM, TDD_CLSPRC, TDD_HGPRC, TDD_LWPRC, TDD_OPNPRC
```

시·고·저·종가와 거래량·거래대금이 모두 있다. 지금 파서는 `MKTCAP` 만 읽고 나머지를 버린다.

`docs/reviews/HISTORICAL_UNIVERSE_SNAPSHOT_REVIEW.md:125` 가 KRX 조회는 "현재는 상장폐지됐더라도 해당 기준일에 유효했던 종목을 반환할 수 있는 구조"임을 확인한다. 공식 제공 시작일은 2010-01-04 이고 smoke 가 그 날짜에서 925행을 받아 실증했다.

현재 봉은 증권사(토스) 소스만 탄다. 증권사는 거래 가능한 종목을 위한 서비스라 상장폐지
종목의 과거 봉을 주지 않는다 — 그래서 과거 시총 상위 N 백테스트가 지금은 살아남은
종목만으로 돌고, 화면에는 정상 실행으로 보인다. 이 계획이 그걸 막는다.

## Global Constraints

- 한국어 주석·문서는 CLAUDE.md 규칙(문어체 평서형, 번역투 금지, "왜"를 쓴다)을 따른다.
- UI 문구는 간결체(합쇼체 금지).
- `pnpm lint && pnpm typecheck && pnpm vitest run tests/unit tests/integration` 커밋 전 통과.
- import 는 `.js` 확장자. 날짜는 ISO `YYYY-MM-DD`.
- 마이그레이션은 `pnpm db:generate` 산출물. **배포된 0004·0005 는 수정 금지** — 새 파일로 만든다.
- KRX 호출 예산은 엔드포인트당 하루 9,000(`KRX_DAILY_CALL_BUDGET`). 날짜 하나가 엔드포인트당 1회를 쓴다.

---

### Task 1: 계약 확장과 일봉 테이블

**Files:**
- Modify: `src/server/modules/market-data/domain/krx-universe-types.ts` (`KrxDailyTradeRow`)
- Modify: `src/server/modules/market-data/infrastructure/krx/krx-contract.ts` (`dailyRowSchema`, `parseDailyRows`)
- Modify: `tests/helpers/krx-fixtures.ts` (`dailyFixture` 에 OHLCV 기본값)
- Modify: `src/server/shared/db/schema.ts` (테이블 추가)
- Create: `migrations/0006_*.sql`
- Test: `tests/unit/krx-contract.test.ts`(케이스 추가), `tests/unit/krx-daily-bars-schema.test.ts`

**Interfaces:**
- Produces:

```typescript
// KrxDailyTradeRow 에 추가 — 값을 모르면 null 이다(휴장 직후·거래 정지 등)
readonly open: number | null;
readonly high: number | null;
readonly low: number | null;
readonly close: number | null;
readonly volume: number | null;

// schema.ts
export const krxDailyBars = sqliteTable(
  'krx_daily_bars',
  {
    /** 단축 종목코드 — 일별매매 응답의 ISU_CD 다(이름과 달리 단축코드다) */
    shortCode: text('short_code').notNull(),
    date: text('date').notNull(),
    market: text('market').notNull(),
    open: integer('open').notNull(),
    high: integer('high').notNull(),
    low: integer('low').notNull(),
    close: integer('close').notNull(),
    volume: integer('volume').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.shortCode, table.date] }),
    index('idx_krx_daily_bars_date').on(table.date),
  ],
);
```

동작 규약:

1. 가격·거래량은 `parseNullableInt64` 와 같은 방식으로 콤마를 걷고 `-`·빈 값을 null 로 본다.
   다만 저장은 `number` 다 — 가격은 원 단위 정수라 2^53 을 넘지 않는다. 거래대금
   (`ACC_TRDVAL`)은 이번에 저장하지 않는다(쓰는 곳이 없다, YAGNI).
2. 기본 키가 (shortCode, date) 라 같은 날짜를 다시 수집해도 덮어쓰기만 하면 된다.
   읽기는 종목 하나의 기간 조회라 이 순서가 맞다.
3. `date` 인덱스는 날짜 단위 삭제·점검용이다.

- [ ] **Step 1: 실패하는 테스트 작성** — 계약: `TDD_OPNPRC` 등 4개 가격과 `ACC_TRDVOL` 이 숫자로 파싱되는 케이스, `-` 이면 null 인 케이스. 스키마: 삽입·조회 왕복과 (shortCode, date) 중복 시 덮어쓰기.
- [ ] **Step 2: 실패 확인** → **Step 3: 구현** → **Step 4: 마이그레이션 생성**(`pnpm db:generate --name krx_daily_bars`) → **Step 5: 통과 확인**(`pnpm vitest run tests/unit` 회귀 포함)
- [ ] **Step 6: 커밋**

```bash
git add src/server tests migrations
git commit -m "feat(krx): 일별매매 OHLCV 를 계약에 넣고 일봉 테이블을 추가한다"
```

---

### Task 2: ingestDate 가 일봉을 적재

**Files:**
- Modify: `src/server/modules/market-data/application/symbol-master-service.ts`
- Test: `tests/unit/symbol-master-daily-bars.test.ts`

**Interfaces:**
- Consumes: Task 1 테이블·파싱
- Produces: 거래일 ingest 가 그날 두 시장의 일봉을 전부 저장한다.

동작 규약:

1. `ingestDateUnguarded` 의 거래일 경로에서, 이미 받아 둔 `kospiTrades`·`kosdaqTrades` 로
   일봉을 저장한다 — **KRX 를 다시 부르지 않는다**. 시장은 어느 응답에서 왔는지로 정한다.
2. 저장은 이벤트·coverage·거래일 기록과 **같은 트랜잭션**이다. 따로 두면 중간에 죽었을 때
   커버는 됐는데 봉만 빠진 상태가 남는다.
3. 가격 4개나 거래량이 null 인 행은 건너뛴다(거래 정지 등). 건너뛴 수를 `logger.debug` 로 남긴다.
4. 500행 단위 배치 삽입(`writeCheckpoint` 선례). `onConflictDoUpdate` 로 재수집을 허용한다.
5. 휴장일 경로는 그대로다 — 저장할 행이 없다.

- [ ] **Step 1: 실패하는 테스트 작성** — fake KRX 로 거래일 수집 후 `krx_daily_bars` 행 수·값 단언, 재수집 시 중복 없이 갱신되는지, 가격 null 행이 빠지는지. 기존 `symbol-master-ingest.test.ts` 헬퍼 재사용.
- [ ] **Step 2: 실패 확인** → **Step 3: 구현** → **Step 4: 통과 확인**
- [ ] **Step 5: 커밋**

```bash
git add src/server tests
git commit -m "feat(symbol-master): 수집한 날짜의 일봉을 함께 적재한다"
```

---

### Task 3: 캔들 읽기 병합

**Files:**
- Create: `src/server/modules/market-data/infrastructure/composite-candle-repository.ts`
- Modify: `src/server/bootstrap/container.ts` (배선)
- Test: `tests/unit/composite-candle-repository.test.ts`

**Interfaces:**
- Consumes: 기존 `CandleRepository` 포트(`getCandles`/`getTimestamps`/`saveCandles`/`deleteSymbol`)
- Produces:

```typescript
/**
 * 1일봉은 KRX 테이블을, 그 밖의 슬라이스는 기존 parquet 저장소를 읽는다.
 * 쓰기(saveCandles)·삭제는 항상 parquet 으로 간다 — KRX 테이블은 수집기가 직접 채운다.
 */
export class CompositeCandleRepository implements CandleRepository { ... }
```

동작 규약:

1. `timeframe !== '1d'` 이면 전부 위임한다.
2. `1d` 이고 KRX 테이블에 그 종목의 행이 범위 안에 하나라도 있으면 KRX 를 쓴다.
   없으면 위임한다 — 두 소스를 섞지 않는다. 섞으면 같은 날짜가 두 번 나오거나
   가격이 소스마다 달라 조용히 어긋난다.
3. `tsMs` 규칙은 **기존 1일봉과 반드시 같아야 한다**. 구현자는 증권사 소스와 parquet
   저장소가 1일봉 `tsMs` 를 어떤 기준(UTC 자정인지 KST 자정인지)으로 쓰는지 코드로
   확인하고 그대로 맞춰라. 어긋나면 엔진이 같은 날을 다른 봉으로 본다.
4. `getTimestamps` 도 같은 규칙으로 합친다 — 커버리지·`missingCandleSymbols` 가 이걸 쓴다.

- [ ] **Step 1: 실패하는 테스트 작성** — 1d 이고 KRX 행 있음 → KRX 값, 1d 이고 없음 → 위임, 1m → 위임, `getTimestamps` 동일 규칙, 저장·삭제는 위임. 위임 대상은 스텁으로.
- [ ] **Step 2: 실패 확인** → **Step 3: 구현·배선** → **Step 4: 통과 확인**(전체 회귀 — 기존 봉 경로가 안 깨지는지)
- [ ] **Step 5: 커밋**

```bash
git add src/server tests
git commit -m "feat(market-data): 1일봉을 KRX 테이블에서 먼저 읽는다"
```

---

### Task 4: 기간 전체 수집과 유니버스 종목 등록

**Files:**
- Modify: `src/server/modules/market-data/application/symbol-master-backfill.ts` (종료일 인자)
- Modify: `src/server/modules/market-data/presentation/symbol-master-routes.ts` (범위 수집 API)
- Modify: `src/server/modules/backtest/presentation/backtest-routes.ts` (미리보기 응답에 기간 커버리지)
- Modify: `src/web/features/backtests/universe-rule-step.tsx`
- Test: 해당 단위·통합 테스트

동작 규약:

1. 일봉은 리밸런스 날짜만으로 부족하다 — 백테스트는 기간 안 모든 거래일의 봉을 쓴다.
   그래서 위저드의 동기화는 **기간 전체**를 수집해야 한다.
2. 2년이면 캘린더 730일 × 엔드포인트당 1회다. `RestClient` 의 250ms 간격 때문에 앞단에서
   기다리면 몇 분이 걸린다 — 포그라운드 루프로 돌리지 마라. 기존 `SymbolMasterBackfill`
   (백그라운드 러너, 상태 폴링)을 종료일을 받도록 확장해 재사용한다.
3. `POST /symbol-master/backfill` 에 `toDate` 를 선택 인자로 더한다. 없으면 지금처럼 오늘까지다.
4. 위저드 버튼은 "기간 전체 동기화"로 바꾸고 `GET /symbol-master/coverage` 의 backfill
   상태를 폴링해 진행을 보여준다. 끝나면 미리보기를 다시 던진다.
5. 유니버스에 든 종목을 `symbols` 에 자동 등록한다 — 이름·시장은 종목 마스터에서 가져온다
   (증권사는 상장폐지 종목의 이름을 주지 않는다). 그래야 가격 데이터 탭에서 상장폐지
   종목도 보이고, 사용자가 물어본 "상장폐지 종목이 조회되지 않는다"가 풀린다.
   등록은 유니버스 일정의 `unionSymbols` 로 한정한다 — KRX 응답 전체(2,700개)를 등록하면
   우선주·리츠·스팩까지 목록에 쏟아진다.

- [ ] **Step 1: 서버부터 TDD** — backfill 종료일, 라우트 인자, 자동 등록. 각각 실패 테스트 먼저.
- [ ] **Step 2: 위저드 수정** → **Step 3: `pnpm lint && pnpm typecheck && pnpm vitest run tests/unit tests/integration && pnpm build`**
- [ ] **Step 4: 커밋**

```bash
git add src tests
git commit -m "feat(backtests): 백테스트 기간 전체를 수집하고 유니버스 종목을 등록한다"
```

---

### Task 5: e2e와 마무리 검증

**Files:**
- Modify: `tests/e2e/mvp-flow.spec.ts`, `scripts/e2e-server.ts`(필요 시 fake 응답에 OHLCV)

동작 규약:

1. fake KRX 서버의 일별매매 응답에 OHLCV 를 넣어, e2e 에서 증권사 없이도 봉이 생기게 한다.
   이러면 위저드가 미리보기 → 기간 동기화 → 봉 확보 → 다음 단계까지 실제로 이어진다.
2. 기존 시나리오(휴장 적용 거래일 표기, 미커버 날짜 일괄 동기화)를 깨지 않게 갱신한다.
3. `pnpm test:e2e` 전부 통과까지 간다.

- [ ] **Step 1: 구현** → **Step 2: 전체 검증** → **Step 3: 커밋**

```bash
git add tests scripts
git commit -m "test(e2e): KRX 일봉으로 백테스트 준비 흐름을 검증한다"
```

---

## 완료 기준

- 과거 시점 유니버스에 든 상장폐지 종목이 봉을 갖고, 가격 데이터 탭에서 조회된다.
- 위저드에서 기간 전체를 한 번에 동기화할 수 있고 진행이 보인다.
- `pnpm test && pnpm lint && pnpm typecheck && pnpm build && pnpm test:e2e` 전부 통과.

## 범위 밖

- 거래대금(`ACC_TRDVAL`)·등락률 저장
- 분봉·시간봉의 KRX 대체(증권사 유지)
- 수정주가(액면분할·배당 보정) — 별도 스펙이 필요하다
