# KRX 과거 시점 고정 유니버스 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 사용자가 과거 기준일의 KRX KOSPI·KOSDAQ 보통주를 시가총액순으로 조회해 고정 유니버스 데이터셋을 만들고, 그 선정 근거(provenance)를 백테스트 실행까지 원자적으로 고정한다.

**Architecture:** `docs/reviews/HISTORICAL_UNIVERSE_SNAPSHOT_REVIEW.md`가 확정한 설계를 그대로 구현한다. 스키마 → KRX 어댑터(`KrxHistoricalUniverseSource`) → 애플리케이션 서비스(`HistoricalUniverseService`, 저장 조정자) → API/UI → 백테스트 검증 순서다. KRX API 호출은 서버 전용이고, 브라우저는 불투명 `snapshotId`와 표준코드 목록만 보낸다.

**Tech Stack:** Fastify 5 + zod v4 + drizzle(better-sqlite3, 동기) + React 19 + TanStack Query v5 + vitest 4 + playwright.

## Global Constraints

- 작업 위치: `C:\Work\trading-webapp\.claude\worktrees\krx-historical-universe` (브랜치 `worktree-krx-historical-universe`, main `ead5f57` 기반). 원본 저장소 루트로 이동하지 않는다.
- 스펙 문서: `docs/reviews/HISTORICAL_UNIVERSE_SNAPSHOT_REVIEW.md` (이하 REVIEW). 충돌 시 REVIEW가 이긴다.
- 검증 명령: `pnpm test`, `pnpm typecheck`, `pnpm lint`. 각 태스크 커밋 전 셋 다 통과해야 한다. baseline: 84 파일 828 테스트 통과.
- 마이그레이션은 손으로 쓰지 않는다. `src/server/shared/db/schema.ts` 수정 후 `pnpm db:generate`로 `migrations/0001_*.sql`을 생성한다. `0000` 재스쿼시 금지(D-015).
- 아키텍처 규칙(.dependency-cruiser.cjs, `tests/architecture`가 강제): domain은 framework·Node 내장 모듈 import 금지, `market-data → broker`·`market-data → facts` 금지, `src/web → src/server` 금지. 웹과 공유하는 타입·상수는 `src/shared/schemas/`에 zod 없이 둔다.
- 시간은 항상 `Clock` 주입(`src/server/shared/clock.ts`), epoch ms. KST는 고정 오프셋 +540분(`exchange-session.ts` 방식)으로 계산하고 `Date` 로컬 메서드를 쓰지 않는다.
- KRX 인증키는 서버 환경변수에서만 읽는다. 브라우저 응답·DB·감사 로그·오류 메시지에 절대 넣지 않는다(REVIEW §10). `audit.record`의 detail은 pino 로그로 spread되므로 키를 넣으면 안 된다.
- KRX 숫자는 문자열이다. 빈 문자열·`-`는 nullable 필드에서만 null, 비정수·음수·64비트 초과는 계약 오류. null을 0으로 바꾸지 않는다.
- 시가총액 원문은 원 단위 정수 문자열로 보존하고, 정렬·순위는 BigInt로 계산한다.
- 서비스 오류 메시지는 한국어 합쇼체, 코드 주석·문서는 문어체 평서형(CLAUDE.md).
- 커밋 메시지는 기존 관례(`feat(scope): ...한다`)를 따르고 다음 트레일러를 붙인다:
  `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>` / `Claude-Session: https://claude.ai/code/session_01HNVm7vrUNNVQUb8acXMQ2F`
- 기능 게이트: KRX 실응답 분류 검증(REVIEW §11.4)은 코드로 대체할 수 없다. Task 16의 smoke script를 실행해 통과하기 전까지 이 기능은 "키가 있으면 열리는" 상태로 두되, smoke 결과가 필터 계약을 깨면 필터 정책을 갱신해야 한다.
- KRX 공식 필드명(ISU_CD·ISU_SRT_CD·MKTCAP 등)과 URL 경로는 계약 버전 `v1`의 가정이다. smoke test에서 불일치가 나오면 `krx-contract.ts` 한 파일만 고치면 되도록 어댑터 밖으로 새지 않게 한다.

## File Map

**Create:**
- `src/server/modules/market-data/domain/kst-date.ts` — KST 달력일 순수 함수
- `src/server/modules/market-data/domain/krx-filter-policy.ts` — 보통주 분류 정책 v1
- `src/server/modules/market-data/domain/historical-universe.ts` — 조인·순위·해시 순수 로직
- `src/server/modules/market-data/infrastructure/krx/krx-contract.ts` — KRX 응답 계약(zod)과 숫자 파서
- `src/server/modules/market-data/infrastructure/krx/krx-historical-universe-source.ts` — 어댑터
- `src/server/modules/market-data/application/historical-universe-service.ts` — 날짜 해소·캐시·미리보기
- `src/server/modules/market-data/application/historical-dataset-service.ts` — 저장 조정자(단일 트랜잭션)
- `src/server/modules/market-data/presentation/universe-routes.ts` — status/preview/스냅샷 저장 라우트
- `src/shared/schemas/historical-universe.ts` — 웹 공유 DTO(zod 없음)
- `src/shared/schemas/dataset-limit.ts` — `MAX_DATASET_SYMBOLS = 1000`
- `src/web/lib/use-historical-universe.ts` — status/preview 훅
- `src/web/features/datasets/krx-snapshot-picker.tsx` — 과거 후보 조회·선택 UI
- `src/web/features/datasets/dataset-provenance-badge.tsx` — 출처 배지
- `tests/helpers/krx-fixtures.ts` — KRX 응답 fixture 빌더 + fake KRX 서버
- `scripts/krx-smoke.ts` — 인증키 발급 후 수동 smoke test
- 단위·통합·E2E 테스트 파일 (각 태스크에 명시)

**Modify:**
- `src/server/bootstrap/config.ts` — `KRX_BASE_URL`/`KRX_API_KEY`/`KRX_APPROVAL_EXPIRY`
- `src/server/shared/logger.ts` — `AUTH_KEY` redaction
- `src/server/shared/db/schema.ts` — provenance·선정 스냅샷 테이블, `datasets.membership_revision`, `symbols.standard_code`, `backtest_jobs/runs.provenance_pin_json`
- `src/server/modules/market-data/application/ports.ts` — KRX 포트·오류 타입
- `src/server/modules/market-data/application/dataset-service.ts` — revision·1..1000 불변식·수동 수정 표시·provenance 요약
- `src/server/modules/market-data/application/symbol-service.ts` — 전역 종목 제거 시 수동 수정 표시
- `src/server/modules/backtest/presentation/backtest-routes.ts` — 제출 게이트·pin
- `src/server/modules/backtest/application/job-queue.ts` — `provenancePin` 저장
- `src/workers/backtest-child.ts` — pin 복사·경고 문구
- `src/shared/schemas/backtest-request.ts` — `expectedMembershipRevision`
- `src/server/bootstrap/container.ts`, `src/server/bootstrap/server.ts` — 배선
- `src/web/features/datasets/datasets-panel.tsx` — 생성 다이얼로그 모드 분기, 카드 배지
- `src/web/features/datasets/symbol-types.ts` — DatasetSummary 확장
- `src/web/features/backtests/new-backtest-wizard.tsx` — revision 토큰·시점 경고
- `src/web/features/backtests/backtest-detail-page.tsx` — 고정 유니버스 문구·pin 표시
- `scripts/e2e-server.ts` — fake KRX 기동
- `tests/e2e/mvp-flow.spec.ts` 또는 신규 spec — E2E
- `infra/app.env.example`, `docs/DECISIONS.md`(D-040), `docs/SPEC.md` §12 테이블 목록

---

### Task 1: KRX 환경변수와 로그 redaction

**Files:**
- Modify: `src/server/bootstrap/config.ts` (envSchema 35–43행 부근, AppConfig, loadConfig 매핑)
- Modify: `src/server/shared/logger.ts` (REDACT_PATHS 5–32행)
- Modify: `infra/app.env.example` (DART 블록 38–45행 뒤에 KRX 블록)
- Test: `tests/unit/config.test.ts`

**Interfaces:**
- Produces: `AppConfig.krxBaseUrl: string`, `AppConfig.krxApiKey: string | null`, `AppConfig.krxApprovalExpiry: string | null`

- [ ] **Step 1: 실패하는 테스트 작성** — `tests/unit/config.test.ts`에 추가:

