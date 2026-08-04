# KRX 과거 유니버스 정렬 기준·선택 버튼·데이터셋 기록 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 백테스트 위저드의 과거 KRX 기준일 조회에 정렬 기준(시가총액·영업이익)을 추가하고, 상위 200 버튼을 페이지/전체 선택으로 바꾸고, 스냅샷 확정 시 데이터셋을 자동 기록한다(기준 시점·정렬 기준 명시, 현시점 미상장 종목은 카드 하단 표시 + 종목 편집 제외).

**Architecture:** 서버가 preview 요청의 `sortBy`로 rank를 매긴다. 영업이익은 parquet facts를 `PitFactView`로 point-in-time TTM 산출한다. 스냅샷 생성 트랜잭션이 데이터셋도 함께 만들고 `datasets.universe_snapshot_id`로 연결한다. 현시점 상장 여부는 기존 `currentStandardCodeMap()`(TTL 6h 캐시) 재사용.

**Tech Stack:** Fastify 5 + zod, Drizzle(SQLite), DuckDB parquet facts, React 19 + TanStack Query, vitest, playwright.

**Spec:** `docs/superpowers/specs/2026-08-04-krx-universe-sort-dataset-design.md`

## Global Constraints

- 한국어 주석·문서는 CLAUDE.md 규칙(문어체 ~한다, 번역투 금지, "왜"를 쓴다).
- `src/shared/schemas/*`는 zod 없이 타입·상수만 (웹 번들 오염 금지, `historical-universe.ts` 상단 주석 참고).
- 웹에서 import되는 shared/스텝 헬퍼 모듈의 상대 import는 `.js` 확장자 필수 (NodeNext).
- `MAX_UNIVERSE_SYMBOLS = 200`(universe-limit.ts) 값 변경 금지.
- MKTCAP 정렬의 canonicalPayload·selectionHash는 기존과 바이트 단위로 같아야 한다 — 기존 스냅샷·테스트 해시 호환.
- PER·PBR·EV/EBITDA는 서버 enum에 넣지 않는다. UI에서만 disabled 항목으로 노출.
- 검증 명령: `pnpm typecheck`, `pnpm vitest run <파일>`, `pnpm lint`. e2e는 `pnpm build && pnpm exec playwright test tests/e2e/krx-universe.spec.ts`.
- 커밋 메시지는 기존 로그 스타일(한국어 문어체, `feat(scope): ...한다`).

---

### Task 1: kstEndOfDayMs 헬퍼

**Files:**
- Modify: `src/server/modules/market-data/domain/kst-date.ts`
- Test: `tests/unit/kst-date.test.ts`

**Interfaces:**
- Produces: `kstEndOfDayMs(isoDate: string): number` — KST 그 날짜의 마지막 ms (다음 날 00:00 KST − 1ms). Task 5가 영업이익 as-of 컷오프로 쓴다.

- [ ] **Step 1: 실패하는 테스트 작성** — `tests/unit/kst-date.test.ts`에 추가:

```ts
import { kstEndOfDayMs, kstDateOf } from '../../src/server/modules/market-data/domain/kst-date.js';

describe('kstEndOfDayMs', () => {
  it('그 날짜 KST 의 마지막 ms 다 — 1ms 뒤는 다음 날짜다', () => {
    const end = kstEndOfDayMs('2020-06-15');
    expect(kstDateOf(end)).toBe('2020-06-15');
    expect(kstDateOf(end + 1)).toBe('2020-06-16');
  });

  it('DART 접수일 18:00 KST 공시가 그 날짜 컷오프에 포함된다', () => {
    // 2020-06-15 18:00 KST = 2020-06-15 09:00 UTC
    const filing = Date.parse('2020-06-15T09:00:00Z');
    expect(filing).toBeLessThanOrEqual(kstEndOfDayMs('2020-06-15'));
  });
});
```

- [ ] **Step 2: 실패 확인** — Run: `pnpm vitest run tests/unit/kst-date.test.ts` — Expected: FAIL (`kstEndOfDayMs` export 없음)

- [ ] **Step 3: 구현** — `kst-date.ts`에 추가:

```ts
/** 그 KST 달력일의 마지막 ms — 공시 as-of 컷오프(≤ 기준일)에 쓴다 */
export function kstEndOfDayMs(isoDate: string): number {
  return Date.parse(`${isoDate}T00:00:00Z`) - KST_OFFSET_MS + DAY_MS - 1;
}
```

- [ ] **Step 4: 통과 확인** — Run: `pnpm vitest run tests/unit/kst-date.test.ts` — Expected: PASS

- [ ] **Step 5: 커밋**

```bash
git add src/server/modules/market-data/domain/kst-date.ts tests/unit/kst-date.test.ts
git commit -m "feat(market-data): KST 하루 끝 시각 헬퍼를 추가한다"
```

---

### Task 2: 공유 정렬 상수·DTO 확장

**Files:**
- Create: `src/shared/schemas/universe-sort.ts`
- Modify: `src/shared/schemas/historical-universe.ts`

**Interfaces:**
- Produces:
  - `type UniverseSortKey = 'MKTCAP' | 'OPERATING_INCOME'`
  - `UNIVERSE_SORT_KEYS: readonly UniverseSortKey[]`
  - `UNIVERSE_SORT_LABELS: Record<UniverseSortKey, string>` — `{ MKTCAP: '시가총액', OPERATING_INCOME: '영업이익' }`
  - `HistoricalCandidateDto`에 `sortValue: string | null` 추가
  - `HistoricalUniversePreviewDto`에 `sortBy: UniverseSortKey`, `unknownSortValueCount: number` 추가
  - `UniverseSnapshotSummaryDto`에 `sortKey: UniverseSortKey` 추가

- [ ] **Step 1: universe-sort.ts 작성**

```ts
/**
 * 과거 유니버스 정렬 기준 — 웹과 서버가 공유한다. zod 를 쓰지 않는 이유는
 * historical-universe.ts 와 같다(웹 번들에 zod 를 끌고 들어오지 않는다).
 *
 * PER·PBR·EV/EBITDA 는 여기 없다 — 필요한 원자료(순이익·자본총계·감가상각)를
 * 아직 수집하지 않는다. 데이터가 생길 때 이 유니온을 확장한다.
 */
export type UniverseSortKey = 'MKTCAP' | 'OPERATING_INCOME';

export const UNIVERSE_SORT_KEYS: readonly UniverseSortKey[] = ['MKTCAP', 'OPERATING_INCOME'];

export const UNIVERSE_SORT_LABELS: Record<UniverseSortKey, string> = {
  MKTCAP: '시가총액',
  OPERATING_INCOME: '영업이익',
};
```

- [ ] **Step 2: historical-universe.ts DTO 확장**

`HistoricalCandidateDto`에 필드 추가 (marketCapKrw 아래):

```ts
  /** 활성 정렬 기준의 값 — MKTCAP 이면 marketCapKrw 와 같고, 영업이익이면 원 단위 문자열. 값이 없으면 null */
  readonly sortValue: string | null;
```

`HistoricalUniversePreviewDto`에 추가 (unknownMarketCapCount 아래):

```ts
  readonly sortBy: UniverseSortKey;
  /** 활성 정렬 기준 값이 없어 rank 를 받지 못한 후보 수 */
  readonly unknownSortValueCount: number;
```

`UniverseSnapshotSummaryDto`에 추가 (selectionMethod 위):

```ts
  readonly sortKey: UniverseSortKey;
```

파일 상단에 `import type { UniverseSortKey } from './universe-sort.js';` 추가.

- [ ] **Step 3: 타입만 바뀌었으므로 typecheck 로 확인** — Run: `pnpm typecheck` — Expected: **FAIL** (previewDto·summaryDto·krx-snapshot-step 가 새 필수 필드를 아직 안 채움). 실패 목록이 이후 태스크의 수정 지점과 일치하는지 확인만 하고 넘어간다. 커밋은 Task 3와 묶는다 — 단독으로는 빌드가 깨진 상태라 커밋하지 않는다.

---

### Task 3: 도메인 applySortKey

**Files:**
- Modify: `src/server/modules/market-data/domain/historical-universe.ts`
- Test: `tests/unit/historical-universe.test.ts`

**Interfaces:**
- Consumes: `UniverseCandidateSet`, `EligibleCandidate`, `compareCandidateIdentity`(파일 내부), `UniverseSortKey` (Task 2)
- Produces:

```ts
export interface SortedUniverseCandidateSet extends UniverseCandidateSet {
  readonly sortKey: UniverseSortKey;
  readonly unknownSortValueCount: number;
  /** standardCode → 정렬 값 문자열 (값 있는 후보만) */
  readonly sortValues: ReadonlyMap<string, string>;
}

export function applySortKey(
  set: UniverseCandidateSet,
  sortKey: UniverseSortKey,
  /** OPERATING_INCOME 일 때 필수 — shortCode → TTM 영업이익(원) */
  operatingIncomeByShortCode?: ReadonlyMap<string, number>,
): SortedUniverseCandidateSet
```

- [ ] **Step 1: 실패하는 테스트 작성** — `tests/unit/historical-universe.test.ts`에 추가. 기존 테스트의 후보 생성 헬퍼를 재사용하되 없으면 아래처럼 직접 만든다:

```ts
import {
  applySortKey,
  type EligibleCandidate,
  type UniverseCandidateSet,
} from '../../src/server/modules/market-data/domain/historical-universe.js';

describe('applySortKey', () => {
  // combineMarketSnapshots 를 거치지 않고 손으로 만든다 — applySortKey 의 계약은
  // UniverseCandidateSet 모양이지 KRX 원시 행이 아니다.
  function candidate(
    shortCode: string, standardCode: string, name: string,
    market: 'KOSPI' | 'KOSDAQ', marketCapKrw: bigint | null, rank: number | null,
  ): EligibleCandidate {
    return { standardCode, shortCode, name, market, marketCapKrw, rank };
  }
  function baseSet(): UniverseCandidateSet {
    // 시가총액순: 005930(300) > 035720(200) > 000001(100)
    const candidates = [
      candidate('005930', 'KR7005930003', '삼성전자', 'KOSPI', 300n, 1),
      candidate('035720', 'KR7035720002', '카카오', 'KOSDAQ', 200n, 2),
      candidate('000001', 'KR7000001009', '테스트', 'KOSPI', 100n, 3),
    ];
    return {
      effectiveTradingDate: '2025-01-06',
      candidates,
      rawCounts: { KOSPI: 2, KOSDAQ: 1 },
      eligibleCount: 3,
      unknownMarketCapCount: 0,
      excludedByType: {},
      filterPolicyVersion: 'test-policy',
      contractVersion: 'test-contract',
      canonicalPayload: 'test-payload',
    };
  }

  it('MKTCAP 은 후보·payload 를 그대로 두고 메타만 얹는다 — 기존 해시 호환', () => {
    const set = baseSet();
    const sorted = applySortKey(set, 'MKTCAP');
    expect(sorted.candidates).toEqual(set.candidates);
    expect(sorted.canonicalPayload).toBe(set.canonicalPayload);
    expect(sorted.unknownSortValueCount).toBe(set.unknownMarketCapCount);
    expect(sorted.sortValues.get('KR7005930003')).toBe('300');
  });

  it('OPERATING_INCOME 은 값 내림차순으로 rank 를 다시 매기고 값 없는 후보를 rank null 로 뒤에 둔다', () => {
    const set = baseSet();
    const oi = new Map([['035720', 500], ['000001', 900]]); // 005930 은 값 없음
    const sorted = applySortKey(set, 'OPERATING_INCOME', oi);
    expect(sorted.candidates.map((c) => c.shortCode)).toEqual(['000001', '035720', '005930']);
    expect(sorted.candidates.map((c) => c.rank)).toEqual([1, 2, null]);
    expect(sorted.unknownSortValueCount).toBe(1);
    expect(sorted.sortValues.get('KR7000001009')).toBe('900');
    expect(sorted.sortValues.has('KR7005930003')).toBe(false);
  });

  it('OPERATING_INCOME payload 는 정렬 구획이 붙어 MKTCAP 과 해시가 갈린다', () => {
    const set = baseSet();
    const sorted = applySortKey(set, 'OPERATING_INCOME', new Map([['035720', 500]]));
    expect(sorted.canonicalPayload).not.toBe(set.canonicalPayload);
    expect(sorted.canonicalPayload).toContain('--sort--');
    expect(sorted.canonicalPayload).toContain('OPERATING_INCOME');
  });

  it('영업이익 동률은 정체성(shortCode) 순으로 결정적이다', () => {
    const set = baseSet();
    const oi = new Map([['005930', 500], ['035720', 500]]);
    const sorted = applySortKey(set, 'OPERATING_INCOME', oi);
    expect(sorted.candidates.map((c) => c.shortCode)).toEqual(['005930', '035720', '000001']);
  });
});
```

- [ ] **Step 2: 실패 확인** — Run: `pnpm vitest run tests/unit/historical-universe.test.ts` — Expected: FAIL (`applySortKey` 없음)

- [ ] **Step 3: 구현** — `historical-universe.ts`에 추가 (import에 `UniverseSortKey` 추가):

```ts
import type { UniverseSortKey } from '../../../../shared/schemas/universe-sort.js';

export interface SortedUniverseCandidateSet extends UniverseCandidateSet {
  readonly sortKey: UniverseSortKey;
  readonly unknownSortValueCount: number;
  readonly sortValues: ReadonlyMap<string, string>;
}

/**
 * 후보 집합에 정렬 기준을 적용한다.
 *
 * MKTCAP 은 combineMarketSnapshots 가 이미 매긴 rank·payload 를 그대로 쓴다 — 기존
 * 스냅샷의 candidateCanonicalHash·selectionHash 와 바이트 단위로 호환돼야 한다.
 * 다른 정렬은 rank 를 다시 매기고 payload 에 정렬 구획을 덧붙인다 — 같은 후보
 * 집합이라도 정렬 기준·값이 다르면 재현 해시가 달라야 한다.
 */
export function applySortKey(
  set: UniverseCandidateSet,
  sortKey: UniverseSortKey,
  operatingIncomeByShortCode?: ReadonlyMap<string, number>,
): SortedUniverseCandidateSet {
  if (sortKey === 'MKTCAP') {
    const sortValues = new Map<string, string>();
    for (const candidate of set.candidates) {
      if (candidate.marketCapKrw !== null) {
        sortValues.set(candidate.standardCode, candidate.marketCapKrw.toString());
      }
    }
    return { ...set, sortKey, unknownSortValueCount: set.unknownMarketCapCount, sortValues };
  }

  const values = operatingIncomeByShortCode ?? new Map<string, number>();
  const known = set.candidates
    .filter((candidate) => values.has(candidate.shortCode))
    .sort((left, right) => {
      const diff = (values.get(right.shortCode) as number) - (values.get(left.shortCode) as number);
      return diff !== 0 ? Math.sign(diff) : compareCandidateIdentity(left, right);
    })
    .map((candidate, index) => ({ ...candidate, rank: index + 1 }));
  const unknown = set.candidates
    .filter((candidate) => !values.has(candidate.shortCode))
    .sort(compareCandidateIdentity)
    .map((candidate) => ({ ...candidate, rank: null }));
  const candidates = [...known, ...unknown];

  const sortValues = new Map<string, string>();
  for (const candidate of known) {
    sortValues.set(candidate.standardCode, String(values.get(candidate.shortCode)));
  }
  const sortLines = known.map(
    (candidate) => `${candidate.standardCode}|${sortValues.get(candidate.standardCode)}`,
  );
  return {
    ...set,
    candidates,
    sortKey,
    unknownSortValueCount: unknown.length,
    sortValues,
    canonicalPayload: [set.canonicalPayload, '--sort--', sortKey, ...sortLines].join('\n'),
  };
}
```

- [ ] **Step 4: 통과 확인** — Run: `pnpm vitest run tests/unit/historical-universe.test.ts` — Expected: PASS

- [ ] **Step 5: 커밋** (Task 2 파일 포함)

```bash
git add src/shared/schemas/universe-sort.ts src/shared/schemas/historical-universe.ts src/server/modules/market-data/domain/historical-universe.ts tests/unit/historical-universe.test.ts
git commit -m "feat(market-data): 유니버스 후보 정렬 기준(applySortKey)과 공유 DTO 를 추가한다"
```

주의: 이 시점에도 `pnpm typecheck` 는 DTO 소비처(previewDto 등)에서 실패한다 — Task 6까지 순차로 해소된다. vitest 는 파일 단위로 통과한다.

---

### Task 4: 영업이익 point-in-time 소스

**Files:**
- Modify: `src/server/modules/market-data/application/ports.ts`
- Create: `src/server/modules/facts/application/operating-income-sort-source.ts`
- Test: `tests/unit/operating-income-sort-source.test.ts`

**Interfaces:**
- Consumes: `FactRepository.getFacts({ scope, keys, fields, asOfMaxTsMs })` (facts/application/ports.ts), `PitFactView` (facts/domain/pit-fact-view.ts)
- Produces (market-data/application/ports.ts):

```ts
/** 정렬용 재무 값 — 조립부가 facts 모듈로 연결한다 (market-data 는 facts 를 모른다) */
export interface FundamentalSortValueSource {
  /** shortCode → asOfMaxTsMs 이전에 공시된 것 기준 TTM 영업이익(원). 산출 불가 종목은 키가 없다 */
  ttmOperatingIncomeAsOf(
    shortCodes: readonly string[],
    asOfMaxTsMs: number,
  ): Promise<ReadonlyMap<string, number>>;
}
```

- Produces (facts 쪽): `class OperatingIncomeSortSource implements FundamentalSortValueSource` — 생성자 `(facts: FactRepository)`

- [ ] **Step 1: 실패하는 테스트 작성**

