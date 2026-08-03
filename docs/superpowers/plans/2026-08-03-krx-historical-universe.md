# KRX 과거 시점 고정 유니버스 Implementation Plan (v2 — 실행 종속)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 사용자가 백테스트를 만들면서 과거 기준일의 KRX KOSPI·KOSDAQ 보통주를 시가총액순으로 조회해 **불변 유니버스 스냅샷**을 만들고, 백테스트 실행이 그 스냅샷을 직접 참조·검증·고정한다.

**Architecture:** `docs/reviews/HISTORICAL_UNIVERSE_SNAPSHOT_REVIEW.md`(이하 REVIEW)의 KRX 연동·필터·날짜·오류 정책은 그대로 따르되, **소유 모델을 변경한다(사용자 결정 2026-08-03)**: 유니버스 스냅샷은 데이터셋이 아니라 백테스트 실행에 종속한다. 스냅샷은 저장 후 불변이며(수정 = 새 스냅샷), 백테스트 요청이 `universeSnapshotId`로 참조한다. 따라서 REVIEW의 데이터셋 결합 부분(§7.1 데이터셋 provenance, §7.3 수동 편집, §9.1 membership revision)은 이 계획이 대체하고, 데이터셋 테이블·편집 흐름은 손대지 않는다. 불변이므로 수동 수정 상태·revision 토큰이 필요 없다.

**Tech Stack:** Fastify 5 + zod v4 + drizzle(better-sqlite3, 동기) + React 19 + TanStack Query v5 + vitest 4 + playwright.

## Global Constraints

- 작업 위치: `C:\Work\trading-webapp\.claude\worktrees\krx-historical-universe` (브랜치 `worktree-krx-historical-universe`, main `ead5f57` 기반). 원본 저장소 루트로 이동하지 않는다.
- 스펙: REVIEW + 이 계획의 v2 소유 모델. 충돌 시 이 계획이 이긴다 (사용자 결정 반영본).
- 검증 명령: `pnpm test`, `pnpm typecheck`, `pnpm lint`. 각 태스크 커밋 전 셋 다 통과해야 한다. Task 1 완료 시점 기준 88 파일 847 테스트 통과.
- 마이그레이션은 손으로 쓰지 않는다. `src/server/shared/db/schema.ts` 수정 후 `pnpm db:generate`. `0000` 재스쿼시 금지(D-015). 기존 컬럼의 NOT NULL 변경 등 테이블 재생성을 유발하는 변경 금지.
- 아키텍처 규칙(.dependency-cruiser.cjs): domain은 framework·Node 내장 모듈 import 금지, `market-data → broker`·`market-data → facts` 금지, `src/web → src/server` 금지. 웹 공유 타입·상수는 `src/shared/schemas/`에 zod 없이 둔다.
- 시간은 항상 `Clock` 주입, epoch ms. KST는 고정 오프셋 +540분으로 계산한다.
- KRX 인증키는 서버 환경변수에서만 읽는다. 브라우저 응답·DB·감사 로그·오류 메시지에 절대 넣지 않는다. `audit.record`의 detail은 pino 로그로 spread되므로 키를 넣으면 안 된다.
- KRX 숫자는 문자열이다. 빈 문자열·`-`는 nullable 필드에서만 null, 비정수·음수·64비트 초과는 계약 오류. null을 0으로 바꾸지 않는다.
- 시가총액 원문은 원 단위 정수 문자열로 보존하고, 정렬·순위는 BigInt로 계산한다.
- 서비스 오류 메시지는 한국어 합쇼체, 코드 주석·문서는 문어체 평서형(CLAUDE.md).
- 커밋 메시지는 `feat(scope): ...한다` 형식 + 트레일러:
  `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>` / `Claude-Session: https://claude.ai/code/session_01HNVm7vrUNNVQUb8acXMQ2F`
- KRX 공식 필드명·URL 경로는 계약 버전 `v1`의 가정이다. 실응답 입증은 Task 16의 smoke script가 담당한다(REVIEW §11.4 게이트).

## v1 → v2 변경 요약 (Task 1은 v1과 동일, 완료됨)

| 영역 | v1 (데이터셋 종속) | v2 (실행 종속) |
| --- | --- | --- |
| 스냅샷 저장처 | `dataset_universe_provenance` + 선정 스냅샷 | `universe_snapshots` + `universe_snapshot_symbols` (불변) |
| 데이터셋 변경 | revision·1000 불변식·수동 수정 상태 | 없음 — 데이터셋은 그대로 |
| 백테스트 참조 | datasetId + expectedMembershipRevision | `datasetId` xor `universeSnapshotId` |
| 수정 | 수동 수정 플래그 유지 | 수정 불가 — 새 스냅샷 생성 |
| UI 진입점 | 데이터셋 생성 다이얼로그 | 백테스트 위저드 2단계 |
| 유지 | KRX 어댑터·필터·날짜 해소·표준코드 규칙·제출 게이트·run pin·부분 유니버스 pin 버그 수정 | 동일 |

## File Map

**Create:**
- `src/server/modules/market-data/domain/kst-date.ts` — KST 달력일 순수 함수
- `src/server/modules/market-data/domain/krx-filter-policy.ts` — 보통주 분류 정책 v1
- `src/server/modules/market-data/domain/historical-universe.ts` — 조인·순위·직렬화 순수 로직
- `src/server/modules/market-data/infrastructure/krx/krx-contract.ts` — KRX 응답 계약(zod)·숫자 파서
- `src/server/modules/market-data/infrastructure/krx/krx-historical-universe-source.ts` — 어댑터
- `src/server/modules/market-data/application/historical-universe-service.ts` — 날짜 해소·캐시·미리보기
- `src/server/modules/market-data/application/universe-snapshot-service.ts` — 스냅샷 영속화(단일 트랜잭션)·조회
- `src/server/modules/market-data/presentation/universe-routes.ts` — status/preview/snapshots 라우트
- `src/shared/schemas/historical-universe.ts` — 웹 공유 DTO(zod 없음)
- `src/web/lib/use-historical-universe.ts` — status/preview/snapshots 훅
- `src/web/features/backtests/krx-snapshot-step.tsx` — 위저드 2단계 KRX 모드 UI
- `src/web/features/backtests/krx-selection.ts` — 선택 순수 로직
- `tests/helpers/krx-fixtures.ts` — fixture 빌더 + fake KRX 서버
- `scripts/krx-smoke.ts` — 수동 smoke test
- 단위·통합·E2E 테스트 파일 (각 태스크에 명시)

**Modify:**
- `src/server/bootstrap/config.ts`, `src/server/shared/logger.ts`, `infra/app.env.example` — Task 1 완료
- `src/server/shared/db/schema.ts` — `universe_snapshots`·`universe_snapshot_symbols`·`symbols.standard_code`·`backtest_jobs.universe_snapshot_id`·`backtest_jobs/runs.provenance_pin_json`
- `src/server/modules/market-data/application/ports.ts` — KRX 포트·오류 타입
- `src/server/modules/market-data/application/dataset-service.ts` — `universeSnapshotFor` 부분집합 pin 버그 수정만
- `src/shared/schemas/backtest-request.ts` — `datasetId` xor `universeSnapshotId`
- `src/server/modules/backtest/presentation/backtest-routes.ts` — 스냅샷 경로 검증·게이트·pin
- `src/server/modules/backtest/application/job-queue.ts` — pin·snapshot id 저장
- `src/workers/backtest-child.ts` — pin 복사·경고
- `src/server/bootstrap/container.ts`, `src/server/bootstrap/server.ts` — 배선
- `src/web/features/backtests/new-backtest-wizard.tsx`, `wizard-steps.ts`, `types.ts` — 2단계 모드·요청 필드
- `src/web/features/backtests/backtest-detail-page.tsx` — 고정 유니버스 문구·pin 표시
- `scripts/e2e-server.ts` — fake KRX 기동
- `infra/app.env.example`(완료), `docs/DECISIONS.md`(D-040), `docs/SPEC.md` §12, REVIEW 상태 갱신

---

### Task 1: KRX 환경변수와 로그 redaction — ✅ 완료 (05cc4db)

v1과 동일. `AppConfig.krxBaseUrl`/`krxApiKey`/`krxApprovalExpiry`, REDACT_PATHS, app.env.example. 완료 커밋 `05cc4db`.

---

### Task 2: 스키마 — universe_snapshots·표준코드·pin

**Files:**
- Modify: `src/server/shared/db/schema.ts`
- Generate: `migrations/0001_*.sql` (`pnpm db:generate`)
- Test: `tests/integration/universe-snapshot-schema.test.ts`

**Interfaces:**
- Produces: 테이블 `universeSnapshots`, `universeSnapshotSymbols`; 컬럼 `symbols.standardCode`(unique), `backtestJobs.universeSnapshotId`, `backtestJobs.provenancePinJson`, `backtestRuns.provenancePinJson`
- **데이터셋 테이블은 변경하지 않는다.**

- [ ] **Step 1: 실패하는 테스트** — `tests/integration/universe-snapshot-schema.test.ts` (`dataset-slice-schema.test.ts`의 mkdtemp 패턴):