```ts
describe('KRX 설정', () => {
  it('미설정이면 krxApiKey 는 null 이고 기본 base URL 을 쓴다', () => {
    const config = loadConfig({});
    expect(config.krxApiKey).toBeNull();
    expect(config.krxBaseUrl).toBe('https://data-dx.krx.co.kr');
    expect(config.krxApprovalExpiry).toBeNull();
  });

  it('만료일 형식이 틀리면 ConfigError 다', () => {
    expect(() => loadConfig({ KRX_API_KEY: 'k', KRX_APPROVAL_EXPIRY: '2027/08/03' })).toThrow(ConfigError);
  });

  it('만료일만 있고 키가 없으면 ConfigError 다 — 반쪽 설정은 즉시 실패', () => {
    expect(() => loadConfig({ KRX_APPROVAL_EXPIRY: '2027-08-03' })).toThrow(ConfigError);
  });
});
```

- [ ] **Step 2: 실패 확인** — `pnpm exec vitest run tests/unit/config.test.ts` → krxApiKey undefined 로 FAIL
- [ ] **Step 3: 구현**

`config.ts` envSchema의 DART 블록 아래:

```ts
/** KRX Open API (정보데이터시스템). 미설정이면 과거 유니버스 모드가 비활성 — 다른 데이터 경로는 영향 없다 */
KRX_BASE_URL: z.string().url().default('https://data-dx.krx.co.kr'),
KRX_API_KEY: z.string().min(1).optional(),
/** KRX 이용 승인 만료일. 지나면 과거 유니버스 조회·신규 실행을 막는다 (REVIEW §10) */
KRX_APPROVAL_EXPIRY: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
```

`AppConfig`에 `readonly krxBaseUrl: string; readonly krxApiKey: string | null; readonly krxApprovalExpiry: string | null;` 추가. 매핑은 `?? null`. cross-field 검증(92–99행 스타일):

```ts
if (raw.KRX_APPROVAL_EXPIRY && !raw.KRX_API_KEY) {
  // 만료일만 있는 설정은 키를 설정했다고 착각한 상태다 — 즉시 실패
  throw new ConfigError('KRX_APPROVAL_EXPIRY 는 KRX_API_KEY 와 함께 설정해야 합니다');
}
```

`logger.ts` REDACT_PATHS에 `'AUTH_KEY'`, `'auth_key'`, `'*.AUTH_KEY'`, `'*.auth_key'`, `'apiKey'`, `'*.apiKey'` 추가.

`infra/app.env.example`에 DART 블록과 같은 형식으로 KRX 3개 변수 문서화(빈 값 ≠ 미설정, 재시작 필요).

- [ ] **Step 4: 통과 확인** — `pnpm exec vitest run tests/unit/config.test.ts`
- [ ] **Step 5: 커밋** — `feat(config): KRX Open API 인증키·승인 만료일 설정을 추가한다`

---

### Task 2: 스키마 — provenance·선정 스냅샷·revision·표준코드·pin

**Files:**
- Modify: `src/server/shared/db/schema.ts`
- Create: `src/shared/schemas/dataset-limit.ts`
- Generate: `migrations/0001_*.sql` (`pnpm db:generate`)
- Test: `tests/integration/universe-provenance-schema.test.ts`

**Interfaces:**
- Produces: 테이블 `datasetUniverseProvenance`, `datasetSelectionSnapshots`; 컬럼 `datasets.membershipRevision`, `symbols.standardCode`, `backtestJobs.provenancePinJson`, `backtestRuns.provenancePinJson`; 상수 `MAX_DATASET_SYMBOLS = 1000`

- [ ] **Step 1: 실패하는 테스트** — `tests/integration/universe-provenance-schema.test.ts` (`dataset-slice-schema.test.ts`의 mkdtemp 패턴):

```ts
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openDatabase, type DatabaseHandle } from '../../src/server/shared/db/database.js';
import {
  datasets, datasetSelectionSnapshots, datasetUniverseProvenance, symbols,
} from '../../src/server/shared/db/schema.js';

describe('universe provenance 스키마', () => {
  let dir: string;
  let handle: DatabaseHandle;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'uvp-schema-'));
    handle = openDatabase(join(dir, 'test.sqlite'));
  });
  afterAll(() => { handle.close(); rmSync(dir, { recursive: true, force: true }); });

  it('datasets 는 membership_revision 기본값 1 을 가진다', () => {
    handle.db.insert(datasets).values({ id: 'ds_x', name: 'x', createdAtMs: 1, updatedAtMs: 1 }).run();
    const row = handle.db.select().from(datasets).all()[0]!;
    expect(row.membershipRevision).toBe(1);
  });

  it('선정 스냅샷은 symbols 삭제에 cascade 되지 않는 값 스냅샷이다', () => {
    handle.db.insert(symbols).values({ code: '005930', market: 'KR', name: null, createdAtMs: 1, standardCode: 'KR7005930003' }).run();
    handle.db.insert(datasetUniverseProvenance).values({
      id: 'uvp_1', datasetId: 'ds_x', sourceKind: 'KRX_HISTORICAL_SNAPSHOT',
      requestedDate: '2025-01-01', effectiveTradingDate: '2024-12-30',
      usableFromDate: '2024-12-31', usableFromRule: 'NEXT_SESSION_CONSERVATIVE_V1',
      marketsJson: '["KOSPI","KOSDAQ"]', filterPolicyVersion: 'krx-common-stock-v1', contractVersion: 'v1',
      sortKey: 'MKTCAP', sortDirection: 'DESC', selectionMethod: 'TOP_MARKET_CAP_N', selectionN: 200,
      selectedCount: 1, eligibleCount: 900, excludedByTypeJson: '{}', unknownMarketCapCount: 0,
      selectionHash: 'h1', candidateCanonicalHash: 'h2', membershipRevisionAtCreation: 1,
      manuallyModified: false, firstManualChangeAtMs: null, krxApprovalExpiryDate: null, createdAtMs: 1,
    }).run();
    handle.db.insert(datasetSelectionSnapshots).values({
      provenanceId: 'uvp_1', standardCode: 'KR7005930003', shortCode: '005930',
      nameAtSelection: '삼성전자', marketAtSelection: 'KOSPI', effectiveTradingDate: '2024-12-30',
      marketCapKrw: '350000000000000', rank: 1, instrumentType: 'COMMON_STOCK',
    }).run();
    handle.db.delete(symbols).run();
    expect(handle.db.select().from(datasetSelectionSnapshots).all()).toHaveLength(1);
  });

  it('symbols.standard_code 는 unique 다', () => {
    handle.db.insert(symbols).values({ code: 'A', market: 'KR', name: null, createdAtMs: 1, standardCode: 'KR700A' }).run();
    expect(() =>
      handle.db.insert(symbols).values({ code: 'B', market: 'KR', name: null, createdAtMs: 1, standardCode: 'KR700A' }).run(),
    ).toThrow();
  });
});
```

- [ ] **Step 2: 실패 확인** — export 없음으로 FAIL
- [ ] **Step 3: 스키마 구현**

`src/shared/schemas/dataset-limit.ts` (universe-limit.ts와 같은 zod-free 형식):

```ts
/**
 * 데이터셋 최종 구성원 수의 상한. 생성·편집이 공유하는 쓰기 경계에서 강제한다
 * (HISTORICAL_UNIVERSE_SNAPSHOT_REVIEW §4.3). 상수만 따로 두는 이유는 zod 를
 * 웹 번들에 끌고 오지 않기 위해서다 (D-038 과 같은 방식).
 */
export const MAX_DATASET_SYMBOLS = 1000;
```

`schema.ts` 변경:

```ts
// symbols 에 추가 (81행 컬럼 뒤, 인덱스 배열에 uniqueIndex 추가)
/** KRX 표준코드(ISIN). 과거 스냅샷 등록 시에만 채워진다 — 단축코드 재사용을 구분하는 유일한 열쇠 */
standardCode: text('standard_code'),
// (table) => [ ..., uniqueIndex('idx_symbols_standard_code').on(table.standardCode) ]

// datasets 에 추가
/** 구성원 변경마다 1 증가. 백테스트 제출의 stale 화면 탐지 토큰 (REVIEW §9.1) */
membershipRevision: integer('membership_revision').notNull().default(1),

// backtestJobs / backtestRuns 에 각각 추가
/** 서버 소유 provenance pin (REVIEW §9.2). 클라이언트 입력이 아니다 */
provenancePinJson: text('provenance_pin_json'),
```

새 테이블 두 개 (기존 명명 관례 그대로):