```ts
import { describe, expect, it } from 'vitest';
import { OperatingIncomeSortSource } from '../../src/server/modules/facts/application/operating-income-sort-source.js';
import type { Fact } from '../../src/server/modules/facts/domain/fact.js';
import type { FactRepository, FactQuery } from '../../src/server/modules/facts/application/ports.js';

function fakeRepo(facts: Fact[]): FactRepository {
  return {
    async getFacts(query: FactQuery) {
      return facts.filter(
        (f) =>
          (query.keys === undefined || query.keys.includes(f.key)) &&
          (query.fields === undefined || query.fields.includes(f.field)) &&
          (query.asOfMaxTsMs === undefined || f.asOfTsMs <= query.asOfMaxTsMs),
      );
    },
    async saveFacts() {},
    hasFacts: () => true,
    symbolsWithFacts: () => new Set(),
  };
}

function oi(key: string, periodKey: string, asOfTsMs: number, value: number): Fact {
  return { scope: 'SYMBOL', key, field: 'OPERATING_INCOME', periodKey, asOfTsMs, value, unit: 'KRW' };
}

describe('OperatingIncomeSortSource', () => {
  const CUTOFF = Date.parse('2020-06-15T15:00:00Z'); // 임의 컷오프

  it('직전 4개 분기 TTM 을 합산한다', async () => {
    const source = new OperatingIncomeSortSource(fakeRepo([
      oi('005930', '2019Q3', 1_000, 10),
      oi('005930', '2019Q4', 2_000, 20),
      oi('005930', '2020Q1', 3_000, 30),
      oi('005930', '2020Q2', 4_000, 40),
    ]));
    const result = await source.ttmOperatingIncomeAsOf(['005930'], CUTOFF);
    expect(result.get('005930')).toBe(100);
  });

  it('컷오프 이후 공시는 보이지 않는다 — 4분기가 안 채워지면 키가 없다', async () => {
    const source = new OperatingIncomeSortSource(fakeRepo([
      oi('005930', '2019Q3', 1_000, 10),
      oi('005930', '2019Q4', 2_000, 20),
      oi('005930', '2020Q1', 3_000, 30),
      oi('005930', '2020Q2', CUTOFF + 1, 40), // 미래 공시
    ]));
    const result = await source.ttmOperatingIncomeAsOf(['005930'], CUTOFF);
    // 컷오프 시점 최신 분기 2020Q1 기준 직전 4개(2019Q2~2020Q1) 중 2019Q2 가 없다
    expect(result.has('005930')).toBe(false);
  });

  it('팩트가 전혀 없는 종목은 키가 없다', async () => {
    const source = new OperatingIncomeSortSource(fakeRepo([]));
    const result = await source.ttmOperatingIncomeAsOf(['005930', '035720'], CUTOFF);
    expect(result.size).toBe(0);
  });
});
```

- [ ] **Step 2: 실패 확인** — Run: `pnpm vitest run tests/unit/operating-income-sort-source.test.ts` — Expected: FAIL (모듈 없음)

- [ ] **Step 3: 구현** — 포트를 `market-data/application/ports.ts`에 추가(위 Interfaces 블록 그대로), 소스 구현:

```ts
import type { FactRepository } from './ports.js';
import { PitFactView } from '../domain/pit-fact-view.js';
import type { FundamentalSortValueSource } from '../../market-data/application/ports.js';

/**
 * 과거 기준일 유니버스 정렬용 TTM 영업이익 (설계 2026-08-04-krx-universe-sort-dataset).
 *
 * PitFactView 를 그대로 쓴다 — point-in-time 컷오프·재집계 우선순위·TTM 4분기 합산
 * 규칙이 value-quality-rank 전략과 같은 코드를 타야 화면의 순위와 백테스트의 순위가
 * 다른 규칙으로 갈리지 않는다.
 */
export class OperatingIncomeSortSource implements FundamentalSortValueSource {
  constructor(private readonly facts: FactRepository) {}

  async ttmOperatingIncomeAsOf(
    shortCodes: readonly string[],
    asOfMaxTsMs: number,
  ): Promise<ReadonlyMap<string, number>> {
    const facts = await this.facts.getFacts({
      scope: 'SYMBOL',
      keys: shortCodes,
      fields: ['OPERATING_INCOME'],
      asOfMaxTsMs,
    });
    const view = new PitFactView(facts);
    view.advanceTo(asOfMaxTsMs);

    const result = new Map<string, number>();
    for (const code of new Set(shortCodes)) {
      const ttm = view.fundamentals(code)?.ttm('OPERATING_INCOME');
      if (ttm !== null && ttm !== undefined) result.set(code, ttm);
    }
    return result;
  }
}
```

- [ ] **Step 4: 통과 확인** — Run: `pnpm vitest run tests/unit/operating-income-sort-source.test.ts` — Expected: PASS

- [ ] **Step 5: 커밋**

```bash
git add src/server/modules/market-data/application/ports.ts src/server/modules/facts/application/operating-income-sort-source.ts tests/unit/operating-income-sort-source.test.ts
git commit -m "feat(facts): 기준일 컷오프 TTM 영업이익 정렬 소스를 추가한다"
```

---

### Task 5: HistoricalUniverseService.preview 에 sortBy

**Files:**
- Modify: `src/server/modules/market-data/application/historical-universe-service.ts`
- Modify: `src/server/bootstrap/container.ts` (sortValueSource 주입)
- Test: `tests/unit/historical-universe-service.test.ts`

**Interfaces:**
- Consumes: `applySortKey`, `SortedUniverseCandidateSet` (Task 3), `FundamentalSortValueSource` (Task 4), `kstEndOfDayMs` (Task 1)
- Produces:
  - `preview(requestedDate: string, sortBy: UniverseSortKey): Promise<HistoricalUniversePreview>` — 두 번째 인자 필수
  - `HistoricalUniversePreview.set` 타입이 `SortedUniverseCandidateSet` 으로 바뀜
  - `currentShortCodes(): Promise<ReadonlySet<string>>` — Task 9가 쓴다
  - `class SortValueUnavailableError extends Error` — 라우트가 502로 매핑 (Task 6)
  - deps 에 `readonly sortValueSource: FundamentalSortValueSource | null` 추가

- [ ] **Step 1: 실패하는 테스트 작성** — `tests/unit/historical-universe-service.test.ts`의 기존 fixture(가짜 source·clock)를 재사용해 추가. 기존 `service.preview('...')` 호출들은 전부 `service.preview('...', 'MKTCAP')` 으로 바꾼다:

```ts
describe('preview sortBy', () => {
  it('MKTCAP 은 기존과 같은 후보 순서·해시를 낸다', async () => {
    // 기존 preview 테스트 fixture 그대로, sortBy 만 명시
    const preview = await service.preview('2025-01-06', 'MKTCAP');
    expect(preview.set.sortKey).toBe('MKTCAP');
    expect(preview.set.candidates[0]!.rank).toBe(1);
  });

  it('OPERATING_INCOME 은 sortValueSource 값으로 rank 를 매기고 값 없는 종목이 뒤로 간다', async () => {
    // sortValueSource: { ttmOperatingIncomeAsOf: async () => new Map([['035720', 900]]) }
    const preview = await service.preview('2025-01-06', 'OPERATING_INCOME');
    expect(preview.set.sortKey).toBe('OPERATING_INCOME');
    expect(preview.set.candidates[0]!.shortCode).toBe('035720');
    expect(preview.set.candidates.at(-1)!.rank).toBeNull();
    expect(preview.set.unknownSortValueCount).toBeGreaterThan(0);
  });

  it('정렬 기준이 다르면 previewId·canonicalHash 가 다르다 — 캐시가 섞이지 않는다', async () => {
    const byCap = await service.preview('2025-01-06', 'MKTCAP');
    const byOi = await service.preview('2025-01-06', 'OPERATING_INCOME');
    expect(byOi.previewId).not.toBe(byCap.previewId);
    expect(byOi.canonicalHash).not.toBe(byCap.canonicalHash);
    // 같은 (날짜, 정렬) 재요청은 캐시를 탄다
    const again = await service.preview('2025-01-06', 'MKTCAP');
    expect(again.previewId).toBe(byCap.previewId);
  });

  it('sortValueSource 가 없거나 실패하면 SortValueUnavailableError 다 — MKTCAP 폴백 금지', async () => {
    // (1) sortValueSource: null 로 만든 서비스
    await expect(serviceWithoutSource.preview('2025-01-06', 'OPERATING_INCOME'))
      .rejects.toBeInstanceOf(SortValueUnavailableError);
    // (2) ttmOperatingIncomeAsOf 가 reject 하는 서비스
    await expect(serviceWithFailingSource.preview('2025-01-06', 'OPERATING_INCOME'))
      .rejects.toBeInstanceOf(SortValueUnavailableError);
  });

  it('컷오프는 적용거래일 KST 하루 끝이다', async () => {
    // sortValueSource 를 스파이로 만들어 asOfMaxTsMs 인자를 캡처한다
    await service.preview('2025-01-06', 'OPERATING_INCOME');
    expect(captured.asOfMaxTsMs).toBe(kstEndOfDayMs('2025-01-06'));
  });
});
```

- [ ] **Step 2: 실패 확인** — Run: `pnpm vitest run tests/unit/historical-universe-service.test.ts` — Expected: FAIL

- [ ] **Step 3: 구현**

핵심 변경 (historical-universe-service.ts):

```ts
export class SortValueUnavailableError extends Error {
  constructor(message = '영업이익 데이터를 읽을 수 없어 이 정렬 기준으로 조회할 수 없습니다.') {
    super(message);
    this.name = 'SortValueUnavailableError';
  }
}
```