```ts
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openDatabase, type DatabaseHandle } from '../../src/server/shared/db/database.js';
import { symbols, universeSnapshots, universeSnapshotSymbols } from '../../src/server/shared/db/schema.js';

describe('universe snapshot 스키마', () => {
  let dir: string;
  let handle: DatabaseHandle;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'usn-schema-'));
    handle = openDatabase(join(dir, 'test.sqlite'));
  });
  afterAll(() => { handle.close(); rmSync(dir, { recursive: true, force: true }); });

  it('스냅샷과 종목 값 행을 저장한다', () => {
    handle.db.insert(universeSnapshots).values({
      id: 'usn_1', sourceKind: 'KRX_HISTORICAL', requestedDate: '2025-01-01',
      effectiveTradingDate: '2024-12-30', usableFromDate: '2024-12-31',
      usableFromRule: 'NEXT_SESSION_CONSERVATIVE_V1', marketsJson: '["KOSPI","KOSDAQ"]',
      filterPolicyVersion: 'krx-common-stock-v1', contractVersion: 'v1',
      sortKey: 'MKTCAP', sortDirection: 'DESC', selectionMethod: 'TOP_MARKET_CAP_N', selectionN: 200,
      selectedCount: 1, eligibleCount: 900, unknownMarketCapCount: 0,
      excludedByTypeJson: '{}', rawCountsJson: '{"KOSPI":950,"KOSDAQ":1700}',
      selectionHash: 'h1', candidateCanonicalHash: 'h2',
      krxApprovalExpiryDate: null, createdAtMs: 1,
    }).run();
    handle.db.insert(universeSnapshotSymbols).values({
      snapshotId: 'usn_1', standardCode: 'KR7005930003', shortCode: '005930',
      nameAtSelection: '삼성전자', marketAtSelection: 'KOSPI',
      marketCapKrw: '350000000000000', rank: 1, instrumentType: 'COMMON_STOCK',
    }).run();
    expect(handle.db.select().from(universeSnapshotSymbols).all()).toHaveLength(1);
  });

  it('스냅샷 종목 행은 symbols 삭제에 cascade 되지 않는 값 스냅샷이다', () => {
    handle.db.insert(symbols).values({ code: '005930', market: 'KR', name: null, createdAtMs: 1, standardCode: 'KR7005930003' }).run();
    handle.db.delete(symbols).run();
    expect(handle.db.select().from(universeSnapshotSymbols).all()).toHaveLength(1);
  });

  it('같은 스냅샷 안에서 표준코드는 유일하다', () => {
    expect(() =>
      handle.db.insert(universeSnapshotSymbols).values({
        snapshotId: 'usn_1', standardCode: 'KR7005930003', shortCode: '005930X',
        nameAtSelection: 'dup', marketAtSelection: 'KOSPI', marketCapKrw: null, rank: null,
        instrumentType: 'COMMON_STOCK',
      }).run(),
    ).toThrow();
  });

  it('symbols.standard_code 는 unique 고 null 은 여러 개 허용된다', () => {
    handle.db.insert(symbols).values({ code: 'A', market: 'KR', name: null, createdAtMs: 1, standardCode: 'KR700A' }).run();
    handle.db.insert(symbols).values({ code: 'B', market: 'KR', name: null, createdAtMs: 1 }).run();
    handle.db.insert(symbols).values({ code: 'C', market: 'KR', name: null, createdAtMs: 1 }).run();
    expect(() =>
      handle.db.insert(symbols).values({ code: 'D', market: 'KR', name: null, createdAtMs: 1, standardCode: 'KR700A' }).run(),
    ).toThrow();
  });
});
```

- [ ] **Step 2: 실패 확인**
- [ ] **Step 3: 스키마 구현** — 기존 명명 관례(snake_case SQL, `*_ms`, `*_json`, `idx_<table>_<cols>`) 그대로:

```ts
/**
 * 백테스트가 참조하는 과거 시점 유니버스 스냅샷 (REVIEW 기반, 소유 모델은 실행 종속 — D-040).
 * 저장 후 불변이다. 구성을 바꾸려면 새 스냅샷을 만든다 — 그래서 수정 이력 컬럼이 없다.
 */
export const universeSnapshots = sqliteTable('universe_snapshots', {
  id: text('id').primaryKey(), // newId('usn')
  sourceKind: text('source_kind').notNull(), // 'KRX_HISTORICAL'
  requestedDate: text('requested_date').notNull(),          // 사용자가 입력한 KST 달력일
  effectiveTradingDate: text('effective_trading_date').notNull(), // 시가총액을 관측한 거래일
  usableFromDate: text('usable_from_date').notNull(),
  usableFromRule: text('usable_from_rule').notNull(),
  marketsJson: text('markets_json').notNull(),
  filterPolicyVersion: text('filter_policy_version').notNull(),
  contractVersion: text('contract_version').notNull(),
  sortKey: text('sort_key').notNull(),
  sortDirection: text('sort_direction').notNull(),
  selectionMethod: text('selection_method').notNull(), // 'TOP_MARKET_CAP_N' | 'MANUAL_FROM_KRX_SNAPSHOT'
  selectionN: integer('selection_n'),
  selectedCount: integer('selected_count').notNull(),
  eligibleCount: integer('eligible_count').notNull(),
  unknownMarketCapCount: integer('unknown_market_cap_count').notNull(),
  excludedByTypeJson: text('excluded_by_type_json').notNull(),
  rawCountsJson: text('raw_counts_json').notNull(),
  selectionHash: text('selection_hash').notNull(),
  candidateCanonicalHash: text('candidate_canonical_hash').notNull(),
  krxApprovalExpiryDate: text('krx_approval_expiry_date'),
  createdAtMs: integer('created_at_ms').notNull(),
}, (table) => [index('idx_universe_snapshots_created').on(table.createdAtMs)]);

/**
 * 스냅샷 선정 종목의 값 스냅샷 (REVIEW §7.2). symbols 에 FK 를 걸지 않는다 —
 * 종목 삭제 뒤에도 실행 근거를 값으로 설명해야 한다 (backtest_trades.symbol 선례).
 */
export const universeSnapshotSymbols = sqliteTable('universe_snapshot_symbols', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  snapshotId: text('snapshot_id').notNull()
    .references(() => universeSnapshots.id, { onDelete: 'cascade' }),
  standardCode: text('standard_code').notNull(),
  shortCode: text('short_code').notNull(), // symbols.code 와 같은 값이지만 FK 없음
  nameAtSelection: text('name_at_selection').notNull(),
  marketAtSelection: text('market_at_selection').notNull(), // 'KOSPI' | 'KOSDAQ'
  /** 원 단위 정수 원문 문자열. null 은 unknown 이지 0 이 아니다 */
  marketCapKrw: text('market_cap_krw'),
  rank: integer('rank'),
  instrumentType: text('instrument_type').notNull(), // 'COMMON_STOCK'
}, (table) => [
  uniqueIndex('idx_universe_snapshot_symbols_snap_code').on(table.snapshotId, table.standardCode),
  index('idx_universe_snapshot_symbols_snap').on(table.snapshotId),
]);
```

`symbols`에 (Task 2 v1과 동일):

```ts
/** KRX 표준코드(ISIN). 스냅샷 등록 시에만 채워진다 — 단축코드 재사용을 구분하는 유일한 열쇠 */
standardCode: text('standard_code'),
// 인덱스 배열에 uniqueIndex('idx_symbols_standard_code').on(table.standardCode) 추가
```

`backtestJobs`에:

```ts
/** 유니버스 스냅샷 참조. datasetId 처럼 FK 를 걸지 않는다 — 실행 기록은 pin 값으로 자립한다 */
universeSnapshotId: text('universe_snapshot_id'),
/** 서버 소유 provenance pin (REVIEW §9.2). 클라이언트 입력이 아니다 */
provenancePinJson: text('provenance_pin_json'),
```

`backtestRuns`에 `provenancePinJson: text('provenance_pin_json')`.

- [ ] **Step 4: `pnpm db:generate`** — `0001_*.sql`이 ADD COLUMN + 새 테이블 + 인덱스만 담는지 확인. 테이블 재생성 DDL이 보이면 중단하고 원인 제거.
- [ ] **Step 5: 통과 확인** — 대상 테스트 후 `pnpm test` 전체
- [ ] **Step 6: 커밋** — `feat(db): 유니버스 스냅샷 테이블과 표준코드·provenance pin 컬럼을 추가한다`

---

### Task 3: KST 날짜 도메인 함수

**Files:**
- Create: `src/server/modules/market-data/domain/kst-date.ts`
- Test: `tests/unit/kst-date.test.ts`

**Interfaces:**
- Produces: `kstDateOf(tsMs): string`(ISO), `kstHourOf(tsMs): number`, `addCalendarDays(isoDate, days): string`, `isoToBasDd(isoDate): string`, `basDdToIso(basDd): string`, `KRX_DATA_EPOCH = '2010-01-04'`

- [ ] **Step 1: 실패하는 테스트**