```ts
/**
 * 데이터셋 유니버스 출처 (REVIEW §7.1). 행이 없으면 MANUAL_OR_LEGACY 다 —
 * 기존 데이터셋을 소급 추정하지 않기 위해 backfill 을 하지 않는다.
 */
export const datasetUniverseProvenance = sqliteTable('dataset_universe_provenance', {
  id: text('id').primaryKey(), // newId('uvp')
  datasetId: text('dataset_id').notNull().references(() => datasets.id, { onDelete: 'cascade' }),
  sourceKind: text('source_kind').notNull(), // 'KRX_HISTORICAL_SNAPSHOT' | 'CURRENT_REGISTERED'
  requestedDate: text('requested_date'),          // ISO, KRX 전용
  effectiveTradingDate: text('effective_trading_date'),
  usableFromDate: text('usable_from_date'),
  usableFromRule: text('usable_from_rule'),
  marketsJson: text('markets_json'),
  filterPolicyVersion: text('filter_policy_version'),
  contractVersion: text('contract_version'),
  sortKey: text('sort_key'),           // 'MKTCAP'
  sortDirection: text('sort_direction'), // 'DESC'
  selectionMethod: text('selection_method'), // 'TOP_MARKET_CAP_N' | 'MANUAL_FROM_KRX_SNAPSHOT'
  selectionN: integer('selection_n'),
  selectedCount: integer('selected_count').notNull(),
  eligibleCount: integer('eligible_count'),
  excludedByTypeJson: text('excluded_by_type_json'),
  unknownMarketCapCount: integer('unknown_market_cap_count'),
  selectionHash: text('selection_hash'),
  candidateCanonicalHash: text('candidate_canonical_hash'),
  membershipRevisionAtCreation: integer('membership_revision_at_creation').notNull(),
  manuallyModified: integer('manually_modified', { mode: 'boolean' }).notNull().default(false),
  firstManualChangeAtMs: integer('first_manual_change_at_ms'),
  krxApprovalExpiryDate: text('krx_approval_expiry_date'),
  createdAtMs: integer('created_at_ms').notNull(),
}, (table) => [uniqueIndex('idx_dataset_universe_provenance_dataset').on(table.datasetId)]);

/**
 * 원본 선정 종목의 값 스냅샷 (REVIEW §7.2). symbols 에 FK 를 걸지 않는다 —
 * 종목 삭제 뒤에도 실행 근거를 값으로 설명해야 한다 (backtest_trades.symbol 과 같은 선례).
 */
export const datasetSelectionSnapshots = sqliteTable('dataset_selection_snapshots', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  provenanceId: text('provenance_id').notNull()
    .references(() => datasetUniverseProvenance.id, { onDelete: 'cascade' }),
  standardCode: text('standard_code').notNull(),
  shortCode: text('short_code').notNull(),
  nameAtSelection: text('name_at_selection').notNull(),
  marketAtSelection: text('market_at_selection').notNull(), // 'KOSPI' | 'KOSDAQ'
  effectiveTradingDate: text('effective_trading_date').notNull(),
  /** 원 단위 정수 원문 문자열. null 은 unknown 이지 0 이 아니다 */
  marketCapKrw: text('market_cap_krw'),
  rank: integer('rank'),
  instrumentType: text('instrument_type').notNull(), // 'COMMON_STOCK'
}, (table) => [
  uniqueIndex('idx_dataset_selection_snapshots_prov_code').on(table.provenanceId, table.standardCode),
]);
```

- [ ] **Step 4: 마이그레이션 생성** — `pnpm db:generate` → `migrations/0001_*.sql` 확인 (`ALTER TABLE` add column + 새 테이블 + 인덱스만 있어야 한다. 테이블 재생성이 나오면 스키마 변경을 되돌리고 원인 제거)
- [ ] **Step 5: 통과 확인** — 대상 테스트 후 `pnpm test` 전체 (모든 DB 테스트가 새 마이그레이션을 자동 실행)
- [ ] **Step 6: 커밋** — `feat(db): 유니버스 provenance·선정 스냅샷 테이블과 membership revision 을 추가한다`

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
- Test: `tests/unit/krx-contract.test.ts`

**Interfaces:**
- Produces (ports.ts):

```ts
export type KrxMarket = 'KOSPI' | 'KOSDAQ';
export interface KrxIssueBaseInfoRow {
  readonly standardCode: string;   // 기본정보 ISU_CD (표준코드)
  readonly shortCode: string;      // ISU_SRT_CD
  readonly name: string;           // ISU_NM 원문
  readonly listedDate: string | null;    // LIST_DD → ISO, 없으면 null
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
export class KrxNotConfiguredError extends Error { /* name 지정, 안내 메시지 */ }
export class KrxApprovalExpiredError extends Error { }
export class KrxContractError extends Error { }
export class KrxQuotaError extends Error { /* retryAfterHint?: string */ }
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

(`baseInfoFixture`는 Task 후반에 만들 `tests/helpers/krx-fixtures.ts`의 빌더를 이 태스크에서 먼저 최소 형태로 만든다.)

- [ ] **Step 2: 실패 확인**
- [ ] **Step 3: 구현** — zod `.loose()` 객체로 필수 필드만 고정하고 나머지는 통과. `LIST_DD`는 8자리 숫자면 `basDdToIso`, 아니면 null. `KrxContractError` 메시지에 필드명·원인 포함(값 원문은 짧게 자른다). `parseNullableInt64`:

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
  constructor(readonly field: string, readonly value: string, readonly shortCode: string) { ... }
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
- [ ] **Step 3: 구현** — allowlist 방식. 판정 순서: 증권그룹 → (주권일 때) SPAC 판정(소속부 `includes('SPAC')` 우선, 이름 `includes('스팩')` 보조 — 보조 규칙은 주석에 smoke 게이트 명시) → 주식종류. 알려진 값 밖은 전부 `UnknownKrxClassificationError`. 파일 헤더 주석에 "이 정책 버전은 fixture 로 검증했고 실응답 입증은 scripts/krx-smoke.ts 가 담당한다. 값 추가 시 버전을 올린다"를 적는다.
- [ ] **Step 4: 통과 확인 후 커밋** — `feat(market-data): KRX 보통주 필터 정책 v1 을 추가한다`

---

### Task 6: 조인·순위·canonical hash 도메인

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
export function selectionHashOf(canonicalHash: string, standardCodes: readonly string[]): string
```

- [ ] **Step 1: 실패하는 테스트** — REVIEW §4.3·§5·§11.1:

```ts
it('시가총액 내림차순, 동률은 단축코드 오름차순으로 완전순서를 만든다', ...);
it('unknown 시가총액은 0 이 되지 않고 rank null 로 뒤에 붙는다', ...);
it('기본정보에 없고 일별정보에만 있는 종목은 전체 실패다', () => {
  expect(() => combineMarketSnapshots({ ..., dailyRows: [dailyFixture({ ISU_CD: '999999' })] })).toThrow(UniverseJoinError);
});
it('단축코드 중복 조인은 전체 실패다', ...);
it('두 시장의 표준코드가 충돌하면 전체 실패다', ...);
it('제외 유형이 사유별로 집계된다', ...);
it('canonical hash 는 입력 순서와 무관하게 결정적이다', () => {
  const a = combineMarketSnapshots({ effectiveTradingDate: d, inputs: [kospi, kosdaq] });
  const b = combineMarketSnapshots({ effectiveTradingDate: d, inputs: [kosdaq, kospi] });
  expect(a.canonicalHash).toBe(b.canonicalHash);
});
it('구성이 하나라도 다르면 hash 가 다르다', ...);
```

- [ ] **Step 2: 실패 확인**
- [ ] **Step 3: 구현** — 시장별로 base를 shortCode 키 Map으로 만들고(중복 → `UniverseJoinError`), daily를 조인. daily에만 있으면 실패, base에만 있으면 marketCap null. `classifyKrxIssue`로 필터(UnknownKrxClassificationError는 그대로 전파). 정렬은 BigInt 비교. canonical hash 는 sha256(`${date}|${policyV}|${contractV}` + 정렬된 후보 라인들 `standardCode|shortCode|market|mktcap∥unknown`). `node:crypto`는 domain 금지이므로 — **주의**: dependency-cruiser가 domain의 Node 내장 모듈을 금지한다. 해시 계산은 순수 문자열 직렬화(`canonicalLinesOf(set): string`)까지만 domain에 두고, sha256 적용은 application 서비스에서 한다. 따라서 `UniverseCandidateSet.canonicalHash` 대신 `canonicalPayload: string`을 반환하고, 서비스가 `sha256(canonicalPayload)`를 붙이는 구조로 구현한다. 테스트도 payload 결정성 기준으로 작성.
- [ ] **Step 4: 통과 확인 후 커밋** — `feat(market-data): KRX 후보 조인·순위·정규화 도메인을 추가한다`