- deps 에 `readonly sortValueSource: FundamentalSortValueSource | null;` 추가.
- `HistoricalUniversePreview.set: SortedUniverseCandidateSet` 으로 타입 변경.
- `preview(requestedDate, sortBy)`: pending 키를 `` `${requestedDate}|${sortBy}` `` 로, `buildPreview(requestedDate, sortBy)` 로 전달.
- `requestCacheKey(requestedDate, sortBy, effectiveTradingDate)` 로 시그니처 확장 — 키 문자열 `` `${requestedDate}|${sortBy}|${this.effectiveCacheKey(effectiveTradingDate)}` ``. `deletePreview` 도 preview 의 sortKey 로 같은 키를 만든다 (`preview.set.sortKey`).
- `buildPreview` 마지막에 정렬 적용:

```ts
    const { set, canonicalHash, fetchedAtMs } = effectiveCached.value;
    const sortedSet = await this.applySort(set, sortBy, effective.date);
    const sortedHash = sortBy === 'MKTCAP'
      ? canonicalHash
      : createHash('sha256').update(sortedSet.canonicalPayload).digest('hex');
    const preview: HistoricalUniversePreview = {
      previewId: newId('uvp'),
      requestedDate,
      effectiveTradingDate: effective.date,
      usableFromDate: addCalendarDays(effective.date, 1),
      usableFromRule: USABLE_FROM_RULE,
      canonicalHash: sortedHash,
      set: sortedSet,
      fetchedAtMs,
    };
```

```ts
  /** 정렬 값 조회 실패를 MKTCAP 결과로 조용히 대체하지 않는다 — 요청과 다른 정렬
   *  기준의 스냅샷이 생길 수 있어서다. 실패는 실패로 알린다 (설계 §오류 처리). */
  private async applySort(
    set: UniverseCandidateSet,
    sortBy: UniverseSortKey,
    effectiveTradingDate: string,
  ): Promise<SortedUniverseCandidateSet> {
    if (sortBy === 'MKTCAP') return applySortKey(set, 'MKTCAP');
    if (this.deps.sortValueSource === null) throw new SortValueUnavailableError();
    let values: ReadonlyMap<string, number>;
    try {
      values = await this.deps.sortValueSource.ttmOperatingIncomeAsOf(
        set.candidates.map((candidate) => candidate.shortCode),
        kstEndOfDayMs(effectiveTradingDate),
      );
    } catch (error) {
      this.deps.logger.error(
        { event: 'krx.universe.sort-values.failed', sortBy, err: error },
        'universe sort value lookup failed',
      );
      throw new SortValueUnavailableError();
    }
    return applySortKey(set, sortBy, values);
  }
```

- `currentShortCodes()` 추가:

```ts
  /** 현재 상장 단축코드 집합 — 데이터셋의 「현시점 조회 불가」 판정에 쓴다 (TTL 은 표준코드 맵과 공유) */
  async currentShortCodes(): Promise<ReadonlySet<string>> {
    return new Set((await this.currentStandardCodeMap()).keys());
  }
```

container.ts: `OperatingIncomeSortSource` import 후,

```ts
  const historicalUniverseService = new HistoricalUniverseService({
    source: krxSource,
    configured: config.krxApiKey !== null,
    approvalExpiry: config.krxApprovalExpiry,
    sortValueSource: new OperatingIncomeSortSource(factRepository),
    clock,
    logger,
  });
```

기존 단위 테스트들의 `new HistoricalUniverseService({...})` 생성부에 `sortValueSource: null` 을 추가하고 `preview(date)` 호출을 `preview(date, 'MKTCAP')` 로 바꾼다.

- [ ] **Step 4: 통과 확인** — Run: `pnpm vitest run tests/unit/historical-universe-service.test.ts` — Expected: PASS

- [ ] **Step 5: 커밋**

```bash
git add src/server/modules/market-data/application/historical-universe-service.ts src/server/bootstrap/container.ts tests/unit/historical-universe-service.test.ts
git commit -m "feat(market-data): 과거 유니버스 preview 에 정렬 기준(sortBy)을 추가한다"
```

---

### Task 6: preview 라우트 sortBy + DTO + 502 매핑

**Files:**
- Modify: `src/server/modules/market-data/presentation/universe-routes.ts`
- Test: `tests/integration/universe-routes.test.ts`

**Interfaces:**
- Consumes: `SortValueUnavailableError` (Task 5), DTO 확장 (Task 2), `SortedUniverseCandidateSet`
- Produces: `POST /universe/historical/preview` body `{ date, sortBy? }` (기본 `MKTCAP`); 응답에 `sortBy`·`unknownSortValueCount`·후보별 `sortValue`

- [ ] **Step 1: 실패하는 테스트 작성** — `tests/integration/universe-routes.test.ts`에 추가. facts 시딩은 `app.container.factRepository.saveFacts([...])` 로 한다:

```ts
it('sortBy 를 생략하면 MKTCAP 이고 응답에 정렬 메타가 실린다', async () => {
  const { app, fake, cookie } = await setupUniverse();
  seedTradingDay(fake, '2025-01-06');
  const res = await app.app.inject({
    method: 'POST', url: '/api/v1/universe/historical/preview',
    cookies: { qp_session: cookie }, payload: { date: '2025-01-06' },
  });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toMatchObject({ sortBy: 'MKTCAP', unknownSortValueCount: 0 });
  expect(res.json().candidates[0].sortValue).toBe(res.json().candidates[0].marketCapKrw);
});

it('sortBy=OPERATING_INCOME 은 TTM 영업이익 순으로 rank 를 낸다', async () => {
  const { app, fake, cookie } = await setupUniverse();
  seedTradingDay(fake, '2025-01-06'); // 005930(시총 350조), 035720(시총 20조)
  const asOf = Date.parse('2024-06-01T00:00:00Z');
  const oi = (key: string, periodKey: string, value: number) =>
    ({ scope: 'SYMBOL' as const, key, field: 'OPERATING_INCOME', periodKey, asOfTsMs: asOf, value, unit: 'KRW' });
  // 카카오만 4분기 채운다 — 삼성전자는 값 없음 → 뒤로 밀린다
  await app.container.factRepository.saveFacts([
    oi('035720', '2023Q2', 100), oi('035720', '2023Q3', 100),
    oi('035720', '2023Q4', 100), oi('035720', '2024Q1', 100),
  ]);
  const res = await app.app.inject({
    method: 'POST', url: '/api/v1/universe/historical/preview',
    cookies: { qp_session: cookie }, payload: { date: '2025-01-06', sortBy: 'OPERATING_INCOME' },
  });
  expect(res.statusCode).toBe(200);
  const body = res.json();
  expect(body.sortBy).toBe('OPERATING_INCOME');
  expect(body.candidates[0]).toMatchObject({ shortCode: '035720', rank: 1, sortValue: '400' });
  expect(body.candidates[1]).toMatchObject({ shortCode: '005930', rank: null, sortValue: null });
  expect(body.unknownSortValueCount).toBe(1);
});

it('허용되지 않는 sortBy 는 400 이다', async () => {
  const { app, fake, cookie } = await setupUniverse();
  seedTradingDay(fake, '2025-01-06');
  const res = await app.app.inject({
    method: 'POST', url: '/api/v1/universe/historical/preview',
    cookies: { qp_session: cookie }, payload: { date: '2025-01-06', sortBy: 'PER' },
  });
  expect(res.statusCode).toBe(400);
});
```

- [ ] **Step 2: 실패 확인** — Run: `pnpm vitest run tests/integration/universe-routes.test.ts` — Expected: FAIL

- [ ] **Step 3: 구현** — universe-routes.ts:

```ts
const previewRequestSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  sortBy: z.enum(UNIVERSE_SORT_KEYS).default('MKTCAP'),
});
```

(`import { UNIVERSE_SORT_KEYS } from '../../../../shared/schemas/universe-sort.js';` — zod `z.enum` 은 readonly 배열을 받는다. 타입 오류가 나면 `z.enum(['MKTCAP', 'OPERATING_INCOME'])` 로 직접 나열하고 상수와의 일치를 단위 테스트로 잡아도 된다.)

- 라우트 핸들러: `historicalUniverseService.preview(parsed.data.date, parsed.data.sortBy)`.
- 400 메시지 갱신: `'date(YYYY-MM-DD)·sortBy 필드가 올바르지 않습니다'`.
- `candidateDto` 에 sortValues 전달:

```ts
function candidateDto(
  candidate: EligibleCandidate,
  sortValues: ReadonlyMap<string, string>,
): HistoricalCandidateDto {
  return {
    // ...기존 필드...
    sortValue: sortValues.get(candidate.standardCode) ?? null,
  };
}
```

- `previewDto` 에 `sortBy: preview.set.sortKey`, `unknownSortValueCount: preview.set.unknownSortValueCount` 추가, candidates 매핑에 `preview.set.sortValues` 전달.
- `summaryDto` 에 `sortKey: summary.sortKey` 추가 (Task 8에서 서비스 쪽 필드가 생기기 전까지 typecheck 실패 — Task 8과 순서 조정 가능하나, 여기서는 `sortKey: summary.sortKey` 를 미리 쓰고 Task 8에서 서비스가 채우도록 한다. 순차 실행 시 이 줄은 Task 8 완료 전 typecheck 에 걸리므로, **이 태스크에서는 summaryDto 를 건드리지 않고 Task 8에서 함께 바꾼다**).
- `mapKnownError` 에 502 분기 추가:

```ts
  if (error instanceof SortValueUnavailableError) {
    return { statusCode: 502, message: error.message };
  }
```

- [ ] **Step 4: 통과 확인** — Run: `pnpm vitest run tests/integration/universe-routes.test.ts` — Expected: PASS

- [ ] **Step 5: 커밋**

```bash
git add src/server/modules/market-data/presentation/universe-routes.ts tests/integration/universe-routes.test.ts
git commit -m "feat(market-data): preview 라우트가 sortBy 를 받고 정렬 메타를 응답한다"
```

---

### Task 7: datasets.universe_snapshot_id 마이그레이션

**Files:**
- Modify: `src/server/shared/db/schema.ts`
- Create: `migrations/0003_*.sql` (drizzle-kit 생성)

**Interfaces:**
- Produces: `datasets.universeSnapshotId: text('universe_snapshot_id')` nullable, FK → `universe_snapshots.id`

- [ ] **Step 1: schema.ts 수정** — `datasets` 테이블 (universeSnapshots 선언이 datasets 보다 아래에 있으므로 순환을 피해 콜백 없이 문자열 참조가 안 되면, `references(() => universeSnapshots.id)` 는 지연 평가라 선언 순서와 무관하게 동작한다):

```ts
export const datasets = sqliteTable('datasets', {
  id: text('id').primaryKey(),
  name: text('name').notNull().unique(),
  description: text('description'),
  /**
   * KRX 스냅샷 확정이 만든 데이터셋이면 그 스냅샷 — 기준 시점·정렬 기준을 여기 중복
   * 저장하지 않고 join 으로 읽는다. 손으로 만든 데이터셋은 null.
   */
  universeSnapshotId: text('universe_snapshot_id').references(() => universeSnapshots.id),
  createdAtMs: integer('created_at_ms').notNull(),
  updatedAtMs: integer('updated_at_ms').notNull(),
});
```

- [ ] **Step 2: 마이그레이션 생성** — Run: `pnpm db:generate` — Expected: `migrations/0003_*.sql` 생성, 내용에 `ALTER TABLE \`datasets\` ADD \`universe_snapshot_id\` text REFERENCES universe_snapshots(id);` 유사 구문

- [ ] **Step 3: 마이그레이션 적용 확인** — 통합 테스트가 마이그레이션을 자동 적용하므로 아무 통합 테스트 하나로 확인. Run: `pnpm vitest run tests/integration/universe-snapshot-schema.test.ts` — Expected: PASS

- [ ] **Step 4: 커밋**

```bash
git add src/server/shared/db/schema.ts migrations/
git commit -m "feat(db): datasets 에 universe_snapshot_id 를 추가한다"
```

---

### Task 8: 스냅샷 확정 — sortKey 저장 + 데이터셋 자동 생성

**Files:**
- Modify: `src/server/modules/market-data/application/universe-snapshot-service.ts`
- Modify: `src/server/modules/market-data/presentation/universe-routes.ts` (summaryDto 에 sortKey)
- Test: `tests/unit/universe-snapshot-service.test.ts`, `tests/integration/universe-routes.test.ts`

**Interfaces:**
- Consumes: Task 5 preview(`set.sortKey`), Task 7 스키마, `UNIVERSE_SORT_LABELS` (Task 2)
- Produces:
  - `UniverseSnapshotSummary.sortKey: UniverseSortKey` 추가
  - `createFromPreview` 가 같은 트랜잭션에서 `datasets` + `dataset_symbols` 생성
  - 데이터셋 이름 `KRX {적용거래일} {라벨}순 {N}종목`, 충돌 시 ` (2)` 접미
  - `TOP_MARKET_CAP_N` 요청 + preview.sortKey ≠ MKTCAP → `SnapshotSelectionError`(400)

- [ ] **Step 1: 실패하는 테스트 작성** — `tests/unit/universe-snapshot-service.test.ts`의 기존 fixture(가짜 universe 서비스에 preview 주입) 재사용. preview fixture 의 `set` 에 `sortKey`·`unknownSortValueCount`·`sortValues` 필드를 채워 넣는다 (기존 fixture 는 `applySortKey(set, 'MKTCAP')` 로 감싸면 된다):

```ts
it('스냅샷 sortKey 는 preview 의 정렬 기준을 그대로 저장한다', async () => {
  // preview.set = applySortKey(baseSet, 'OPERATING_INCOME', new Map([...]))
  const detail = await service.createFromPreview({ previewId, selectedStandardCodes: [codeA], selectionMethod: 'MANUAL_FROM_KRX_SNAPSHOT', selectionN: null });
  const row = db.select().from(universeSnapshots).all()[0]!;
  expect(row.sortKey).toBe('OPERATING_INCOME');
  expect(detail.sortKey).toBe('OPERATING_INCOME');
});

it('MKTCAP 이 아닌 preview 에 TOP_MARKET_CAP_N 을 보내면 400 계열 오류다', async () => {
  await expect(service.createFromPreview({
    previewId: oiPreviewId, selectedStandardCodes: topCodes,
    selectionMethod: 'TOP_MARKET_CAP_N', selectionN: topCodes.length,
  })).rejects.toBeInstanceOf(SnapshotSelectionError);
});

it('확정하면 스냅샷과 같은 트랜잭션으로 데이터셋이 생긴다 — 이름·연결·종목', async () => {
  await service.createFromPreview({ previewId, selectedStandardCodes: [codeA, codeB], selectionMethod: 'MANUAL_FROM_KRX_SNAPSHOT', selectionN: null });
  const dataset = db.select().from(datasets).all()[0]!;
  expect(dataset.name).toBe('KRX 2025-01-06 시가총액순 2종목');
  expect(dataset.universeSnapshotId).toBe(db.select().from(universeSnapshots).all()[0]!.id);
  const refs = db.select().from(datasetSymbols).all();
  expect(refs.map((r) => r.code).sort()).toEqual([shortCodeA, shortCodeB].sort());
});

it('같은 이름이 이미 있으면 접미를 붙인다', async () => {
  await service.createFromPreview({ /* 같은 preview, 같은 선택 */ });
  await service.createFromPreview({ /* 두 번째 확정 */ });
  const names = db.select().from(datasets).all().map((d) => d.name).sort();
  expect(names).toEqual(['KRX 2025-01-06 시가총액순 2종목', 'KRX 2025-01-06 시가총액순 2종목 (2)']);
});
```

- [ ] **Step 2: 실패 확인** — Run: `pnpm vitest run tests/unit/universe-snapshot-service.test.ts` — Expected: FAIL

- [ ] **Step 3: 구현** — universe-snapshot-service.ts:

- import 에 `datasets`, `datasetSymbols`, `UNIVERSE_SORT_LABELS` 추가.
- `UniverseSnapshotSummary` 에 `readonly sortKey: UniverseSortKey;` 추가, `toSummary` 에 `sortKey: row.sortKey as UniverseSortKey` 추가.
- `validateSelection` TOP 분기 맨 앞에:

```ts
      if (preview.set.sortKey !== 'MKTCAP') {
        throw new SnapshotSelectionError(
          '시가총액 상위 N 선택은 시가총액 정렬 미리보기에서만 쓸 수 있습니다.',
        );
      }
```

- 트랜잭션 안 `universeSnapshots` insert 의 `sortKey: 'MKTCAP'` 을 `sortKey: preview.set.sortKey` 로 교체.
- `universeSnapshotSymbols` insert 다음에 데이터셋 생성:

```ts
        // 스냅샷은 위저드 밖에서 보이지 않는다 — 같은 구성을 데이터 화면에서도 쓰도록
        // 데이터셋으로 함께 기록한다. 같은 트랜잭션이어야 "스냅샷은 있는데 데이터셋이
        // 없다"는 어중간한 상태가 없다 (설계 §3).
        const baseName =
          `KRX ${preview.effectiveTradingDate} ` +
          `${UNIVERSE_SORT_LABELS[preview.set.sortKey]}순 ${selected.length}종목`;
        let datasetName = baseName;
        for (
          let suffix = 2;
          tx.select().from(datasets).where(eq(datasets.name, datasetName)).get() !== undefined;
          suffix += 1
        ) {
          datasetName = `${baseName} (${suffix})`;
        }
        datasetId = newId('ds');
        tx.insert(datasets).values({
          id: datasetId,
          name: datasetName,
          description: null,
          universeSnapshotId: snapshotId,
          createdAtMs,
          updatedAtMs: createdAtMs,
        }).run();
        const shortCodes = [...new Set(selected.map((candidate) => candidate.shortCode))].sort();
        for (const code of shortCodes) {
          tx.insert(datasetSymbols).values({ datasetId, code }).run();
        }
```

(`let datasetId = '';` 를 `let snapshotId = '';` 옆에 선언. 감사로그에 `datasetId` 포함: `this.deps.audit.record('system', 'universe.snapshot.created', { snapshotId, datasetId, ... })`.)

- universe-routes.ts `summaryDto` 에 `sortKey: summary.sortKey,` 추가.

- [ ] **Step 4: 통과 확인** — Run: `pnpm vitest run tests/unit/universe-snapshot-service.test.ts tests/integration/universe-routes.test.ts tests/integration/universe-snapshot-schema.test.ts` — Expected: PASS. 기존 스냅샷 테스트가 데이터셋 생성 때문에 깨지면(예: DB 행 수 단언) 단언을 새 동작에 맞게 갱신한다.