```ts
import { describe, expect, it } from 'vitest';
import {
  addCalendarDays, basDdToIso, isoToBasDd, KRX_DATA_EPOCH, kstDateOf, kstHourOf,
} from '../../src/server/modules/market-data/domain/kst-date.js';

describe('kst-date', () => {
  it('UTC 자정 직전은 KST 다음 날이다', () => {
    // 2026-08-02T23:00:00Z = KST 2026-08-03 08:00
    expect(kstDateOf(Date.UTC(2026, 7, 2, 23, 0, 0))).toBe('2026-08-03');
    expect(kstHourOf(Date.UTC(2026, 7, 2, 23, 0, 0))).toBe(8);
  });
  it('달력일 가감은 월 경계를 넘는다', () => {
    expect(addCalendarDays('2025-01-01', -1)).toBe('2024-12-31');
    expect(addCalendarDays('2024-12-30', 1)).toBe('2024-12-31');
  });
  it('basDd 변환은 왕복한다', () => {
    expect(isoToBasDd('2025-01-02')).toBe('20250102');
    expect(basDdToIso('20250102')).toBe('2025-01-02');
  });
  it('KRX 공식 제공 시작일은 2010-01-04 다', () => {
    expect(KRX_DATA_EPOCH).toBe('2010-01-04');
  });
});
```

- [ ] **Step 2: 실패 확인**
- [ ] **Step 3: 구현** — 고정 오프셋 방식(`fact-year-range.ts`와 동일 근거):

```ts
/** KST 달력일 계산. 저장소는 tz 라이브러리를 쓰지 않고 고정 오프셋으로 자른다 (exchange-session.ts 와 같은 방식) */
const KST_OFFSET_MS = 540 * 60 * 1000;
const DAY_MS = 86_400_000;

export const KRX_DATA_EPOCH = '2010-01-04';

export function kstDateOf(tsMs: number): string {
  return new Date(tsMs + KST_OFFSET_MS).toISOString().slice(0, 10);
}
export function kstHourOf(tsMs: number): number {
  return new Date(tsMs + KST_OFFSET_MS).getUTCHours();
}
export function addCalendarDays(isoDate: string, days: number): string {
  return new Date(Date.parse(`${isoDate}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}
export function isoToBasDd(isoDate: string): string { return isoDate.replaceAll('-', ''); }
export function basDdToIso(basDd: string): string {
  return `${basDd.slice(0, 4)}-${basDd.slice(4, 6)}-${basDd.slice(6, 8)}`;
}
```

- [ ] **Step 4: 통과 확인 후 커밋** — `feat(market-data): KST 달력일 도메인 함수를 추가한다`

---

### Task 4: KRX 응답 계약과 숫자 파서

**Files:**
- Create: `src/server/modules/market-data/infrastructure/krx/krx-contract.ts`
- Modify: `src/server/modules/market-data/application/ports.ts` (오류·포트 타입)
- Create: `tests/helpers/krx-fixtures.ts` (fixture 빌더 최소 형태)
- Test: `tests/unit/krx-contract.test.ts`

**Interfaces:**
- Produces (ports.ts — 포트 계약 오류는 application 이 catch 할 수 있게 여기 둔다, `MarketDataSourceNotConfiguredError` 선례):

```ts
export type KrxMarket = 'KOSPI' | 'KOSDAQ';
export interface KrxIssueBaseInfoRow {
  readonly standardCode: string;   // 기본정보 ISU_CD (표준코드)
  readonly shortCode: string;      // ISU_SRT_CD
  readonly name: string;           // ISU_NM 원문
  readonly listedDate: string | null;    // LIST_DD → ISO, 형식이 다르면 null
  readonly marketRaw: string;      // MKT_TP_NM 원문
  readonly securityGroupRaw: string;     // SECUGRP_NM 원문
  readonly sectionRaw: string | null;    // SECT_TP_NM 원문
  readonly stockKindRaw: string | null;  // KIND_STKCERT_TP_NM 원문
}
export interface KrxDailyTradeRow {
  readonly shortCode: string;            // 일별 ISU_CD — 이름과 달리 단축코드다 (REVIEW §3.1)
  readonly name: string;
  readonly marketCapRaw: string | null;  // MKTCAP 정규화 원문(콤마 제거), unknown 은 null
}
export interface KrxHistoricalUniverseSource {
  fetchIssueBaseInfo(market: KrxMarket, isoDate: string): Promise<readonly KrxIssueBaseInfoRow[]>;
  fetchDailyTrades(market: KrxMarket, isoDate: string): Promise<readonly KrxDailyTradeRow[]>;
  todayCallCount(): number;
}
export class KrxNotConfiguredError extends Error { }   // name 지정, 발급·승인 안내 메시지
export class KrxApprovalExpiredError extends Error { }
export class KrxContractError extends Error { }
export class KrxQuotaError extends Error { }
```

- Produces (krx-contract.ts): `KRX_CONTRACT_VERSION = 'v1'`, `parseKrxEnvelope(payload): readonly Record<string, unknown>[]`, `parseBaseInfoRows(rows): KrxIssueBaseInfoRow[]`, `parseDailyRows(rows): KrxDailyTradeRow[]`, `parseNullableInt64(raw, field): bigint | null`

- [ ] **Step 1: 실패하는 테스트** — 핵심 케이스:

```ts
describe('parseNullableInt64', () => {
  it('빈 문자열과 - 는 null 이다', () => {
    expect(parseNullableInt64('', 'MKTCAP')).toBeNull();
    expect(parseNullableInt64('-', 'MKTCAP')).toBeNull();
    expect(parseNullableInt64(null, 'MKTCAP')).toBeNull();
  });
  it('콤마 구분 정수를 BigInt 로 파싱한다', () => {
    expect(parseNullableInt64('350,000,000,000,000', 'MKTCAP')).toBe(350_000_000_000_000n);
  });
  it('비정수·음수·64비트 초과는 KrxContractError 다', () => {
    expect(() => parseNullableInt64('12.5', 'MKTCAP')).toThrow(KrxContractError);
    expect(() => parseNullableInt64('-3', 'MKTCAP')).toThrow(KrxContractError);
    expect(() => parseNullableInt64('9223372036854775808', 'MKTCAP')).toThrow(KrxContractError);
  });
});
describe('parseKrxEnvelope', () => {
  it('OutBlock_1 배열이 없으면 계약 오류다', () => {
    expect(() => parseKrxEnvelope({ resultCode: 'ERR' })).toThrow(KrxContractError);
  });
});
describe('parseBaseInfoRows', () => {
  it('필수 필드가 빠지면 계약 오류다', () => {
    expect(() => parseBaseInfoRows([{ ISU_SRT_CD: '005930' }])).toThrow(KrxContractError);
  });
  it('정상 행을 내부 모델로 변환하고 원문을 보존한다', () => {
    const rows = parseBaseInfoRows([baseInfoFixture({ ISU_NM: '삼성전자', SECUGRP_NM: '주권' })]);
    expect(rows[0]!.securityGroupRaw).toBe('주권');
    expect(rows[0]!.standardCode).toBe('KR7005930003');
  });
});
```

`tests/helpers/krx-fixtures.ts`에 `baseInfoFixture(overrides)` / `dailyFixture(overrides)` — 완전한 기본값을 가진 KRX 원문 행 빌더.

- [ ] **Step 2: 실패 확인**
- [ ] **Step 3: 구현** — zod `.loose()` 객체로 필수 필드만 고정. `LIST_DD`는 8자리 숫자면 `basDdToIso`, 아니면 null. `KrxContractError` 메시지에 필드명·원인 포함(값 원문은 30자 이내로 자른다):

```ts
export function parseNullableInt64(raw: string | null | undefined, field: string): bigint | null {
  const trimmed = (raw ?? '').trim().replaceAll(',', '');
  if (trimmed === '' || trimmed === '-') return null;
  if (!/^\d+$/.test(trimmed)) throw new KrxContractError(`${field} 가 정수 형식이 아닙니다: ${trimmed.slice(0, 30)}`);
  const value = BigInt(trimmed);
  if (value > 2n ** 63n - 1n) throw new KrxContractError(`${field} 가 64비트 범위를 넘습니다`);
  return value;
}
```

- [ ] **Step 4: 통과 확인 후 커밋** — `feat(market-data): KRX 응답 계약 v1 파서를 추가한다`

---

### Task 5: 보통주 필터 정책 v1

**Files:**
- Create: `src/server/modules/market-data/domain/krx-filter-policy.ts`
- Test: `tests/unit/krx-filter-policy.test.ts`

**Interfaces:**
- Produces:

```ts
export const KRX_FILTER_POLICY_VERSION = 'krx-common-stock-v1';
export type KrxExclusionReason =
  | 'PREFERRED_STOCK' | 'REIT' | 'SPAC' | 'DR' | 'FUND_OR_TRUST' | 'NON_STOCK_SECURITY' | 'FOREIGN_LISTING';
export type KrxFilterDecision =
  | { readonly kind: 'INCLUDE'; readonly instrumentType: 'COMMON_STOCK' }
  | { readonly kind: 'EXCLUDE'; readonly reason: KrxExclusionReason };
export class UnknownKrxClassificationError extends Error {
  constructor(readonly field: string, readonly value: string, readonly shortCode: string)
}
export function classifyKrxIssue(row: {
  securityGroupRaw: string; stockKindRaw: string | null; sectionRaw: string | null;
  name: string; shortCode: string;
}): KrxFilterDecision
```

- [ ] **Step 1: 실패하는 테스트** — REVIEW §4.1·§11.1의 각 유형:

```ts
const base = { securityGroupRaw: '주권', stockKindRaw: '보통주', sectionRaw: null, name: '삼성전자', shortCode: '005930' };