---

### Task 7: KRX 어댑터

**Files:**
- Create: `src/server/modules/market-data/infrastructure/krx/krx-historical-universe-source.ts`
- Create: `tests/helpers/krx-fixtures.ts` (fixture 빌더 확장 + fake fetch)
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
it('승인 만료일이 지나면 KrxApprovalExpiredError 를 던지고 외부 호출이 없다', () => {
  const fetchImpl = vi.fn();
  const source = createKrxHistoricalUniverseSource(
    { baseUrl: 'https://x', apiKey: 'k', approvalExpiry: '2026-08-01' },
    { now: () => Date.UTC(2026, 7, 3) }, logger, { fetchImpl });
  await expect(source.fetchDailyTrades('KOSPI', '2025-01-02')).rejects.toBeInstanceOf(KrxApprovalExpiredError);
  expect(fetchImpl).not.toHaveBeenCalled();
});
it('AUTH_KEY 헤더로 호출하고 URL 에 키가 없다', () => { /* fetchImpl 캡처로 헤더·URL 검증 */ });
it('시장별 경로가 다르다 — KOSPI stk_*, KOSDAQ ksq_*', ...);
it('OutBlock_1 을 포트 행으로 변환한다', ...);
it('429 소진 후 KrxQuotaError 로 구분해 던진다', ...);
it('호출마다 KST 일 기준 카운터가 올라가고 로그에 남는다', () => { /* todayCallCount() === 2, 로그 이벤트 krx.fetch */ });
it('인증키가 로그에 남지 않는다', () => { /* capturing logger 전체 직렬화에 'k' 부재 확인 — dart 테스트와 같은 방식 */ });
```

- [ ] **Step 2: 실패 확인**
- [ ] **Step 3: 구현**

```ts
const PATHS: Record<KrxMarket, { readonly base: string; readonly daily: string }> = {
  KOSPI: { base: '/svc/apis/sto/stk_isu_base_info', daily: '/svc/apis/sto/stk_bydd_trd' },
  KOSDAQ: { base: '/svc/apis/sto/ksq_isu_base_info', daily: '/svc/apis/sto/ksq_bydd_trd' },
};
```

- null config → 전 메서드 reject하는 inert 객체(toss L120–135 방식), `todayCallCount()`는 0.
- 호출 전 만료 검사: `config.approvalExpiry && kstDateOf(clock.now()) > config.approvalExpiry` → `KrxApprovalExpiredError`.
- `RestClient` tokenProvider 없이 생성, `groupMinIntervalMs: { default: 250 }`. 요청은 `request(group, \`${path}?basDd=${isoToBasDd(date)}\`, { headers: { AUTH_KEY: config.apiKey } })`.
- RestClient 실패 메시지가 `REST 요청 실패: 429`로 시작하면 `KrxQuotaError('KRX 일일 호출 한도 또는 속도 제한에 걸렸습니다 — 잠시 후 또는 다음 날 다시 시도하세요.')`로 변환. 상태 코드를 메시지에서 읽는 이유(RestClient가 구조화 오류를 주지 않음)를 주석으로 남긴다.
- 호출 카운터: `Map<string /* KST date */, number>` 하나만 유지(전일 키는 접근 시 제거). 매 호출 `logger.info({ module: 'market-data', event: 'krx.fetch', market, basDd, rows, callsToday }, 'krx fetch ok')`.
- 응답은 Task 4 파서로 변환하고, zod 실패·envelope 이상은 `KrxContractError`.

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
  readonly snapshotId: string;
  readonly requestedDate: string;
  readonly effectiveTradingDate: string;
  readonly usableFromDate: string;          // effective + 1 달력일
  readonly usableFromRule: 'NEXT_SESSION_CONSERVATIVE_V1';
  readonly canonicalHash: string;           // sha256(canonicalPayload)
  readonly set: UniverseCandidateSet;       // canonicalPayload 포함
  readonly fetchedAtMs: number;
}
export class HistoricalUniverseDateError extends Error {
  constructor(readonly code: 'BEFORE_EPOCH' | 'FUTURE_OR_UNPUBLISHED' | 'NO_TRADING_DAY_IN_RANGE', message: string)
}
export class SnapshotExpiredError extends Error { }
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
  getSnapshot(snapshotId: string): HistoricalUniversePreview | null   // 만료·부재 시 null
  async currentStandardCodeMap(): Promise<ReadonlyMap<string, string>> // shortCode → standardCode, 표준코드 검증·백필용
}
```

- [ ] **Step 1: 실패하는 테스트** — fake source(호출 기록 배열 + 날짜별 canned 응답)로:

```ts
it('키 미설정이면 available=false 와 이유를 준다', ...);
it('승인 만료면 available=false — 이유에 만료일 표시', ...);
it('2010-01-04 이전 요청은 BEFORE_EPOCH 로 차단한다', ...);
it('KST 어제보다 뒤는 FUTURE_OR_UNPUBLISHED 로 차단한다', ...);
it('KST 08시 전에는 어제 데이터도 공개 대기로 차단한다', () => {
  // clock = 2026-08-03T07:00 KST, requested 2026-08-02 → FUTURE_OR_UNPUBLISHED
});
it('주말 요청은 이전 거래일로 해소하고 두 날짜를 모두 반환한다', () => {
  // 일별 응답: 2025-01-01(수·휴장) 빈 배열 → 2024-12-31? ... fake 가 2024-12-30 에만 데이터
  // requestedDate 2025-01-01, effectiveTradingDate 2024-12-30
});
it('31일 안에 거래일이 없으면 NO_TRADING_DAY_IN_RANGE 다', ...);
it('KOSPI 는 성공했지만 KOSDAQ 이 그 날짜에 비어 있으면 전체 실패다 — 부분 후보군을 만들지 않는다', ...);
it('한 시장 호출이 실패하면 전체 실패고 캐시에 남지 않는다', () => {
  // 첫 호출 KOSDAQ reject → preview reject; 두 번째 호출은 다시 시도(오류 미캐시)
});
it('같은 요청일 동시 호출은 single-flight 로 합쳐진다', async () => {
  const [a, b] = await Promise.all([svc.preview('2025-01-02'), svc.preview('2025-01-02')]);
  expect(a.snapshotId).toBe(b.snapshotId);
  expect(fakeSource.calls.filter((c) => c.kind === 'daily')).toHaveLength(2); // 시장당 1회
});
it('같은 적용일 재조회는 캐시를 쓰고 TTL 이 지나면 다시 부른다', ...);
it('getSnapshot 은 TTL 만료 후 null 이다', ...);
```

- [ ] **Step 2: 실패 확인**
- [ ] **Step 3: 구현**

날짜 해소 알고리즘 (REVIEW §4.2):

```ts
async preview(requestedDate) {
  this.assertAvailable();                       // configured·만료 검사 → 명시 오류
  if (requestedDate < KRX_DATA_EPOCH) throw new HistoricalUniverseDateError('BEFORE_EPOCH', '2010-01-04 이전은 KRX 공식 제공 범위 밖입니다');
  const nowMs = this.deps.clock.now();
  const yesterday = addCalendarDays(kstDateOf(nowMs), -1);
  const publishedThrough = kstHourOf(nowMs) < 8 ? addCalendarDays(yesterday, -1) : yesterday;
  if (requestedDate > publishedThrough) throw new HistoricalUniverseDateError('FUTURE_OR_UNPUBLISHED', ...);
  return this.singleFlight(requestedDate, () => this.buildPreview(requestedDate));
}
```

`buildPreview`: KOSPI daily를 requestedDate부터 최대 31일 뒤로 탐색(빈 배열 = 휴장; 날짜별 daily 응답은 `dailyCache` Map에 저장 — 빈 결과도 정상 응답이므로 캐시), 첫 비어있지 않은 날짜가 effective. 이후 같은 날짜의 KOSDAQ daily·양 시장 base info를 fetch. KOSDAQ이 비면 전체 실패(캐시에 preview를 넣지 않음). `combineMarketSnapshots` → `canonicalHash = sha256(set.canonicalPayload)`(`node:crypto`) → snapshotId `newId('snap')`. previewCache는 snapshotId·(effective+정책+계약) 양 키. single-flight는 dart-corp-code-cache 패턴(실패 시 pending 제거).

`currentStandardCodeMap`: publishedThrough부터 최대 31일 뒤로 base info 행이 나오는 날짜를 찾아 양 시장 base info의 `shortCode → standardCode` Map 생성, TTL 캐시(같은 previewTtlMs).

- [ ] **Step 4: 통과 확인 후 커밋** — `feat(market-data): 과거 유니버스 미리보기 서비스를 추가한다`

---

### Task 9: DatasetService 개정 — revision·1..1000 불변식·수동 수정 경계·부분 유니버스 스냅샷 버그

**Files:**
- Modify: `src/server/modules/market-data/application/dataset-service.ts`
- Modify: `src/server/modules/market-data/application/symbol-service.ts` (removeSymbols)
- Modify: `src/server/modules/market-data/presentation/dataset-routes.ts` (스키마 상수 교체)
- Test: `tests/unit/dataset-service-revision.test.ts`, 기존 관련 테스트 갱신

**Interfaces:**
- Consumes: Task 2 스키마, `MAX_DATASET_SYMBOLS`
- Produces:

```ts
export interface DatasetProvenanceSummary {
  readonly sourceKind: 'KRX_HISTORICAL_SNAPSHOT' | 'CURRENT_REGISTERED';
  readonly requestedDate: string | null;
  readonly effectiveTradingDate: string | null;
  readonly usableFromDate: string | null;
  readonly selectionMethod: string | null;
  readonly filterPolicyVersion: string | null;
  readonly manuallyModified: boolean;
  readonly firstManualChangeAtMs: number | null;
  readonly selectedCount: number;
  readonly krxApprovalExpiryDate: string | null;
}
// DatasetSummary 에 추가:
readonly membershipRevision: number;
readonly provenance: DatasetProvenanceSummary | null;  // null = MANUAL_OR_LEGACY
// 새 메서드:
getProvenance(datasetId: string): DatasetProvenanceSummary | null
// tx 공유 헬퍼 (편집·전역 제거가 공유하는 쓰기 경계):
export function applyMembershipMutation(tx: /* drizzle tx */, datasetId: string, nowMs: number): void
// — membership_revision +1, updatedAtMs 갱신, provenance 있으면 manually_modified=true·first_manual_change_at_ms 최초 기록
```

- [ ] **Step 1: 실패하는 테스트**

```ts
it('updateSymbols 는 revision 을 1 올린다', ...);
it('최종 구성원이 1000 을 넘으면 거부한다', () => {
  // 999 + add 2 → '데이터셋 종목은 최대 1000개입니다 — 현재 1001개가 됩니다'
});
it('createDataset 도 1000 초과를 거부한다', ...);
it('provenance 있는 데이터셋의 구성 변경은 수동 수정 상태를 남기고 최초 시각을 기록한다', ...);
it('두 번째 변경은 first_manual_change_at_ms 를 덮어쓰지 않는다', ...);
it('이름 변경은 수동 수정 상태를 만들지 않고 revision 도 올리지 않는다', ...);
it('전역 종목 제거도 소속 데이터셋의 수동 수정 상태와 revision 을 갱신한다', async () => {
  // removeSymbols 경유 — dataset_symbols cascade 전에 소속 데이터셋 목록을 찾아 마킹
});
it('universeSnapshot 은 요청 종목 부분집합만 pin 한다', () => {
  // universeSnapshotFor(datasetId, ['A'], slice) 가 B 를 포함하지 않는다
});
```

- [ ] **Step 2: 실패 확인**
- [ ] **Step 3: 구현**
  - `createDataset`·`updateSymbols`에 `MAX_DATASET_SYMBOLS` 최종 크기 검사(서비스 계층 — 라우트 zod는 배열별 1000 유지).
  - `updateSymbols` 트랜잭션(167–173행) 안에서 `applyMembershipMutation(tx, ...)` 호출.
  - `SymbolService.removeSymbols`: 삭제 전에 `datasetSymbols`에서 영향 데이터셋 id 수집, DB 삭제 구간을 `db.transaction`으로 묶고 같은 tx에서 `applyMembershipMutation`. (Parquet 삭제는 기존처럼 트랜잭션 밖 — DB만 원자화.)
  - `toSummary`에 revision·provenance 조인(1쿼리 배치, listDatasets N+1 금지 — 기존 batch 패턴).
  - `universeSnapshot(datasetId, slice)` → `universeSnapshotFor(datasetId, codes, slice)`로 교체(기존 시그니처는 전체 구성 위임으로 유지). 해시 대상은 실제 요청 종목만(REVIEW §2 마지막 항목).
- [ ] **Step 4: 통과 확인** — 기존 dataset 관련 단위·통합 테스트 갱신 포함 `pnpm test`
- [ ] **Step 5: 커밋** — `feat(datasets): membership revision·1000 상한·수동 수정 경계를 쓰기 계층에 강제한다`

---

### Task 10: 저장 조정자 — createFromKrxSnapshot

**Files:**
- Create: `src/server/modules/market-data/application/historical-dataset-service.ts`
- Test: `tests/unit/historical-dataset-service.test.ts`

**Interfaces:**
- Consumes: `HistoricalUniverseService.getSnapshot/currentStandardCodeMap`, Task 2 스키마, `newId`, `AuditLogService`
- Produces:

```ts
export class SnapshotSelectionError extends Error { } // 후보 밖 코드·크기 위반·방식 불일치
export class SymbolIdentityConflictError extends Error { } // 표준코드 충돌·미검증 병합
export class HistoricalDatasetService {
  constructor(private readonly deps: {
    readonly db: AppDatabase;
    readonly universe: HistoricalUniverseService;
    readonly clock: Clock;
    readonly audit: AuditLogService;
    readonly logger: Logger;
    readonly approvalExpiry: string | null;
  })
  async createFromSnapshot(args: {
    readonly name: string;
    readonly snapshotId: string;
    readonly selectedStandardCodes: readonly string[];
    readonly selectionMethod: 'TOP_MARKET_CAP_N' | 'MANUAL_FROM_KRX_SNAPSHOT';
    readonly selectionN: number | null;
  }): Promise<DatasetSummary>
}
```

- [ ] **Step 1: 실패하는 테스트** — 실제 `openDatabase(':memory:')` + fake universe service:

```ts
it('만료·부재 snapshotId 는 SnapshotExpiredError — 조용히 새 결과로 저장하지 않는다', ...);
it('후보에 없는 표준코드는 SnapshotSelectionError 다', ...);
it('TOP_MARKET_CAP_N 은 unknown 이 있으면 거부한다', ...);
it('TOP_MARKET_CAP_N 은 선택이 정확히 상위 N 과 일치해야 한다', () => {
  // 상위 2 대신 1위·3위 → 거부. 서버가 재검증한다 (REVIEW §5.5)
});
it('선택 종목만 symbols 에 등록된다 — 미선택 후보는 등록되지 않는다', ...);
it('신규 종목은 standardCode 와 함께 market=KR 로 등록된다', ...);
it('기존 행의 standardCode 가 일치하면 재사용한다', ...);
it('기존 행이 다른 standardCode 면 SymbolIdentityConflictError 다', ...);
it('기존 행이 미매핑이고 현재 KRX 기본정보로 검증되면 백필 후 연결한다', ...);
it('미매핑이고 현재 정보로 검증할 수 없으면 등록을 차단한다', ...);
it('dataset·참조·provenance·선정 스냅샷이 한 트랜잭션이다 — 중간 실패 시 아무것도 남지 않는다', () => {
  // 이름 중복(datasets.name unique)을 마지막 insert 이후 터뜨리는 대신,
  // selection insert 직전에 실패하도록 fixture 를 구성하고 symbols/datasets 잔존 0 확인
});
it('선정 스냅샷 행이 당시 이름·시장·시가총액 원문·순위를 값으로 보존한다', ...);
it('provenance 는 selectionHash·정책 버전·승인 만료일을 기록한다', ...);
it('감사 기록은 커밋 뒤 한 번 — dataset.created.krx-snapshot', ...);
it('1..1000 경계 — 0 개와 1001 개는 거부한다', ...);
```

- [ ] **Step 2: 실패 확인**
- [ ] **Step 3: 구현** — 순서 (REVIEW §5.6):
  1. `snapshot = universe.getSnapshot(snapshotId)` — null → `SnapshotExpiredError('미리보기가 만료되었거나 내용이 바뀌었습니다 — 다시 조회하세요.')`
  2. 선택 검증: 후보 Map 대조, 크기 1..`MAX_DATASET_SYMBOLS`, 백테스트 상한은 여기서 막지 않음(REVIEW §4.3 — 201+ 저장 허용).
  3. `TOP_MARKET_CAP_N`: `snapshot.set.unknownMarketCapCount === 0`이고 선택 = 순위 1..N 정확 일치.
  4. 충돌 해소용 외부 조회: 선택 중 기존 `symbols` 행이 미매핑인 단축코드가 있으면 `currentStandardCodeMap()` 1회 조회(트랜잭션 밖).
  5. 단일 `db.transaction`: 신규 symbols insert(standardCode 포함) / 검증된 백필 update / datasets insert(revision 1) / dataset_symbols insert / provenance insert(`newId('uvp')`, 모든 §7.1 필드) / 선정 스냅샷 insert(선택 종목별 값).
  6. 커밋 후 `audit.record('system', 'dataset.created.krx-snapshot', { datasetId, name, effectiveTradingDate, selectedCount, selectionMethod })` — 키·원문 후보는 넣지 않는다.
- [ ] **Step 4: 통과 확인 후 커밋** — `feat(datasets): KRX 스냅샷 저장 조정자를 단일 트랜잭션으로 추가한다`

---

### Task 11: 라우트와 배선 — status/preview/저장 + CURRENT_REGISTERED provenance

**Files:**
- Create: `src/server/modules/market-data/presentation/universe-routes.ts`
- Create: `src/shared/schemas/historical-universe.ts` (웹 공유 DTO 타입)
- Modify: `src/server/bootstrap/container.ts`, `src/server/bootstrap/server.ts`
- Modify: `src/server/modules/market-data/application/dataset-service.ts` (`createDataset`이 CURRENT_REGISTERED provenance 행도 남기도록)
- Test: `tests/integration/historical-universe-routes.test.ts`

**Interfaces:**
- Produces (HTTP, `/api/v1` 하위, 전부 `requireAuth`):
  - `GET /universe/historical/status` → `{ available: boolean; reason: string | null; approvalExpiry: string | null; todayCallCount: number }`
  - `POST /universe/historical/preview` body `{ date: 'YYYY-MM-DD' }` → 200 `HistoricalUniversePreviewDto` | 400(날짜) | 409(미설정·만료·스냅샷) | 429(quota) | 502(계약)
  - `POST /datasets/from-krx-snapshot` body `{ name: string(1..64); snapshotId: string; standardCodes: string[](1..1000); selectionMethod; selectionN?: number }` → 201 `{ dataset }` | 400 | 404 | 409
- Produces (shared DTO, zod 없음):

```ts
export interface HistoricalCandidateDto {
  readonly standardCode: string; readonly shortCode: string; readonly name: string;
  readonly market: 'KOSPI' | 'KOSDAQ';
  readonly marketCapKrw: string | null;   // 원 단위 정수 문자열 — JS number 정밀도 문제를 피한다
  readonly rank: number | null;
}
export interface HistoricalUniversePreviewDto {
  readonly snapshotId: string;
  readonly requestedDate: string; readonly effectiveTradingDate: string;
  readonly usableFromDate: string;
  readonly rawCounts: { readonly KOSPI: number; readonly KOSDAQ: number };
  readonly eligibleCount: number; readonly unknownMarketCapCount: number;
  readonly excludedByType: Readonly<Record<string, number>>;
  readonly candidates: readonly HistoricalCandidateDto[];
  readonly attribution: '한국거래소 통계정보';
}
export interface HistoricalUniverseStatusDto { ... }
export type DatasetProvenanceDto = DatasetProvenanceSummary;  // GET /datasets 응답에 합류
```

- [ ] **Step 1: 실패하는 통합 테스트** — `createTestApp` + `tests/helpers/krx-fixtures.ts`의 **fake KRX HTTP 서버**(Fastify로 4 경로 서빙, basDd별 canned 응답, 수신 요청 기록):

```ts
it('키 미설정이면 status.available=false 고 preview 는 409 다 — 외부 호출 없음', ...);
it('미리보기는 DB 에 아무것도 쓰지 않는다', async () => {
  // preview 200 후 symbols·datasets·provenance 카운트 전부 0 (REVIEW §5.3)
});
it('주말 기준일은 이전 거래일로 해소되고 두 날짜가 응답에 있다', ...);
it('스냅샷 저장이 dataset·symbols·provenance·선정 스냅샷을 만든다', ...);
it('만료 snapshotId 저장은 409 와 재조회 안내다', ...);
it('한 시장 실패 시 502 고 이후 상태가 깨끗하다', ...);
it('현재 등록 종목으로 만든 데이터셋은 CURRENT_REGISTERED provenance 를 남긴다', ...);
it('미인증 요청은 전부 401 이다', ...);
```

- [ ] **Step 2: 실패 확인**
- [ ] **Step 3: 구현**
  - `registerUniverseRoutes(app, historicalUniverseService, historicalDatasetService, requireAuth)` — dataset-routes와 같은 positional 주입, zod `safeParse`, 오류 매핑은 위 표대로. 계약 오류 502 메시지: `'KRX 응답이 예상 계약과 다릅니다 — 로그를 확인하세요.'`(원문 미노출).
  - preview DTO 변환에서 BigInt → 문자열.
  - `container.ts`: `createKrxHistoricalUniverseSource(config.krxApiKey ? { baseUrl: config.krxBaseUrl, apiKey: config.krxApiKey, approvalExpiry: config.krxApprovalExpiry } : null, clock, logger)` → `HistoricalUniverseService`(configured = `config.krxApiKey !== null`) → `HistoricalDatasetService`. `Container` 인터페이스에 두 서비스 추가.
  - `server.ts`: `registerUniverseRoutes(...)` 등록.
  - `DatasetService.createDataset`: 트랜잭션 안에 `sourceKind: 'CURRENT_REGISTERED'` provenance insert(요청일 등 null, selectedCount만 채움).
- [ ] **Step 4: 통과 확인 후 커밋** — `feat(api): 과거 유니버스 status·preview·스냅샷 저장 라우트를 추가한다`

---

### Task 12: 백테스트 계약 — revision 토큰·시점 게이트·provenance pin

**Files:**
- Modify: `src/shared/schemas/backtest-request.ts` (`expectedMembershipRevision?: number`)
- Modify: `src/server/modules/backtest/presentation/backtest-routes.ts` (validateSubmission·pin·clone)
- Modify: `src/server/modules/backtest/application/job-queue.ts` (`enqueue(request, pinnedUniverse?, provenancePin?)`)
- Modify: `src/workers/backtest-child.ts` (pin 복사 + 경고)
- Modify: 결과 조회 서비스(run 응답에 `provenancePinJson` 포함)
- Test: `tests/unit/backtest-request.test.ts`, `tests/integration/backtest-provenance-gate.test.ts`

**Interfaces:**
- Produces: pin JSON 형태 (서버 소유, 클라이언트 입력 아님):

```ts
export interface ProvenancePin {
  readonly sourceKind: 'KRX_HISTORICAL_SNAPSHOT' | 'CURRENT_REGISTERED' | 'MANUAL_OR_LEGACY';
  readonly requestedDate: string | null;
  readonly effectiveTradingDate: string | null;
  readonly manuallyModified: boolean;
  readonly filterPolicyVersion: string | null;
  readonly membershipRevision: number;
  readonly selectionHash: string | null;
  readonly krxApprovalExpiryDate: string | null;
  readonly approvalValidAtSubmit: boolean | null;
  readonly timepointWarning: string | null;   // null 이면 경고 없음
  readonly symbols: ReadonlyArray<{
    readonly standardCode: string; readonly shortCode: string; readonly name: string;
    readonly market: string; readonly marketCapKrw: string | null; readonly rank: number | null;
  }> | null;                                   // KRX 스냅샷일 때만
}
```

- [ ] **Step 1: 실패하는 테스트**

단위(`backtest-request.test.ts`): `expectedMembershipRevision` 수용·양의 정수 검증·생략 허용(레거시 저장 요청 재파싱).

통합(`backtest-provenance-gate.test.ts`) — seed 데이터셋 + provenance 행 직접 insert로 시나리오 구성:

```ts
it('expectedMembershipRevision 생략은 400 이다 — stale 화면 탐지 토큰', ...);
it('revision 불일치는 400 과 새로고침 안내다', ...);
it('요청 유니버스가 데이터셋 전체와 다르면 400 이다 — 부분집합 불허', ...);
it('KRX 데이터셋: 적용일 >= period.from 은 두 날짜와 해결책을 담아 400 이다', () => {
  // '적용일 2026-07-31은 시작일 2025-01-01보다 이전이어야 합니다. 더 이른 스냅샷을 선택하거나 시작일을 늦추세요'
});
it('적용일 == 시작일도 차단한다 — 종가 정보는 그날 세션 시작에 알 수 없다', ...);
it('적용일 < 시작일이고 승인 유효하면 202/201 로 통과한다', ...);
it('KRX 승인 만료 후 KRX 데이터셋 신규 실행은 차단된다', ...);
it('KRX 데이터셋에서 기간 내 가격 데이터가 전혀 없는 종목이 있으면 차단하고 코드를 나열한다', ...);
it('수동 수정된 KRX 데이터셋은 허용하되 pin.timepointWarning 이 남는다', ...);
it('MANUAL_OR_LEGACY 데이터셋은 기존 흐름대로 통과하고 시점 불명 경고가 pin 에 남는다', ...);
it('job 행에 서버 소유 provenance pin 이 저장되고 run 에 복사된다', ...);
it('pin 의 universe 버전 스냅샷이 실제 실행 종목만 커버한다 — 데이터셋 전체 해시 버그 제거', ...);
it('clone 은 원 요청의 부분 유니버스를 현재 데이터셋 전체로 대체하고 경고를 준다', ...);
```

- [ ] **Step 2: 실패 확인**
- [ ] **Step 3: 구현**
  - `backtest-request.ts`: `expectedMembershipRevision: z.number().int().positive().optional()` (주석: 저장된 레거시 요청 재파싱을 위해 optional, POST 경로는 라우트가 필수로 강제).
  - `validateSubmission`(L153–280) 확장: 같은 곳에서 `datasets.getDataset` + `getProvenance` + revision을 읽는다(동기 SQLite — 한 지점에서 함께 읽어 일관 스냅샷). 검사 순서: revision 필수·일치 → 유니버스 = 전체 구성 정확 일치(정렬 비교) → provenance 게이트(위 시나리오) → KRX면 종목별 커버리지 존재 검사(`symbolService.getCoverage` 활용, 기간과 교집합 0인 종목 나열) → 기존 검사 유지. 반환에 `provenancePin` 추가.
  - pin 조립: KRX면 선정 스냅샷 행(`datasetSelectionSnapshots` ← provenance id)에서 값 복사. `timepointWarning`은 REVIEW §9.3 문구.
  - `queue.enqueue(request, pinnedUniverse, provenancePin)` — `provenance_pin_json` 저장.
  - `universeSnapshotFor` 사용으로 교체(실해소 종목만 버전 pin).
  - `backtest-child.ts`: `provenancePinJson`을 run에 복사, pin 파싱 후 `timepointWarning`이 있으면 `datasetWarnings`에 추가.
  - clone(L433–478): rebase 후 `universe.symbols`를 현재 데이터셋 전체로 대체, 달라졌으면 warnings에 추가, `expectedMembershipRevision`은 현재 revision으로 채움. clone-draft도 동일 정보 반환.
  - 결과 응답(run 상세)에 `provenancePin`(파싱된 객체) 포함.
- [ ] **Step 4: 통과 확인** — 기존 `job-queue.test.ts:151-163` 등 스냅샷 형태 의존 테스트 갱신 포함 `pnpm test`
- [ ] **Step 5: 커밋** — `feat(backtest): 유니버스 provenance 게이트와 서버 소유 pin 을 추가한다`

---

### Task 13: 웹 — 상태 훅·생성 다이얼로그 KRX 모드·후보 선택 UI

**Files:**
- Create: `src/web/lib/use-historical-universe.ts`
- Create: `src/web/features/datasets/krx-snapshot-picker.tsx`
- Modify: `src/web/features/datasets/datasets-panel.tsx` (CreateDatasetDialog 330–397행)
- Modify: `src/web/features/datasets/symbol-types.ts` (DatasetSummary 확장)
- Test: `tests/unit/krx-selection-state.test.ts` (선택 로직은 순수 모듈로 분리해 테스트)

**Interfaces:**
- Consumes: `HistoricalUniverseStatusDto`, `HistoricalUniversePreviewDto` (`src/shared/schemas/historical-universe.ts`)
- Produces:
  - `useHistoricalUniverseStatus(): { status: HistoricalUniverseStatusDto | null; isLoading: boolean }` — queryKey `['universe','historical','status']`, `staleTime: 60_000`
  - `KrxSnapshotPicker({ onSubmitted })` — 내부에서 preview mutation·선택 상태·저장 mutation까지 처리
  - 순수 선택 로직 `src/web/features/datasets/krx-selection.ts`:

```ts
export function topNCodes(candidates: readonly HistoricalCandidateDto[], n: number): readonly string[]
// rank 1..n 정확 추출. unknown 포함 후보에서는 호출하지 않는다 (버튼 비활성)
export function selectionMethodOf(selected: ReadonlySet<string>, candidates: ..., n: number):
  'TOP_MARKET_CAP_N' | 'MANUAL_FROM_KRX_SNAPSHOT'