- [ ] **Step 5: 커밋**

```bash
git add src/server/modules/market-data/application/universe-snapshot-service.ts src/server/modules/market-data/presentation/universe-routes.ts tests/unit/universe-snapshot-service.test.ts tests/integration/universe-routes.test.ts
git commit -m "feat(market-data): 스냅샷 확정이 sortKey 를 저장하고 데이터셋을 함께 만든다"
```

---

### Task 9: 데이터셋 응답 — 스냅샷 메타 + 현시점 미상장 종목

**Files:**
- Modify: `src/server/modules/market-data/application/dataset-service.ts`
- Modify: `src/server/modules/market-data/presentation/dataset-routes.ts`
- Modify: `src/server/bootstrap/server.ts` (currentShortCodes 썽크 전달)
- Test: `tests/integration/universe-routes.test.ts` (또는 신규 `tests/integration/dataset-snapshot-link.test.ts`)

**Interfaces:**
- Consumes: Task 7 스키마, Task 5 `currentShortCodes()`
- Produces:
  - `DatasetSummary`(서버)에 `readonly universeSnapshot: { readonly snapshotId: string; readonly effectiveTradingDate: string; readonly sortKey: string } | null` 추가
  - `GET /datasets` 응답의 각 dataset 에 `unlistedSymbols: string[] | null` 추가 (null = 판정 불가 또는 스냅샷 비연결)
  - `registerDatasetRoutes` 마지막 인자 앞에 `currentShortCodes: () => Promise<ReadonlySet<string>>` 파라미터 추가

- [ ] **Step 1: 실패하는 테스트 작성** — `tests/integration/universe-routes.test.ts` 에 추가 (KRX fake 를 이미 갖고 있어 여기가 적합):

```ts
it('스냅샷이 만든 데이터셋은 목록에 기준 시점·정렬 기준·미상장 종목이 실린다', async () => {
  const { app, fake, cookie } = await setupUniverse();
  seedTradingDay(fake, '2025-01-06');
  // 현재(publishedThrough 시점) 기본정보에는 005930 만 있다 → 035720 은 미상장 판정
  // seedTradingDay 가 심는 과거 날짜와 별개로, currentStandardCodeMap 이 조회하는
  // 최신 날짜(테스트 clock 의 어제)에 기본정보를 심는다.
  const preview = await app.app.inject({
    method: 'POST', url: '/api/v1/universe/historical/preview',
    cookies: { qp_session: cookie }, payload: { date: '2025-01-06' },
  });
  const { previewId, candidates } = preview.json();
  await app.app.inject({
    method: 'POST', url: '/api/v1/universe/snapshots',
    cookies: { qp_session: cookie },
    payload: {
      previewId,
      standardCodes: candidates.map((c: { standardCode: string }) => c.standardCode),
      selectionMethod: 'MANUAL_FROM_KRX_SNAPSHOT',
    },
  });

  const res = await app.app.inject({
    method: 'GET', url: '/api/v1/datasets', cookies: { qp_session: cookie },
  });
  const dataset = res.json().datasets[0];
  expect(dataset.universeSnapshot).toMatchObject({ effectiveTradingDate: '2025-01-06', sortKey: 'MKTCAP' });
  expect(dataset.unlistedSymbols).toEqual(['035720']);
});

it('현재 목록 조회가 실패하면 unlistedSymbols 는 null 이고 응답은 200 이다', async () => {
  // 위와 같은 흐름이되 현재 날짜 기본정보를 심지 않아 currentShortCodes 가 실패한다
  // (31일 탐색 실패 → HistoricalUniverseDateError). 응답은 그래도 200.
  const res = await app.app.inject({ method: 'GET', url: '/api/v1/datasets', cookies: { qp_session: cookie } });
  expect(res.statusCode).toBe(200);
  expect(res.json().datasets[0].unlistedSymbols).toBeNull();
});
```

주의: `currentStandardCodeMap` 은 `publishedThrough()`(오늘 기준 어제)부터 뒤로 탐색한다 — 테스트 clock 이 고정돼 있으면 그 날짜(`kstDateOf(clock.now()) - 1일` 부근)에 `fake.setResponse('stk_isu_base_info' / 'ksq_isu_base_info', ...)` 를 심는다. 첫 테스트에서 KOSPI 는 005930 한 건, KOSDAQ 은 **비어 있지 않은 다른 코드 한 건**(예: 999999)을 심어야 한다 — 두 시장 중 하나라도 빈 배열이면 탐색이 이전 날로 넘어가 버린다.

- [ ] **Step 2: 실패 확인** — Run: `pnpm vitest run tests/integration/universe-routes.test.ts` — Expected: FAIL

- [ ] **Step 3: 구현**

dataset-service.ts — join 추가:

```ts
export interface DatasetSummary {
  // ...기존 필드...
  /** KRX 스냅샷 확정이 만든 데이터셋이면 그 출처 — 기준 시점·정렬 기준 표시용 */
  readonly universeSnapshot: {
    readonly snapshotId: string;
    readonly effectiveTradingDate: string;
    readonly sortKey: string;
  } | null;
}
```

`listDatasets`/`getDataset` 이 `universeSnapshotId` 가 있는 행에 대해 `universeSnapshots` 를 조회해 채운다. `listDatasets` 는 N+1 을 피해 한 번에 읽는다:

```ts
    const snapshotIds = rows
      .map((row) => row.universeSnapshotId)
      .filter((id): id is string => id !== null);
    const snapshotById = new Map(
      snapshotIds.length === 0
        ? []
        : this.db
            .select()
            .from(universeSnapshots)
            .where(inArray(universeSnapshots.id, snapshotIds))
            .all()
            .map((row) => [row.id, row]),
    );
```

`toSummary(row, codes, snapshotRow)` 로 시그니처 확장:

```ts
      universeSnapshot: snapshotRow
        ? {
            snapshotId: snapshotRow.id,
            effectiveTradingDate: snapshotRow.effectiveTradingDate,
            sortKey: snapshotRow.sortKey,
          }
        : null,
```

dataset-routes.ts — 파라미터 추가(`symbolsWithFacts` 다음):

```ts
  /** 현재 상장 단축코드 집합 — 조립부가 market-data 유니버스 서비스로 연결한다.
   *  실패(미설정·승인만료·KRX 오류)는 여기서 삼키지 않고 그대로 던진다 — 라우트가
   *  null 로 강등해 응답은 계속 낸다. */
  currentShortCodes: () => Promise<ReadonlySet<string>>,
```

`GET /datasets` 핸들러 교체:

```ts
  app.get('/datasets', { preHandler: requireAuth }, async (request) => {
    const summaries = datasetService.listDatasets();
    // 스냅샷 연결 데이터셋이 있을 때만 현재 목록을 조회한다 — 손으로 만든 데이터셋만
    // 있으면 KRX 호출이 없어야 한다.
    let listed: ReadonlySet<string> | null = null;
    if (summaries.some((dataset) => dataset.universeSnapshot !== null)) {
      try {
        listed = await currentShortCodes();
      } catch (error) {
        // 판정 불가는 데이터셋 목록 실패가 아니다 — 전 종목 정상 취급 + 로그 (설계 §4)
        request.log.warn(
          { module: 'market-data', event: 'dataset.listing-check.failed', err: error },
          'current listing lookup failed; skipping unlisted diff',
        );
      }
    }
    return {
      datasets: summaries.map((dataset) => ({
        ...dataset,
        unlistedSymbols:
          dataset.universeSnapshot !== null && listed !== null
            ? dataset.symbols.filter((code) => !listed.has(code))
            : null,
      })),
    };
  });
```

server.ts — `registerDatasetRoutes(...)` 호출에 인자 추가 (`symbolsWithFacts` 썽크 다음, `requireAuth` 앞):

```ts
        () => container.historicalUniverseService.currentShortCodes(),
```

- [ ] **Step 4: 통과 확인** — Run: `pnpm vitest run tests/integration/universe-routes.test.ts tests/integration/market-data.test.ts` — Expected: PASS (market-data.test.ts 는 GET /datasets 기존 단언 회귀 확인)

- [ ] **Step 5: 서버 전체 typecheck** — Run: `pnpm typecheck` — Expected: 서버 프로그램 오류 0. 웹(krx-snapshot-step 등)은 아직 실패할 수 있다 — Task 11~13에서 해소.

- [ ] **Step 6: 커밋**

```bash
git add src/server/modules/market-data/application/dataset-service.ts src/server/modules/market-data/presentation/dataset-routes.ts src/server/bootstrap/server.ts tests/integration/universe-routes.test.ts
git commit -m "feat(market-data): 데이터셋 목록에 스냅샷 출처와 현시점 미상장 종목을 싣는다"
```

---

### Task 10: 프론트 선택 헬퍼 togglePageSelection

**Files:**
- Modify: `src/web/features/backtests/krx-selection.ts`
- Test: `tests/unit/krx-selection.test.ts`

**Interfaces:**
- Produces: `togglePageSelection(selected: ReadonlySet<string>, pageCodes: readonly string[]): ReadonlySet<string>` — 페이지 전체가 이미 선택돼 있으면 페이지 몫을 해제, 아니면 페이지 전체를 추가