it('주권·보통주는 포함한다', () => {
  expect(classifyKrxIssue(base)).toEqual({ kind: 'INCLUDE', instrumentType: 'COMMON_STOCK' });
});
it.each(['구형우선주', '신형우선주', '우선주'])('주식종류 %s 는 우선주로 제외한다', (kind) => {
  expect(classifyKrxIssue({ ...base, stockKindRaw: kind })).toEqual({ kind: 'EXCLUDE', reason: 'PREFERRED_STOCK' });
});
it.each([
  ['부동산투자회사', 'REIT'], ['주식예탁증권', 'DR'], ['수익증권', 'FUND_OR_TRUST'],
  ['선박투자회사', 'FUND_OR_TRUST'], ['사회간접자본투융자회사', 'FUND_OR_TRUST'],
  ['신주인수권증권', 'NON_STOCK_SECURITY'], ['신주인수권증서', 'NON_STOCK_SECURITY'],
  ['ETF', 'NON_STOCK_SECURITY'], ['ETN', 'NON_STOCK_SECURITY'], ['ELW', 'NON_STOCK_SECURITY'],
  ['외국주권', 'FOREIGN_LISTING'],
])('증권그룹 %s 는 %s 로 제외한다', (group, reason) => {
  expect(classifyKrxIssue({ ...base, securityGroupRaw: group })).toEqual({ kind: 'EXCLUDE', reason });
});
it('소속부에 SPAC 이 있으면 SPAC 으로 제외한다', () => {
  expect(classifyKrxIssue({ ...base, sectionRaw: 'SPAC(소속부없음)' })).toEqual({ kind: 'EXCLUDE', reason: 'SPAC' });
});
it('종목명에 스팩이 있으면 SPAC 으로 제외한다 — 필드 조합은 smoke test 로 입증한다', () => {
  expect(classifyKrxIssue({ ...base, name: '하나32호스팩' })).toEqual({ kind: 'EXCLUDE', reason: 'SPAC' });
});
it('모르는 증권그룹은 조용히 제외하지 않고 전체 실패시킨다', () => {
  expect(() => classifyKrxIssue({ ...base, securityGroupRaw: '신종증권' })).toThrow(UnknownKrxClassificationError);
});
it('모르는 주식종류도 전체 실패시킨다', () => {
  expect(() => classifyKrxIssue({ ...base, stockKindRaw: '전환주' })).toThrow(UnknownKrxClassificationError);
});
```

- [ ] **Step 2: 실패 확인**
- [ ] **Step 3: 구현** — allowlist 방식. 판정 순서: 증권그룹 → (주권일 때) SPAC 판정(소속부 `includes('SPAC')` 우선, 이름 `includes('스팩')` 보조 — 보조 규칙은 주석에 smoke 게이트 명시) → 주식종류. 알려진 값 밖은 전부 `UnknownKrxClassificationError`. 파일 헤더 주석: "이 정책 버전은 fixture 로 검증했고 실응답 입증은 scripts/krx-smoke.ts 가 담당한다. 값 추가 시 버전을 올린다."
- [ ] **Step 4: 통과 확인 후 커밋** — `feat(market-data): KRX 보통주 필터 정책 v1 을 추가한다`

---

### Task 6: 조인·순위·canonical payload 도메인

**Files:**
- Create: `src/server/modules/market-data/domain/historical-universe.ts`
- Test: `tests/unit/historical-universe.test.ts`

**Interfaces:**
- Consumes: Task 4 포트 행 타입, Task 5 `classifyKrxIssue`
- Produces:

```ts
export interface EligibleCandidate {
  readonly standardCode: string; readonly shortCode: string; readonly name: string;
  readonly market: KrxMarket;
  readonly marketCapKrw: bigint | null;  // null = unknown
  readonly rank: number | null;          // unknown 은 null
}
export interface UniverseCandidateSet {
  readonly effectiveTradingDate: string;
  readonly candidates: readonly EligibleCandidate[]; // 순위순, unknown 은 뒤에 단축코드 오름차순
  readonly rawCounts: Readonly<Record<KrxMarket, number>>;
  readonly eligibleCount: number;
  readonly unknownMarketCapCount: number;
  readonly excludedByType: Readonly<Record<string, number>>;
  readonly filterPolicyVersion: string;
  readonly contractVersion: string;
  /** 결정적 직렬화 문자열. sha256 적용은 application 이 한다 — domain 은 Node 내장 모듈 금지 */
  readonly canonicalPayload: string;
}
export class UniverseJoinError extends Error { }
export function combineMarketSnapshots(args: {
  effectiveTradingDate: string;
  inputs: ReadonlyArray<{ market: KrxMarket; baseRows: readonly KrxIssueBaseInfoRow[]; dailyRows: readonly KrxDailyTradeRow[] }>;
}): UniverseCandidateSet
export function selectionPayloadOf(canonicalPayload: string, standardCodes: readonly string[]): string
// 정렬한 표준코드를 붙인 결정적 직렬화 — 서비스가 sha256 해 selectionHash 로 쓴다
```

- [ ] **Step 1: 실패하는 테스트** — REVIEW §4.3·§5·§11.1:

```ts
it('시가총액 내림차순, 동률은 단축코드 오름차순으로 완전순서를 만든다', () => {
  // mktcap 300/300/500 인 3종목 → [500, 300(코드 작은 쪽), 300(코드 큰 쪽)], rank 1·2·3
});
it('unknown 시가총액은 0 이 되지 않고 rank null 로 뒤에 붙는다', () => {
  // 일별정보에 없는 적격 종목 → candidates 마지막, marketCapKrw null, rank null
});
it('기본정보에 없고 일별정보에만 있는 종목은 전체 실패다', () => {
  expect(() => combineMarketSnapshots({ /* daily 에만 있는 코드 */ })).toThrow(UniverseJoinError);
});
it('단축코드 중복 조인은 전체 실패다', () => { /* 같은 shortCode 기본정보 2행 */ });
it('시장 간 표준코드 충돌은 전체 실패다', () => { /* KOSPI·KOSDAQ 에 같은 standardCode */ });
it('제외 유형이 사유별로 집계된다', () => {
  // 우선주 1, ETF 1 → excludedByType { PREFERRED_STOCK: 1, NON_STOCK_SECURITY: 1 }, eligibleCount 는 보통주만
});
it('canonical payload 는 입력 순서와 무관하게 결정적이다', () => {
  const a = combineMarketSnapshots({ effectiveTradingDate: d, inputs: [kospi, kosdaq] });
  const b = combineMarketSnapshots({ effectiveTradingDate: d, inputs: [kosdaq, kospi] });
  expect(a.canonicalPayload).toBe(b.canonicalPayload);
});
it('구성이 하나라도 다르면 payload 가 다르다', () => { /* mktcap 1 차이 → 다른 payload */ });
it('selectionPayloadOf 는 선택 순서와 무관하다', () => {
  expect(selectionPayloadOf(p, ['B', 'A'])).toBe(selectionPayloadOf(p, ['A', 'B']));
});
```

- [ ] **Step 2: 실패 확인**
- [ ] **Step 3: 구현** — 시장별 base를 shortCode 키 Map으로(중복 → `UniverseJoinError`), daily 조인. daily에만 있으면 실패, base에만 있으면 marketCap null. `classifyKrxIssue` 적용(UnknownKrxClassificationError 전파). BigInt 내림차순 + 단축코드 오름차순. `canonicalPayload` = `${date}|${policyV}|${contractV}` + 후보 라인들(`standardCode|shortCode|market|mktcap∥unknown`) 개행 결합.
- [ ] **Step 4: 통과 확인 후 커밋** — `feat(market-data): KRX 후보 조인·순위·정규화 도메인을 추가한다`

---

### Task 7: KRX 어댑터

**Files:**
- Create: `src/server/modules/market-data/infrastructure/krx/krx-historical-universe-source.ts`
- Modify: `tests/helpers/krx-fixtures.ts` (fake fetch·envelope 빌더 확장)
- Test: `tests/unit/krx-historical-universe-source.test.ts`

**Interfaces:**
- Consumes: `RestClient`(`src/server/shared/rest-client.ts`), Task 4 계약, `Clock`
- Produces:

```ts
export interface KrxConfig { readonly baseUrl: string; readonly apiKey: string; readonly approvalExpiry: string | null }
export function createKrxHistoricalUniverseSource(
  config: KrxConfig | null,
  clock: Clock,
  logger: Logger,
  options: { fetchImpl?: typeof fetch; sleep?: (ms: number) => Promise<void> } = {},
): KrxHistoricalUniverseSource
```

- [ ] **Step 1: 실패하는 테스트** — dart-fact-source.test.ts 패턴(fetchImpl 주입, capturing logger):

```ts
it('null config 는 KrxNotConfiguredError 를 던지는 비활성 어댑터다', ...);
it('승인 만료일이 지나면 KrxApprovalExpiredError 를 던지고 외부 호출이 없다', async () => {
  const fetchImpl = vi.fn();
  const source = createKrxHistoricalUniverseSource(
    { baseUrl: 'https://x', apiKey: 'k', approvalExpiry: '2026-08-01' },
    { now: () => Date.UTC(2026, 7, 3) }, logger, { fetchImpl });
  await expect(source.fetchDailyTrades('KOSPI', '2025-01-02')).rejects.toBeInstanceOf(KrxApprovalExpiredError);
  expect(fetchImpl).not.toHaveBeenCalled();
});
it('AUTH_KEY 헤더로 호출하고 URL 에 키가 없다', ...);
it('시장별 경로가 다르다 — KOSPI stk_*, KOSDAQ ksq_*, basDd 쿼리', ...);
it('OutBlock_1 을 포트 행으로 변환한다', ...);
it('429 소진 후 KrxQuotaError 로 구분해 던진다', ...);
it('호출마다 KST 일 기준 카운터가 올라가고 krx.fetch 이벤트가 남는다', ...);
it('인증키가 로그에 남지 않는다', ...); // capturing logger 전체 직렬화에 키 문자열 부재
```

- [ ] **Step 2: 실패 확인**
- [ ] **Step 3: 구현**

```ts
const PATHS: Record<KrxMarket, { readonly base: string; readonly daily: string }> = {
  KOSPI: { base: '/svc/apis/sto/stk_isu_base_info', daily: '/svc/apis/sto/stk_bydd_trd' },
  KOSDAQ: { base: '/svc/apis/sto/ksq_isu_base_info', daily: '/svc/apis/sto/ksq_bydd_trd' },
};
```

- null config → 전 메서드 reject하는 inert 객체(toss 방식), `todayCallCount()` 0.
- 호출 전 만료 검사: `config.approvalExpiry && kstDateOf(clock.now()) > config.approvalExpiry` → `KrxApprovalExpiredError`.
- `RestClient` tokenProvider 없이, `groupMinIntervalMs: { default: 250 }`, 요청 헤더 `{ AUTH_KEY: config.apiKey }`, 경로 `?basDd=${isoToBasDd(date)}`.
- RestClient 실패 메시지가 `REST 요청 실패: 429`로 시작하면 `KrxQuotaError`로 변환(구조화 오류가 없어 메시지 판별 — 이유 주석).
- 호출 카운터: KST 날짜 키 Map(전일 키 접근 시 제거). 매 호출 `logger.info({ module: 'market-data', event: 'krx.fetch', market, basDd, rows, callsToday }, 'krx fetch ok')`.
- 응답은 Task 4 파서로 변환. zod 실패·envelope 이상은 `KrxContractError`.

- [ ] **Step 4: 통과 확인 후 커밋** — `feat(market-data): KRX Open API 어댑터를 추가한다`

---

### Task 8: HistoricalUniverseService — 날짜 해소·원자 결합·캐시·single-flight

**Files:**
- Create: `src/server/modules/market-data/application/historical-universe-service.ts`
- Test: `tests/unit/historical-universe-service.test.ts`

**Interfaces:**
- Consumes: `KrxHistoricalUniverseSource`, Task 6 domain, `Clock`, `newId`
- Produces:

```ts
export interface HistoricalUniversePreview {
  readonly previewId: string;               // newId('uvp') — 서버 캐시 키, 불투명
  readonly requestedDate: string;
  readonly effectiveTradingDate: string;
  readonly usableFromDate: string;          // effective + 1 달력일
  readonly usableFromRule: 'NEXT_SESSION_CONSERVATIVE_V1';
  readonly canonicalHash: string;           // sha256(set.canonicalPayload)
  readonly set: UniverseCandidateSet;
  readonly fetchedAtMs: number;
}
export class HistoricalUniverseDateError extends Error {
  constructor(readonly code: 'BEFORE_EPOCH' | 'FUTURE_OR_UNPUBLISHED' | 'NO_TRADING_DAY_IN_RANGE', message: string)
}
export class PreviewExpiredError extends Error { }
export interface HistoricalUniverseAvailability { readonly available: boolean; readonly reason: string | null }
export class HistoricalUniverseService {
  constructor(private readonly deps: {
    readonly source: KrxHistoricalUniverseSource;
    readonly configured: boolean;            // 컨테이너가 config 로 판단해 주입
    readonly approvalExpiry: string | null;
    readonly clock: Clock;
    readonly logger: Logger;
    readonly previewTtlMs?: number;           // 기본 6h, 테스트 주입용
  })
  availability(): HistoricalUniverseAvailability
  async preview(requestedDate: string): Promise<HistoricalUniversePreview>
  getPreview(previewId: string): HistoricalUniversePreview | null   // 만료·부재 시 null
  async currentStandardCodeMap(): Promise<ReadonlyMap<string, string>> // shortCode → standardCode, 표준코드 검증·백필용
}
```

- [ ] **Step 1: 실패하는 테스트** — fake source(호출 기록 + 날짜별 canned 응답)로:

```ts
it('키 미설정이면 available=false 와 발급·승인 안내 이유를 준다', ...);
it('승인 만료면 available=false — 이유에 만료일 표시', ...);
it('2010-01-04 이전 요청은 BEFORE_EPOCH 로 차단한다', ...);
it('KST 어제보다 뒤는 FUTURE_OR_UNPUBLISHED 로 차단한다', ...);
it('KST 08시 전에는 어제 데이터도 공개 대기로 차단한다', () => {
  // clock = KST 2026-08-03 07:00, requested 2026-08-02 → FUTURE_OR_UNPUBLISHED
});
it('휴장일 요청은 이전 거래일로 해소하고 두 날짜를 모두 반환한다', () => {
  // fake: 2025-01-01 빈 응답, 2024-12-31 빈 응답, 2024-12-30 데이터 → effective 2024-12-30
});
it('31일 안에 거래일이 없으면 NO_TRADING_DAY_IN_RANGE 다', ...);
it('KOSPI 성공·KOSDAQ 빈 응답이면 전체 실패다 — 부분 후보군을 만들지 않는다', ...);
it('한 시장 호출 실패는 전체 실패고 오류는 캐시되지 않는다', () => {
  // 첫 preview reject 후 fake 를 정상으로 바꾸면 두 번째 preview 는 성공해야 한다
});
it('같은 요청일 동시 호출은 single-flight 로 합쳐진다', async () => {
  const [a, b] = await Promise.all([svc.preview('2025-01-02'), svc.preview('2025-01-02')]);
  expect(a.previewId).toBe(b.previewId);
  expect(fakeSource.calls.filter((c) => c.kind === 'daily' && c.market === 'KOSPI')).toHaveLength(1);
});
it('같은 적용일 재조회는 캐시를 쓰고 TTL 이 지나면 다시 부른다', ...);
it('getPreview 는 TTL 만료 후 null 이다', ...);
it('usableFromDate 는 적용일 + 1 달력일이다', ...);
```

- [ ] **Step 2: 실패 확인**
- [ ] **Step 3: 구현** — 날짜 해소(REVIEW §4.2):

```ts
async preview(requestedDate) {
  this.assertAvailable();
  if (requestedDate < KRX_DATA_EPOCH) throw new HistoricalUniverseDateError('BEFORE_EPOCH', '2010-01-04 이전은 KRX 공식 제공 범위 밖입니다');
  const nowMs = this.deps.clock.now();
  const yesterday = addCalendarDays(kstDateOf(nowMs), -1);
  const publishedThrough = kstHourOf(nowMs) < 8 ? addCalendarDays(yesterday, -1) : yesterday;
  if (requestedDate > publishedThrough) throw new HistoricalUniverseDateError('FUTURE_OR_UNPUBLISHED', ...);
  return this.singleFlight(requestedDate, () => this.buildPreview(requestedDate));
}
```

`buildPreview`: KOSPI daily를 requestedDate부터 최대 31일 뒤로 탐색(빈 배열 = 휴장, 날짜별 결과는 `dailyCache`에 저장 — 빈 결과도 정상 응답이라 캐시), 첫 데이터 있는 날짜가 effective. 같은 날짜의 KOSDAQ daily + 양 시장 base info fetch. KOSDAQ 비면 전체 실패(캐시 안 함). `combineMarketSnapshots` → `canonicalHash = sha256(set.canonicalPayload)`(`node:crypto`) → `previewId = newId('uvp')`. previewCache는 previewId·(effective+정책+계약 버전) 양 키, TTL 6h. single-flight는 dart-corp-code-cache 패턴(실패 시 pending 제거). `currentStandardCodeMap`: publishedThrough부터 최대 31일 뒤로 base info 행이 나오는 날짜를 찾아 양 시장 `shortCode → standardCode` Map, 같은 TTL 캐시.

- [ ] **Step 4: 통과 확인 후 커밋** — `feat(market-data): 과거 유니버스 미리보기 서비스를 추가한다`

---

### Task 9: universeSnapshotFor — 부분 유니버스 pin 버그 수정

**Files:**
- Modify: `src/server/modules/market-data/application/dataset-service.ts` (232–250행)
- Modify: `src/server/modules/backtest/presentation/backtest-routes.ts` (220행 호출부)
- Test: `tests/unit/dataset-service-universe-pin.test.ts`

**Interfaces:**
- Produces: `DatasetService.universeSnapshotFor(codes: readonly string[], slice: DatasetSlice): UniverseSnapshot` — 데이터셋이 아니라 **실제 해소된 실행 종목**의 버전만 pin 한다(REVIEW §2). 기존 `universeSnapshot(datasetId, slice)`은 내부에서 `universeSnapshotFor(this.symbolsOf(datasetId), slice)`로 위임.

- [ ] **Step 1: 실패하는 테스트**

```ts
it('요청 종목 부분집합만 pin 한다 — 데이터셋의 다른 종목은 해시에 들어가지 않는다', () => {
  // 데이터셋 {A,B}, universeSnapshotFor(['A'], '1d') → entries 에 B 없음
});
it('전체 위임 경로는 기존과 같은 결과다', () => {
  // universeSnapshot(datasetId, slice) === universeSnapshotFor(전체코드, slice)
});
```

- [ ] **Step 2: 실패 확인 후 구현** — `backtest-routes.ts:220`을 `datasets.universeSnapshotFor(body.universe.symbols, slice)`로 교체(해소된 실행 종목 기준). 기존 `job-queue.test.ts` 등 영향 테스트 갱신.
- [ ] **Step 3: 통과 확인 후 커밋** — `fix(backtest): 유니버스 버전 pin 을 실제 실행 종목으로 좁힌다`

---

### Task 10: UniverseSnapshotService — 스냅샷 영속화·종목 등록·조회

**Files:**
- Create: `src/server/modules/market-data/application/universe-snapshot-service.ts`
- Test: `tests/unit/universe-snapshot-service.test.ts`

**Interfaces:**
- Consumes: `HistoricalUniverseService.getPreview/currentStandardCodeMap`, Task 2 스키마, `newId`, `AuditLogService`
- Produces:

```ts
export class SnapshotSelectionError extends Error { }      // 후보 밖 코드·크기 위반·방식 불일치
export class SymbolIdentityConflictError extends Error { } // 표준코드 충돌·미검증 병합
export interface UniverseSnapshotSummary {
  readonly id: string; readonly sourceKind: 'KRX_HISTORICAL';
  readonly requestedDate: string; readonly effectiveTradingDate: string;
  readonly usableFromDate: string;
  readonly selectionMethod: 'TOP_MARKET_CAP_N' | 'MANUAL_FROM_KRX_SNAPSHOT';
  readonly selectionN: number | null; readonly selectedCount: number;
  readonly unknownMarketCapCount: number; readonly createdAtMs: number;
}
export interface UniverseSnapshotDetail extends UniverseSnapshotSummary {
  readonly symbols: ReadonlyArray<{
    readonly standardCode: string; readonly shortCode: string; readonly name: string;
    readonly market: 'KOSPI' | 'KOSDAQ'; readonly marketCapKrw: string | null; readonly rank: number | null;
  }>;
  readonly krxApprovalExpiryDate: string | null;
}
export class UniverseSnapshotService {
  constructor(private readonly deps: {
    readonly db: AppDatabase;
    readonly universe: HistoricalUniverseService;
    readonly clock: Clock;
    readonly audit: AuditLogService;
    readonly logger: Logger;
    readonly approvalExpiry: string | null;
  })
  async createFromPreview(args: {
    readonly previewId: string;
    readonly selectedStandardCodes: readonly string[];
    readonly selectionMethod: 'TOP_MARKET_CAP_N' | 'MANUAL_FROM_KRX_SNAPSHOT';
    readonly selectionN: number | null;
  }): Promise<UniverseSnapshotDetail>
  listSnapshots(): UniverseSnapshotSummary[]
  getSnapshot(id: string): UniverseSnapshotDetail | null
}
```

- [ ] **Step 1: 실패하는 테스트** — 실제 `openDatabase(':memory:')` + fake HistoricalUniverseService:

```ts
it('만료·부재 previewId 는 PreviewExpiredError — 조용히 새 결과로 저장하지 않는다', ...);
it('후보에 없는 표준코드는 SnapshotSelectionError 다', ...);
it('TOP_MARKET_CAP_N 은 unknown 이 있으면 거부한다', ...);
it('TOP_MARKET_CAP_N 은 선택이 정확히 상위 N 과 일치해야 한다', () => {
  // 상위 2 대신 1위·3위 → 거부. 클라이언트 주장을 서버가 재검증한다 (REVIEW §5.5)
});
it('선택 종목만 symbols 에 등록된다 — 미선택 후보는 등록되지 않는다', ...);
it('신규 종목은 standardCode 와 함께 market=KR 로 등록된다', ...);
it('기존 행의 standardCode 가 일치하면 재사용한다', ...);
it('기존 행이 다른 standardCode 면 SymbolIdentityConflictError 다', ...);
it('기존 행이 미매핑이고 현재 KRX 기본정보로 검증되면 백필 후 연결한다', ...);
it('미매핑이고 현재 정보로 검증할 수 없으면 등록을 차단한다', () => {
  // currentStandardCodeMap 에 없는 단축코드 (상장폐지 등) + 기존 미매핑 행 → 차단
});
it('스냅샷·종목 값 행·symbols 등록이 한 트랜잭션이다 — 중간 실패 시 아무것도 남지 않는다', ...);
it('종목 값 행이 당시 이름·시장·시가총액 원문·순위를 보존한다', ...);
it('selectionHash 가 canonical payload 와 선택 집합에서 결정적으로 나온다', ...);
it('감사 기록은 커밋 뒤 한 번 — universe.snapshot.created', ...);
it('1..1000 경계 — 0 개와 1001 개는 거부한다', ...);
it('저장 후 getSnapshot 이 값 그대로 돌려준다 — 스냅샷은 불변이다', ...);
```

- [ ] **Step 2: 실패 확인**
- [ ] **Step 3: 구현** — 순서(REVIEW §5.6 — 외부 조회를 끝낸 뒤 단일 트랜잭션):
  1. `preview = universe.getPreview(previewId)` — null → `PreviewExpiredError('미리보기가 만료되었거나 내용이 바뀌었습니다 — 다시 조회하세요.')`
  2. 선택 검증: 후보 Map 대조, 크기 1..1000(상수 인라인 — 스냅샷 전용 상한, 백테스트 상한 200은 제출 시 별도), `TOP_MARKET_CAP_N`이면 unknown 0 + 상위 N 정확 일치.
  3. 기존 `symbols` 행과 충돌 검사: 미매핑 행이 있으면 `currentStandardCodeMap()` 1회 조회(트랜잭션 밖).
  4. 단일 `db.transaction`: 신규 symbols insert(standardCode 포함, market 'KR', name = 당시 이름) / 검증된 백필 update / `universeSnapshots` insert(`newId('usn')`) / `universeSnapshotSymbols` insert(선택 종목별 값).
  5. 커밋 후 `audit.record('system', 'universe.snapshot.created', { snapshotId, effectiveTradingDate, selectedCount, selectionMethod })`.
  - `selectionHash = sha256(selectionPayloadOf(preview.set.canonicalPayload, selectedStandardCodes))`.
- [ ] **Step 4: 통과 확인 후 커밋** — `feat(market-data): 유니버스 스냅샷 저장 서비스를 단일 트랜잭션으로 추가한다`

---

### Task 11: 라우트와 배선

**Files:**
- Create: `src/server/modules/market-data/presentation/universe-routes.ts`
- Create: `src/shared/schemas/historical-universe.ts` (웹 공유 DTO)
- Modify: `src/server/bootstrap/container.ts`, `src/server/bootstrap/server.ts`
- Test: `tests/integration/universe-routes.test.ts`

**Interfaces:**
- Produces (HTTP, `/api/v1`, 전부 `requireAuth`, zod `safeParse` + `{ error }` 규약):
  - `GET /universe/historical/status` → `{ available, reason, approvalExpiry, todayCallCount }`
  - `POST /universe/historical/preview` body `{ date: 'YYYY-MM-DD' }` → 200 preview DTO | 400(날짜 형식·범위) | 409(미설정·만료) | 429(quota) | 502(계약)
  - `POST /universe/snapshots` body `{ previewId, standardCodes: string[](1..1000), selectionMethod, selectionN? }` → 201 `{ snapshot }` | 400 | 409(미리보기 만료·표준코드 충돌)
  - `GET /universe/snapshots` → `{ snapshots: UniverseSnapshotSummaryDto[] }`
  - `GET /universe/snapshots/:snapshotId` → `{ snapshot: UniverseSnapshotDetailDto }` | 404
- Produces (shared DTO, zod 없음): `HistoricalCandidateDto`(marketCapKrw는 문자열 — number 정밀도 회피), `HistoricalUniversePreviewDto`(previewId·두 날짜·counts·excludedByType·candidates·`attribution: '한국거래소 통계정보'`), `HistoricalUniverseStatusDto`, `UniverseSnapshotSummaryDto`, `UniverseSnapshotDetailDto`

- [ ] **Step 1: 실패하는 통합 테스트** — `createTestApp` + `tests/helpers/krx-fixtures.ts`의 **fake KRX HTTP 서버**(Fastify로 4 경로 서빙, basDd별 canned 응답, 수신 기록; `KRX_BASE_URL`을 fake 주소로 주입):

```ts
it('키 미설정이면 status.available=false 고 preview 는 409 다 — 외부 호출 없음', ...);
it('미리보기는 DB 에 아무것도 쓰지 않는다', () => {
  // preview 200 후 symbols·universe_snapshots 카운트 0 (REVIEW §5.3)
});
it('휴장일 기준일은 이전 거래일로 해소되고 두 날짜가 응답에 있다', ...);
it('스냅샷 저장이 universe_snapshots·값 행·symbols 등록을 만든다', ...);
it('만료 previewId 저장은 409 와 재조회 안내다', ...);
it('한 시장 실패 시 502 고 이후 DB 상태가 깨끗하다', ...);
it('저장한 스냅샷을 목록·상세로 조회한다', ...);
it('미인증 요청은 전부 401 이다', ...);
```

- [ ] **Step 2: 실패 확인**
- [ ] **Step 3: 구현** — `registerUniverseRoutes(app, historicalUniverseService, universeSnapshotService, requireAuth)` positional 주입. 오류 매핑: `HistoricalUniverseDateError` → 400, `KrxNotConfiguredError`·`KrxApprovalExpiredError`·`PreviewExpiredError`·`SymbolIdentityConflictError` → 409, `KrxQuotaError` → 429, `KrxContractError`·`UniverseJoinError`·`UnknownKrxClassificationError` → 502(`'KRX 응답이 예상 계약과 다릅니다 — 로그를 확인하세요.'`, 원문 미노출). BigInt → 문자열 변환은 DTO 경계에서. `container.ts`: source(`config.krxApiKey ? {...} : null`) → `HistoricalUniverseService`(configured 주입) → `UniverseSnapshotService`, `Container`에 추가. `server.ts` 등록.
- [ ] **Step 4: 통과 확인 후 커밋** — `feat(api): 유니버스 status·preview·snapshot 라우트를 추가한다`

---

### Task 12: 백테스트 계약 — datasetId xor universeSnapshotId·게이트·pin

**Files:**
- Modify: `src/shared/schemas/backtest-request.ts`
- Modify: `src/server/modules/backtest/presentation/backtest-routes.ts`
- Modify: `src/server/modules/backtest/application/job-queue.ts`
- Modify: `src/workers/backtest-child.ts`
- Modify: run 상세 응답 경로(결과 서비스/라우트) — `provenancePin` 포함
- Test: `tests/unit/backtest-request.test.ts`(확장), `tests/integration/backtest-universe-snapshot.test.ts`

**Interfaces:**
- Produces (request 계약): `datasetId: z.string().min(1).optional()`, `universeSnapshotId: z.string().min(1).optional()`, `.refine(정확히 하나)` — 저장된 레거시 요청(datasetId만)은 그대로 파싱된다.
- Produces (pin JSON — 서버 소유):

```ts
export interface ProvenancePin {
  readonly sourceKind: 'KRX_HISTORICAL' | 'DATASET';
  readonly universeSnapshotId: string | null;
  readonly requestedDate: string | null;
  readonly effectiveTradingDate: string | null;
  readonly usableFromDate: string | null;
  readonly filterPolicyVersion: string | null;
  readonly selectionMethod: string | null;
  readonly selectionHash: string | null;
  readonly krxApprovalExpiryDate: string | null;
  readonly approvalValidAtSubmit: boolean | null;
  readonly timepointWarning: string | null;   // 시점 불명 데이터셋 경고 등, null 이면 없음
  readonly symbols: ReadonlyArray<{
    readonly standardCode: string; readonly shortCode: string; readonly name: string;
    readonly market: string; readonly marketCapKrw: string | null; readonly rank: number | null;
  }> | null;                                   // KRX 스냅샷일 때만
}
```

- [ ] **Step 1: 실패하는 테스트**

단위: xor 검증(둘 다·둘 다 없음 → 실패), 레거시 datasetId 단독 통과, `universeSnapshotId` 단독 통과.

통합(`backtest-universe-snapshot.test.ts` — seed 스냅샷은 서비스로 생성):

```ts
it('스냅샷 경로: universe.symbols 가 스냅샷 구성과 다르면 400 이다', ...);
it('적용일 >= period.from 은 두 날짜와 해결책을 담아 400 이다', () => {
  // '적용일 X는 시작일 Y보다 이전이어야 합니다. 더 이른 스냅샷을 선택하거나 시작일을 늦추세요'
});
it('적용일 == 시작일도 차단한다 — 종가 정보는 그날 세션 시작에 알 수 없다', ...);
it('적용일 < 시작일이고 데이터가 있으면 통과한다', ...);
it('KRX 승인 만료 후 스냅샷 기반 신규 실행은 차단된다', ...);
it('기간 내 가격 데이터가 전혀 없는 스냅샷 종목이 있으면 코드를 나열하며 차단한다', () => {
  // 일부만 조용히 제외하면 생존 편향 재발 (REVIEW §9.1)
});
it('200 종목 초과 유니버스는 기존 정책대로 차단한다', ...);
it('없는 snapshotId 는 404 다', ...);
it('job 에 universeSnapshotId·서버 소유 pin 이 저장되고 run 에 복사된다', ...);
it('pin 의 종목 버전 스냅샷이 스냅샷 구성 종목만 커버한다', ...);
it('데이터셋 경로는 기존 검증을 유지하고 pin.sourceKind=DATASET·시점 불명 경고를 남긴다', ...);
it('clone: 스냅샷이 삭제(부재)면 명확한 오류로 차단한다', ...);
```

- [ ] **Step 2: 실패 확인**
- [ ] **Step 3: 구현**
  - `validateSubmission` 분기: `universeSnapshotId` 경로는 `universeSnapshotService.getSnapshot`으로 해소 — 404, `universe.symbols`(정렬)와 스냅샷 shortCode 집합 정확 일치, 적용일 게이트(`effectiveTradingDate >= period.from` 차단, 문구는 위 테스트), 승인 만료 게이트(config 만료일 기준), 종목별 기간 교집합 커버리지 존재 검사(`symbolService.getCoverage`), timeframe 해소는 기존 커버리지 로직 재사용, 버전 pin은 `datasets.universeSnapshotFor(codes, slice)`(Task 9 — DatasetService의 코드 기반 메서드라 데이터셋 무관).
  - 데이터셋 경로: 기존 검증 그대로 + pin(sourceKind DATASET, timepointWarning `'이 데이터셋은 과거 시점 적합성을 확인할 수 없습니다 — 현재 등록 종목 기준일 수 있습니다.'`).
  - pin 조립은 서버에서만. `queue.enqueue(request, pinnedUniverse, provenancePin, universeSnapshotId?)` — 새 컬럼 저장.
  - `backtest-child.ts`: run에 `provenancePinJson` 복사, `timepointWarning` 있으면 `datasetWarnings`에 추가.
  - clone(433–478행): 요청에 universeSnapshotId 있으면 스냅샷 존재 재검증(부재 → blocker). clone-draft에도 동일 정보.
  - run 상세 응답에 `provenancePin`(파싱 객체) 추가.
- [ ] **Step 4: 통과 확인** — 기존 backtest 통합 테스트 갱신 포함 `pnpm test`
- [ ] **Step 5: 커밋** — `feat(backtest): 유니버스 스냅샷 참조와 시점 게이트·서버 소유 pin 을 추가한다`

---

### Task 13: 웹 — 위저드 2단계 KRX 모드

**Files:**
- Create: `src/web/lib/use-historical-universe.ts`
- Create: `src/web/features/backtests/krx-selection.ts` (순수 로직)
- Create: `src/web/features/backtests/krx-snapshot-step.tsx`
- Modify: `src/web/features/backtests/new-backtest-wizard.tsx`, `wizard-steps.ts`, `types.ts`
- Test: `tests/unit/krx-selection.test.ts`, `tests/unit/wizard-steps.test.ts`(갱신)

**Interfaces:**
- Produces:

```ts
// use-historical-universe.ts
export function useHistoricalUniverseStatus(): { status: HistoricalUniverseStatusDto | null; isLoading: boolean }
// queryKey ['universe','historical','status'], staleTime 60_000
export function useUniverseSnapshots(): { snapshots: readonly UniverseSnapshotSummaryDto[]; ... }
// queryKey ['universe','snapshots']