// 선택이 정확히 상위 N 이면 TOP, 아니면 MANUAL
```

- [ ] **Step 1: 실패하는 테스트** — `krx-selection.ts` 순수 로직: top-200 추출, unknown 존재 시 사용 금지 전제, 검색·페이지 변경과 무관한 선택 유지(Set 기반), 수동 추가 후 method 가 MANUAL 로 바뀜.
- [ ] **Step 2: 실패 확인 후 구현**

UI 구성 (REVIEW §8.1):
- `CreateDatasetDialog`에 shadcn `Tabs`: `현재 등록 종목에서 선택`(기존 그대로) / `과거 KRX 시점으로 구성`.
- KRX 탭: status.available=false면 컨트롤 비활성 + 이유 상시 표시(`'KRX Open API 인증키와 API별 이용 승인이 필요합니다'` — use-market-support의 D-027 방식).
- 활성 시: `<Input type="date">` + 조회 버튼 → preview mutation. 성공 시:
  - 요약 줄: `요청 {requestedDate} → 적용 {effectiveTradingDate}` (다르면 두 날짜, 같으면 하나), KOSPI·KOSDAQ 원시 수, 보통주 수, 유형별 제외 수, unknown 수, `출처: 한국거래소 통계정보`
  - `시가총액 상위 200종목 선택` 버튼 — `unknownMarketCapCount > 0`이면 `aria-disabled` + title 이유
  - 후보 목록: `filterSymbols`·`Pagination`·`PageSizeInput`·`SymbolSelectScopeButtons`는 재사용하되 rows는 `HistoricalCandidateDto`(시가총액 `formatCompactNumber(Number(marketCapKrw))` 표시 — 정렬·순위는 서버 값 그대로, 반올림은 표시만). unknown 행은 경고 배지와 함께 수동 선택 가능.
  - 선택 > `MAX_UNIVERSE_SYMBOLS`면 저장은 허용하되 `'현재 백테스트 상한 200종목을 초과합니다'` 상시 표시.
  - 저장: `postJson('/datasets/from-krx-snapshot', { name, snapshotId, standardCodes, selectionMethod, selectionN })`; 409(만료)면 `'미리보기를 다시 실행하세요'` 토스트 + preview 초기화. 성공 시 `['datasets']`·`['symbols']` invalidate.
- `symbol-types.ts` `DatasetSummary`에 `membershipRevision: number; provenance: DatasetProvenanceDto | null` 추가.
- [ ] **Step 3: 검증** — `pnpm typecheck && pnpm lint && pnpm test`
- [ ] **Step 4: 커밋** — `feat(web): 데이터셋 생성에 과거 KRX 시점 구성 모드를 추가한다`

---

### Task 14: 웹 — 배지·위저드 토큰·결과 문구

**Files:**
- Create: `src/web/features/datasets/dataset-provenance-badge.tsx`
- Modify: `src/web/features/datasets/datasets-panel.tsx` (DatasetCard 223행·258행 부근)
- Modify: `src/web/features/backtests/new-backtest-wizard.tsx`
- Modify: `src/web/features/backtests/backtest-detail-page.tsx` (RunMetadataCard 479–504행, WarningsSection)
- Test: `tests/unit/dataset-provenance-label.test.ts` (라벨 도출 순수 함수)

**Interfaces:**
- Produces: `provenanceLabels(p: DatasetProvenanceDto | null): { badges: string[]; sourceLine: string | null; timepointNote: string | null }` — 순수 함수로 분리해 테스트

- [ ] **Step 1: 실패하는 테스트** — 라벨 규칙 (REVIEW §8.2):

```ts
it('KRX 스냅샷은 KRX {적용일} 기준·고정 유니버스 배지를 만든다', ...);
it('수동 수정이면 수동 수정됨 배지와 시점 보장 제한 문구가 붙는다', ...);
it('요청일과 적용일이 다르면 요청 → 적용 두 날짜를 표시한다', ...);
it('provenance 없음·CURRENT_REGISTERED 는 시점 확인 불가 배지다', ...);
it('KRX 출처 표기는 한국거래소 통계정보다', ...);
```

- [ ] **Step 2: 실패 확인 후 구현**
  - `DatasetProvenanceBadge` — `strategy-data-badge.tsx`의 VARIANTS/ICONS record 패턴, 색만이 아니라 아이콘+텍스트.
  - DatasetCard: 제목줄 배지(223행 뒤) + 본문 출처·날짜 줄(258행 옆). 위저드 1단계 카드(new-backtest-wizard 630–648행)에도 같은 배지.
  - 위저드: `buildRequest()`에 `expectedMembershipRevision: selectedDataset.membershipRevision` 추가. `prefilledSymbols` 제출 경로 제거 — prefill은 안내 문구로만 남기고 제출은 항상 데이터셋 전체(Task 12 서버 계약과 일치). 검토 단계에 provenance 시점 경고(수동 수정·시점 불명) 표시. 400 응답 메시지는 기존 스텝 오류 Alert에 그대로 노출(서버가 두 날짜+해결책 문구를 만든다).
  - 결과 페이지: run 응답의 `provenancePin`으로 RunMetadataCard rows에 `['유니버스 출처', ...]`, `['적용 거래일', ...]`, `['membership revision', ...]` 추가. 카드 위에 고정 유니버스 문구(REVIEW §9.3 — 미수정/수동 수정 두 변형, 합쇼체 원문 그대로). `생존자 편향 제거` 문구 금지.
- [ ] **Step 3: 검증 후 커밋** — `feat(web): 데이터셋 출처 배지와 백테스트 시점 문구를 표시한다`

---

### Task 15: E2E

**Files:**
- Modify: `scripts/e2e-server.ts` — fake KRX Fastify 서버(포트 3101)를 함께 기동, `KRX_API_KEY: 'e2e-krx-key'`, `KRX_BASE_URL: 'http://127.0.0.1:3101'` 주입. fixture: 2024-12-30(거래일)·2025-01-01(휴장 빈 응답), KOSPI 3종목(보통주 2 + 우선주 1), KOSDAQ 2종목(보통주 1 + 스팩 1), 시가총액 정렬 검증 가능한 값.
- Create: `tests/e2e/krx-universe.spec.ts`

- [ ] **Step 1: 시나리오 작성** (REVIEW §11.3, 기존 spec 관례 — 상태 복원 필수, 한국어 문자열 셀렉터):

```
1) 휴일 기준일 조회: 2025-01-01 입력 → '요청 2025-01-01 → 적용 2024-12-30' 표시,
   원시/보통주/제외 수 표시, 출처 문구 확인