- [ ] **Step 1: 실패하는 테스트 작성** — `tests/unit/krx-selection.test.ts`에 추가:

```ts
describe('togglePageSelection', () => {
  it('페이지에 미선택이 하나라도 있으면 페이지 전체를 추가한다', () => {
    const next = togglePageSelection(new Set(['a']), ['a', 'b', 'c']);
    expect([...next].sort()).toEqual(['a', 'b', 'c']);
  });

  it('페이지 전체가 이미 선택돼 있으면 페이지 몫만 해제한다 — 다른 페이지 선택은 남는다', () => {
    const next = togglePageSelection(new Set(['a', 'b', 'z']), ['a', 'b']);
    expect([...next]).toEqual(['z']);
  });

  it('빈 페이지는 그대로 돌려준다', () => {
    const original = new Set(['a']);
    expect(togglePageSelection(original, [])).toBe(original);
  });
});
```

- [ ] **Step 2: 실패 확인** — Run: `pnpm vitest run tests/unit/krx-selection.test.ts` — Expected: FAIL

- [ ] **Step 3: 구현** — krx-selection.ts에 추가:

```ts
/**
 * 「페이지 선택」 토글. 페이지 전체가 이미 선택된 상태에서 다시 누르면 해제다 —
 * 추가만 하는 버튼이면 잘못 누른 페이지를 되돌릴 방법이 체크박스 개별 해제뿐이다.
 */
export function togglePageSelection(
  selected: ReadonlySet<string>,
  pageCodes: readonly string[],
): ReadonlySet<string> {
  if (pageCodes.length === 0) return selected;
  const next = new Set(selected);
  const allSelected = pageCodes.every((code) => next.has(code));
  for (const code of pageCodes) {
    if (allSelected) next.delete(code);
    else next.add(code);
  }
  return next;
}
```

- [ ] **Step 4: 통과 확인** — Run: `pnpm vitest run tests/unit/krx-selection.test.ts` — Expected: PASS

- [ ] **Step 5: 커밋**

```bash
git add src/web/features/backtests/krx-selection.ts tests/unit/krx-selection.test.ts
git commit -m "feat(backtests): 후보 페이지 선택 토글 헬퍼를 추가한다"
```

---

### Task 11: 위저드 KRX 단계 UI — 정렬 Select + 선택 버튼 개편

**Files:**
- Modify: `src/web/features/backtests/krx-snapshot-step.tsx`

**Interfaces:**
- Consumes: `UNIVERSE_SORT_LABELS`, `UniverseSortKey` (Task 2), `togglePageSelection` (Task 10), preview 응답의 `sortBy`·`unknownSortValueCount`·`sortValue` (Task 6), summary 의 `sortKey` (Task 8)
- Produces: 사용자 화면 변경 — 컴포넌트 시그니처는 불변

- [ ] **Step 1: 구현** — krx-snapshot-step.tsx 수정 사항 전체:

(1) import 추가:

```ts
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { UNIVERSE_SORT_LABELS, type UniverseSortKey } from '../../../shared/schemas/universe-sort.js';
import { selectionMethodOf, togglePageSelection, topNCodes } from './krx-selection';
```

(2) 상태 추가: `const [sortBy, setSortBy] = useState<UniverseSortKey>('MKTCAP');`

(3) previewMutation: `postJson(... , { date: requestedDate, sortBy })` — mutationFn 인자를 `{ date, sortBy }` 객체로 바꾸거나 클로저로 sortBy 를 읽는다. 조회 버튼 `onClick={() => previewMutation.mutate({ date, sortBy })}`.

(4) 조회 카드: 기준일 Input 옆에 정렬 Select. 준비 안 된 지표는 disabled:

```tsx
<div className="space-y-1">
  <Label htmlFor="krx-sort">정렬 기준</Label>
  <Select value={sortBy} onValueChange={(value) => setSortBy(value as UniverseSortKey)}>
    <SelectTrigger id="krx-sort" className="h-11 w-44">
      <SelectValue />
    </SelectTrigger>
    <SelectContent>
      <SelectItem value="MKTCAP">시가총액 상위</SelectItem>
      <SelectItem value="OPERATING_INCOME">영업이익 상위</SelectItem>
      <SelectItem value="PER" disabled>PER 상위 (데이터 준비 중)</SelectItem>
      <SelectItem value="PBR" disabled>PBR 상위 (데이터 준비 중)</SelectItem>
      <SelectItem value="EV_EBITDA" disabled>EV/EBITDA 상위 (데이터 준비 중)</SelectItem>
    </SelectContent>
  </Select>
</div>
```

CardDescription 을 `KOSPI·KOSDAQ 보통주를 그 시점 기준으로 조회합니다. 정렬 기준을 고르세요.` 로 바꾼다.

(5) 요약 카드: `preview.sortBy === 'OPERATING_INCOME'` 이면 줄 추가:

```tsx
{preview.sortBy === 'OPERATING_INCOME' ? (
  <p>영업이익 데이터 없는 종목 {preview.unknownSortValueCount}개 — 목록 끝에 있습니다</p>
) : null}
```

(6) 버튼 줄 교체 — `TOP_N`·`topDisabledReason`·`selectTopN` 제거, 기존 상위 N 버튼 자리를:

```tsx
<span className="ml-auto flex items-center gap-2">
  <Button type="button" variant="outline" size="sm"
    onClick={() => setSelected(togglePageSelection(selected, visible.map((c) => c.standardCode)))}>
    페이지 선택
  </Button>
  <Button type="button" variant="outline" size="sm"
    // 검색 필터가 적용된 후보 전체다 — 지금 보이는 페이지와 무관하다
    onClick={() => setSelected(new Set([...selected, ...filtered.map((c) => c.standardCode)]))}>
    전체 선택
  </Button>
  <Button type="button" variant="outline" size="sm"
    disabled={selected.size === 0}
    onClick={() => setSelected(new Set())}>
    전체 해제
  </Button>
</span>
```

(7) confirm(): 자동 상위 N 판정은 시가총액 정렬에서만 — 다른 정렬의 "상위 N" 은 데이터 보유 종목 안에서만 참이라 그 이름으로 저장하지 않는다:

```ts
  const confirm = (): void => {
    if (preview === null || selected.size === 0) return;
    const method =
      preview.sortBy === 'MKTCAP'
        ? selectionMethodOf(selected, candidates, MAX_UNIVERSE_SYMBOLS)
        : 'MANUAL_FROM_KRX_SNAPSHOT';
    createMutation.mutate({
      previewId: preview.previewId,
      standardCodes: Array.from(selected),
      selectionMethod: method,
      ...(method === 'TOP_MARKET_CAP_N' ? { selectionN: selected.size } : {}),
    });
  };
```

(`TOP_N` 상수 제거로 `MAX_UNIVERSE_SYMBOLS` 직접 사용. 파일 상단 주석의 「상위 N」 설명도 새 동작으로 고친다.)

(8) 후보 행 보조 정보 — 정렬 기준 값 표시:

```tsx
const sortLabel = UNIVERSE_SORT_LABELS[preview.sortBy];
const sortValueText =
  candidate.sortValue === null
    ? preview.sortBy === 'MKTCAP' ? '확인 불가' : '데이터 없음'
    : `${formatCompactNumber(Number(candidate.sortValue))}원`;
// <p>{candidate.market} · {sortLabel} {sortValueText}{candidate.rank !== null ? ` · ${candidate.rank}위` : ''}</p>
```

(기존 `marketCap` 변수 계산은 제거 — sortValue 로 통합. MKTCAP 일 때 sortValue == marketCapKrw.)

(9) 「기존 스냅샷 다시 쓰기」 행 문구 — sortKey 라벨 반영:

```tsx
요청 {snapshot.requestedDate} · {UNIVERSE_SORT_LABELS[snapshot.sortKey]}순 ·{' '}
{snapshot.selectionMethod === 'TOP_MARKET_CAP_N'
  ? `시가총액 상위 ${snapshot.selectionN ?? MAX_UNIVERSE_SYMBOLS}`
  : '수동 선택'}
```

- [ ] **Step 2: 검증** — Run: `pnpm typecheck` — Expected: 웹 프로그램에서 krx-snapshot-step 관련 오류 0 (datasets-panel 은 Task 13 전까지 오류 가능). `@/components/ui/select` 가 없으면 `pnpm exec shadcn add select` 로 추가한다.

- [ ] **Step 3: 커밋**

```bash
git add src/web/features/backtests/krx-snapshot-step.tsx src/web/components/ui/select.tsx
git commit -m "feat(backtests): KRX 조회에 정렬 기준을 추가하고 상위 200 버튼을 페이지·전체 선택으로 바꾼다"
```

---

### Task 12: 데이터셋 카드 — 스냅샷 배지 + 미상장 종목 하단 표시 + 편집 제외

**Files:**
- Modify: `src/web/features/datasets/symbol-types.ts`
- Modify: `src/web/features/datasets/datasets-panel.tsx`