// krx-selection.ts
export function topNCodes(candidates: readonly HistoricalCandidateDto[], n: number): readonly string[]
export function selectionMethodOf(selected: ReadonlySet<string>, candidates: readonly HistoricalCandidateDto[], n: number):
  'TOP_MARKET_CAP_N' | 'MANUAL_FROM_KRX_SNAPSHOT'
```

- `KrxSnapshotStep` 컴포넌트: preview mutation → 후보 목록(검색·페이징·상위 N 버튼·수동 체크·unknown 경고) → `POST /universe/snapshots` → `onSnapshotReady(snapshot: UniverseSnapshotDetailDto)`; 기존 스냅샷 재사용 목록 포함.
- 위저드 상태: `universeMode: 'DATASET' | 'KRX_SNAPSHOT'`, `selectedSnapshot: UniverseSnapshotDetailDto | null`. `buildRequest()`: KRX 모드면 `universeSnapshotId` + `universe.symbols = snapshot.symbols.map(s => s.shortCode)`, `datasetId` 생략.

- [ ] **Step 1: 실패하는 테스트** — `krx-selection.ts`: 상위 N 추출(rank 기준), 선택이 정확히 상위 N이면 TOP 판별, 수동 변경 시 MANUAL, 검색·페이지 변경과 무관한 Set 유지. `wizard-steps.ts` 게이트: 스냅샷 모드에서 datasetId 없이 스냅샷으로 통과, 200 초과 차단 유지.
- [ ] **Step 2: 실패 확인 후 구현** — UI(REVIEW §8.1 준용):
  - 2단계에 모드 토글(shadcn Tabs): `데이터셋` / `과거 KRX 시점`.
  - KRX 탭: status.available=false면 컨트롤 비활성 + 이유 **상시** 표시(D-027). 활성 시 `<Input type="date">` → 조회 → 요약(요청→적용 두 날짜, 원시/보통주/제외/unknown 수, `출처: 한국거래소 통계정보`) → 후보 목록(`filterSymbols`·`Pagination`·`PageSizeInput` 재사용, `SymbolCheckList`는 재사용하지 않음) → `시가총액 상위 200종목 선택`(unknown>0이면 `aria-disabled`+title 이유) → `스냅샷 확정`.
  - 시가총액 표시는 `formatCompactNumber(Number(marketCapKrw))` — 표시만 반올림, 순위는 서버 값.
  - 선택 > 200이면 확정은 허용하되 `'현재 백테스트 상한 200종목을 초과합니다'` 상시 표시(제출은 서버가 차단).
  - 스냅샷 확정 후 요약 카드(적용일·종목 수·`고정 유니버스`) 표시, 기존 스냅샷 목록에서 재선택 가능.
  - timeframe 해소: 스냅샷 shortCode 목록으로 기존 커버리지 훅 재사용.
- [ ] **Step 3: 검증** — `pnpm typecheck && pnpm lint && pnpm test`
- [ ] **Step 4: 커밋** — `feat(web): 백테스트 위저드에 과거 KRX 시점 유니버스 모드를 추가한다`

---

### Task 14: 웹 — 검토·결과 화면 문구

**Files:**
- Create: `src/web/features/backtests/universe-provenance.ts` (문구 순수 함수)
- Modify: `src/web/features/backtests/new-backtest-wizard.tsx` (검토 단계)
- Modify: `src/web/features/backtests/backtest-detail-page.tsx` (RunMetadataCard 479–504행·안내문)
- Test: `tests/unit/universe-provenance-label.test.ts`

**Interfaces:**
- Produces: `provenanceNotice(pin: ProvenancePinDto | null): { badges: string[]; sentence: string | null; warning: string | null }`

- [ ] **Step 1: 실패하는 테스트** — 문구 규칙(REVIEW §9.3 원문 그대로, 합쇼체):

```ts
it('KRX 스냅샷 실행은 고정 유니버스 문장을 만든다', () => {
  // '이 실행은 2024-12-30의 KRX 종목·시가총액으로 구성한 고정 유니버스를 전체 기간에 사용했습니다. ...'
});
it('데이터셋 실행은 시점 확인 불가 경고를 만든다', ...);
it('배지: KRX {적용일} 기준·고정 유니버스', ...);
it('생존자 편향 제거 문구는 어디에도 없다', () => {
  // provenanceNotice 결과 문자열에 '생존자 편향 제거' 부재를 명시적으로 확인
});
```

- [ ] **Step 2: 실패 확인 후 구현**
  - 위저드 검토 단계: 선택 스냅샷의 적용일·종목 수·`고정 유니버스` 배지 + usableFrom 안내. 서버 400 메시지는 기존 스텝 오류 Alert로 노출.
  - 결과 페이지: run의 `provenancePin`으로 RunMetadataCard에 `['유니버스 출처', 'KRX 2024-12-30 스냅샷' | '데이터셋']`, `['적용 거래일', ...]`, `['선정 방식', ...]` 행 추가. 카드 위 안내문(§9.3 문장). `출처: 한국거래소 통계정보` 표기.
- [ ] **Step 3: 검증 후 커밋** — `feat(web): 백테스트 검토·결과에 유니버스 시점 문구를 표시한다`

---

### Task 15: E2E

**Files:**
- Modify: `scripts/e2e-server.ts` — fake KRX Fastify 서버(127.0.0.1:3101) 기동, `KRX_API_KEY: 'e2e-krx-key'`·`KRX_BASE_URL` 주입. fixture: 2024-12-30 거래일(2025-01-01 빈 응답), KOSPI에 005930(삼성전자, 보통주, 1위) + 우선주 1 + 상장폐지 가정 종목 1(가격 데이터 없음), KOSDAQ에 보통주 1 + 스팩 1.
- Create: `tests/e2e/krx-universe.spec.ts`

- [ ] **Step 1: 시나리오** (REVIEW §11.3 준용, 상태 복원 관례):

```
1) 위저드 2단계 KRX 모드: 2025-01-01 조회 → '요청 2025-01-01 → 적용 2024-12-30',
   보통주 수·제외 수·출처 문구 표시