2) 상위 N 선택 + 검색 후 선택 유지 + 수동 해제 → 수동 선택 방식 저장
   → 카드에 'KRX 2024-12-30 기준'·'고정 유니버스' 배지 + 출처 표기
3) 이 데이터셋으로 위저드 진입 → 시작일 2024-12-30(적용일과 같음) → 제출 차단,
   두 날짜와 해결책 문구 확인 → 시작일을 뒤로 → (가격 데이터 없음 차단 확인 또는
   데이터 있는 종목만으로 구성한 fixture 로 통과)
4) 데이터셋 종목 편집 → '수동 수정됨' 배지 유지 확인
5) 정리: 만든 데이터셋·종목 삭제 (상태 복원 관례)
```

키 없는 잠금 상태는 E2E 서버가 단일 구성이므로 통합 테스트(Task 11)가 담당한다는 주석을 spec에 남긴다.

- [ ] **Step 2: 실행** — `pnpm test:e2e` (desktop·mobile 프로젝트 모두)
- [ ] **Step 3: 커밋** — `test(e2e): KRX 과거 유니버스 생성·차단 흐름을 검증한다`

---### Task 16: smoke script와 문서

**Files:**
- Create: `scripts/krx-smoke.ts`
- Modify: `docs/DECISIONS.md` (D-040), `docs/SPEC.md` §12 테이블 목록, `docs/reviews/HISTORICAL_UNIVERSE_SNAPSHOT_REVIEW.md` 상태 갱신

- [ ] **Step 1: smoke script** — `pnpm exec tsx scripts/krx-smoke.ts --date 2016-01-04` 형태. `KRX_API_KEY` 필수(없으면 안내 후 종료). 수행 (REVIEW §11.4):
  1. 네 API 원문 필드 목록을 계약 v1 기대와 대조해 차이를 출력
  2. 상장폐지 종목 포함 확인 — 기본 검증일 2016-01-04에 한진해운(117930) 존재 여부 등 알려진 폐지 종목 검사
  3. 분류값 인벤토리 — `--years 2010,2015,2020,2025`의 SECUGRP_NM·KIND_STKCERT_TP_NM·SECT_TP_NM 고유값을 필터 정책 allowlist와 대조, 미지값 나열
  4. 일별 ISU_CD ↔ 기본 ISU_SRT_CD 조인 무결성(미조인·중복 수)
  5. 휴장일·과거일·최근 공개일 각 1회 조회 결과 요약
  6. 호출 수 출력(일일 한도 확인용)
  결과는 표 형태 stdout. 실패 항목이 있으면 exit 1 — **이 게이트를 통과하기 전 실서비스 사용을 열지 않는다.**
- [ ] **Step 2: 문서**
  - `DECISIONS.md` D-040: 과거 시점 고정 유니버스 도입 결정 — provenance 분리 저장(참조 vs 값 스냅샷), revision 토큰, 서버 소유 pin, 부분 유니버스 스냅샷 버그 제거, 필터 정책 버전제. REVIEW 링크.
  - `SPEC.md` §12 테이블 목록에 `dataset_universe_provenance`·`dataset_selection_snapshots` 추가, `datasets.membership_revision`·`symbols.standard_code` 언급.
  - REVIEW 헤더 상태를 `구현 완료 — smoke test 게이트 대기`로 갱신하고 §12 조건 충족 현황 기록.
- [ ] **Step 3: 전체 검증** — `pnpm test && pnpm typecheck && pnpm lint && pnpm test:e2e`
- [ ] **Step 4: 커밋** — `docs: KRX 과거 유니버스 결정 기록과 smoke test 절차를 추가한다`

---

## 완료 판정 대조 (REVIEW §14)

| §14 항목 | 담당 태스크 |
| --- | --- |
| 과거 달력일로 후보 조회 | 8, 11, 13 |
| 휴장일 해소·두 날짜 표시 | 8, 13, 14 |
| 서버 결정적 순위·null≠0 | 6 |
| unknown 시 자동 top-N 금지 | 6, 10, 13 |
| 선택 종목만 등록·스냅샷 보존 | 10 |
| 수동 편집 후 출처 유지·표시 | 9, 14 |
| 적용일 ≥ 시작일 차단 | 12 |
| 실행 종목·버전·revision·provenance 원자 고정 | 12 |
| 데이터셋 삭제 후에도 값으로 남는 실행 근거 | 2, 12 (pin 값 복사) |
| 가격 없는 종목 조용한 제외 금지 | 12 |
| 고정 유니버스 문구·편향 제거 주장 금지 | 14 |
| 키 미노출 | 1, 7, 10 |
| 양 시장 부분 실패 차단 | 8 |
| 실응답 분류 검증·출처 표기 | 13, 16 |
| 승인 기간·범위 위반 차단 | 1, 7, 12 |

## 남은 외부 게이트 (코드로 해소 불가)

1. KOSPI·KOSDAQ 기본·일별 네 서비스의 KRX 이용 승인 완료 여부 확인 (REVIEW §12-2)
2. `scripts/krx-smoke.ts` 실행과 분류 필터 입증 (REVIEW §12-4) — 실패 시 필터 정책 갱신 후 재실행
3. 비상업 약관 범위·로컬 저장·만료 후 처리의 KRX 확인 (REVIEW §12-5·6) — 운영자 확인 사항