**Interfaces:**
- Consumes: Task 9 응답 (`universeSnapshot`, `unlistedSymbols`), `UNIVERSE_SORT_LABELS`
- Produces: `DatasetSummary`(웹 타입) 확장 — 위저드 데이터셋 탭(new-backtest-wizard)은 같은 타입을 쓰므로 필드가 optional 이 아니면 typecheck 로 영향 범위가 드러난다

- [ ] **Step 1: 타입 확장** — symbol-types.ts `DatasetSummary`:

```ts
export interface DatasetSummary {
  id: string;
  name: string;
  description: string | null;
  symbols: string[];
  createdAtMs: number;
  /** KRX 스냅샷 확정이 만든 데이터셋이면 그 출처 */
  universeSnapshot: {
    snapshotId: string;
    effectiveTradingDate: string;
    sortKey: string;
  } | null;
  /** 현재 상장 목록에 없는 참조 종목 — null 은 판정 불가(KRX 실패)거나 스냅샷 비연결 */
  unlistedSymbols: string[] | null;
}
```

- [ ] **Step 2: DatasetCard 수정** — datasets-panel.tsx:

(1) import: `import { UNIVERSE_SORT_LABELS, type UniverseSortKey } from '../../../shared/schemas/universe-sort.js';`

(2) 카드 상단 배지 (기존 `{dataset.symbols.length}종목` Badge 옆):

```tsx
{dataset.universeSnapshot ? (
  <>
    <Badge variant="outline">KRX {dataset.universeSnapshot.effectiveTradingDate} 기준</Badge>
    <Badge variant="outline">
      {UNIVERSE_SORT_LABELS[dataset.universeSnapshot.sortKey as UniverseSortKey] ??
        dataset.universeSnapshot.sortKey}
      순 정렬
    </Badge>
  </>
) : null}
```

(3) 미상장 집합과 목록 분리 — `members` 계산부 근처:

```ts
const unlisted = new Set(dataset.unlistedSymbols ?? []);
const listedMembers = members.filter((symbol) => !unlisted.has(symbol.code));
const unlistedMembers = members.filter((symbol) => unlisted.has(symbol.code));
```

기존 `sortedMembers = sortSymbols(members)` 를 `sortSymbols(listedMembers)` 로 바꾼다 — 미상장 종목은 본문 배지 줄에서 빠지고 하단에만 나온다. `hiddenMemberCount` 도 자연히 listed 기준이 된다.

(4) CardContent 하단 (배지 div 다음):

```tsx
{unlistedMembers.length > 0 ? (
  <details className="text-xs text-muted-foreground">
    <summary className="cursor-pointer">
      현재 상장 목록에 없는 종목 {unlistedMembers.length}개
    </summary>
    <div className="mt-1 flex flex-wrap gap-1">
      {sortSymbols(unlistedMembers).map((symbol) => (
        <Badge key={symbol.code} variant="outline" className="text-muted-foreground">
          {symbol.name ?? symbol.code}
          <span className="ml-1 text-[10px] opacity-70">{symbol.code}</span>
        </Badge>
      ))}
    </div>
    <p className="mt-1">
      상장폐지 등의 사유로 지금은 조회되지 않습니다 — 종목 편집에서 다루지 않습니다.
    </p>
  </details>
) : null}
```

(5) 종목 편집 제외 — `EditSymbolsDialog` 호출에 필터 적용:

```tsx
<EditSymbolsDialog
  open={editSymbols}
  onOpenChange={setEditSymbols}
  dataset={dataset}
  allSymbols={allSymbols.filter((symbol) => !unlisted.has(symbol.code))}
/>
```

EditSymbolsDialog 자체는 바꾸지 않는다 — 초기 `selected` 는 `dataset.symbols` 전체(미상장 포함)라서, 목록에 없는 미상장 종목은 체크를 풀 수 없고 `removed` 계산에도 걸리지 않아 참조가 그대로 유지된다. 이 사실을 EditSymbolsDialog 상단 주석에 한 줄 덧붙인다:

```
 * 미상장 종목은 카드가 목록에서 걸러 넘긴다 — 화면에 없으므로 해제할 수 없고,
 * `selected` 초기값에는 남아 있어 저장해도 참조가 지워지지 않는다.
```

- [ ] **Step 3: 검증** — Run: `pnpm typecheck && pnpm lint` — Expected: PASS (전체 통과 — 서버·웹 모두)

- [ ] **Step 4: 전체 단위·통합 테스트** — Run: `pnpm test` — Expected: PASS

- [ ] **Step 5: 커밋**

```bash
git add src/web/features/datasets/symbol-types.ts src/web/features/datasets/datasets-panel.tsx
git commit -m "feat(datasets): 스냅샷 출처 배지와 미상장 종목 하단 표시를 추가한다"
```

---

### Task 13: e2e 갱신

**Files:**
- Modify: `tests/e2e/krx-universe.spec.ts`

**Interfaces:**
- Consumes: Task 11 버튼 이름(`전체 선택` 등), Task 8 데이터셋 자동 생성(이름 `KRX 2024-12-30 시가총액순 {N}종목`)

- [ ] **Step 1: 시나리오 1~4 테스트 수정**

- `await page.getByRole('button', { name: '시가총액 상위 200종목 선택' }).click();` → `await page.getByRole('button', { name: '전체 선택' }).click();` (fixture 후보 3종목 전체 선택 → `'3개 선택'` 단언 유지).
- 정렬 Select 기본값 확인 추가 (조회 전, 기준일 채우기 근처):

```ts
await expect(page.getByLabel('정렬 기준')).toContainText('시가총액 상위');
```

(Select 트리거가 `getByLabel` 로 안 잡히면 `page.getByRole('combobox')` 로 대체.)

- 「페이지 선택」 동작 확인 한 줄 추가 (전체 선택 전에):

```ts
await page.getByRole('button', { name: '페이지 선택' }).click();
await expect(page.getByText('3개 선택')).toBeVisible(); // 후보 3개가 한 페이지에 다 있다
await page.getByRole('button', { name: '전체 해제' }).click();
await expect(page.getByText('0개 선택')).toBeVisible();
```

- [ ] **Step 2: 데이터셋 자동 기록 확인 추가** — 시나리오 1~4 테스트에서 `스냅샷 확정` 단언 직후:

```ts
// 스냅샷 확정이 데이터셋도 만들었다 — 기준 시점·정렬 기준 배지까지 확인
await page.goto('/datasets?tab=datasets');
const autoCard = page.getByText('KRX 2024-12-30 시가총액순 1종목');
await expect(autoCard).toBeVisible();
await expect(page.getByText('KRX 2024-12-30 기준')).toBeVisible();
await expect(page.getByText('시가총액순 정렬')).toBeVisible();
await page.goto('/backtests/new'); // 위저드로 복귀
```

주의: 위저드 상태는 페이지 이동으로 사라진다 — 이 확인은 **스냅샷 확정 뒤, 위저드를 계속 쓰기 전** 이 아니라 별도 테스트로 분리하는 편이 안전하다. 위저드 흐름을 깨지 않으려면 시나리오 1~4 테스트를 건드리지 말고 **새 테스트**로 추가한다:

```ts
test('스냅샷 확정은 데이터셋으로도 기록된다', async ({ page }) => {
  await login(page);
  await page.goto('/backtests/new');
  await selectRangeBreakoutStrategy(page);
  await queryKrxPreview(page, REQUESTED_DATE);
  await page.getByRole('checkbox', { name: '삼성전자 선택' }).check();
  await page.getByRole('button', { name: '스냅샷 확정' }).click();
  await expect(page.getByText(`적용 ${EFFECTIVE_DATE} · 1종목`).first()).toBeVisible();

  await page.goto('/datasets?tab=datasets');
  await expect(page.getByText(/KRX 2024-12-30 시가총액순 1종목/).first()).toBeVisible();
  await expect(page.getByText('KRX 2024-12-30 기준').first()).toBeVisible();
});
```

시나리오 1~4·5 테스트도 확정 시 데이터셋을 만들므로, 데이터셋 개수를 세는 다른 스펙이 있는지 확인한다 (`grep -r "데이터셋" tests/e2e/mvp-flow.spec.ts`). 이름 충돌 접미 ` (2)` 때문에 위 단언은 정확 일치가 아니라 `getByText(/.../).first()` 패턴을 쓴다.

- [ ] **Step 3: 실행 확인** — Run: `pnpm build && pnpm exec playwright test tests/e2e/krx-universe.spec.ts` — Expected: PASS. mvp-flow 회귀 확인: `pnpm exec playwright test tests/e2e/mvp-flow.spec.ts` — Expected: PASS

- [ ] **Step 4: 커밋**

```bash
git add tests/e2e/krx-universe.spec.ts
git commit -m "test(e2e): KRX 유니버스 시나리오를 정렬·선택 버튼·데이터셋 기록에 맞춘다"
```

---

### Task 14: 최종 검증

- [ ] **Step 1: 전체 게이트** — Run: `pnpm typecheck && pnpm lint && pnpm test` — Expected: 모두 PASS
- [ ] **Step 2: e2e 전체** — Run: `pnpm test:e2e` — Expected: PASS
- [ ] **Step 3: 수동 확인 (선택)** — `pnpm dev` + `pnpm dev:web` 로 위저드에서 정렬 Select·버튼·데이터셋 카드 확인
- [ ] **Step 4: 남은 변경 커밋 후 superpowers:finishing-a-development-branch 진행**