2) 상위 N 선택 → 검색 후 선택 유지 → 005930 만 남기고 수동 해제 → 스냅샷 확정
3) 시작일 2024-12-30(적용일과 같음) → 제출 차단, 두 날짜+해결책 문구 확인
4) 시작일을 뒤로 → 제출 성공 → 결과 화면에 고정 유니버스 문구·적용일 표시
5) 가격 없는 종목 포함 스냅샷 → 제출 차단에 코드 나열 확인
6) 정리: 생성한 리소스 정돈 (등록된 종목 제거 등 상태 복원)
```

키 없는 잠금 상태는 통합 테스트가 담당(단일 e2e 서버 구성) — spec 주석으로 남긴다.

- [ ] **Step 2: 실행** — `pnpm test:e2e` (desktop·mobile)
- [ ] **Step 3: 커밋** — `test(e2e): KRX 과거 유니버스 위저드 흐름을 검증한다`

---

### Task 16: smoke script와 문서

**Files:**
- Create: `scripts/krx-smoke.ts`
- Modify: `docs/DECISIONS.md`(D-040), `docs/SPEC.md` §12 테이블 목록, `docs/reviews/HISTORICAL_UNIVERSE_SNAPSHOT_REVIEW.md` 상태 갱신

- [ ] **Step 1: smoke script** — `pnpm exec tsx scripts/krx-smoke.ts --date 2016-01-04 --years 2010,2015,2020,2025`. `KRX_API_KEY` 필수. 수행(REVIEW §11.4):
  1. 네 API 원문 필드 목록 vs 계약 v1 기대 대조
  2. 상장폐지 종목 포함 확인(예: 2016-01-04의 한진해운 117930)
  3. 연도별 SECUGRP_NM·KIND_STKCERT_TP_NM·SECT_TP_NM 고유값 vs 필터 allowlist 대조, 미지값 나열
  4. 일별 ISU_CD ↔ 기본 ISU_SRT_CD 조인 무결성(미조인·중복 수)
  5. 휴장일·과거일·최근 공개일 각 1회 조회 요약
  6. 총 호출 수 출력
  실패 항목 있으면 exit 1 — **통과 전 실서비스 사용을 열지 않는다.**
- [ ] **Step 2: 문서**
  - `DECISIONS.md` D-040: 과거 시점 고정 유니버스 — **실행 종속 소유 모델**(사용자 결정 2026-08-03, REVIEW §7 데이터셋 결합안을 대체), 불변 스냅샷·값 스냅샷·서버 소유 pin·부분 유니버스 pin 버그 제거·필터 정책 버전제.
  - `SPEC.md` §12 테이블 목록에 `universe_snapshots`·`universe_snapshot_symbols`, `symbols.standard_code`·`backtest_jobs.universe_snapshot_id` 언급.
  - REVIEW 헤더 상태: `구현 완료(v2 실행 종속 모델) — smoke test 게이트 대기` + 소유 모델 변경 각주.
- [ ] **Step 3: 전체 검증** — `pnpm test && pnpm typecheck && pnpm lint && pnpm test:e2e`
- [ ] **Step 4: 커밋** — `docs: KRX 과거 유니버스 결정 기록과 smoke test 절차를 추가한다`

---

## 완료 판정 대조 (REVIEW §14, v2 소유 모델 반영)

| 항목 | 담당 태스크 |
| --- | --- |
| 과거 달력일로 후보 조회 | 8, 11, 13 |
| 휴장일 해소·두 날짜 표시 | 8, 13, 14 |
| 서버 결정적 순위·null≠0 | 6 |
| unknown 시 자동 top-N 금지 | 6, 10, 13 |
| 선택 종목만 등록·스냅샷 보존 | 10 |
| 적용일 ≥ 시작일 차단 | 12 |
| 실행 종목·버전·provenance 원자 고정 | 12 |
| 종목/스냅샷 삭제 후에도 값으로 남는 실행 근거 | 2, 12 |
| 가격 없는 종목 조용한 제외 금지 | 12 |
| 고정 유니버스 문구·편향 제거 주장 금지 | 14 |
| 키 미노출 | 1, 7, 10 |
| 양 시장 부분 실패 차단 | 8 |
| 실응답 분류 검증·출처 표기 | 13, 16 |
| 승인 기간·범위 위반 차단 | 1, 7, 12 |
| (v2) 수동 편집 이력 표시 | 해당 없음 — 스냅샷 불변, 수정 = 새 스냅샷 |

## 남은 외부 게이트 (코드로 해소 불가)

1. KOSPI·KOSDAQ 기본·일별 네 서비스의 KRX 이용 승인 완료 여부 확인 (REVIEW §12-2)
2. `scripts/krx-smoke.ts` 실행과 분류 필터 입증 (REVIEW §12-4)
3. 비상업 약관 범위·로컬 저장·만료 후 처리의 KRX 확인 (REVIEW §12-5·6)
