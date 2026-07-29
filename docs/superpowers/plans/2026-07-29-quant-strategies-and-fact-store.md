# 정량 전략 2종 + PIT 팩트 스토어 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 횡단면 모멘텀 전략과 밸류·퀄리티 랭킹 전략을 추가하고, 후자가 요구하는 상장시점(PIT) 재무 데이터 채널을 DART OpenAPI 수집까지 갖춘다.

**Architecture:** 재무·거시 데이터를 장(long) 포맷 `Fact` 하나로 저장하고(데이터셋 귀속 Parquet), 엔진이 봉 타임라인을 진행하며 `asOfTsMs ≤ 현재` 인 팩트만 흡수하는 커서를 굴린다. 전략은 `context.fundamentals(symbol)` / `context.corporateActions(symbol)` 로만 접근하므로 미래 팩트에 닿을 자리가 구조적으로 없다. 분할 보정은 신호 계산에만 적용하고 캔들은 실제 거래 가격을 유지한다.

**Tech Stack:** TypeScript (ESM, NodeNext), Zod 4 (`z.toJSONSchema`), Vitest, DuckDB + Parquet, Fastify, Drizzle/SQLite, dependency-cruiser.

## Global Constraints

- 설계 문서: `docs/superpowers/specs/2026-07-29-quant-strategies-and-fact-store-design.md`. 충돌 시 설계 문서가 이긴다.
- 계층 방향 (§7, `.dependency-cruiser.cjs` 가 강제): `domain/` 은 `application/`·`infrastructure/`·`presentation/`·Node 코어·프레임워크를 import 하지 않는다. `domain → domain` 은 허용된다.
- import 경로는 항상 `.js` 확장자를 붙인다 (NodeNext ESM). 소스가 `.ts` 여도 `.js` 로 쓴다.
- 전략 파라미터의 기본값·한국어 라벨은 Zod 스키마의 `.default()` 와 `.meta({ title, description })` 에만 둔다. 클라이언트에 사본을 만들지 않는다 — 위저드가 JSON 스키마를 읽는다.
- `strategySourceHash` 는 `title`/`description` 을 해시에서 제외한다. 문구만 고쳐도 "전략 변경" 으로 보이면 안 된다.
- 새 전략의 `version` 은 `1.0.0` 으로 시작한다. `ENGINE_VERSION` 은 체결·지표 로직이 바뀔 때만 올린다 — 이 계획에서는 Task 2 에서 `1.2.0` 으로 한 번만 올린다.
- 주석·에러 메시지·로그는 한국어로 쓴다 (기존 코드 관례).
- 시간은 전부 UTC epoch milliseconds. 거래소 현지 시각이 필요하면 `market-data/domain/exchange-session.ts` 의 `KR_SESSION` / `toLocalTime` 을 쓴다. 새로 계산하지 않는다.
- 테스트 실행: `pnpm vitest run <파일경로>`. 타입 검사: `pnpm typecheck`. 린트: `pnpm lint`.
- 커밋 메시지는 `feat(scope): ...` / `test(scope): ...` / `refactor(scope): ...` 형식. 본문 끝에 아래 두 줄을 붙인다:
  ```
  Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01KFoDKRngmr3EM4tEVudeQ4
  ```

## File Structure

**신규 모듈 `src/server/modules/facts/`**

| 파일 | 책임 |
|---|---|
| `domain/fact.ts` | `Fact` · `FactScope` · `FundamentalField` · `CorporateAction` 타입, `CORPORATE_ACTION_FIELD` 상수 |
| `domain/pit-fact-view.ts` | 팩트 목록 → 시점별 PIT 뷰. 커서 전진, `FundamentalSnapshot` 생성, 자본변동 이벤트 변환 |
| `application/ports.ts` | `FactRepository` · `FactSource` · `FactQuery` · `FactIngestionResult` · `FactSourceNotConfiguredError` |
| `infrastructure/parquet-fact-repository.ts` | DuckDB/Parquet 저장소. `dataset=<id>/facts/scope=<scope>/data.parquet` |
| `infrastructure/dart/dart-account-map.ts` | DART 계정 태그 → `FundamentalField` 매핑, 누적/시점 구분 |
| `infrastructure/dart/dart-fact-source.ts` | DART OpenAPI 어댑터 |
| `application/fact-sync-service.ts` | 수집 오케스트레이션 (소스 → 저장소 + 누락 리포트) |

**신규 전략 파일 `src/server/modules/strategy/strategies/`**

| 파일 | 책임 |
|---|---|
| `shared/rank.ts` | 결정적 내림차순 순위 |
| `shared/rebalance-schedule.ts` | KST 월 키, 경과 개월, 리밸런스 봉 판정 |
| `shared/adjusted-price.ts` | 분할 보정 종가 (신호 전용) |
| `shared/two-phase-rebalance.ts` | 2단계 리밸런스 주문 계획 (매도 봉 / 매수 봉) |
| `cross-sectional-momentum.ts` | 전략 A |
| `value-quality-rank.ts` | 전략 B |

**수정 파일**

| 파일 | 변경 |
|---|---|
| `strategy/domain/strategy.ts` | `StrategyBarContext` 에 `fundamentals` · `corporateActions` |
| `backtest/domain/engine.ts` | `BacktestRunInput.facts`, PIT 커서, 경고 문구, `ENGINE_VERSION` |
| `strategy/application/strategy-registry.ts` | 전략 2개 등록 |
| `src/shared/schemas/backtest-request.ts` | `symbols` max 50 → 200 |
| `src/server/shared/rest-client.ts` | `broker/infrastructure/rest-client.ts` 에서 승격 |
| `bootstrap/config.ts` | `DART_API_KEY` |
| `server/cli.ts` | `facts:sync` 명령 |
| `src/workers/backtest-child.ts` | 팩트 로드 후 엔진에 전달 |
| `backtest/presentation/backtest-routes.ts` | 재무 없는 데이터셋에 밸류 전략 제출 거부 |
| `.dependency-cruiser.cjs` | `facts-no-broker` 규칙 |

---

## Task 1: 팩트 도메인 + PIT 뷰

이 태스크가 룩어헤드 방어선이다. 순수 계산만 하고 IO 가 없다.

**Files:**
- Create: `src/server/modules/facts/domain/fact.ts`
- Create: `src/server/modules/facts/domain/pit-fact-view.ts`
- Test: `tests/unit/pit-fact-view.test.ts`

**Interfaces:**
- Consumes: `market-data/domain/exchange-session.ts` 의 `KR_SESSION` (기준일 → UTC 변환용 오프셋)
- Produces:
  - `type FactScope = 'SYMBOL' | 'MACRO'`
  - `interface Fact { scope; key; field; periodKey; asOfTsMs; value; unit }`
  - `type FundamentalField` (문자열 리터럴 유니온, 11개)
  - `const CORPORATE_ACTION_FIELD = 'SPLIT_RATIO'`
  - `interface CorporateAction { effectiveTsMs: number; ratio: number }`
  - `interface FundamentalSnapshot { get(field): number|null; ttm(field): number|null; latestPeriodKey; latestAsOfTsMs }`
  - `class PitFactView { constructor(facts: readonly Fact[]); advanceTo(tsMs: number): void; fundamentals(symbol: string): FundamentalSnapshot | null; corporateActions(symbol: string, tsMs: number): readonly CorporateAction[] }`
  - `function quarterOrdinal(periodKey: string): number | null`

- [ ] **Step 1: 도메인 타입 파일 작성**

`src/server/modules/facts/domain/fact.ts`:

```ts
/**
 * 상장시점(point-in-time) 팩트 — 재무·거시 지표를 장(long) 포맷 하나로 담는다.
 * 새 지표를 추가할 때 스키마 마이그레이션이 없다는 것이 이 모양의 이유다.
 */
export type FactScope = 'SYMBOL' | 'MACRO';

export interface Fact {
  readonly scope: FactScope;
  /** SYMBOL 이면 종목코드, MACRO 이면 지표 키 (예: 'KR_BASE_RATE') */
  readonly key: string;
  readonly field: string;
  /** 기준 기간. 분기 '2025Q1' | 연간 '2025FY' | 시점성 이벤트 '2025-03-14' */
  readonly periodKey: string;
  /** 이 값이 세상에 알려진 시각 — PIT 컷오프 기준 (DART 접수일 18:00 KST) */
  readonly asOfTsMs: number;
  readonly value: number;
  readonly unit: string;
}

/** 전략이 참조하는 재무 계정. 문자열 리터럴 유니온이라 오타가 컴파일에서 잡힌다. */
export type FundamentalField =
  | 'OPERATING_INCOME'
  | 'CURRENT_ASSETS'
  | 'CURRENT_LIABILITIES'
  | 'TANGIBLE_ASSETS'
  | 'CASH_AND_EQUIVALENTS'
  | 'SHORT_TERM_INVESTMENTS'
  | 'SHORT_TERM_BORROWINGS'
  | 'CURRENT_LONG_TERM_DEBT'
  | 'BONDS'
  | 'LONG_TERM_BORROWINGS'
  | 'SHARES_OUTSTANDING';

/** 손익 계정 — 분기 단독값이며 TTM 합산 대상 */
export const FLOW_FIELDS: readonly FundamentalField[] = ['OPERATING_INCOME'];

/**
 * 자본변동 이벤트는 값이 '비율' 이라 재무 계정과 성질이 다르다 — 별도 field 로 둔다.
 * periodKey = 효력 발생일('YYYY-MM-DD', 거래소 현지 날짜), value = 주식수 증가 배수.
 */
export const CORPORATE_ACTION_FIELD = 'SPLIT_RATIO';

export interface CorporateAction {
  /** 효력 발생일의 거래소 현지 자정을 UTC 로 옮긴 시각 */
  readonly effectiveTsMs: number;
  /** 주식수 증가 배수. 2:1 분할 = 2 */
  readonly ratio: number;
}

export interface FundamentalSnapshot {
  /** 이 시점까지 공시된 것 중 가장 최근 분기의 값 */
  get(field: FundamentalField): number | null;
  /** 직전 4개 분기 합. 4개가 채워지지 않으면 null */
  ttm(field: FundamentalField): number | null;
  readonly latestPeriodKey: string | null;
  readonly latestAsOfTsMs: number | null;
}
```

- [ ] **Step 2: 실패하는 테스트 작성**

`tests/unit/pit-fact-view.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { Fact } from '../../src/server/modules/facts/domain/fact.js';
import { PitFactView, quarterOrdinal } from '../../src/server/modules/facts/domain/pit-fact-view.js';

const DAY = 86_400_000;

function fact(overrides: Partial<Fact> & Pick<Fact, 'field' | 'periodKey' | 'asOfTsMs' | 'value'>): Fact {
  return { scope: 'SYMBOL', key: '005930', unit: 'KRW', ...overrides };
}

describe('quarterOrdinal', () => {
  it('분기 키를 단조 정수로 바꾼다', () => {
    expect(quarterOrdinal('2025Q1')).toBe(2025 * 4);
    expect(quarterOrdinal('2025Q2')).toBe(2025 * 4 + 1);
    expect(quarterOrdinal('2026Q1')).toBe(2026 * 4);
  });

  it('분기 키가 아니면 null', () => {
    expect(quarterOrdinal('2025FY')).toBeNull();
    expect(quarterOrdinal('2025-03-14')).toBeNull();
  });
});

describe('PitFactView 룩어헤드 차단', () => {
  const disclosedQ1 = Date.UTC(2025, 4, 15); // 2025-05-15 에 Q1 공시
  const disclosedQ2 = Date.UTC(2025, 7, 14); // 2025-08-14 에 Q2 공시

  const facts: Fact[] = [
    fact({ field: 'OPERATING_INCOME', periodKey: '2025Q1', asOfTsMs: disclosedQ1, value: 100 }),
    fact({ field: 'OPERATING_INCOME', periodKey: '2025Q2', asOfTsMs: disclosedQ2, value: 200 }),
  ];

  it('공시 하루 전에는 그 분기 값이 보이지 않는다', () => {
    const view = new PitFactView(facts);
    view.advanceTo(disclosedQ1 - DAY);
    expect(view.fundamentals('005930')).toBeNull();
  });

  it('공시 시각에는 그 분기 값이 보인다', () => {
    const view = new PitFactView(facts);
    view.advanceTo(disclosedQ1);
    expect(view.fundamentals('005930')?.get('OPERATING_INCOME')).toBe(100);
    expect(view.fundamentals('005930')?.latestPeriodKey).toBe('2025Q1');
  });

  it('Q2 공시 하루 전에는 여전히 Q1 을 반환한다', () => {
    const view = new PitFactView(facts);
    view.advanceTo(disclosedQ2 - DAY);
    const snapshot = view.fundamentals('005930');
    expect(snapshot?.latestPeriodKey).toBe('2025Q1');
    expect(snapshot?.get('OPERATING_INCOME')).toBe(100);
  });

  it('Q2 공시 후에는 Q2 를 반환한다', () => {
    const view = new PitFactView(facts);
    view.advanceTo(disclosedQ2);
    expect(view.fundamentals('005930')?.latestPeriodKey).toBe('2025Q2');
    expect(view.fundamentals('005930')?.get('OPERATING_INCOME')).toBe(200);
  });

  it('커서는 되돌아가지 않는다 — 앞선 시점을 다시 요청해도 흡수한 팩트를 버리지 않는다', () => {
    const view = new PitFactView(facts);
    view.advanceTo(disclosedQ2);
    view.advanceTo(disclosedQ1);
    expect(view.fundamentals('005930')?.latestPeriodKey).toBe('2025Q2');
  });
});

describe('PitFactView TTM', () => {
  it('직전 4개 분기 합을 낸다', () => {
    const view = new PitFactView([
      fact({ field: 'OPERATING_INCOME', periodKey: '2024Q3', asOfTsMs: 1_000, value: 10 }),
      fact({ field: 'OPERATING_INCOME', periodKey: '2024Q4', asOfTsMs: 2_000, value: 20 }),
      fact({ field: 'OPERATING_INCOME', periodKey: '2025Q1', asOfTsMs: 3_000, value: 30 }),
      fact({ field: 'OPERATING_INCOME', periodKey: '2025Q2', asOfTsMs: 4_000, value: 40 }),
    ]);
    view.advanceTo(4_000);
    expect(view.fundamentals('005930')?.ttm('OPERATING_INCOME')).toBe(100);
  });

  it('4개 분기가 채워지지 않으면 null', () => {
    const view = new PitFactView([
      fact({ field: 'OPERATING_INCOME', periodKey: '2025Q1', asOfTsMs: 3_000, value: 30 }),
      fact({ field: 'OPERATING_INCOME', periodKey: '2025Q2', asOfTsMs: 4_000, value: 40 }),
    ]);
    view.advanceTo(4_000);
    expect(view.fundamentals('005930')?.ttm('OPERATING_INCOME')).toBeNull();
  });

  it('중간 분기가 빠지면 null — 3개를 4개인 척 더하지 않는다', () => {
    const view = new PitFactView([
      fact({ field: 'OPERATING_INCOME', periodKey: '2024Q3', asOfTsMs: 1_000, value: 10 }),
      // 2024Q4 누락
      fact({ field: 'OPERATING_INCOME', periodKey: '2025Q1', asOfTsMs: 3_000, value: 30 }),
      fact({ field: 'OPERATING_INCOME', periodKey: '2025Q2', asOfTsMs: 4_000, value: 40 }),
    ]);
    view.advanceTo(4_000);
    expect(view.fundamentals('005930')?.ttm('OPERATING_INCOME')).toBeNull();
  });

  it('시점 계정(재무상태표)은 최신 분기 값을 그대로 준다', () => {
    const view = new PitFactView([
      fact({ field: 'CURRENT_ASSETS', periodKey: '2025Q1', asOfTsMs: 3_000, value: 500 }),
      fact({ field: 'CURRENT_ASSETS', periodKey: '2025Q2', asOfTsMs: 4_000, value: 600 }),
    ]);
    view.advanceTo(4_000);
    expect(view.fundamentals('005930')?.get('CURRENT_ASSETS')).toBe(600);
  });
});

describe('PitFactView 재집계(restatement)', () => {
  it('같은 분기에 더 늦은 공시가 오면 그것이 이긴다', () => {
    const first = Date.UTC(2025, 4, 15);
    const restated = Date.UTC(2025, 10, 1);
    const view = new PitFactView([
      fact({ field: 'OPERATING_INCOME', periodKey: '2025Q1', asOfTsMs: first, value: 100 }),
      fact({ field: 'OPERATING_INCOME', periodKey: '2025Q1', asOfTsMs: restated, value: 90 }),
    ]);
    view.advanceTo(restated - DAY);
    expect(view.fundamentals('005930')?.get('OPERATING_INCOME')).toBe(100);

    const later = new PitFactView([
      fact({ field: 'OPERATING_INCOME', periodKey: '2025Q1', asOfTsMs: first, value: 100 }),
      fact({ field: 'OPERATING_INCOME', periodKey: '2025Q1', asOfTsMs: restated, value: 90 }),
    ]);
    later.advanceTo(restated);
    expect(later.fundamentals('005930')?.get('OPERATING_INCOME')).toBe(90);
  });
});

describe('PitFactView 자본변동 이벤트', () => {
  // 2025-03-10 공시, 2025-03-14 기준일 2:1 분할
  const announced = Date.UTC(2025, 2, 10);
  const splitFacts: Fact[] = [
    fact({
      field: 'SPLIT_RATIO',
      periodKey: '2025-03-14',
      asOfTsMs: announced,
      value: 2,
      unit: 'RATIO',
    }),
  ];

  it('공시 전에는 이벤트가 보이지 않는다', () => {
    const view = new PitFactView(splitFacts);
    view.advanceTo(announced - DAY);
    expect(view.corporateActions('005930', Date.UTC(2025, 2, 20))).toEqual([]);
  });

  it('공시했지만 기준일 전이면 아직 적용하지 않는다', () => {
    const view = new PitFactView(splitFacts);
    view.advanceTo(Date.UTC(2025, 2, 12));
    expect(view.corporateActions('005930', Date.UTC(2025, 2, 12))).toEqual([]);
  });

  it('기준일 이후 봉에는 이벤트가 보인다', () => {
    const view = new PitFactView(splitFacts);
    const barTs = Date.UTC(2025, 2, 14, 0, 0); // 기준일 KST 09:00 = UTC 00:00
    view.advanceTo(barTs);
    const actions = view.corporateActions('005930', barTs);
    expect(actions).toHaveLength(1);
    expect(actions[0]?.ratio).toBe(2);
  });

  it('자본변동 이벤트는 재무 스냅샷에 섞이지 않는다', () => {
    const view = new PitFactView(splitFacts);
    view.advanceTo(Date.UTC(2025, 2, 20));
    expect(view.fundamentals('005930')).toBeNull();
  });
});

describe('PitFactView 종목 격리', () => {
  it('한 종목의 팩트가 다른 종목에 새지 않는다', () => {
    const view = new PitFactView([
      fact({ key: '005930', field: 'OPERATING_INCOME', periodKey: '2025Q1', asOfTsMs: 1_000, value: 100 }),
      fact({ key: '000660', field: 'OPERATING_INCOME', periodKey: '2025Q1', asOfTsMs: 1_000, value: 55 }),
    ]);
    view.advanceTo(1_000);
    expect(view.fundamentals('005930')?.get('OPERATING_INCOME')).toBe(100);
    expect(view.fundamentals('000660')?.get('OPERATING_INCOME')).toBe(55);
    expect(view.fundamentals('999999')).toBeNull();
  });

  it('MACRO 스코프 팩트는 종목 스냅샷에 들어가지 않는다', () => {
    const view = new PitFactView([
      { scope: 'MACRO', key: 'KR_BASE_RATE', field: 'RATE', periodKey: '2025-03-01', asOfTsMs: 1_000, value: 3.5, unit: 'PERCENT' },
    ]);
    view.advanceTo(1_000);
    expect(view.fundamentals('KR_BASE_RATE')).toBeNull();
  });
});
```

- [ ] **Step 3: 테스트가 실패하는 것을 확인**

Run: `pnpm vitest run tests/unit/pit-fact-view.test.ts`
Expected: FAIL — `Failed to resolve import ".../pit-fact-view.js"`

- [ ] **Step 4: PIT 뷰 구현**

`src/server/modules/facts/domain/pit-fact-view.ts`:

```ts
import { KR_SESSION } from '../../market-data/domain/exchange-session.js';
import {
  CORPORATE_ACTION_FIELD,
  FLOW_FIELDS,
  type CorporateAction,
  type Fact,
  type FundamentalField,
  type FundamentalSnapshot,
} from './fact.js';

const MS_PER_MINUTE = 60_000;
const QUARTER_PATTERN = /^(\d{4})Q([1-4])$/;

/** 분기 키를 비교 가능한 단조 정수로 바꾼다. 분기 키가 아니면 null. */
export function quarterOrdinal(periodKey: string): number | null {
  const match = QUARTER_PATTERN.exec(periodKey);
  if (!match) return null;
  return Number(match[1]) * 4 + (Number(match[2]) - 1);
}

/** 'YYYY-MM-DD'(거래소 현지 날짜) → 그 날 현지 자정의 UTC epoch ms */
function localDateToUtcMs(dateKey: string): number | null {
  const parsed = Date.parse(`${dateKey}T00:00:00Z`);
  if (Number.isNaN(parsed)) return null;
  return parsed - KR_SESSION.utcOffsetMinutes * MS_PER_MINUTE;
}

interface FieldEntry {
  /** periodKey → { value, asOfTsMs }. 같은 분기에 더 늦은 공시가 오면 교체된다 */
  readonly byPeriod: Map<string, { value: number; asOfTsMs: number }>;
}

interface SymbolEntry {
  readonly fields: Map<string, FieldEntry>;
  readonly actions: CorporateAction[];
  /** 흡수한 재무 팩트 중 가장 큰 분기 서수 */
  latestQuarter: number | null;
  latestPeriodKey: string | null;
  latestAsOfTsMs: number | null;
}

function ordinalToPeriodKey(ordinal: number): string {
  const year = Math.floor(ordinal / 4);
  const quarter = (ordinal % 4) + 1;
  return `${year}Q${quarter}`;
}

/**
 * 팩트 목록을 `asOfTsMs` 순서로 흡수하는 시점 뷰.
 *
 * 엔진이 봉 타임라인을 진행하며 `advanceTo(현재 봉 tsMs)` 를 호출하고, 전략은
 * 흡수된 것만 볼 수 있다 — 미래 공시는 뷰에 들어올 자리가 없다. 커서는 단조
 * 증가만 하므로 (§9.1 look-ahead 금지) 되돌리는 경로 자체를 두지 않는다.
 */
export class PitFactView {
  private readonly ordered: readonly Fact[];
  private cursor = 0;
  private absorbedUpToTsMs = Number.NEGATIVE_INFINITY;
  private readonly bySymbol = new Map<string, SymbolEntry>();

  constructor(facts: readonly Fact[]) {
    this.ordered = [...facts].sort((a, b) => a.asOfTsMs - b.asOfTsMs);
  }

  advanceTo(tsMs: number): void {
    if (tsMs < this.absorbedUpToTsMs) return; // 커서는 되돌아가지 않는다
    this.absorbedUpToTsMs = tsMs;
    while (this.cursor < this.ordered.length) {
      const fact = this.ordered[this.cursor] as Fact;
      if (fact.asOfTsMs > tsMs) break;
      this.absorb(fact);
      this.cursor += 1;
    }
  }

  fundamentals(symbol: string): FundamentalSnapshot | null {
    const entry = this.bySymbol.get(symbol);
    if (!entry || entry.latestQuarter === null) return null;
    const latestQuarter = entry.latestQuarter;

    return {
      latestPeriodKey: entry.latestPeriodKey,
      latestAsOfTsMs: entry.latestAsOfTsMs,
      get(field: FundamentalField): number | null {
        const byPeriod = entry.fields.get(field)?.byPeriod;
        if (!byPeriod) return null;
        // 최신 분기부터 과거로 내려가며 값이 있는 첫 분기를 쓴다 — 계정별로
        // 공시 시점이 어긋나는 경우(주식수는 사업보고서만 등)를 흡수한다.
        for (let ordinal = latestQuarter; ordinal > latestQuarter - 4; ordinal -= 1) {
          const found = byPeriod.get(ordinalToPeriodKey(ordinal));
          if (found) return found.value;
        }
        return null;
      },
      ttm(field: FundamentalField): number | null {
        if (!FLOW_FIELDS.includes(field)) return null;
        const byPeriod = entry.fields.get(field)?.byPeriod;
        if (!byPeriod) return null;
        let sum = 0;
        for (let ordinal = latestQuarter; ordinal > latestQuarter - 4; ordinal -= 1) {
          const found = byPeriod.get(ordinalToPeriodKey(ordinal));
          if (!found) return null; // 구멍이 있으면 4개인 척 더하지 않는다
          sum += found.value;
        }
        return sum;
      },
    };
  }

  /** 효력 발생일이 `tsMs` 이하인 이벤트만. 공시는 됐지만 아직 발생 전인 분할은 제외된다. */
  corporateActions(symbol: string, tsMs: number): readonly CorporateAction[] {
    const entry = this.bySymbol.get(symbol);
    if (!entry) return [];
    return entry.actions.filter((action) => action.effectiveTsMs <= tsMs);
  }

  private absorb(fact: Fact): void {
    if (fact.scope !== 'SYMBOL') return; // MACRO 는 이 뷰가 다루지 않는다

    let entry = this.bySymbol.get(fact.key);
    if (!entry) {
      entry = {
        fields: new Map(),
        actions: [],
        latestQuarter: null,
        latestPeriodKey: null,
        latestAsOfTsMs: null,
      };
      this.bySymbol.set(fact.key, entry);
    }

    if (fact.field === CORPORATE_ACTION_FIELD) {
      const effectiveTsMs = localDateToUtcMs(fact.periodKey);
      if (effectiveTsMs === null || !Number.isFinite(fact.value) || fact.value <= 0) return;
      entry.actions.push({ effectiveTsMs, ratio: fact.value });
      entry.actions.sort((a, b) => a.effectiveTsMs - b.effectiveTsMs);
      return;
    }

    const ordinal = quarterOrdinal(fact.periodKey);
    if (ordinal === null) return; // 분기 팩트만 재무 스냅샷에 들어간다

    let field = entry.fields.get(fact.field);
    if (!field) {
      field = { byPeriod: new Map() };
      entry.fields.set(fact.field, field);
    }
    const existing = field.byPeriod.get(fact.periodKey);
    // asOfTsMs 오름차순으로 흡수하므로 뒤에 온 것이 더 늦은 공시 = 재집계다
    if (!existing || fact.asOfTsMs >= existing.asOfTsMs) {
      field.byPeriod.set(fact.periodKey, { value: fact.value, asOfTsMs: fact.asOfTsMs });
    }

    if (entry.latestQuarter === null || ordinal > entry.latestQuarter) {
      entry.latestQuarter = ordinal;
      entry.latestPeriodKey = fact.periodKey;
    }
    if (entry.latestAsOfTsMs === null || fact.asOfTsMs > entry.latestAsOfTsMs) {
      entry.latestAsOfTsMs = fact.asOfTsMs;
    }
  }
}
```

- [ ] **Step 5: 테스트 통과 확인**

Run: `pnpm vitest run tests/unit/pit-fact-view.test.ts`
Expected: PASS (모든 케이스)

- [ ] **Step 6: 계층 경계·타입 검사**

Run: `pnpm vitest run tests/architecture/module-boundaries.test.ts && pnpm typecheck && pnpm lint`
Expected: 모두 통과. `facts/domain` 은 `market-data/domain` 만 import 하므로 domain → domain 이고 규칙 위반이 아니다.

- [ ] **Step 7: 커밋**

```bash
git add src/server/modules/facts/domain tests/unit/pit-fact-view.test.ts
git commit -m "feat(facts): 상장시점 팩트 도메인 + PIT 뷰

장(long) 포맷 Fact 하나로 재무·거시·자본변동을 담고, asOfTsMs 커서로
흡수한 것만 노출한다. 미래 공시는 뷰에 들어올 자리가 없다.

- 재집계는 더 늦은 asOf 가 이긴다 — 과거 시점 조회 결과는 변하지 않는다
- TTM 은 4개 분기에 구멍이 있으면 null (3개를 4개인 척 더하지 않는다)
- 분할 이벤트는 공시일(asOf)에 흡수하고 기준일(periodKey) 이후에만 적용

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01KFoDKRngmr3EM4tEVudeQ4"
```

---

## Task 2: 전략 컨텍스트 확장 + 엔진 배선

**Files:**
- Modify: `src/server/modules/strategy/domain/strategy.ts:19-27`
- Modify: `src/server/modules/backtest/domain/engine.ts:29-39`, `:66`, `:104-120`, `:131-137`, `:168-174`, `:198`
- Test: `tests/unit/engine-facts.test.ts`

**Interfaces:**
- Consumes: Task 1 의 `Fact` · `PitFactView` · `FundamentalSnapshot` · `CorporateAction`
- Produces:
  - `StrategyBarContext.fundamentals(symbol: string): FundamentalSnapshot | null`
  - `StrategyBarContext.corporateActions(symbol: string): readonly CorporateAction[]`
  - `BacktestRunInput.facts?: readonly Fact[]` (optional — 기존 호출부가 그대로 컴파일된다)
  - `ENGINE_VERSION = '1.2.0'`

- [ ] **Step 1: 실패하는 테스트 작성**

`tests/unit/engine-facts.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { runBacktest } from '../../src/server/modules/backtest/domain/engine.js';
import type { ExecutionProfile } from '../../src/server/modules/backtest/domain/types.js';
import type { Fact } from '../../src/server/modules/facts/domain/fact.js';
import type { Candle } from '../../src/server/modules/market-data/domain/candle.js';
import type { TradingStrategy } from '../../src/server/modules/strategy/domain/strategy.js';

const DAY = 86_400_000;
const START = Date.UTC(2025, 4, 12); // 2025-05-12

const ZERO_COST: ExecutionProfile = {
  cost: { id: 'zero', version: '1', buyCommissionRate: 0, sellCommissionRate: 0, sellTaxRate: 0 },
  slippage: { id: 'zero', version: '1', bps: 0, fixed: 0 },
  rules: { tickSize: 0, minOrderQty: 1 },
};

function bar(index: number): Candle {
  return {
    symbol: '005930',
    market: 'KR',
    timeframe: '1d',
    tsMs: START + index * DAY,
    open: 1_000,
    high: 1_010,
    low: 990,
    close: 1_000,
    volume: 100,
  };
}

/** 봉마다 보이는 영업이익을 기록하는 관찰 전략 */
function observingStrategy(): {
  strategy: TradingStrategy<unknown, null>;
  seen: Array<number | null>;
} {
  const seen: Array<number | null> = [];
  return {
    seen,
    strategy: {
      id: 'observe',
      version: '1.0.0',
      name: 'observe',
      description: 'test',
      parameterSchema: z.unknown(),
      initialize: () => null,
      onBars(context) {
        seen.push(context.fundamentals('005930')?.get('OPERATING_INCOME') ?? null);
        return { orders: [] };
      },
    },
  };
}

describe('엔진 PIT 배선', () => {
  it('공시 시각 이전 봉에는 재무가 보이지 않고 이후 봉에만 보인다', () => {
    // 봉 2(2025-05-14) 보다 늦고 봉 3(2025-05-15) 보다 이른 시각에 공시
    const disclosed = START + 2 * DAY + 3_600_000;
    const facts: Fact[] = [
      {
        scope: 'SYMBOL',
        key: '005930',
        field: 'OPERATING_INCOME',
        periodKey: '2025Q1',
        asOfTsMs: disclosed,
        value: 100,
        unit: 'KRW',
      },
    ];

    const { strategy, seen } = observingStrategy();
    runBacktest(strategy, {
      candles: [bar(0), bar(1), bar(2), bar(3), bar(4)],
      initialCash: 1_000_000,
      execution: ZERO_COST,
      parameters: {},
      randomSeed: 1,
      maxPositions: 5,
      facts,
    });

    expect(seen.slice(0, 3)).toEqual([null, null, null]);
    expect(seen.slice(3)).toEqual([100, 100]);
  });

  it('facts 를 넘기지 않으면 fundamentals 는 항상 null (기존 전략 호환)', () => {
    const { strategy, seen } = observingStrategy();
    runBacktest(strategy, {
      candles: [bar(0), bar(1)],
      initialCash: 1_000_000,
      execution: ZERO_COST,
      parameters: {},
      randomSeed: 1,
      maxPositions: 5,
    });
    expect(seen).toEqual([null, null]);
  });

  it('기준일 이후 봉에서만 자본변동 이벤트가 보인다', () => {
    const announced = START - 5 * DAY;
    const facts: Fact[] = [
      {
        scope: 'SYMBOL',
        key: '005930',
        field: 'SPLIT_RATIO',
        periodKey: '2025-05-14', // 봉 2 의 날짜
        asOfTsMs: announced,
        value: 2,
        unit: 'RATIO',
      },
    ];

    const counts: number[] = [];
    const strategy: TradingStrategy<unknown, null> = {
      id: 'observe-actions',
      version: '1.0.0',
      name: 'observe',
      description: 'test',
      parameterSchema: z.unknown(),
      initialize: () => null,
      onBars(context) {
        counts.push(context.corporateActions('005930').length);
        return { orders: [] };
      },
    };

    runBacktest(strategy, {
      candles: [bar(0), bar(1), bar(2), bar(3)],
      initialCash: 1_000_000,
      execution: ZERO_COST,
      parameters: {},
      randomSeed: 1,
      maxPositions: 5,
      facts,
    });

    // 봉 0(05-12)·1(05-13) 은 기준일 전 → 0. 봉 2(05-14)·3(05-15) 은 이후 → 1
    expect(counts).toEqual([0, 0, 1, 1]);
  });

  it('경고 문구는 분할이 보정된다는 사실을 반영한다', () => {
    const { strategy } = observingStrategy();
    const result = runBacktest(strategy, {
      candles: [bar(0)],
      initialCash: 1_000_000,
      execution: ZERO_COST,
      parameters: {},
      randomSeed: 1,
      maxPositions: 5,
    });
    const biasWarning = result.warnings.find((warning) => warning.includes('§9.4'));
    expect(biasWarning).toBeDefined();
    expect(biasWarning).toContain('배당');
  });
});
```

- [ ] **Step 2: 테스트가 실패하는 것을 확인**

Run: `pnpm vitest run tests/unit/engine-facts.test.ts`
Expected: FAIL — `facts` 가 `BacktestRunInput` 에 없고 `context.fundamentals` 가 존재하지 않는다

- [ ] **Step 3: `StrategyBarContext` 확장**

`src/server/modules/strategy/domain/strategy.ts` — import 를 한 줄 추가한다:

```ts
import type { CorporateAction, FundamentalSnapshot } from '../../facts/domain/fact.js';
```

`StrategyBarContext` 를 아래로 교체한다:

```ts
export interface StrategyBarContext {
  readonly tsMs: number;
  /** 이번 시점에 확정된 봉 (심볼별) */
  readonly bars: ReadonlyMap<string, Candle>;
  /** 현재 시점까지 확정된 봉 이력 — 미래 봉은 절대 포함되지 않는다 */
  getHistory(symbol: string): readonly Candle[];
  readonly portfolio: PortfolioView;
  readonly rng: Rng;
  /**
   * 현재 시점 이전에 공시된 재무만. 데이터가 없거나 아직 공시 전이면 null.
   * 미래 공시는 구조적으로 접근 불가다 (PitFactView 커서, §9.4 look-ahead).
   */
  fundamentals(symbol: string): FundamentalSnapshot | null;
  /** 효력 발생일이 현재 시점 이하인 자본변동 이벤트만 (분할 보정용) */
  corporateActions(symbol: string): readonly CorporateAction[];
}
```

- [ ] **Step 4: 엔진 배선**

`src/server/modules/backtest/domain/engine.ts` 에 다섯 곳을 고친다.

(a) import 블록에 추가:

```ts
import type { Fact } from '../../facts/domain/fact.js';
import { PitFactView } from '../../facts/domain/pit-fact-view.js';
```

(b) `BacktestRunInput` 의 `maxPositions` 아래에 필드 추가:

```ts
  /**
   * 상장시점 팩트. 미지정이면 전략의 fundamentals/corporateActions 가 항상 비어 있다 —
   * 재무를 쓰지 않는 전략(hourly-breakout 등)은 넘길 필요가 없다.
   */
  readonly facts?: readonly Fact[];
```

(c) `ENGINE_VERSION` 을 올린다:

```ts
export const ENGINE_VERSION = '1.2.0';
```

(d) `const state = strategy.initialize({ symbols, ... });` 바로 위에 뷰를 만든다:

```ts
  const factView = new PitFactView(input.facts ?? []);
```

(e) 이벤트 루프에서 `const bars = barsByTs.get(tsMs) as Map<string, Candle>;` 바로 다음 줄에 커서 전진을 넣는다 (전략 호출 전이어야 한다):

```ts
    // 이 시점까지 공시된 팩트만 흡수한다 — 전략이 미래 공시를 볼 자리를 없앤다 (§9.4)
    factView.advanceTo(tsMs);
```

(f) 컨텍스트 리터럴에 두 필드를 추가한다:

```ts
    const context: StrategyBarContext = {
      tsMs,
      bars,
      getHistory: (symbol) => historyBySymbol.get(symbol) ?? [],
      portfolio: portfolioView,
      rng,
      fundamentals: (symbol) => factView.fundamentals(symbol),
      corporateActions: (symbol) => factView.corporateActions(symbol, tsMs),
    };
```

(g) 편향 경고 문구를 교체한다 — 분할은 이제 전략이 보정하므로 무조건 미보정이라고 쓰면 거짓이 된다:

```ts
  warnings.push(
    '생존 편향·공휴일 캘린더·배당·권리락 보정은 MVP 에서 다루지 않습니다 (§9.4). ' +
      '액면분할은 분할 이력이 수집된 데이터셋에서 신호 계산 시에만 보정됩니다 — 체결가는 실제 거래 가격입니다.',
  );
```

- [ ] **Step 5: 테스트 통과 확인**

Run: `pnpm vitest run tests/unit/engine-facts.test.ts`
Expected: PASS

- [ ] **Step 6: 기존 테스트가 깨지지 않았는지 확인**

Run: `pnpm vitest run tests/unit/engine.test.ts tests/unit/hourly-breakout.test.ts tests/architecture/module-boundaries.test.ts && pnpm typecheck`
Expected: 전부 PASS. `StrategyBarContext` 를 리터럴로 만드는 곳은 `engine.ts` 한 군데뿐이므로(테스트는 파라미터 타입으로만 쓴다) 다른 수정이 필요 없다.

`tests/unit/engine.test.ts` 나 통합 테스트가 편향 경고 문구를 문자열 일치로 단정하고 있으면 그 단정을 `expect(warning).toContain('§9.4')` 로 완화한다 — 문구가 바뀌는 것이 이 태스크의 의도다.

- [ ] **Step 7: 커밋**

```bash
git add src/server/modules/strategy/domain/strategy.ts src/server/modules/backtest/domain/engine.ts tests/
git commit -m "feat(backtest): 전략 컨텍스트에 상장시점 재무·자본변동 채널

엔진이 봉 타임라인을 진행하며 PitFactView 커서를 전진시키고, 전략은
흡수된 것만 본다. BacktestRunInput.facts 는 optional 이라 재무를 쓰지
않는 전략은 그대로 동작한다.

ENGINE_VERSION 1.1.0 -> 1.2.0. 편향 경고에서 액면분할을 조건부로 고쳤다 —
분할 이력이 있는 데이터셋에서는 신호 계산이 보정된다.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01KFoDKRngmr3EM4tEVudeQ4"
```

---

## Task 3: 공용 전략 헬퍼

두 전략이 공유하는 순수 로직이다. 전략 파일에 각자 구현하면 두 곳에서 따로 틀린다.

**Files:**
- Create: `src/server/modules/strategy/strategies/shared/rank.ts`
- Create: `src/server/modules/strategy/strategies/shared/rebalance-schedule.ts`
- Create: `src/server/modules/strategy/strategies/shared/adjusted-price.ts`
- Create: `src/server/modules/strategy/strategies/shared/two-phase-rebalance.ts`
- Test: `tests/unit/strategy-shared.test.ts`

**Interfaces:**
- Consumes: Task 1 의 `CorporateAction`; `market-data/domain/exchange-session.ts` 의 `KR_SESSION`·`toLocalTime`; `backtest/domain/types.ts` 의 `OrderIntent`·`Position`; `market-data/domain/candle.ts` 의 `Candle`
- Produces:
  - `interface Scored { readonly symbol: string; readonly score: number }`
  - `function rankDescending(items: readonly Scored[]): Map<string, number>` — 큰 값이 1위, 동점은 심볼 코드 오름차순
  - `function localMonthKey(tsMs: number): string` — `'YYYY-MM'` (KST)
  - `function monthsBetween(fromKey: string, toKey: string): number`
  - `function isRebalanceDue(lastKey: string | null, currentKey: string, rebalanceMonths: number): boolean`
  - `function splitAdjustedClose(history: readonly Candle[], actions: readonly CorporateAction[], index: number): number | null`
  - `interface SellPhaseInput { targets: readonly string[]; positions: ReadonlyMap<string, Readonly<Position>> }`
  - `interface BuyPhaseInput { positions: ReadonlyMap<string, Readonly<Position>>; bars: ReadonlyMap<string, Candle>; equity: number; topN: number }`
  - `function planSellPhase(input: SellPhaseInput): readonly OrderIntent[]`
  - `function planBuyPhase(pendingBuys: readonly string[], input: BuyPhaseInput): readonly OrderIntent[]`

- [ ] **Step 1: 실패하는 테스트 작성**

`tests/unit/strategy-shared.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { Position } from '../../src/server/modules/backtest/domain/types.js';
import type { CorporateAction } from '../../src/server/modules/facts/domain/fact.js';
import type { Candle } from '../../src/server/modules/market-data/domain/candle.js';
import { splitAdjustedClose } from '../../src/server/modules/strategy/strategies/shared/adjusted-price.js';
import { rankDescending } from '../../src/server/modules/strategy/strategies/shared/rank.js';
import {
  isRebalanceDue,
  localMonthKey,
  monthsBetween,
} from '../../src/server/modules/strategy/strategies/shared/rebalance-schedule.js';
import {
  planBuyPhase,
  planSellPhase,
} from '../../src/server/modules/strategy/strategies/shared/two-phase-rebalance.js';

const DAY = 86_400_000;

function candle(tsMs: number, close: number, symbol = 'A'): Candle {
  return {
    symbol,
    market: 'KR',
    timeframe: '1d',
    tsMs,
    open: close,
    high: close,
    low: close,
    close,
    volume: 1,
  };
}

function position(symbol: string, quantity: number): Position {
  return { symbol, quantity, avgEntryPrice: 100, entryCosts: 0, entryTsMs: 0 };
}

describe('rankDescending', () => {
  it('큰 값이 1위다', () => {
    const ranks = rankDescending([
      { symbol: 'A', score: 0.1 },
      { symbol: 'B', score: 0.5 },
      { symbol: 'C', score: 0.3 },
    ]);
    expect(ranks.get('B')).toBe(1);
    expect(ranks.get('C')).toBe(2);
    expect(ranks.get('A')).toBe(3);
  });

  it('동점은 심볼 코드 오름차순으로 깬다 — 결정적이어야 한다', () => {
    const ranks = rankDescending([
      { symbol: 'B', score: 0.5 },
      { symbol: 'A', score: 0.5 },
    ]);
    expect(ranks.get('A')).toBe(1);
    expect(ranks.get('B')).toBe(2);
  });

  it('입력 순서가 달라도 같은 결과가 나온다', () => {
    const forward = rankDescending([
      { symbol: 'A', score: 1 },
      { symbol: 'B', score: 1 },
      { symbol: 'C', score: 2 },
    ]);
    const reversed = rankDescending([
      { symbol: 'C', score: 2 },
      { symbol: 'B', score: 1 },
      { symbol: 'A', score: 1 },
    ]);
    expect([...forward.entries()].sort()).toEqual([...reversed.entries()].sort());
  });

  it('입력 배열을 변형하지 않는다', () => {
    const items = [
      { symbol: 'A', score: 1 },
      { symbol: 'B', score: 2 },
    ];
    rankDescending(items);
    expect(items[0]?.symbol).toBe('A');
  });
});

describe('localMonthKey (KST)', () => {
  it('KST 기준 월을 낸다', () => {
    // 2025-07-01 00:00 KST = 2025-06-30 15:00 UTC → KST 기준 7월
    expect(localMonthKey(Date.UTC(2025, 5, 30, 15, 0))).toBe('2025-07');
    // 2025-06-30 23:59 KST = 2025-06-30 14:59 UTC → 6월
    expect(localMonthKey(Date.UTC(2025, 5, 30, 14, 59))).toBe('2025-06');
  });

  it('연말 경계를 넘긴다', () => {
    expect(localMonthKey(Date.UTC(2025, 11, 31, 15, 0))).toBe('2026-01');
  });
});

describe('monthsBetween', () => {
  it('연을 넘는 개월 차를 낸다', () => {
    expect(monthsBetween('2025-11', '2026-02')).toBe(3);
    expect(monthsBetween('2025-01', '2025-01')).toBe(0);
  });
});

describe('isRebalanceDue', () => {
  it('최초 실행이면 항상 참', () => {
    expect(isRebalanceDue(null, '2025-01', 3)).toBe(true);
  });

  it('같은 달이면 거짓', () => {
    expect(isRebalanceDue('2025-01', '2025-01', 1)).toBe(false);
  });

  it('간격이 rebalanceMonths 미만이면 거짓', () => {
    expect(isRebalanceDue('2025-01', '2025-02', 3)).toBe(false);
    expect(isRebalanceDue('2025-01', '2025-03', 3)).toBe(false);
  });

  it('간격이 채워지면 참', () => {
    expect(isRebalanceDue('2025-01', '2025-04', 3)).toBe(true);
    expect(isRebalanceDue('2025-01', '2025-02', 1)).toBe(true);
  });

  it('휴장으로 달을 건너뛰어도 참 — 리밸런스를 놓치지 않는다', () => {
    expect(isRebalanceDue('2025-01', '2025-06', 3)).toBe(true);
  });
});

describe('splitAdjustedClose', () => {
  const history = [candle(0, 200), candle(DAY, 200), candle(2 * DAY, 100), candle(3 * DAY, 110)];
  // 2일차(2*DAY)에 2:1 분할 발생
  const actions: CorporateAction[] = [{ effectiveTsMs: 2 * DAY, ratio: 2 }];

  it('분할 이전 봉은 배수로 나눈다', () => {
    expect(splitAdjustedClose(history, actions, 0)).toBe(100);
    expect(splitAdjustedClose(history, actions, 1)).toBe(100);
  });

  it('분할 이후 봉은 그대로다', () => {
    expect(splitAdjustedClose(history, actions, 2)).toBe(100);
    expect(splitAdjustedClose(history, actions, 3)).toBe(110);
  });

  it('보정하면 거짓 -50% 가 사라진다', () => {
    const raw = (history[2] as Candle).close / (history[0] as Candle).close - 1;
    const from = splitAdjustedClose(history, actions, 0) as number;
    const to = splitAdjustedClose(history, actions, 2) as number;
    expect(raw).toBeCloseTo(-0.5);
    expect(to / from - 1).toBeCloseTo(0);
  });

  it('이벤트가 여러 개면 배수를 곱한다', () => {
    const many: CorporateAction[] = [
      { effectiveTsMs: DAY, ratio: 2 },
      { effectiveTsMs: 2 * DAY, ratio: 5 },
    ];
    expect(splitAdjustedClose(history, many, 0)).toBe(20);
  });

  it('이벤트가 없으면 종가 그대로', () => {
    expect(splitAdjustedClose(history, [], 0)).toBe(200);
  });

  it('범위 밖 index 는 null', () => {
    expect(splitAdjustedClose(history, actions, 99)).toBeNull();
    expect(splitAdjustedClose(history, actions, -1)).toBeNull();
  });
});

describe('planSellPhase', () => {
  it('목표에 없는 보유 종목만 전량 매도한다', () => {
    const positions = new Map<string, Position>([
      ['A', position('A', 10)],
      ['B', position('B', 5)],
    ]);
    expect(planSellPhase({ targets: ['A', 'C'], positions })).toEqual([
      { symbol: 'B', side: 'SELL', quantity: 5, reason: 'REBALANCE_EXIT' },
    ]);
  });

  it('전량 회전이면 보유 전부를 매도한다', () => {
    const positions = new Map<string, Position>([
      ['A', position('A', 10)],
      ['B', position('B', 5)],
    ]);
    expect(planSellPhase({ targets: ['C', 'D'], positions }).map((o) => o.symbol)).toEqual([
      'A',
      'B',
    ]);
  });

  it('수량 0 포지션은 주문을 내지 않는다', () => {
    const positions = new Map<string, Position>([['A', position('A', 0)]]);
    expect(planSellPhase({ targets: [], positions })).toEqual([]);
  });

  it('주문 순서는 심볼 코드 순으로 결정적이다', () => {
    const positions = new Map<string, Position>([
      ['C', position('C', 1)],
      ['A', position('A', 1)],
      ['B', position('B', 1)],
    ]);
    expect(planSellPhase({ targets: [], positions }).map((o) => o.symbol)).toEqual(['A', 'B', 'C']);
  });
});

describe('planBuyPhase', () => {
  const bars = new Map<string, Candle>([
    ['A', candle(0, 1_000, 'A')],
    ['B', candle(0, 500, 'B')],
  ]);

  it('동일가중으로 수량을 낸다', () => {
    // 종목당 예산 10,000/2 = 5,000 → A 5주, B 10주
    expect(planBuyPhase(['A', 'B'], { positions: new Map(), bars, equity: 10_000, topN: 2 })).toEqual(
      [
        { symbol: 'A', side: 'BUY', quantity: 5, reason: 'REBALANCE_ENTRY' },
        { symbol: 'B', side: 'BUY', quantity: 10, reason: 'REBALANCE_ENTRY' },
      ],
    );
  });

  it('이미 보유 중인 종목은 매수하지 않는다', () => {
    const orders = planBuyPhase(['A', 'B'], {
      positions: new Map([['A', position('A', 3)]]),
      bars,
      equity: 10_000,
      topN: 2,
    });
    expect(orders.map((o) => o.symbol)).toEqual(['B']);
  });

  it('이번 봉에 봉이 없는 종목은 건너뛴다 (거래정지 등)', () => {
    const orders = planBuyPhase(['A', 'Z'], {
      positions: new Map(),
      bars,
      equity: 10_000,
      topN: 2,
    });
    expect(orders.map((o) => o.symbol)).toEqual(['A']);
  });

  it('1주도 못 사면 주문을 내지 않는다', () => {
    expect(planBuyPhase(['A'], { positions: new Map(), bars, equity: 100, topN: 2 })).toEqual([]);
  });

  it('비중은 목표 종목 수가 아니라 topN 으로 나눈다 — 남는 몫은 현금', () => {
    // 10,000/4 = 2,500 → 1,000원 종목 2주
    const orders = planBuyPhase(['A'], { positions: new Map(), bars, equity: 10_000, topN: 4 });
    expect(orders[0]?.quantity).toBe(2);
  });
});
```

- [ ] **Step 2: 테스트가 실패하는 것을 확인**

Run: `pnpm vitest run tests/unit/strategy-shared.test.ts`
Expected: FAIL — 네 모듈 모두 `Failed to resolve import`

- [ ] **Step 3: `shared/rank.ts` 구현**

```ts
export interface Scored {
  readonly symbol: string;
  readonly score: number;
}

/**
 * 큰 값이 1위. 동점은 심볼 코드 오름차순으로 깬다 — 순위가 입력 순서에 의존하면
 * 같은 요청을 두 번 돌려도 결과가 달라진다 (재현성, 스펙 §9.5).
 */
export function rankDescending(items: readonly Scored[]): Map<string, number> {
  const sorted = [...items].sort((a, b) =>
    a.score === b.score ? (a.symbol < b.symbol ? -1 : 1) : b.score - a.score,
  );
  const ranks = new Map<string, number>();
  sorted.forEach((item, index) => ranks.set(item.symbol, index + 1));
  return ranks;
}
```

- [ ] **Step 4: `shared/rebalance-schedule.ts` 구현**

```ts
import { KR_SESSION, toLocalTime } from '../../../market-data/domain/exchange-session.js';

const MS_PER_DAY = 86_400_000;

/**
 * 거래소 현지(KST) 기준 'YYYY-MM'. UTC 월을 쓰면 매월 1일 장 시작 봉(KST 09:00 =
 * UTC 00:00)은 괜찮지만 월말 야간 봉이 다음 달로 새어 리밸런스가 어긋난다.
 */
export function localMonthKey(tsMs: number): string {
  const { dayIndex } = toLocalTime(tsMs, KR_SESSION);
  const date = new Date(dayIndex * MS_PER_DAY);
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

export function monthsBetween(fromKey: string, toKey: string): number {
  const [fromYear, fromMonth] = fromKey.split('-').map(Number) as [number, number];
  const [toYear, toMonth] = toKey.split('-').map(Number) as [number, number];
  return (toYear - fromYear) * 12 + (toMonth - fromMonth);
}

/**
 * 리밸런스 봉 판정. 최초 실행(lastKey === null)은 항상 참이다.
 * 부등호가 `>=` 인 이유: 휴장·데이터 공백으로 정확한 달을 건너뛰어도 놓치지 않는다.
 */
export function isRebalanceDue(
  lastKey: string | null,
  currentKey: string,
  rebalanceMonths: number,
): boolean {
  if (lastKey === null) return true;
  return monthsBetween(lastKey, currentKey) >= rebalanceMonths;
}
```

- [ ] **Step 5: `shared/adjusted-price.ts` 구현**

```ts
import type { CorporateAction } from '../../../facts/domain/fact.js';
import type { Candle } from '../../../market-data/domain/candle.js';

/**
 * 분할 보정 종가 — **신호 계산 전용**이다.
 *
 * 캔들 자체를 수정주가로 바꾸지 않는 이유: 체결가·호가 단위·수수료는 실제 거래된
 * 가격이어야 한다. 수정주가로 체결하면 비용 모델 전체가 틀어진다.
 *
 * 대상 봉보다 나중에 발생한 분할 배수를 모두 곱해 나눈다 — 분할 전 가격을 분할 후
 * 기준으로 끌어내려 과거·현재 가격을 직접 비교할 수 있게 만든다.
 */
export function splitAdjustedClose(
  history: readonly Candle[],
  actions: readonly CorporateAction[],
  index: number,
): number | null {
  const bar = history[index];
  if (!bar) return null;
  let factor = 1;
  for (const action of actions) {
    if (action.effectiveTsMs > bar.tsMs) factor *= action.ratio;
  }
  if (!Number.isFinite(factor) || factor <= 0) return null;
  return bar.close / factor;
}
```

- [ ] **Step 6: `shared/two-phase-rebalance.ts` 구현**

```ts
import type { OrderIntent, Position } from '../../../backtest/domain/types.js';
import type { Candle } from '../../../market-data/domain/candle.js';

export interface SellPhaseInput {
  /** 이번 리밸런스의 목표 보유 종목 */
  readonly targets: readonly string[];
  readonly positions: ReadonlyMap<string, Readonly<Position>>;
}

export interface BuyPhaseInput {
  readonly positions: ReadonlyMap<string, Readonly<Position>>;
  readonly bars: ReadonlyMap<string, Candle>;
  readonly equity: number;
  readonly topN: number;
}

/**
 * 2단계 리밸런스 1단계 — 탈락 종목만 전량 매도한다.
 *
 * 같은 봉에서 매수까지 내지 않는 이유: 엔진의 동시 포지션 상한 검증은 청산 주문을
 * 낸 포지션도 체결 전까지 슬롯을 쓰는 것으로 센다 (engine.ts validateOrder).
 * topN 과 maxPositions 가 같으면 전량 회전이 통째로 거부된다. 매도와 매수를 두 봉으로
 * 나누면 엔진을 고치지 않고도 회전이 되고, 실제 대금 결제와도 부합한다.
 */
export function planSellPhase(input: SellPhaseInput): readonly OrderIntent[] {
  const targetSet = new Set(input.targets);
  return [...input.positions.values()]
    .filter((position) => position.quantity > 0 && !targetSet.has(position.symbol))
    .sort((a, b) => (a.symbol < b.symbol ? -1 : 1))
    .map((position) => ({
      symbol: position.symbol,
      side: 'SELL' as const,
      quantity: position.quantity,
      reason: 'REBALANCE_EXIT',
    }));
}

/**
 * 2단계 — 이전 봉에서 넘어온 편입 종목을 동일가중으로 매수한다.
 * 비중은 목표 종목 수가 아니라 `topN` 으로 나눈다 — 후보가 부족하면 그만큼 현금이 남는
 * 것이 의도된 동작이다 (절대 모멘텀 필터가 후보를 걸러낸 경우 등).
 */
export function planBuyPhase(
  pendingBuys: readonly string[],
  input: BuyPhaseInput,
): readonly OrderIntent[] {
  if (input.topN <= 0) return [];
  const budgetPerSymbol = input.equity / input.topN;
  const orders: OrderIntent[] = [];

  for (const symbol of [...pendingBuys].sort()) {
    const held = input.positions.get(symbol);
    if (held && held.quantity > 0) continue;
    const bar = input.bars.get(symbol);
    if (!bar || bar.close <= 0) continue; // 이번 봉에 거래가 없으면 다음 리밸런스로 넘긴다
    const quantity = Math.floor(budgetPerSymbol / bar.close);
    if (quantity < 1) continue;
    orders.push({ symbol, side: 'BUY', quantity, reason: 'REBALANCE_ENTRY' });
  }
  return orders;
}
```

- [ ] **Step 7: 테스트 통과 확인**

Run: `pnpm vitest run tests/unit/strategy-shared.test.ts && pnpm typecheck && pnpm lint`
Expected: PASS

- [ ] **Step 8: 커밋**

```bash
git add src/server/modules/strategy/strategies/shared tests/unit/strategy-shared.test.ts
git commit -m "feat(strategy): 랭킹·리밸런스·분할보정 공용 헬퍼

두 랭킹 전략이 공유하는 순수 로직을 먼저 뽑는다.

- rankDescending: 동점을 심볼 코드로 깨서 결정적 (재현성 §9.5)
- localMonthKey: KST 기준 월 — UTC 월은 리밸런스를 어긋나게 한다
- splitAdjustedClose: 신호 전용 보정. 캔들은 실제 거래 가격 유지
- planSellPhase/planBuyPhase: 2단계 리밸런스로 maxPositions 마찰 회피

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01KFoDKRngmr3EM4tEVudeQ4"
```

---

## Task 4: 전략 A — 횡단면 모멘텀

**Files:**
- Create: `src/server/modules/strategy/strategies/cross-sectional-momentum.ts`
- Modify: `src/server/modules/strategy/application/strategy-registry.ts:3`, `:9-11`
- Test: `tests/unit/cross-sectional-momentum.test.ts`

**Interfaces:**
- Consumes: Task 3 의 `rankDescending`·`Scored`·`isRebalanceDue`·`localMonthKey`·`splitAdjustedClose`·`planSellPhase`·`planBuyPhase`; Task 2 의 확장된 `StrategyBarContext`
- Produces:
  - `const crossSectionalMomentumParameters` (Zod 객체)
  - `type CrossSectionalMomentumParameters`
  - `interface CrossSectionalMomentumState { readonly symbols: readonly string[]; lastRebalanceMonthKey: string | null; pendingBuys: readonly string[] | null }`
  - `function momentumScore(history, actions, formationDays, skipDays): number | null` — 테스트가 직접 호출하는 순수 함수
  - `const crossSectionalMomentumStrategy: TradingStrategy<CrossSectionalMomentumParameters, CrossSectionalMomentumState>` (id `'cross-sectional-momentum'`)

- [ ] **Step 1: 실패하는 테스트 작성**

`tests/unit/cross-sectional-momentum.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { runBacktest } from '../../src/server/modules/backtest/domain/engine.js';
import type { ExecutionProfile } from '../../src/server/modules/backtest/domain/types.js';
import type { CorporateAction } from '../../src/server/modules/facts/domain/fact.js';
import type { Candle } from '../../src/server/modules/market-data/domain/candle.js';
import { StrategyRegistry } from '../../src/server/modules/strategy/application/strategy-registry.js';
import {
  crossSectionalMomentumParameters,
  crossSectionalMomentumStrategy,
  momentumScore,
} from '../../src/server/modules/strategy/strategies/cross-sectional-momentum.js';

const DAY = 86_400_000;
/** 2025-01-02 09:00 KST = 2025-01-02 00:00 UTC */
const START = Date.UTC(2025, 0, 2);

const ZERO_COST: ExecutionProfile = {
  cost: { id: 'zero', version: '1', buyCommissionRate: 0, sellCommissionRate: 0, sellTaxRate: 0 },
  slippage: { id: 'zero', version: '1', bps: 0, fixed: 0 },
  rules: { tickSize: 0, minOrderQty: 1 },
};

function candle(symbol: string, index: number, close: number): Candle {
  return {
    symbol,
    market: 'KR',
    timeframe: '1d',
    tsMs: START + index * DAY,
    open: close,
    high: close,
    low: close,
    close,
    volume: 1_000,
  };
}

describe('momentumScore 창 인덱싱', () => {
  // close = index 로 두면 인덱스를 값으로 직접 읽을 수 있다
  const history = Array.from({ length: 100 }, (_, index) => candle('A', index, 100 + index));

  it('skipDays 만큼 뒤로 물러난 지점에서 formationDays 창을 잡는다', () => {
    // history.length - 1 = 99. skipDays 5 → end index 94 (=194), formation 10 → start 84 (=184)
    expect(momentumScore(history, [], 10, 5)).toBeCloseTo(194 / 184 - 1);
  });

  it('skipDays 0 이면 마지막 봉이 종점이다', () => {
    expect(momentumScore(history, [], 10, 0)).toBeCloseTo(199 / 189 - 1);
  });

  it('이력이 formationDays + skipDays 보다 짧으면 null', () => {
    expect(momentumScore(history.slice(0, 12), [], 10, 5)).toBeNull();
  });

  it('경계: 이력이 정확히 formationDays + skipDays + 1 개면 계산된다', () => {
    // 창 시작 index 0 을 쓸 수 있는 최소 길이
    const exact = history.slice(0, 16);
    expect(momentumScore(exact, [], 10, 5)).toBeCloseTo(110 / 100 - 1);
  });

  it('분할을 보정해 거짓 하락을 없앤다', () => {
    // index 90 에 2:1 분할 — 그 이후 종가가 절반이 된 이력
    const split: Candle[] = history.map((bar, index) =>
      index >= 90 ? { ...bar, close: bar.close / 2 } : bar,
    );
    const actions: CorporateAction[] = [{ effectiveTsMs: START + 90 * DAY, ratio: 2 }];
    const unadjusted = momentumScore(split, [], 10, 5) as number;
    const adjusted = momentumScore(split, actions, 10, 5) as number;
    expect(unadjusted).toBeLessThan(-0.4); // 거짓 -50% 근처
    expect(adjusted).toBeCloseTo(194 / 184 - 1); // 원래 신호로 복원
  });
});

describe('crossSectionalMomentumParameters', () => {
  it('기본값만으로 파싱된다', () => {
    const parsed = crossSectionalMomentumParameters.parse({});
    expect(parsed).toEqual({
      formationDays: 252,
      skipDays: 21,
      topN: 10,
      rebalanceMonths: 1,
      absoluteMomentumFilter: true,
    });
  });

  it('범위 밖 값을 거부한다', () => {
    expect(crossSectionalMomentumParameters.safeParse({ formationDays: 19 }).success).toBe(false);
    expect(crossSectionalMomentumParameters.safeParse({ skipDays: 64 }).success).toBe(false);
    expect(crossSectionalMomentumParameters.safeParse({ topN: 0 }).success).toBe(false);
  });
});

describe('레지스트리 등록', () => {
  it('전략 목록에 노출된다', () => {
    const registry = new StrategyRegistry();
    expect(registry.list().map((s) => s.id)).toContain('cross-sectional-momentum');
  });

  it('JSON 스키마에 한국어 라벨과 기본값이 실린다', () => {
    const schema = new StrategyRegistry().getParameterJsonSchema('cross-sectional-momentum');
    const properties = (schema as { properties: Record<string, Record<string, unknown>> }).properties;
    expect(properties.topN?.title).toBe('보유 종목 수');
    expect(properties.topN?.default).toBe(10);
    expect(typeof properties.formationDays?.description).toBe('string');
  });
});

describe('2단계 리밸런스 실행', () => {
  /**
   * A 는 계속 오르고 B 는 계속 내린다. 워밍업 30봉 뒤 첫 리밸런스에서 A 만 목표가 된다.
   * formationDays·skipDays 를 작게 줄여 테스트 봉 수를 줄인다.
   */
  function buildCandles(bars: number): Candle[] {
    const candles: Candle[] = [];
    for (let index = 0; index < bars; index += 1) {
      candles.push(candle('AAA', index, 1_000 + index * 10));
      candles.push(candle('BBB', index, 1_000 - index * 5));
    }
    return candles;
  }

  const parameters = {
    formationDays: 20,
    skipDays: 0,
    topN: 1,
    rebalanceMonths: 1,
    absoluteMomentumFilter: true,
  };

  it('topN 과 maxPositions 가 같아도 전량 회전이 막히지 않는다', () => {
    const result = runBacktest(crossSectionalMomentumStrategy, {
      candles: buildCandles(70),
      initialCash: 10_000_000,
      execution: ZERO_COST,
      parameters,
      randomSeed: 1,
      maxPositions: 1,
    });

    const buys = result.fills.filter((fill) => fill.side === 'BUY');
    expect(buys.length).toBeGreaterThan(0);
    // 오르는 종목만 산다 — 절대 모멘텀 필터가 BBB 를 걸러낸다
    expect(new Set(buys.map((fill) => fill.symbol))).toEqual(new Set(['AAA']));
  });

  it('매수는 매도 봉이 아니라 그 다음 봉에서 체결된다', () => {
    const result = runBacktest(crossSectionalMomentumStrategy, {
      candles: buildCandles(70),
      initialCash: 10_000_000,
      execution: ZERO_COST,
      parameters,
      randomSeed: 1,
      maxPositions: 1,
    });
    const firstBuy = result.fills.find((fill) => fill.side === 'BUY');
    expect(firstBuy).toBeDefined();
    // 리밸런스 판정 봉 + 1(매수 주문 봉) + 1(체결 봉) — 워밍업 이후 최소 2봉 뒤
    expect((firstBuy as { tsMs: number }).tsMs).toBeGreaterThanOrEqual(START + 21 * DAY);
  });

  it('절대 모멘텀 필터가 모두 걸러내면 현금으로 남는다', () => {
    const candles: Candle[] = [];
    for (let index = 0; index < 70; index += 1) {
      candles.push(candle('AAA', index, 1_000 - index * 5));
      candles.push(candle('BBB', index, 1_000 - index * 3));
    }
    const result = runBacktest(crossSectionalMomentumStrategy, {
      candles,
      initialCash: 10_000_000,
      execution: ZERO_COST,
      parameters,
      randomSeed: 1,
      maxPositions: 1,
    });
    expect(result.fills).toEqual([]);
    expect(result.metrics.finalEquity).toBe(10_000_000);
  });

  it('필터를 끄면 하락장에서도 상대적 상위를 산다', () => {
    const candles: Candle[] = [];
    for (let index = 0; index < 70; index += 1) {
      candles.push(candle('AAA', index, 1_000 - index * 5));
      candles.push(candle('BBB', index, 1_000 - index * 3));
    }
    const result = runBacktest(crossSectionalMomentumStrategy, {
      candles,
      initialCash: 10_000_000,
      execution: ZERO_COST,
      parameters: { ...parameters, absoluteMomentumFilter: false },
      randomSeed: 1,
      maxPositions: 1,
    });
    // 덜 빠진 BBB 가 1위
    expect(result.fills.filter((f) => f.side === 'BUY').map((f) => f.symbol)).toContain('BBB');
  });

  it('같은 입력을 두 번 돌리면 같은 결과가 나온다 (재현성 §9.5)', () => {
    const input = {
      candles: buildCandles(70),
      initialCash: 10_000_000,
      execution: ZERO_COST,
      parameters,
      randomSeed: 1,
      maxPositions: 1,
    };
    const first = runBacktest(crossSectionalMomentumStrategy, input);
    const second = runBacktest(crossSectionalMomentumStrategy, input);
    expect(second.fills).toEqual(first.fills);
    expect(second.metrics.finalEquity).toBe(first.metrics.finalEquity);
  });
});
```

- [ ] **Step 2: 테스트가 실패하는 것을 확인**

Run: `pnpm vitest run tests/unit/cross-sectional-momentum.test.ts`
Expected: FAIL — `Failed to resolve import ".../cross-sectional-momentum.js"`

- [ ] **Step 3: 전략 구현**

`src/server/modules/strategy/strategies/cross-sectional-momentum.ts`:

```ts
import { z } from 'zod';
import type { CorporateAction } from '../../facts/domain/fact.js';
import type { Candle } from '../../market-data/domain/candle.js';
import type {
  StrategyBarContext,
  StrategyDecision,
  StrategyInitializeContext,
  TradingStrategy,
} from '../domain/strategy.js';
import { splitAdjustedClose } from './shared/adjusted-price.js';
import { rankDescending, type Scored } from './shared/rank.js';
import { isRebalanceDue, localMonthKey } from './shared/rebalance-schedule.js';
import { planBuyPhase, planSellPhase } from './shared/two-phase-rebalance.js';

/**
 * 횡단면 모멘텀 (설계 2026-07-29-quant-strategies-and-fact-store-design.md §1).
 *
 * 매 리밸런스 시점에 유니버스 전 종목의 12-1개월 수익률을 랭킹해 상위 N 을 동일가중
 * 보유하고 나머지는 청산한다. 소비 timeframe 은 1d 를 전제로 파라미터 기본값이 정해져
 * 있다 (252 거래일 ≈ 12개월).
 *
 * 리밸런스는 두 봉에 나눈다 — 매도 봉, 그 다음 매수 봉. 엔진의 동시 포지션 상한이
 * 청산 대기 포지션도 슬롯으로 세기 때문이다 (two-phase-rebalance.ts 주석).
 */
export const crossSectionalMomentumParameters = z.object({
  formationDays: z.number().int().min(20).max(756).default(252).meta({
    title: '수익률 측정 기간 (봉 수)',
    description:
      '모멘텀을 재는 창의 길이입니다. 일봉 기준 252봉이 약 12개월입니다. 길게 잡으면 장기 추세만 잡고, 짧게 잡으면 최근 흐름에 민감해집니다.',
  }),
  skipDays: z.number().int().min(0).max(63).default(21).meta({
    title: '최근 제외 기간 (봉 수)',
    description:
      '측정 창의 끝에서 최근 N봉을 제외합니다. 일봉 기준 21봉이 약 1개월입니다. 직전 한 달은 단기 반전이 잦아 학계 표준(12-1 모멘텀)이 이 구간을 뺍니다. 0 으로 두면 마지막 봉까지 씁니다.',
  }),
  topN: z.number().int().min(1).max(50).default(10).meta({
    title: '보유 종목 수',
    description:
      '순위 상위 몇 종목을 동일가중으로 보유할지 정합니다. 종목당 비중은 자본의 1/N 입니다. 요청의 최대 동시 보유 종목 수보다 크게 잡으면 일부 종목이 편입되지 않습니다.',
  }),
  rebalanceMonths: z.number().int().min(1).max(12).default(1).meta({
    title: '리밸런스 주기 (개월)',
    description:
      '몇 개월마다 순위를 다시 매길지 정합니다. 새 주기의 첫 거래일에 실행됩니다. 짧게 잡으면 회전율과 거래비용이 올라갑니다.',
  }),
  absoluteMomentumFilter: z.boolean().default(true).meta({
    title: '절대 모멘텀 필터',
    description:
      '켜면 측정 기간 수익률이 0 이하인 종목은 순위 상위여도 편입하지 않습니다. 하락장에서 그만큼 현금으로 남습니다. 끄면 하락장에서도 상대적으로 덜 빠진 종목을 보유합니다.',
  }),
});

export type CrossSectionalMomentumParameters = z.infer<typeof crossSectionalMomentumParameters>;

export interface CrossSectionalMomentumState {
  /** 유니버스 — 이번 봉에 거래가 없는 종목도 후보에서 빠지지 않게 초기화 시점에 고정한다 */
  readonly symbols: readonly string[];
  /** 마지막 리밸런스가 일어난 KST 월 ('YYYY-MM') */
  lastRebalanceMonthKey: string | null;
  /** 다음 봉에서 매수할 편입 종목. null 이면 매수 단계가 아니다 */
  pendingBuys: readonly string[] | null;
}

/**
 * 분할 보정 종가 기준 모멘텀. 이력이 창을 채우지 못하면 null.
 *
 * 창 종점은 `history.length - 1 - skipDays`, 시작점은 그보다 `formationDays` 앞이다.
 * `history` 는 현재 봉을 포함하므로 종점이 마지막 봉이 되는 것은 `skipDays === 0` 일 때뿐이다.
 */
export function momentumScore(
  history: readonly Candle[],
  actions: readonly CorporateAction[],
  formationDays: number,
  skipDays: number,
): number | null {
  const endIndex = history.length - 1 - skipDays;
  const startIndex = endIndex - formationDays;
  if (startIndex < 0) return null;

  const start = splitAdjustedClose(history, actions, startIndex);
  const end = splitAdjustedClose(history, actions, endIndex);
  if (start === null || end === null || start <= 0) return null;
  return end / start - 1;
}

export const crossSectionalMomentumStrategy: TradingStrategy<
  CrossSectionalMomentumParameters,
  CrossSectionalMomentumState
> = {
  id: 'cross-sectional-momentum',
  version: '1.0.0',
  name: '횡단면 모멘텀',
  description:
    '유니버스 전 종목의 12-1개월 수익률을 랭킹해 상위 N 을 동일가중 보유하고 주기마다 교체합니다. 액면분할은 신호 계산에서 보정합니다.',
  parameterSchema: crossSectionalMomentumParameters,

  initialize(context: StrategyInitializeContext): CrossSectionalMomentumState {
    return {
      symbols: [...context.symbols],
      lastRebalanceMonthKey: null,
      pendingBuys: null,
    };
  },

  onBars(
    context: StrategyBarContext,
    state: CrossSectionalMomentumState,
    parameters: CrossSectionalMomentumParameters,
  ): StrategyDecision {
    // 2단계 — 이전 봉에서 넘어온 편입 종목을 매수한다. 이번 봉에 매도가 이미
    // 체결되어 현금이 들어온 상태다 (엔진 §9.2 순서: 체결 → 평가 → 전략).
    if (state.pendingBuys !== null) {
      const buys = planBuyPhase(state.pendingBuys, {
        positions: context.portfolio.positions,
        bars: context.bars,
        equity: context.portfolio.equity,
        topN: parameters.topN,
      });
      state.pendingBuys = null;
      return { orders: buys };
    }

    const monthKey = localMonthKey(context.tsMs);
    if (!isRebalanceDue(state.lastRebalanceMonthKey, monthKey, parameters.rebalanceMonths)) {
      return { orders: [] };
    }

    // 워밍업 중이면 아무것도 하지 않고 리밸런스 시점도 소진하지 않는다 — 첫 리밸런스는
    // 창이 채워진 첫 봉에서 일어난다. 후보가 '필터에 걸려' 비는 경우와 구분해야 하는데,
    // 그때는 목표가 빈 채로 진행해 전량 청산(현금)이 정답이다.
    const minBars = parameters.formationDays + parameters.skipDays + 1;
    const warmedUp = state.symbols.some(
      (symbol) => context.getHistory(symbol).length >= minBars,
    );
    if (!warmedUp) return { orders: [] };

    const scored: Scored[] = [];
    for (const symbol of state.symbols) {
      const score = momentumScore(
        context.getHistory(symbol),
        context.corporateActions(symbol),
        parameters.formationDays,
        parameters.skipDays,
      );
      if (score === null) continue;
      if (parameters.absoluteMomentumFilter && score <= 0) continue;
      scored.push({ symbol, score });
    }

    const ranks = rankDescending(scored);
    const targets = [...ranks.entries()]
      .filter(([, rank]) => rank <= parameters.topN)
      .map(([symbol]) => symbol)
      .sort();

    state.lastRebalanceMonthKey = monthKey;

    const sells = planSellPhase({ targets, positions: context.portfolio.positions });
    const newEntries = targets.filter(
      (symbol) => (context.portfolio.positions.get(symbol)?.quantity ?? 0) <= 0,
    );
    state.pendingBuys = newEntries.length > 0 ? newEntries : null;

    return { orders: sells };
  },
};
```

- [ ] **Step 4: 레지스트리에 등록**

`src/server/modules/strategy/application/strategy-registry.ts` — import 를 추가하고 배열에 넣는다:

```ts
import { crossSectionalMomentumStrategy } from '../strategies/cross-sectional-momentum.js';
import { hourlyBreakoutStrategy } from '../strategies/hourly-breakout.js';
```

```ts
const STRATEGIES: readonly AnyTradingStrategy[] = [
  hourlyBreakoutStrategy as AnyTradingStrategy,
  crossSectionalMomentumStrategy as AnyTradingStrategy,
];
```

- [ ] **Step 5: 테스트 통과 확인**

Run: `pnpm vitest run tests/unit/cross-sectional-momentum.test.ts`
Expected: PASS

`2단계 리밸런스 실행` 블록이 실패하면 워밍업·리밸런스 시점 계산을 먼저 의심한다. 봉 70개는 2025-01-02 부터 약 2개월 반이라 KST 월 경계가 2번 있고, 워밍업(21봉)이 끝나는 시점이 2월 초다. `pnpm vitest run tests/unit/cross-sectional-momentum.test.ts --reporter=verbose` 로 어느 케이스가 깨지는지 좁힌다.

- [ ] **Step 6: 전체 테스트·타입·경계 확인**

Run: `pnpm vitest run && pnpm typecheck && pnpm lint`
Expected: 전부 PASS. `tests/unit/param-specs.test.ts` 나 웹 프리필 테스트가 "등록된 전략 수" 를 단정하고 있으면 새 전략을 포함하도록 고친다.

- [ ] **Step 7: 커밋**

```bash
git add src/server/modules/strategy tests/unit/cross-sectional-momentum.test.ts tests/
git commit -m "feat(strategy): 횡단면 모멘텀 전략

12-1개월 수익률 랭킹 상위 N 동일가중, 캘린더 리밸런스. 분할은 신호
계산에서만 보정한다.

- 유니버스를 initialize 에서 고정 — 이번 봉에 거래 없는 종목도 후보에 남는다
- 워밍업과 '필터에 걸려 후보 없음' 을 구분한다. 후자는 전량 청산(현금)이 정답
- 2단계 리밸런스로 topN == maxPositions 에서도 전량 회전이 된다

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01KFoDKRngmr3EM4tEVudeQ4"
```

---

## Task 5: 전략 B — 밸류·퀄리티 랭킹

> **설계 정정 (이 태스크에서 확정):** 설계 문서는 `consolidated` (연결/별도) 를 전략
> 파라미터로 두었지만 `Fact` 스키마에는 연결·별도를 구분할 자리가 없다 —
> `(scope, key, field, periodKey, asOfTsMs)` 로는 같은 계정의 두 기준을 담으면
> 서로를 덮어쓴다. 전략 파라미터에서 **빼고 수집 시점 선택**으로 옮긴다
> (`facts:sync --fs-div CFS|OFS`, Task 10). 데이터셋 하나는 한 기준만 담는다.
> 필드 이름에 접미사를 붙이는 대안은 `FundamentalField` 유니온을 두 배로 늘리고
> 모든 조회 지점을 분기시키므로 택하지 않는다.

**Files:**
- Create: `src/server/modules/strategy/strategies/value-quality-rank.ts`
- Modify: `src/server/modules/strategy/application/strategy-registry.ts`
- Test: `tests/unit/value-quality-rank.test.ts`

**Interfaces:**
- Consumes: Task 1 의 `FundamentalSnapshot`·`quarterOrdinal`; Task 3 의 `rankDescending`·`isRebalanceDue`·`localMonthKey`·`planSellPhase`·`planBuyPhase`
- Produces:
  - `const valueQualityRankParameters` (Zod 객체 — `topN`·`rebalanceMonths`·`staleQuarters`)
  - `type ValueQualityRankParameters`
  - `interface ValueQualityRankState { readonly symbols: readonly string[]; lastRebalanceMonthKey: string | null; pendingBuys: readonly string[] | null }`
  - `function currentQuarterOrdinal(tsMs: number): number` — KST 월 기준 분기 서수
  - `interface ValueQualityMetrics { earningsYield: number; returnOnCapital: number }`
  - `function computeValueQualityMetrics(snapshot: FundamentalSnapshot, close: number, currentQuarter: number, staleQuarters: number): ValueQualityMetrics | null`
  - `const valueQualityRankStrategy: TradingStrategy<...>` (id `'value-quality-rank'`)

- [ ] **Step 1: 실패하는 테스트 작성**

`tests/unit/value-quality-rank.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type {
  FundamentalField,
  FundamentalSnapshot,
} from '../../src/server/modules/facts/domain/fact.js';
import { StrategyRegistry } from '../../src/server/modules/strategy/application/strategy-registry.js';
import {
  computeValueQualityMetrics,
  currentQuarterOrdinal,
  valueQualityRankParameters,
} from '../../src/server/modules/strategy/strategies/value-quality-rank.js';

/** 계정 → 값 맵으로 스냅샷을 흉내낸다. ttm 은 손익 계정만 응답한다. */
function snapshot(
  values: Partial<Record<FundamentalField, number>>,
  options: { latestPeriodKey?: string; ttmOperatingIncome?: number | null } = {},
): FundamentalSnapshot {
  return {
    latestPeriodKey: options.latestPeriodKey ?? '2025Q1',
    latestAsOfTsMs: 0,
    get: (field) => values[field] ?? null,
    ttm: (field) =>
      field === 'OPERATING_INCOME' ? (options.ttmOperatingIncome ?? null) : null,
  };
}

const HEALTHY: Partial<Record<FundamentalField, number>> = {
  SHARES_OUTSTANDING: 1_000,
  CURRENT_ASSETS: 500_000,
  CURRENT_LIABILITIES: 200_000,
  TANGIBLE_ASSETS: 400_000,
  CASH_AND_EQUIVALENTS: 50_000,
  SHORT_TERM_INVESTMENTS: 30_000,
  SHORT_TERM_BORROWINGS: 60_000,
  CURRENT_LONG_TERM_DEBT: 10_000,
  BONDS: 20_000,
  LONG_TERM_BORROWINGS: 40_000,
};

/** 2025Q2(4~6월) 의 분기 서수 */
const Q2_2025 = 2025 * 4 + 1;

describe('currentQuarterOrdinal', () => {
  it('KST 월을 분기로 접는다', () => {
    expect(currentQuarterOrdinal(Date.UTC(2025, 0, 15))).toBe(2025 * 4); // 1월 → Q1
    expect(currentQuarterOrdinal(Date.UTC(2025, 4, 15))).toBe(2025 * 4 + 1); // 5월 → Q2
    expect(currentQuarterOrdinal(Date.UTC(2025, 11, 1))).toBe(2025 * 4 + 3); // 12월 → Q4
  });

  it('UTC 가 아니라 KST 로 접는다', () => {
    // 2025-04-01 00:00 KST = 2025-03-31 15:00 UTC → Q2
    expect(currentQuarterOrdinal(Date.UTC(2025, 2, 31, 15, 0))).toBe(2025 * 4 + 1);
  });
});

describe('computeValueQualityMetrics', () => {
  it('이익수익률과 자본수익률을 낸다', () => {
    const metrics = computeValueQualityMetrics(
      snapshot(HEALTHY, { ttmOperatingIncome: 120_000 }),
      1_000, // 종가 → 시가총액 1,000주 × 1,000 = 1,000,000
      Q2_2025,
      2,
    );
    // 총차입금 60,000+10,000+20,000+40,000 = 130,000
    // 현금성 50,000+30,000 = 80,000
    // EV = 1,000,000 + 130,000 - 80,000 = 1,050,000
    expect(metrics?.earningsYield).toBeCloseTo(120_000 / 1_050_000);
    // 순운전자본 500,000-200,000 = 300,000, +유형자산 400,000 = 700,000
    expect(metrics?.returnOnCapital).toBeCloseTo(120_000 / 700_000);
  });

  it('TTM 영업이익이 없으면 null', () => {
    expect(
      computeValueQualityMetrics(snapshot(HEALTHY, { ttmOperatingIncome: null }), 1_000, Q2_2025, 2),
    ).toBeNull();
  });

  it('TTM 영업이익이 0 이하면 null (Greenblatt 규칙)', () => {
    expect(
      computeValueQualityMetrics(snapshot(HEALTHY, { ttmOperatingIncome: 0 }), 1_000, Q2_2025, 2),
    ).toBeNull();
    expect(
      computeValueQualityMetrics(snapshot(HEALTHY, { ttmOperatingIncome: -1 }), 1_000, Q2_2025, 2),
    ).toBeNull();
  });

  it('발행주식수가 없으면 null — 시가총액을 만들 수 없다', () => {
    const { SHARES_OUTSTANDING: _omitted, ...withoutShares } = HEALTHY;
    expect(
      computeValueQualityMetrics(
        snapshot(withoutShares, { ttmOperatingIncome: 120_000 }),
        1_000,
        Q2_2025,
        2,
      ),
    ).toBeNull();
  });

  it('현금이 시가총액+차입금을 넘어 EV 가 0 이하면 null', () => {
    const cashRich = { ...HEALTHY, CASH_AND_EQUIVALENTS: 5_000_000 };
    expect(
      computeValueQualityMetrics(
        snapshot(cashRich, { ttmOperatingIncome: 120_000 }),
        1_000,
        Q2_2025,
        2,
      ),
    ).toBeNull();
  });

  it('순운전자본이 음수면 0 으로 깎는다 (원 규칙)', () => {
    const negativeWorkingCapital = { ...HEALTHY, CURRENT_ASSETS: 100_000 }; // 100,000-200,000 < 0
    const metrics = computeValueQualityMetrics(
      snapshot(negativeWorkingCapital, { ttmOperatingIncome: 120_000 }),
      1_000,
      Q2_2025,
      2,
    );
    // 투입자본 = 0 + 유형자산 400,000
    expect(metrics?.returnOnCapital).toBeCloseTo(120_000 / 400_000);
  });

  it('투입자본이 0 이면 null — 무한 수익률을 만들지 않는다', () => {
    const noCapital = { ...HEALTHY, CURRENT_ASSETS: 0, TANGIBLE_ASSETS: 0 };
    expect(
      computeValueQualityMetrics(
        snapshot(noCapital, { ttmOperatingIncome: 120_000 }),
        1_000,
        Q2_2025,
        2,
      ),
    ).toBeNull();
  });

  it('공시가 staleQuarters 보다 낡으면 null', () => {
    // 최신 공시가 2024Q2 (서수 2024*4+1) → 현재 2025Q2 와 4분기 차
    const stale = snapshot(HEALTHY, {
      ttmOperatingIncome: 120_000,
      latestPeriodKey: '2024Q2',
    });
    expect(computeValueQualityMetrics(stale, 1_000, Q2_2025, 2)).toBeNull();
    // staleQuarters 를 넉넉히 주면 통과한다
    expect(computeValueQualityMetrics(stale, 1_000, Q2_2025, 8)).not.toBeNull();
  });

  it('직전 분기 공시는 낡은 것이 아니다', () => {
    const fresh = snapshot(HEALTHY, {
      ttmOperatingIncome: 120_000,
      latestPeriodKey: '2025Q1',
    });
    expect(computeValueQualityMetrics(fresh, 1_000, Q2_2025, 2)).not.toBeNull();
  });

  it('분기 키가 아닌 latestPeriodKey 는 null', () => {
    const annual = snapshot(HEALTHY, {
      ttmOperatingIncome: 120_000,
      latestPeriodKey: '2025FY',
    });
    expect(computeValueQualityMetrics(annual, 1_000, Q2_2025, 2)).toBeNull();
  });

  it('없는 차입금·현금 계정은 0 으로 본다', () => {
    const minimal: Partial<Record<FundamentalField, number>> = {
      SHARES_OUTSTANDING: 1_000,
      CURRENT_ASSETS: 500_000,
      CURRENT_LIABILITIES: 200_000,
      TANGIBLE_ASSETS: 400_000,
    };
    const metrics = computeValueQualityMetrics(
      snapshot(minimal, { ttmOperatingIncome: 100_000 }),
      1_000,
      Q2_2025,
      2,
    );
    expect(metrics?.earningsYield).toBeCloseTo(100_000 / 1_000_000); // EV = 시가총액
  });

  it('종가가 0 이하면 null', () => {
    expect(
      computeValueQualityMetrics(snapshot(HEALTHY, { ttmOperatingIncome: 120_000 }), 0, Q2_2025, 2),
    ).toBeNull();
  });
});

describe('valueQualityRankParameters', () => {
  it('기본값만으로 파싱된다', () => {
    expect(valueQualityRankParameters.parse({})).toEqual({
      topN: 20,
      rebalanceMonths: 3,
      staleQuarters: 2,
    });
  });

  it('연결/별도(consolidated)는 파라미터가 아니다 — 수집 시점 선택이다', () => {
    const parsed = valueQualityRankParameters.parse({}) as Record<string, unknown>;
    expect('consolidated' in parsed).toBe(false);
  });

  it('범위 밖 값을 거부한다', () => {
    expect(valueQualityRankParameters.safeParse({ staleQuarters: 0 }).success).toBe(false);
    expect(valueQualityRankParameters.safeParse({ staleQuarters: 9 }).success).toBe(false);
    expect(valueQualityRankParameters.safeParse({ topN: 51 }).success).toBe(false);
  });
});

describe('레지스트리 등록', () => {
  it('전략 목록에 노출된다', () => {
    expect(new StrategyRegistry().list().map((s) => s.id)).toContain('value-quality-rank');
  });

  it('JSON 스키마에 한국어 라벨과 기본값이 실린다', () => {
    const schema = new StrategyRegistry().getParameterJsonSchema('value-quality-rank');
    const properties = (schema as { properties: Record<string, Record<string, unknown>> }).properties;
    expect(properties.topN?.title).toBe('보유 종목 수');
    expect(properties.staleQuarters?.default).toBe(2);
  });
});
```

- [ ] **Step 2: 랭킹 통합 테스트 작성 (같은 파일에 이어서)**

아래 `import` 들은 파일 맨 위 import 블록에 **합쳐서** 넣는다 — 같은 파일에 import 문이
두 번 나오면 `pnpm lint` 가 잡는다. `FundamentalField` 는 Step 1 에서 이미 import 했다.

```ts
import { runBacktest } from '../../src/server/modules/backtest/domain/engine.js';
import type { ExecutionProfile } from '../../src/server/modules/backtest/domain/types.js';
import type { Fact } from '../../src/server/modules/facts/domain/fact.js';
import type { Candle } from '../../src/server/modules/market-data/domain/candle.js';
import { valueQualityRankStrategy } from '../../src/server/modules/strategy/strategies/value-quality-rank.js';

const DAY = 86_400_000;
const START = Date.UTC(2025, 0, 2);

const ZERO_COST: ExecutionProfile = {
  cost: { id: 'zero', version: '1', buyCommissionRate: 0, sellCommissionRate: 0, sellTaxRate: 0 },
  slippage: { id: 'zero', version: '1', bps: 0, fixed: 0 },
  rules: { tickSize: 0, minOrderQty: 1 },
};

function candleFor(symbol: string, index: number, close: number): Candle {
  return {
    symbol,
    market: 'KR',
    timeframe: '1d',
    tsMs: START + index * DAY,
    open: close,
    high: close,
    low: close,
    close,
    volume: 1_000,
  };
}

/** 한 종목의 4개 분기 재무를 모두 같은 시각에 공시된 것으로 만든다 */
function quarterlyFacts(
  symbol: string,
  asOfTsMs: number,
  quarterlyOperatingIncome: number,
  balance: Partial<Record<FundamentalField, number>>,
): Fact[] {
  const facts: Fact[] = [];
  const quarters = ['2024Q2', '2024Q3', '2024Q4', '2025Q1'];
  for (const periodKey of quarters) {
    facts.push({
      scope: 'SYMBOL',
      key: symbol,
      field: 'OPERATING_INCOME',
      periodKey,
      asOfTsMs,
      value: quarterlyOperatingIncome,
      unit: 'KRW',
    });
  }
  for (const [field, value] of Object.entries(balance)) {
    facts.push({
      scope: 'SYMBOL',
      key: symbol,
      field,
      periodKey: '2025Q1',
      asOfTsMs,
      value: value as number,
      unit: field === 'SHARES_OUTSTANDING' ? 'SHARES' : 'KRW',
    });
  }
  return facts;
}

describe('밸류·퀄리티 랭킹 실행', () => {
  const disclosed = START + 5 * DAY;
  const balance: Partial<Record<FundamentalField, number>> = {
    SHARES_OUTSTANDING: 1_000,
    CURRENT_ASSETS: 500_000,
    CURRENT_LIABILITIES: 200_000,
    TANGIBLE_ASSETS: 400_000,
  };

  // CHEAP 은 같은 이익에 주가가 싸다 → 이익수익률·ROC 둘 다 우위
  const facts: Fact[] = [
    ...quarterlyFacts('CHEAP', disclosed, 50_000, balance),
    ...quarterlyFacts('RICH', disclosed, 5_000, balance),
  ];

  function candles(bars: number): Candle[] {
    const out: Candle[] = [];
    for (let index = 0; index < bars; index += 1) {
      out.push(candleFor('CHEAP', index, 1_000));
      out.push(candleFor('RICH', index, 1_000));
    }
    return out;
  }

  const parameters = { topN: 1, rebalanceMonths: 3, staleQuarters: 2 };

  it('두 지표 합산 상위만 편입한다', () => {
    const result = runBacktest(valueQualityRankStrategy, {
      candles: candles(40),
      initialCash: 10_000_000,
      execution: ZERO_COST,
      parameters,
      randomSeed: 1,
      maxPositions: 1,
      facts,
    });
    const buys = result.fills.filter((fill) => fill.side === 'BUY');
    expect(buys.length).toBeGreaterThan(0);
    expect(new Set(buys.map((fill) => fill.symbol))).toEqual(new Set(['CHEAP']));
  });

  it('공시 전에는 아무것도 사지 않는다', () => {
    const result = runBacktest(valueQualityRankStrategy, {
      candles: candles(4), // 공시(5봉)보다 이른 구간만
      initialCash: 10_000_000,
      execution: ZERO_COST,
      parameters,
      randomSeed: 1,
      maxPositions: 1,
      facts,
    });
    expect(result.fills).toEqual([]);
  });

  it('facts 가 없으면 아무것도 사지 않는다 — 조용히 랭킹하지 않는다', () => {
    const result = runBacktest(valueQualityRankStrategy, {
      candles: candles(40),
      initialCash: 10_000_000,
      execution: ZERO_COST,
      parameters,
      randomSeed: 1,
      maxPositions: 1,
    });
    expect(result.fills).toEqual([]);
  });

  it('같은 입력을 두 번 돌리면 같은 결과가 나온다 (재현성 §9.5)', () => {
    const input = {
      candles: candles(40),
      initialCash: 10_000_000,
      execution: ZERO_COST,
      parameters,
      randomSeed: 1,
      maxPositions: 1,
      facts,
    };
    expect(runBacktest(valueQualityRankStrategy, input).fills).toEqual(
      runBacktest(valueQualityRankStrategy, input).fills,
    );
  });
});
```

- [ ] **Step 3: 테스트가 실패하는 것을 확인**

Run: `pnpm vitest run tests/unit/value-quality-rank.test.ts`
Expected: FAIL — `Failed to resolve import ".../value-quality-rank.js"`

- [ ] **Step 4: 전략 구현**

`src/server/modules/strategy/strategies/value-quality-rank.ts`:

```ts
import { z } from 'zod';
import type { FundamentalField, FundamentalSnapshot } from '../../facts/domain/fact.js';
import { quarterOrdinal } from '../../facts/domain/pit-fact-view.js';
import type {
  StrategyBarContext,
  StrategyDecision,
  StrategyInitializeContext,
  TradingStrategy,
} from '../domain/strategy.js';
import { rankDescending, type Scored } from './shared/rank.js';
import { isRebalanceDue, localMonthKey } from './shared/rebalance-schedule.js';
import { planBuyPhase, planSellPhase } from './shared/two-phase-rebalance.js';

/**
 * 밸류·퀄리티 랭킹 (설계 2026-07-29-quant-strategies-and-fact-store-design.md §2).
 *
 * 이익수익률(TTM EBIT / EV) 과 자본수익률(TTM EBIT / 투입자본) 을 각각 순위 매겨
 * 합산하고, 합이 작은 상위 N 을 동일가중 보유한다.
 *
 * 비율을 팩트로 저장하지 않는 이유: 시가총액은 매 봉 종가에 따라 변한다. 원자료만
 * 저장하고 여기서 봉 시점 가격으로 계산한다.
 *
 * 연결(CFS)/별도(OFS) 는 파라미터가 아니라 **수집 시점 선택**이다 — Fact 스키마에
 * 두 기준을 함께 담을 자리가 없다. 데이터셋 하나는 한 기준만 담는다.
 */
export const valueQualityRankParameters = z.object({
  topN: z.number().int().min(1).max(50).default(20).meta({
    title: '보유 종목 수',
    description:
      '두 지표 순위 합이 작은 상위 몇 종목을 동일가중으로 보유할지 정합니다. 종목당 비중은 자본의 1/N 입니다.',
  }),
  rebalanceMonths: z.number().int().min(1).max(12).default(3).meta({
    title: '리밸런스 주기 (개월)',
    description:
      '몇 개월마다 순위를 다시 매길지 정합니다. 분기 재무가 갱신되는 주기와 맞춰 3개월이 기본입니다. 새 주기의 첫 거래일에 실행됩니다.',
  }),
  staleQuarters: z.number().int().min(1).max(8).default(2).meta({
    title: '허용 공시 지연 (분기)',
    description:
      '가장 최근 공시가 현재 분기로부터 몇 분기까지 낡아도 후보로 볼지 정합니다. 작게 잡으면 공시가 끊긴 관리종목·상장폐지 직전 종목이 순위 상위에 오르는 것을 막습니다.',
  }),
});

export type ValueQualityRankParameters = z.infer<typeof valueQualityRankParameters>;

export interface ValueQualityRankState {
  readonly symbols: readonly string[];
  lastRebalanceMonthKey: string | null;
  pendingBuys: readonly string[] | null;
}

export interface ValueQualityMetrics {
  /** TTM EBIT / EV */
  readonly earningsYield: number;
  /** TTM EBIT / (순운전자본 + 유형자산) */
  readonly returnOnCapital: number;
}

const DEBT_FIELDS: readonly FundamentalField[] = [
  'SHORT_TERM_BORROWINGS',
  'CURRENT_LONG_TERM_DEBT',
  'BONDS',
  'LONG_TERM_BORROWINGS',
];

const CASH_FIELDS: readonly FundamentalField[] = ['CASH_AND_EQUIVALENTS', 'SHORT_TERM_INVESTMENTS'];

function sumFields(
  snapshot: FundamentalSnapshot,
  fields: readonly FundamentalField[],
): number {
  let total = 0;
  for (const field of fields) total += snapshot.get(field) ?? 0;
  return total;
}

/** 봉 시각의 KST 월을 분기 서수로 접는다 (quarterOrdinal 과 같은 눈금) */
export function currentQuarterOrdinal(tsMs: number): number {
  const [year, month] = localMonthKey(tsMs).split('-').map(Number) as [number, number];
  return year * 4 + Math.floor((month - 1) / 3);
}

/**
 * 두 지표 계산. 후보 자격이 없으면 null 을 준다 — 호출부가 조용히 0 으로 세지 않도록
 * 제외 사유를 전부 여기서 흡수한다.
 */
export function computeValueQualityMetrics(
  snapshot: FundamentalSnapshot,
  close: number,
  currentQuarter: number,
  staleQuarters: number,
): ValueQualityMetrics | null {
  if (!Number.isFinite(close) || close <= 0) return null;

  // 공시가 너무 낡았으면 제외 (관리종목·상장폐지 직전)
  const latestQuarter =
    snapshot.latestPeriodKey === null ? null : quarterOrdinal(snapshot.latestPeriodKey);
  if (latestQuarter === null) return null;
  if (currentQuarter - latestQuarter > staleQuarters) return null;

  const ebit = snapshot.ttm('OPERATING_INCOME');
  if (ebit === null || ebit <= 0) return null; // 원 규칙: 적자 기업 제외

  const shares = snapshot.get('SHARES_OUTSTANDING');
  if (shares === null || shares <= 0) return null;

  const marketCap = close * shares;
  const enterpriseValue = marketCap + sumFields(snapshot, DEBT_FIELDS) - sumFields(snapshot, CASH_FIELDS);
  if (enterpriseValue <= 0) return null; // 현금이 시총+차입금을 넘는 경우 — 비율이 무의미해진다

  const currentAssets = snapshot.get('CURRENT_ASSETS');
  const currentLiabilities = snapshot.get('CURRENT_LIABILITIES');
  const tangibleAssets = snapshot.get('TANGIBLE_ASSETS');
  if (currentAssets === null || currentLiabilities === null || tangibleAssets === null) return null;

  // 순운전자본이 음수면 0 으로 깎는다 (Greenblatt 관례) — 음수 투입자본은 부호를 뒤집는다
  const workingCapital = Math.max(currentAssets - currentLiabilities, 0);
  const investedCapital = workingCapital + tangibleAssets;
  if (investedCapital <= 0) return null;

  return {
    earningsYield: ebit / enterpriseValue,
    returnOnCapital: ebit / investedCapital,
  };
}

export const valueQualityRankStrategy: TradingStrategy<
  ValueQualityRankParameters,
  ValueQualityRankState
> = {
  id: 'value-quality-rank',
  version: '1.0.0',
  name: '밸류·퀄리티 랭킹',
  description:
    '이익수익률(EBIT/EV)과 자본수익률(EBIT/투입자본) 순위를 합산해 상위 N 을 동일가중 보유합니다. 상장시점 재무제표가 수집된 데이터셋에서만 동작합니다.',
  parameterSchema: valueQualityRankParameters,

  initialize(context: StrategyInitializeContext): ValueQualityRankState {
    return { symbols: [...context.symbols], lastRebalanceMonthKey: null, pendingBuys: null };
  },

  onBars(
    context: StrategyBarContext,
    state: ValueQualityRankState,
    parameters: ValueQualityRankParameters,
  ): StrategyDecision {
    if (state.pendingBuys !== null) {
      const buys = planBuyPhase(state.pendingBuys, {
        positions: context.portfolio.positions,
        bars: context.bars,
        equity: context.portfolio.equity,
        topN: parameters.topN,
      });
      state.pendingBuys = null;
      return { orders: buys };
    }

    const monthKey = localMonthKey(context.tsMs);
    if (!isRebalanceDue(state.lastRebalanceMonthKey, monthKey, parameters.rebalanceMonths)) {
      return { orders: [] };
    }

    const currentQuarter = currentQuarterOrdinal(context.tsMs);
    const earningsYield: Scored[] = [];
    const returnOnCapital: Scored[] = [];

    for (const symbol of state.symbols) {
      const snapshot = context.fundamentals(symbol);
      const close = context.bars.get(symbol)?.close;
      if (!snapshot || close === undefined) continue;
      const metrics = computeValueQualityMetrics(
        snapshot,
        close,
        currentQuarter,
        parameters.staleQuarters,
      );
      if (!metrics) continue;
      earningsYield.push({ symbol, score: metrics.earningsYield });
      returnOnCapital.push({ symbol, score: metrics.returnOnCapital });
    }

    // 재무가 아직 하나도 공시되지 않았으면 리밸런스 시점을 소진하지 않는다 —
    // 다음 봉에서 다시 본다. 후보가 '자격 미달로' 비는 것과 구분되지 않지만, 둘 다
    // 아무것도 사지 않는 것이 정답이므로 같은 경로로 둔다.
    if (earningsYield.length === 0) return { orders: [] };

    const yieldRanks = rankDescending(earningsYield);
    const capitalRanks = rankDescending(returnOnCapital);
    const combined: Scored[] = earningsYield.map(({ symbol }) => ({
      symbol,
      // 순위 합이 작을수록 좋다 — rankDescending 은 큰 값을 1위로 두므로 부호를 뒤집는다
      score: -((yieldRanks.get(symbol) ?? 0) + (capitalRanks.get(symbol) ?? 0)),
    }));

    const finalRanks = rankDescending(combined);
    const targets = [...finalRanks.entries()]
      .filter(([, rank]) => rank <= parameters.topN)
      .map(([symbol]) => symbol)
      .sort();

    state.lastRebalanceMonthKey = monthKey;

    const sells = planSellPhase({ targets, positions: context.portfolio.positions });
    const newEntries = targets.filter(
      (symbol) => (context.portfolio.positions.get(symbol)?.quantity ?? 0) <= 0,
    );
    state.pendingBuys = newEntries.length > 0 ? newEntries : null;

    return { orders: sells };
  },
};
```

- [ ] **Step 5: 레지스트리에 등록**

`src/server/modules/strategy/application/strategy-registry.ts`:

```ts
import { crossSectionalMomentumStrategy } from '../strategies/cross-sectional-momentum.js';
import { hourlyBreakoutStrategy } from '../strategies/hourly-breakout.js';
import { valueQualityRankStrategy } from '../strategies/value-quality-rank.js';
```

```ts
const STRATEGIES: readonly AnyTradingStrategy[] = [
  hourlyBreakoutStrategy as AnyTradingStrategy,
  crossSectionalMomentumStrategy as AnyTradingStrategy,
  valueQualityRankStrategy as AnyTradingStrategy,
];
```

- [ ] **Step 6: 테스트 통과 확인**

Run: `pnpm vitest run tests/unit/value-quality-rank.test.ts && pnpm vitest run && pnpm typecheck && pnpm lint`
Expected: 전부 PASS

- [ ] **Step 7: 설계 문서 정정 반영**

`docs/superpowers/specs/2026-07-29-quant-strategies-and-fact-store-design.md` §2 의 파라미터
블록에서 `consolidated` 줄을 삭제하고, 그 아래에 문단을 추가한다:

```markdown
연결(CFS)/별도(OFS)는 전략 파라미터가 아니라 **수집 시점 선택**이다
(`facts:sync --fs-div`). `Fact` 의 키는 `(scope, key, field, periodKey, asOfTsMs)`
이므로 같은 계정의 두 기준을 함께 담으면 서로를 덮어쓴다. 필드 이름에 접미사를 붙여
유니온을 두 배로 늘리는 대안은 모든 조회 지점을 분기시키므로 택하지 않았다.
데이터셋 하나는 한 기준만 담는다.
```

- [ ] **Step 8: 커밋**

```bash
git add src/server/modules/strategy tests/unit/value-quality-rank.test.ts docs/superpowers/specs
git commit -m "feat(strategy): 밸류·퀄리티 랭킹 전략

이익수익률(EBIT/EV)과 자본수익률(EBIT/투입자본) 순위 합산 상위 N 동일가중.
비율은 저장하지 않고 봉 시점 종가로 계산한다.

제외 사유를 computeValueQualityMetrics 한 곳에 모았다 — 적자, 발행주식수
없음, EV<=0, 투입자본<=0, 공시 지연. 호출부가 조용히 0 으로 세지 않는다.

연결/별도는 파라미터에서 빼고 수집 시점 선택으로 옮겼다 — Fact 키에 두
기준을 담을 자리가 없다. 설계 문서도 함께 정정.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01KFoDKRngmr3EM4tEVudeQ4"
```

---

## Task 6: 유니버스 상한 확대 (50 → 200)

랭킹 전략은 유니버스가 50종목이면 "상위 N 선별" 의 의미가 얕다. 하위호환 확대이므로
저장된 과거 요청은 그대로 유효하다.

**Files:**
- Modify: `src/shared/schemas/backtest-request.ts:17`
- Test: `tests/unit/backtest-request.test.ts`

**Interfaces:**
- Produces: `backtestRequestSchema` 의 `universe.symbols` 가 최대 200개를 받는다. 다른 서명 변화 없음.

- [ ] **Step 1: 실패하는 테스트 추가**

`tests/unit/backtest-request.test.ts` 에 아래 블록을 추가한다 (기존 테스트는 건드리지 않는다):

```ts
describe('유니버스 상한 (랭킹 전략용 확대)', () => {
  function requestWithSymbols(count: number): Record<string, unknown> {
    return {
      strategyId: 'cross-sectional-momentum',
      strategyVersion: '1.0.0',
      parameters: {},
      datasetId: 'ds-1',
      universe: {
        type: 'SYMBOLS',
        symbols: Array.from({ length: count }, (_, index) =>
          String(index + 1).padStart(6, '0'),
        ),
      },
      period: { from: '2020-01-01', to: '2025-12-31' },
      capital: { initialCash: 10_000_000, currency: 'KRW' },
      execution: {
        fillTiming: 'NEXT_BAR_OPEN',
        commissionProfileId: 'kr-default',
        slippageProfileId: 'kr-default',
      },
      risk: { maxPositions: 20 },
    };
  }

  it('200종목을 받는다', () => {
    expect(backtestRequestSchema.safeParse(requestWithSymbols(200)).success).toBe(true);
  });

  it('201종목은 거부한다', () => {
    expect(backtestRequestSchema.safeParse(requestWithSymbols(201)).success).toBe(false);
  });

  it('기존 상한(50) 이하 요청은 그대로 유효하다', () => {
    expect(backtestRequestSchema.safeParse(requestWithSymbols(50)).success).toBe(true);
    expect(backtestRequestSchema.safeParse(requestWithSymbols(1)).success).toBe(true);
  });

  it('0종목은 여전히 거부한다', () => {
    expect(backtestRequestSchema.safeParse(requestWithSymbols(0)).success).toBe(false);
  });
});
```

파일 상단에 `backtestRequestSchema` import 가 없으면 추가한다:

```ts
import { backtestRequestSchema } from '../../src/shared/schemas/backtest-request.js';
```

- [ ] **Step 2: 테스트가 실패하는 것을 확인**

Run: `pnpm vitest run tests/unit/backtest-request.test.ts`
Expected: FAIL — `200종목을 받는다` 가 실패 (현재 상한 50)

- [ ] **Step 3: 상한 확대**

`src/shared/schemas/backtest-request.ts` 의 `universe` 블록을 교체한다:

```ts
  universe: z.object({
    type: z.literal('SYMBOLS'),
    /**
     * 상한 200 — 횡단면 랭킹 전략은 유니버스가 좁으면 '상위 N 선별' 이 의미를 잃는다
     * (설계 2026-07-29-quant-strategies-and-fact-store-design.md). 확대이므로
     * 저장된 과거 요청(복제·재실행)은 그대로 유효하다.
     * 메모리 상한은 여기가 아니라 MAX_BACKTEST_BARS 가 지킨다 (bar-estimate.ts).
     */
    symbols: z.array(z.string().regex(/^[A-Za-z0-9._-]{1,20}$/)).min(1).max(200),
  }),
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `pnpm vitest run tests/unit/backtest-request.test.ts && pnpm vitest run tests/unit/bar-estimate.test.ts && pnpm typecheck`
Expected: PASS. 봉 수 상한은 `MAX_BACKTEST_BARS` 가 별도로 지키므로 200종목 × 장기간 요청은 제출 검증에서 거부된다 — 이 태스크가 그 방어선을 약화시키지 않는다.

- [ ] **Step 5: 커밋**

```bash
git add src/shared/schemas/backtest-request.ts tests/unit/backtest-request.test.ts
git commit -m "feat(backtest): 유니버스 상한 50 -> 200

횡단면 랭킹 전략은 유니버스가 좁으면 상위 N 선별이 의미를 잃는다.
확대이므로 저장된 과거 요청은 그대로 유효하다. 메모리 상한은 여전히
MAX_BACKTEST_BARS 가 지킨다.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01KFoDKRngmr3EM4tEVudeQ4"
```

---

## Task 7: REST 클라이언트를 shared 로 승격

DART 는 증권사가 아니다. `facts` 모듈이 `broker/infrastructure` 를 import 하면 계층이
거짓말을 하게 된다 (§7 — 도메인·애플리케이션에 증권사 이름이 없어야 한다는 원칙의 연장).
토큰·rate limit·backoff 로직을 다시 쓰는 것은 DRY 위반이므로 공용 위치로 옮긴다.

기계적 이동이다. 동작 변경 없음.

**Files:**
- Create: `src/server/shared/rest-client.ts` (`broker/infrastructure/rest-client.ts` 내용 그대로)
- Delete: `src/server/modules/broker/infrastructure/rest-client.ts`
- Modify: `src/server/modules/broker/infrastructure/kiwoom/kiwoom-market-data-source.ts:8`
- Modify: `src/server/modules/broker/infrastructure/toss/toss-market-data-source.ts:14`
- Modify: `tests/unit/rest-client.test.ts:2`
- Modify: `.dependency-cruiser.cjs`

**Interfaces:**
- Produces: `src/server/shared/rest-client.ts` 가 `BrokerRestClient`·`TokenProvider`·`RestClientOptions` 를 export 한다. 클래스·메서드 이름은 바꾸지 않는다 — 이름 변경까지 겹치면 리뷰어가 동작 변경과 구분할 수 없다.
- `RestClientOptions.tokenProvider` 가 **optional** 이 된다. 없으면 `Authorization` 헤더를 붙이지 않는다.

**이 태스크는 커밋 3개다.** Step 1~5 순수 이동(동작 불변), Step 6~9 인증 방식 확장,
Step 10~12 이름 변경(`BrokerRestClient` → `RestClient`). 섞으면 리뷰어가 "이동 중에 뭐가
바뀌었나" 를 diff 로 확인할 수 없다. 이름 변경을 마지막에 두는 이유도 같다 — 앞의 두
커밋은 이름이 그대로여서 diff 가 순수하게 이동·동작만 보여준다.

- [ ] **Step 1: 파일 이동**

```bash
git mv src/server/modules/broker/infrastructure/rest-client.ts src/server/shared/rest-client.ts
```

- [ ] **Step 2: import 3곳 수정**

`src/server/modules/broker/infrastructure/kiwoom/kiwoom-market-data-source.ts`:

```ts
import { BrokerRestClient, type TokenProvider } from '../../../../shared/rest-client.js';
```

`src/server/modules/broker/infrastructure/toss/toss-market-data-source.ts`:

```ts
import { BrokerRestClient, type TokenProvider } from '../../../../shared/rest-client.js';
```

`tests/unit/rest-client.test.ts`:

```ts
import { BrokerRestClient, type TokenProvider } from '../../src/server/shared/rest-client.js';
```

경로 깊이가 맞지 않으면 `pnpm typecheck` 가 잡는다. `src/server/modules/broker/infrastructure/toss/` 에서 `src/server/shared/` 까지는 4단계 위다.

- [ ] **Step 3: 계층 규칙 추가**

`.dependency-cruiser.cjs` 의 `forbidden` 배열에 아래 규칙을 추가한다 (`backtest-no-broker-adapter` 다음):

```js
    {
      name: 'facts-no-broker',
      severity: 'error',
      comment:
        'facts → broker 금지 (§7) — DART 는 증권사가 아니다. 공용 HTTP 클라이언트는 src/server/shared 에 있다',
      from: { path: 'src/server/modules/facts' },
      to: { path: 'src/server/modules/broker' },
    },
```

- [ ] **Step 4: 전체 검증**

Run: `pnpm vitest run tests/unit/rest-client.test.ts tests/unit/toss-market-data-source.test.ts tests/architecture/module-boundaries.test.ts && pnpm typecheck && pnpm lint`
Expected: 전부 PASS. 남은 참조가 있으면 `grep -rn "infrastructure/rest-client" src tests` 로 찾는다 (결과가 없어야 한다).

- [ ] **Step 5: 커밋**

```bash
git add -A src/server tests/unit/rest-client.test.ts .dependency-cruiser.cjs
git commit -m "refactor(server): REST 클라이언트를 shared 로 승격

DART 어댑터가 곧 같은 토큰·rate limit·backoff 로직을 쓴다. broker
모듈에서 가져오면 계층이 거짓말을 하고(DART 는 증권사가 아니다),
복사하면 DRY 위반이다.

이동만 한다 — 이름·시그니처는 그대로 둔다. facts-no-broker 규칙을
dependency-cruiser 에 추가해 되돌아가지 못하게 못박는다.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01KFoDKRngmr3EM4tEVudeQ4"
```

---

- [ ] **Step 6: 토큰 없는 인증을 위한 실패 테스트 추가**

DART 는 OAuth 토큰이 아니라 `crtfc_key` 쿼리 파라미터로 인증한다. 현재
`BrokerRestClient` 는 `tokenProvider` 를 필수로 요구하고 매 요청에
`Authorization: Bearer <token>` 을 붙인다 — 더미 토큰 공급자를 끼우는 것은
거짓 헤더를 보내는 일이므로 옵션을 하나 더 받는다.

`tests/unit/rest-client.test.ts` 에 추가:

```ts
describe('tokenProvider 없는 인증 (쿼리 파라미터 방식)', () => {
  it('tokenProvider 를 생략하면 Authorization 헤더를 붙이지 않는다', async () => {
    const seen: Array<Record<string, string>> = [];
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      seen.push((init?.headers ?? {}) as Record<string, string>);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as unknown as typeof fetch;

    const client = new BrokerRestClient({
      baseUrl: 'https://opendart.fss.or.kr',
      logger: { debug() {}, info() {}, warn() {}, error() {} } as never,
      fetchImpl,
      sleep: async () => undefined,
      clock: () => 0,
    });

    await client.request('default', '/api/list.json?crtfc_key=x');
    expect(seen[0]).not.toHaveProperty('authorization');
  });

  it('tokenProvider 가 있으면 기존대로 Bearer 를 붙인다', async () => {
    const seen: Array<Record<string, string>> = [];
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      seen.push((init?.headers ?? {}) as Record<string, string>);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as unknown as typeof fetch;

    const tokenProvider: TokenProvider = {
      issueToken: async () => ({ accessToken: 'tok', expiresAtMs: 9_999_999_999_999 }),
    };
    const client = new BrokerRestClient({
      baseUrl: 'https://api.example.com',
      tokenProvider,
      logger: { debug() {}, info() {}, warn() {}, error() {} } as never,
      fetchImpl,
      sleep: async () => undefined,
      clock: () => 0,
    });

    await client.request('default', '/x');
    expect(seen[0]?.authorization).toBe('Bearer tok');
  });

  it('tokenProvider 없이 401 이 오면 토큰 재발급을 시도하지 않고 즉시 실패한다', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return new Response('unauthorized', { status: 401 });
    }) as unknown as typeof fetch;

    const client = new BrokerRestClient({
      baseUrl: 'https://opendart.fss.or.kr',
      logger: { debug() {}, info() {}, warn() {}, error() {} } as never,
      fetchImpl,
      sleep: async () => undefined,
      clock: () => 0,
    });

    await expect(client.request('default', '/x')).rejects.toThrow(/401/);
    expect(calls).toBe(1); // 재발급 재시도가 없어야 한다
  });
});
```

Run: `pnpm vitest run tests/unit/rest-client.test.ts`
Expected: FAIL — `tokenProvider` 가 필수라 타입 오류, 그리고 401 재시도가 1회 더 발생

- [ ] **Step 7: `tokenProvider` 를 optional 로 만든다**

`src/server/shared/rest-client.ts` 에서 세 곳을 고친다.

(a) 옵션 타입:

```ts
export interface RestClientOptions {
  readonly baseUrl: string;
  /**
   * OAuth 토큰 공급자. 생략하면 Authorization 헤더를 붙이지 않는다 —
   * DART 처럼 쿼리 파라미터로 인증하는 API 를 위한 경로다. 더미 토큰 공급자를
   * 끼우면 거짓 헤더를 보내게 되므로 옵션으로 둔다.
   */
  readonly tokenProvider?: TokenProvider;
  readonly logger: Logger;
  readonly fetchImpl?: typeof fetch;
  /** API 그룹별 최소 호출 간격 (ms). 기본 그룹은 'default' */
  readonly groupMinIntervalMs?: Record<string, number>;
  readonly maxRetries?: number;
  /** 테스트 결정성을 위해 주입 가능한 jitter (0~1) */
  readonly random?: () => number;
  /** 테스트용 sleep 대체 */
  readonly sleep?: (ms: number) => Promise<void>;
  readonly clock?: () => number;
}
```

(b) `getToken` 이 `null` 을 낼 수 있게 한다:

```ts
  private async getToken(): Promise<string | null> {
    const provider = this.options.tokenProvider;
    if (!provider) return null;
    const now = this.clock();
    if (!this.token || this.token.expiresAtMs - TOKEN_REFRESH_MARGIN_MS <= now) {
      this.token = await provider.issueToken(this.fetchImpl);
    }
    return this.token.accessToken;
  }
```

(c) `request` 안에서 헤더와 401 처리를 조건부로 만든다:

```ts
      const token = await this.getToken();

      const response = await this.fetchImpl(`${this.options.baseUrl}${path}`, {
        method: init.method ?? 'GET',
        headers: {
          ...(token !== null ? { authorization: `Bearer ${token}` } : {}),
          ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
          ...init.headers,
        },
        ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      });
```

```ts
      // 토큰 인증일 때만 401 재발급을 시도한다 — 쿼리 키 방식에서 401 은 키가
      // 틀린 것이므로 재시도가 의미 없다
      if (response.status === 401 && attempt === 0 && this.options.tokenProvider) {
        this.token = null;
        attempt += 1;
        continue;
      }
```

- [ ] **Step 8: 테스트 통과 확인**

Run: `pnpm vitest run tests/unit/rest-client.test.ts tests/unit/toss-market-data-source.test.ts && pnpm typecheck && pnpm lint`
Expected: PASS. 기존 토스·키움 어댑터는 `tokenProvider` 를 넘기므로 동작이 그대로다.

- [ ] **Step 9: 두 번째 커밋**

```bash
git add src/server/shared/rest-client.ts tests/unit/rest-client.test.ts
git commit -m "feat(server): REST 클라이언트에 토큰 없는 인증 경로

DART 는 crtfc_key 쿼리 파라미터로 인증한다. 더미 tokenProvider 를
끼우면 거짓 Authorization 헤더를 보내게 되므로 optional 로 만든다.

tokenProvider 가 없으면 401 재발급 재시도도 건너뛴다 — 쿼리 키 방식에서
401 은 키가 틀린 것이라 재시도가 의미 없다.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01KFoDKRngmr3EM4tEVudeQ4"
```

- [ ] **Step 10: 클래스 이름 변경 — `BrokerRestClient` → `RestClient`**

`src/server/shared/` 에 `Broker*` 이름이 남으면 위치와 이름이 서로 거짓말을 한다.
기계적 치환이다. `TokenProvider`·`RestClientOptions` 는 이미 일반 이름이므로 건드리지
않는다.

`src/server/shared/rest-client.ts`:

```ts
export class RestClient {
```

파일 상단 주석도 고친다 — "증권사 공통" 이 아니다:

```ts
/**
 * 공통 REST 클라이언트 (스펙 §13):
 * - 토큰 발급·캐싱·만료 전 재발급 (tokenProvider 가 있을 때)
 * - API 그룹별 rate limiter (최소 간격)
 * - 429 는 Retry-After 우선, 이후 exponential backoff + jitter
 *
 * 증권사 어댑터와 DART 어댑터가 공유한다 — 그래서 modules/broker 가 아니라 shared 에 있다.
 */
```

에러 메시지의 `broker` 도 일반화한다:

```ts
        throw new Error(`REST 요청 실패: ${response.status} ${body.slice(0, 200)}`);
```

로그의 `module: 'broker'` 는 호출자를 식별하는 필드다. 공용 클라이언트가 자기를
`broker` 라고 부르면 DART 요청이 broker 로그로 섞인다 — `module: 'rest-client'` 로 바꾼다:

```ts
      this.options.logger.warn(
        { module: 'rest-client', event: 'rest.retry', status: response.status, attempt, backoffMs },
        'retrying REST request',
      );
```

- [ ] **Step 11: 참조 4곳 치환**

```bash
grep -rn "BrokerRestClient" src tests
```

나오는 곳을 모두 `RestClient` 로 바꾼다 — `kiwoom-market-data-source.ts`,
`toss-market-data-source.ts`, `tests/unit/rest-client.test.ts`, 그리고 Step 7 에서
추가한 테스트 블록. `grep` 결과가 비어야 완료다.

로그 메시지를 문자열로 단정하는 테스트가 있으면 새 문구로 고친다.

- [ ] **Step 12: 검증 + 세 번째 커밋**

Run: `pnpm vitest run && pnpm typecheck && pnpm lint`
Expected: 전부 PASS

```bash
git add -A src tests
git commit -m "refactor(server): BrokerRestClient -> RestClient

shared 에 있는 클래스가 Broker* 이면 위치와 이름이 서로 거짓말을 한다.
증권사 어댑터와 DART 어댑터가 함께 쓰는 클라이언트다.

로그 필드도 module: 'broker' -> 'rest-client' 로 바꿨다 — 공용
클라이언트가 자기를 broker 라고 부르면 DART 요청이 broker 로그로 섞인다.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01KFoDKRngmr3EM4tEVudeQ4"
```

## Task 8: 팩트 포트 + Parquet 저장소

**Files:**
- Create: `src/server/modules/facts/application/ports.ts`
- Create: `src/server/modules/facts/infrastructure/parquet-fact-repository.ts`
- Test: `tests/integration/fact-repository.test.ts`

**Interfaces:**
- Consumes: Task 1 의 `Fact`·`FactScope`; `market-data/infrastructure/duckdb-service.ts` 의 `DuckDbService`·`sqlString`
- Produces:
  - `interface FactQuery { datasetId: string; scope: FactScope; keys?: readonly string[]; fields?: readonly string[]; asOfMaxTsMs?: number }`
  - `interface FactRepository { getFacts(query: FactQuery): Promise<Fact[]>; saveFacts(datasetId: string, facts: readonly Fact[]): Promise<void>; hasFacts(datasetId: string, scope: FactScope): boolean }`
  - `interface FactIngestionResult { facts: readonly Fact[]; gaps: readonly FactIngestionGap[] }`
  - `interface FactIngestionGap { symbol: string; periodKey: string; reason: string }`
  - `interface FetchFinancialsRequest { symbols: readonly string[]; fromYear: number; toYear: number; consolidated: boolean }`
  - `interface FactSource { fetchFinancials(r): Promise<FactIngestionResult>; fetchCorporateActions(r): Promise<FactIngestionResult> }`
  - `class FactSourceNotConfiguredError extends Error`
  - `class ParquetFactRepository implements FactRepository`

- [ ] **Step 1: 포트 파일 작성**

`src/server/modules/facts/application/ports.ts`:

```ts
import type { Fact, FactScope } from '../domain/fact.js';

export interface FactQuery {
  /** 데이터셋 단위 물리 격리 — 캔들과 같은 관례 (§11) */
  readonly datasetId: string;
  readonly scope: FactScope;
  readonly keys?: readonly string[];
  readonly fields?: readonly string[];
  /** 이 시각 이후에 공시된 팩트는 제외한다 */
  readonly asOfMaxTsMs?: number;
}

export interface FactRepository {
  getFacts(query: FactQuery): Promise<Fact[]>;
  saveFacts(datasetId: string, facts: readonly Fact[]): Promise<void>;
  /** 제출 검증용 — 재무가 수집되지 않은 데이터셋에 재무 전략을 걸지 않게 막는다 */
  hasFacts(datasetId: string, scope: FactScope): boolean;
}

/** 수집이 채우지 못한 칸. 조용히 빠뜨리면 랭킹이 소리 없이 왜곡된다. */
export interface FactIngestionGap {
  readonly symbol: string;
  readonly periodKey: string;
  readonly reason: string;
}

export interface FactIngestionResult {
  readonly facts: readonly Fact[];
  /** 파서가 만든 것과 같은 이름을 쓴다 (ParsedFinancials.gaps) — 경계마다 이름이
   *  바뀌면 합칠 때 조용히 빈 배열이 된다 */
  readonly gaps: readonly FactIngestionGap[];
}

export interface FetchFinancialsRequest {
  readonly symbols: readonly string[];
  readonly fromYear: number;
  readonly toYear: number;
  /** true = 연결(CFS), false = 별도(OFS). 데이터셋 하나는 한 기준만 담는다 */
  readonly consolidated: boolean;
}

export interface FactSource {
  /** 재무제표 계정 + 발행주식수 */
  fetchFinancials(request: FetchFinancialsRequest): Promise<FactIngestionResult>;
  /** 분할·무상증자 등 자본변동 이벤트 */
  fetchCorporateActions(request: FetchFinancialsRequest): Promise<FactIngestionResult>;
}

export class FactSourceNotConfiguredError extends Error {
  constructor() {
    super('DART_API_KEY 가 설정되지 않았습니다. 재무 데이터 수집을 사용할 수 없습니다.');
    this.name = 'FactSourceNotConfiguredError';
  }
}
```

- [ ] **Step 2: 실패하는 통합 테스트 작성**

`tests/integration/fact-repository.test.ts`:

```ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Fact } from '../../src/server/modules/facts/domain/fact.js';
import { ParquetFactRepository } from '../../src/server/modules/facts/infrastructure/parquet-fact-repository.js';
import { DuckDbService } from '../../src/server/modules/market-data/infrastructure/duckdb-service.js';

let dataRoot: string;
let duckdb: DuckDbService;
let repository: ParquetFactRepository;

function fact(overrides: Partial<Fact> = {}): Fact {
  return {
    scope: 'SYMBOL',
    key: '005930',
    field: 'OPERATING_INCOME',
    periodKey: '2025Q1',
    asOfTsMs: 1_700_000_000_000,
    value: 123_456,
    unit: 'KRW',
    ...overrides,
  };
}

beforeEach(() => {
  dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'facts-'));
  duckdb = new DuckDbService({ threads: 1, memoryLimit: '256MB' });
  repository = new ParquetFactRepository(dataRoot, duckdb);
});

afterEach(() => {
  duckdb.close();
  fs.rmSync(dataRoot, { recursive: true, force: true });
});

describe('ParquetFactRepository', () => {
  it('저장한 팩트를 그대로 읽는다', async () => {
    await repository.saveFacts('ds-1', [fact()]);
    const rows = await repository.getFacts({ datasetId: 'ds-1', scope: 'SYMBOL' });
    expect(rows).toEqual([fact()]);
  });

  it('빈 배열 저장은 아무 일도 하지 않는다', async () => {
    await repository.saveFacts('ds-1', []);
    expect(repository.hasFacts('ds-1', 'SYMBOL')).toBe(false);
  });

  it('수집되지 않은 데이터셋 조회는 빈 배열', async () => {
    expect(await repository.getFacts({ datasetId: 'nope', scope: 'SYMBOL' })).toEqual([]);
    expect(repository.hasFacts('nope', 'SYMBOL')).toBe(false);
  });

  it('asOfMaxTsMs 로 미래 공시를 잘라낸다', async () => {
    await repository.saveFacts('ds-1', [
      fact({ periodKey: '2025Q1', asOfTsMs: 1_000, value: 10 }),
      fact({ periodKey: '2025Q2', asOfTsMs: 2_000, value: 20 }),
    ]);
    const rows = await repository.getFacts({
      datasetId: 'ds-1',
      scope: 'SYMBOL',
      asOfMaxTsMs: 1_500,
    });
    expect(rows.map((row) => row.periodKey)).toEqual(['2025Q1']);
  });

  it('keys·fields 로 걸러낸다', async () => {
    await repository.saveFacts('ds-1', [
      fact({ key: '005930', field: 'OPERATING_INCOME' }),
      fact({ key: '000660', field: 'OPERATING_INCOME' }),
      fact({ key: '005930', field: 'CURRENT_ASSETS' }),
    ]);
    const rows = await repository.getFacts({
      datasetId: 'ds-1',
      scope: 'SYMBOL',
      keys: ['005930'],
      fields: ['OPERATING_INCOME'],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.key).toBe('005930');
    expect(rows[0]?.field).toBe('OPERATING_INCOME');
  });

  it('같은 (key, field, periodKey, asOf) 재수집은 덮어쓴다 — idempotent', async () => {
    await repository.saveFacts('ds-1', [fact({ value: 100 })]);
    await repository.saveFacts('ds-1', [fact({ value: 200 })]);
    const rows = await repository.getFacts({ datasetId: 'ds-1', scope: 'SYMBOL' });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.value).toBe(200);
  });

  it('같은 분기의 다른 asOf(재집계)는 둘 다 남는다', async () => {
    await repository.saveFacts('ds-1', [
      fact({ asOfTsMs: 1_000, value: 100 }),
      fact({ asOfTsMs: 2_000, value: 90 }),
    ]);
    const rows = await repository.getFacts({ datasetId: 'ds-1', scope: 'SYMBOL' });
    expect(rows).toHaveLength(2);
  });

  it('두 번에 걸쳐 저장해도 앞서 저장한 것이 남는다 (병합 저장)', async () => {
    await repository.saveFacts('ds-1', [fact({ periodKey: '2025Q1' })]);
    await repository.saveFacts('ds-1', [fact({ periodKey: '2025Q2' })]);
    const rows = await repository.getFacts({ datasetId: 'ds-1', scope: 'SYMBOL' });
    expect(rows.map((row) => row.periodKey).sort()).toEqual(['2025Q1', '2025Q2']);
  });

  it('데이터셋끼리 격리된다', async () => {
    await repository.saveFacts('ds-1', [fact({ value: 1 })]);
    await repository.saveFacts('ds-2', [fact({ value: 2 })]);
    const first = await repository.getFacts({ datasetId: 'ds-1', scope: 'SYMBOL' });
    expect(first.map((row) => row.value)).toEqual([1]);
  });

  it('SYMBOL 과 MACRO 는 다른 파티션이다', async () => {
    await repository.saveFacts('ds-1', [
      fact(),
      { scope: 'MACRO', key: 'KR_BASE_RATE', field: 'RATE', periodKey: '2025-03-01', asOfTsMs: 1_000, value: 3.5, unit: 'PERCENT' },
    ]);
    expect(await repository.getFacts({ datasetId: 'ds-1', scope: 'MACRO' })).toHaveLength(1);
    expect(await repository.getFacts({ datasetId: 'ds-1', scope: 'SYMBOL' })).toHaveLength(1);
    expect(repository.hasFacts('ds-1', 'MACRO')).toBe(true);
  });

  it('데이터셋 삭제 경로에 놓인다 — dataset= 디렉터리 아래에 저장한다', async () => {
    await repository.saveFacts('ds-1', [fact()]);
    expect(fs.existsSync(path.join(dataRoot, 'dataset=ds-1'))).toBe(true);
    // ParquetCandleRepository.deleteDataset 이 dataset=<id> 를 재귀 삭제하므로
    // 팩트 정리 코드를 따로 만들지 않는다
    fs.rmSync(path.join(dataRoot, 'dataset=ds-1'), { recursive: true, force: true });
    expect(await repository.getFacts({ datasetId: 'ds-1', scope: 'SYMBOL' })).toEqual([]);
  });

  it('부적절한 datasetId 는 거부한다 (경로 조작 방지)', async () => {
    await expect(repository.saveFacts('../escape', [fact()])).rejects.toThrow(/datasetId/);
  });

  it('결과는 (key, field, periodKey, asOf) 순으로 결정적이다', async () => {
    await repository.saveFacts('ds-1', [
      fact({ key: '000660', periodKey: '2025Q2' }),
      fact({ key: '005930', periodKey: '2025Q1' }),
      fact({ key: '000660', periodKey: '2025Q1' }),
    ]);
    const rows = await repository.getFacts({ datasetId: 'ds-1', scope: 'SYMBOL' });
    expect(rows.map((row) => `${row.key}:${row.periodKey}`)).toEqual([
      '000660:2025Q1',
      '000660:2025Q2',
      '005930:2025Q1',
    ]);
  });
});
```

- [ ] **Step 3: 테스트가 실패하는 것을 확인**

Run: `pnpm vitest run tests/integration/fact-repository.test.ts`
Expected: FAIL — `Failed to resolve import ".../parquet-fact-repository.js"`

- [ ] **Step 4: Parquet 저장소 구현**

`src/server/modules/facts/infrastructure/parquet-fact-repository.ts`:

```ts
import fs from 'node:fs';
import path from 'node:path';
import { DuckDbService, sqlString } from '../../market-data/infrastructure/duckdb-service.js';
import type { Fact, FactScope } from '../domain/fact.js';
import type { FactQuery, FactRepository } from '../application/ports.js';

const DATASET_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const SCOPES: readonly FactScope[] = ['SYMBOL', 'MACRO'];

let tmpCounter = 0;

/**
 * Parquet 기반 FactRepository.
 *   dataset=<id>/facts/scope=SYMBOL/data.parquet
 *
 * 캔들과 같은 최상위 파티션(`dataset=`)을 쓰는 이유가 세 개다:
 *  1. 재현성이 공짜다 — 과거 공시를 나중에 backfill 해도 다른 데이터셋의 과거
 *     백테스트가 변하지 않는다.
 *  2. 정리 코드가 필요 없다 — ParquetCandleRepository.deleteDataset 이 dataset=<id>
 *     를 재귀 삭제한다.
 *  3. 작다 — 200종목 × 20분기 × 12필드 ≈ 5만 행. 단일 파일로 충분하다.
 *
 * 컬럼: key VARCHAR, field VARCHAR, period_key VARCHAR, as_of_ts_ms BIGINT,
 *       value DOUBLE, unit VARCHAR. scope 는 경로 파티션이라 파일에 넣지 않는다.
 */
export class ParquetFactRepository implements FactRepository {
  /** 파티션별 쓰기 직렬화 — read-merge-write 경합으로 행이 유실되지 않게 한다 */
  private readonly partitionLocks = new Map<string, Promise<unknown>>();

  constructor(
    private readonly dataRoot: string,
    private readonly duckdb: DuckDbService,
  ) {}

  private assertDatasetId(datasetId: string): void {
    if (!DATASET_ID_PATTERN.test(datasetId)) throw new Error(`invalid datasetId: ${datasetId}`);
  }

  private partitionDir(datasetId: string, scope: FactScope): string {
    return path.join(this.dataRoot, `dataset=${datasetId}`, 'facts', `scope=${scope}`);
  }

  private filePath(datasetId: string, scope: FactScope): string {
    return path.join(this.partitionDir(datasetId, scope), 'data.parquet');
  }

  hasFacts(datasetId: string, scope: FactScope): boolean {
    if (!DATASET_ID_PATTERN.test(datasetId)) return false;
    return fs.existsSync(this.filePath(datasetId, scope));
  }

  async saveFacts(datasetId: string, facts: readonly Fact[]): Promise<void> {
    this.assertDatasetId(datasetId);
    if (facts.length === 0) return;

    for (const scope of SCOPES) {
      const scoped = facts.filter((fact) => fact.scope === scope);
      if (scoped.length === 0) continue;
      await this.writePartitionLocked(datasetId, scope, scoped);
    }
  }

  private async writePartitionLocked(
    datasetId: string,
    scope: FactScope,
    incoming: readonly Fact[],
  ): Promise<void> {
    const dir = this.partitionDir(datasetId, scope);
    const previous = this.partitionLocks.get(dir) ?? Promise.resolve();
    const run = previous.then(
      () => this.writePartition(datasetId, scope, incoming),
      () => this.writePartition(datasetId, scope, incoming),
    );
    const guard = run.then(
      () => undefined,
      () => undefined,
    );
    this.partitionLocks.set(dir, guard);
    void guard.then(() => {
      if (this.partitionLocks.get(dir) === guard) this.partitionLocks.delete(dir);
    });
    await run;
  }

  private async writePartition(
    datasetId: string,
    scope: FactScope,
    incoming: readonly Fact[],
  ): Promise<void> {
    const dir = this.partitionDir(datasetId, scope);
    fs.mkdirSync(dir, { recursive: true });
    const target = this.filePath(datasetId, scope);
    tmpCounter += 1;
    const tmpPath = path.join(dir, `data.parquet.tmp-${process.pid}-${tmpCounter}`);

    const existing = fs.existsSync(target)
      ? await this.getFacts({ datasetId, scope })
      : [];

    // (key, field, periodKey, asOf) 가 같으면 뒤에 온 것이 이긴다 — idempotent 재수집.
    // asOf 가 다르면 둘 다 남는다: 재집계는 새 행이어야 과거 시점 조회가 변하지 않는다.
    const merged = new Map<string, Fact>();
    for (const fact of [...existing, ...incoming]) {
      // 구분자 없이 이어붙이면 (key, field) 경계가 어긋나며 충돌한다 — key·field 는
      // 리터럴 유니온이 아니라 string 이고 MACRO 키는 자유형식이다
      merged.set(JSON.stringify([fact.key, fact.field, fact.periodKey, fact.asOfTsMs]), fact);
    }

    const values = [...merged.values()]
      .map(
        (fact) =>
          `(${sqlString(fact.key)}, ${sqlString(fact.field)}, ${sqlString(fact.periodKey)}, ` +
          `${fact.asOfTsMs}, ${fact.value}, ${sqlString(fact.unit)})`,
      )
      .join(',\n');

    // DuckDB 의 VALUES 타입 추론(DECIMAL/BIGINT)을 피하려고 명시적으로 CAST 한다
    await this.duckdb.run(
      `COPY (
         SELECT
           CAST(key AS VARCHAR) AS key,
           CAST(field AS VARCHAR) AS field,
           CAST(period_key AS VARCHAR) AS period_key,
           CAST(as_of_ts_ms AS BIGINT) AS as_of_ts_ms,
           CAST(value AS DOUBLE) AS value,
           CAST(unit AS VARCHAR) AS unit
         FROM (VALUES ${values}) AS t(key, field, period_key, as_of_ts_ms, value, unit)
         ORDER BY key, field, period_key, as_of_ts_ms
       ) TO ${sqlString(tmpPath.replaceAll('\\', '/'))} (FORMAT PARQUET, COMPRESSION ZSTD)`,
    );

    fs.renameSync(tmpPath, target);
  }

  async getFacts(query: FactQuery): Promise<Fact[]> {
    this.assertDatasetId(query.datasetId);
    const target = this.filePath(query.datasetId, query.scope);
    if (!fs.existsSync(target)) return [];

    const conditions: string[] = [];
    if (query.asOfMaxTsMs !== undefined) conditions.push(`as_of_ts_ms <= ${query.asOfMaxTsMs}`);
    if (query.keys && query.keys.length > 0) {
      conditions.push(`key IN (${query.keys.map((key) => sqlString(key)).join(', ')})`);
    }
    if (query.fields && query.fields.length > 0) {
      conditions.push(`field IN (${query.fields.map((field) => sqlString(field)).join(', ')})`);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const rows = await this.duckdb.query<{
      key: string;
      field: string;
      period_key: string;
      as_of_ts_ms: bigint | number;
      value: number;
      unit: string;
    }>(
      `SELECT CAST(key AS VARCHAR) AS key,
              CAST(field AS VARCHAR) AS field,
              CAST(period_key AS VARCHAR) AS period_key,
              CAST(as_of_ts_ms AS BIGINT) AS as_of_ts_ms,
              CAST(value AS DOUBLE) AS value,
              CAST(unit AS VARCHAR) AS unit
       FROM read_parquet(${sqlString(target.replaceAll('\\', '/'))})
       ${where}
       ORDER BY key, field, period_key, as_of_ts_ms`,
    );

    return rows.map((row) => ({
      scope: query.scope,
      key: row.key,
      field: row.field,
      periodKey: row.period_key,
      asOfTsMs: Number(row.as_of_ts_ms),
      value: row.value,
      unit: row.unit,
    }));
  }
}
```

- [ ] **Step 5: 테스트 통과 확인**

Run: `pnpm vitest run tests/integration/fact-repository.test.ts`
Expected: PASS

`결과는 ... 순으로 결정적이다` 가 실패하면 `ORDER BY` 절과 문자열 정렬 규칙(DuckDB 는 바이너리 정렬)을 확인한다.

- [ ] **Step 6: 경계·타입 검사**

Run: `pnpm vitest run tests/architecture/module-boundaries.test.ts && pnpm typecheck && pnpm lint`
Expected: PASS. `facts/infrastructure` 가 `market-data/infrastructure` 를 import 하는 것은 infrastructure → infrastructure 이고 금지 규칙에 없다. `facts/application/ports.ts` 는 `facts/domain` 만 import 한다.

- [ ] **Step 7: 커밋**

```bash
git add src/server/modules/facts tests/integration/fact-repository.test.ts
git commit -m "feat(facts): 팩트 포트 + Parquet 저장소

dataset=<id>/facts/scope=<scope>/data.parquet — 캔들과 같은 최상위
파티션을 쓴다. 재현성이 공짜로 따라오고(backfill 이 다른 데이터셋의
과거를 바꾸지 않는다) deleteDataset 이 이미 정리한다.

(key, field, periodKey, asOf) 가 같으면 덮어쓰고 asOf 가 다르면 둘 다
남긴다 — 재집계가 새 행이어야 과거 시점 조회가 변하지 않는다.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01KFoDKRngmr3EM4tEVudeQ4"
```

---

## Task 9: DART 응답 파싱 (순수 계층)

HTTP 없이 테스트할 수 있는 부분을 먼저 만든다. 정확성 함정이 전부 여기에 있다.

**Files:**
- Create: `src/server/modules/facts/infrastructure/dart/dart-account-map.ts`
- Create: `src/server/modules/facts/infrastructure/dart/dart-report-parser.ts`
- Test: `tests/unit/dart-report-parser.test.ts`

**Interfaces:**
- Consumes: Task 1 의 `Fact`·`FundamentalField`·`CORPORATE_ACTION_FIELD`; Task 8 의 `FactIngestionGap`
- Produces:
  - `type DartReportCode = '11013' | '11012' | '11014' | '11011'` (1Q / 반기 / 3Q / 사업보고서)
  - `const REPORT_CODE_TO_QUARTER: Record<DartReportCode, 1 | 2 | 3 | 4>`
  - `interface DartAccountRule { field: FundamentalField; statement: 'BS' | 'IS' }` — 누적 여부는 `statement` 가 결정한다 (IS 는 누적, BS 는 시점). 별도 플래그를 두면 두 값이 어긋날 수 있다
  - `function resolveAccount(accountId: string, accountName: string): DartAccountRule | null`
  - `interface DartFinancialRow { rcept_no: string; reprt_code: string; bsns_year: string; sj_div: string; account_id: string; account_nm: string; thstrm_amount: string; thstrm_add_amount?: string }`
  - `function receiptDateToAsOfTsMs(rceptNo: string): number | null`
  - `function parseAmount(raw: string): number | null`
  - `interface ParsedFinancials { facts: readonly Fact[]; gaps: readonly FactIngestionGap[] }`
  - `function parseFinancialRows(symbol: string, rowsByReport: ReadonlyMap<DartReportCode, readonly DartFinancialRow[]>): ParsedFinancials`
  - `interface DartIssuanceRow { isu_dcrs_de: string; isu_dcrs_stle: string; isu_dcrs_qy: string; rcept_no: string }`
  - `function parseIssuanceRows(symbol: string, rows: readonly DartIssuanceRow[], sharesBefore: (dateKey: string) => number | null): ParsedFinancials`

- [ ] **Step 1: 계정 매핑 파일 작성**

`src/server/modules/facts/infrastructure/dart/dart-account-map.ts`:

```ts
import type { FundamentalField } from '../../domain/fact.js';

export interface DartAccountRule {
  readonly field: FundamentalField;
  /** BS = 재무상태표(시점값), IS = 손익계산서(기간값 — 누적 차분 필요) */
  readonly statement: 'BS' | 'IS';
}

/**
 * IFRS 표준 태그(account_id) 우선 매핑. 이것이 있으면 회사별 계정명 차이를 타지 않는다.
 * 태그·필드 이름은 DART API 키 발급 후 실제 응답으로 검증해 조정한다
 * (kiwoom-market-data-source.ts 가 쓰는 것과 같은 관례).
 */
const BY_ACCOUNT_ID: Record<string, DartAccountRule> = {
  'ifrs-full_ProfitLossFromOperatingActivities': { field: 'OPERATING_INCOME', statement: 'IS' },
  'dart_OperatingIncomeLoss': { field: 'OPERATING_INCOME', statement: 'IS' },
  'ifrs-full_CurrentAssets': { field: 'CURRENT_ASSETS', statement: 'BS' },
  'ifrs-full_CurrentLiabilities': { field: 'CURRENT_LIABILITIES', statement: 'BS' },
  'ifrs-full_PropertyPlantAndEquipment': { field: 'TANGIBLE_ASSETS', statement: 'BS' },
  'ifrs-full_CashAndCashEquivalents': { field: 'CASH_AND_EQUIVALENTS', statement: 'BS' },
  'dart_ShortTermDepositsNotClassifiedAsCashEquivalents': {
    field: 'SHORT_TERM_INVESTMENTS',
    statement: 'BS',
  },
  'ifrs-full_ShorttermBorrowings': { field: 'SHORT_TERM_BORROWINGS', statement: 'BS' },
  'dart_ShortTermBorrowings': { field: 'SHORT_TERM_BORROWINGS', statement: 'BS' },
  'dart_CurrentPortionOfLongTermBorrowings': {
    field: 'CURRENT_LONG_TERM_DEBT',
    statement: 'BS',
  },
  'dart_BondsIssued': { field: 'BONDS', statement: 'BS' },
  'ifrs-full_LongtermBorrowings': { field: 'LONG_TERM_BORROWINGS', statement: 'BS' },
  'dart_LongTermBorrowings': { field: 'LONG_TERM_BORROWINGS', statement: 'BS' },
};

/**
 * 계정명(account_nm) 폴백. 표준 태그가 '-표준계정코드 미사용-' 인 회사를 위한 경로다.
 * 공백을 제거하고 정확히 일치하는 것만 받는다 — 부분 일치는 '단기차입금' 이
 * '유동성장기차입금' 을 잡는 식으로 조용히 틀린다.
 */
const BY_ACCOUNT_NAME: Record<string, DartAccountRule> = {
  영업이익: { field: 'OPERATING_INCOME', statement: 'IS' },
  '영업이익(손실)': { field: 'OPERATING_INCOME', statement: 'IS' },
  유동자산: { field: 'CURRENT_ASSETS', statement: 'BS' },
  유동부채: { field: 'CURRENT_LIABILITIES', statement: 'BS' },
  유형자산: { field: 'TANGIBLE_ASSETS', statement: 'BS' },
  현금및현금성자산: { field: 'CASH_AND_EQUIVALENTS', statement: 'BS' },
  단기금융상품: { field: 'SHORT_TERM_INVESTMENTS', statement: 'BS' },
  단기차입금: { field: 'SHORT_TERM_BORROWINGS', statement: 'BS' },
  유동성장기부채: { field: 'CURRENT_LONG_TERM_DEBT', statement: 'BS' },
  유동성장기차입금: { field: 'CURRENT_LONG_TERM_DEBT', statement: 'BS' },
  사채: { field: 'BONDS', statement: 'BS' },
  장기차입금: { field: 'LONG_TERM_BORROWINGS', statement: 'BS' },
};

export function resolveAccount(accountId: string, accountName: string): DartAccountRule | null {
  const byId = BY_ACCOUNT_ID[accountId.trim()];
  if (byId) return byId;
  return BY_ACCOUNT_NAME[accountName.replace(/\s/g, '')] ?? null;
}
```

- [ ] **Step 2: 실패하는 테스트 작성**

`tests/unit/dart-report-parser.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { resolveAccount } from '../../src/server/modules/facts/infrastructure/dart/dart-account-map.js';
import {
  parseAmount,
  parseFinancialRows,
  parseIssuanceRows,
  receiptDateToAsOfTsMs,
  type DartFinancialRow,
  type DartIssuanceRow,
  type DartReportCode,
} from '../../src/server/modules/facts/infrastructure/dart/dart-report-parser.js';

describe('resolveAccount', () => {
  it('IFRS 표준 태그를 우선한다', () => {
    expect(resolveAccount('ifrs-full_CurrentAssets', '아무이름')).toEqual({
      field: 'CURRENT_ASSETS',
      statement: 'BS',
    });
  });

  it('표준 태그가 없으면 계정명으로 폴백한다', () => {
    expect(resolveAccount('-표준계정코드 미사용-', '유동부채')).toEqual({
      field: 'CURRENT_LIABILITIES',
      statement: 'BS',
    });
  });

  it('계정명의 공백을 무시한다', () => {
    expect(resolveAccount('', '현금및 현금성 자산')?.field).toBe('CASH_AND_EQUIVALENTS');
  });

  it('부분 일치로 잘못 잡지 않는다', () => {
    // '유동성장기차입금' 이 '단기차입금' 으로 매핑되면 총차입금이 이중 계상된다
    expect(resolveAccount('', '유동성장기차입금')?.field).toBe('CURRENT_LONG_TERM_DEBT');
    expect(resolveAccount('', '기타단기차입금등')).toBeNull();
  });

  it('모르는 계정은 null', () => {
    expect(resolveAccount('unknown_tag', '알수없는계정')).toBeNull();
  });
});

describe('parseAmount', () => {
  it('천 단위 쉼표를 제거한다', () => {
    expect(parseAmount('1,234,567')).toBe(1_234_567);
  });

  it('괄호 음수를 처리한다', () => {
    expect(parseAmount('(1,234)')).toBe(-1_234);
  });

  it('마이너스 부호를 처리한다', () => {
    expect(parseAmount('-1,234')).toBe(-1_234);
  });

  it('빈 값·하이픈은 null', () => {
    expect(parseAmount('')).toBeNull();
    expect(parseAmount('-')).toBeNull();
    expect(parseAmount('  ')).toBeNull();
  });

  it('숫자가 아니면 null', () => {
    expect(parseAmount('해당사항없음')).toBeNull();
  });
});

describe('receiptDateToAsOfTsMs', () => {
  it('접수번호 앞 8자리를 접수일 18:00 KST 로 바꾼다', () => {
    // 2025-05-15 18:00 KST = 2025-05-15 09:00 UTC
    expect(receiptDateToAsOfTsMs('20250515000123')).toBe(Date.UTC(2025, 4, 15, 9, 0));
  });

  it('1d 봉 마감(15:30 KST)보다 늦다 — 공시일 당일 봉에는 반영되지 않는다', () => {
    const asOf = receiptDateToAsOfTsMs('20250515000123') as number;
    const barClose = Date.UTC(2025, 4, 15, 6, 30); // 15:30 KST
    expect(asOf).toBeGreaterThan(barClose);
  });

  it('형식이 다르면 null', () => {
    expect(receiptDateToAsOfTsMs('짧음')).toBeNull();
    expect(receiptDateToAsOfTsMs('99999999000001')).toBeNull();
  });
});

describe('parseFinancialRows — 누적값 차분', () => {
  const RECEIPTS: Record<DartReportCode, string> = {
    '11013': '20250515000001', // 1Q
    '11012': '20250814000001', // 반기
    '11014': '20251114000001', // 3Q
    '11011': '20260316000001', // 사업보고서
  };

  function incomeRow(report: DartReportCode, cumulative: number): DartFinancialRow {
    return {
      rcept_no: RECEIPTS[report],
      reprt_code: report,
      bsns_year: '2025',
      sj_div: 'IS',
      account_id: 'ifrs-full_ProfitLossFromOperatingActivities',
      account_nm: '영업이익',
      thstrm_amount: '0',
      thstrm_add_amount: String(cumulative),
    };
  }

  function balanceRow(report: DartReportCode, amount: number): DartFinancialRow {
    return {
      rcept_no: RECEIPTS[report],
      reprt_code: report,
      bsns_year: '2025',
      sj_div: 'BS',
      account_id: 'ifrs-full_CurrentAssets',
      account_nm: '유동자산',
      thstrm_amount: String(amount),
    };
  }

  it('손익 계정은 누적 차분으로 분기 단독값을 만든다', () => {
    const rows = new Map<DartReportCode, DartFinancialRow[]>([
      ['11013', [incomeRow('11013', 100)]],
      ['11012', [incomeRow('11012', 250)]],
      ['11014', [incomeRow('11014', 420)]],
      ['11011', [incomeRow('11011', 600)]],
    ]);
    const { facts } = parseFinancialRows('005930', rows);
    const income = facts
      .filter((fact) => fact.field === 'OPERATING_INCOME')
      .sort((a, b) => (a.periodKey < b.periodKey ? -1 : 1));

    expect(income.map((fact) => [fact.periodKey, fact.value])).toEqual([
      ['2025Q1', 100],
      ['2025Q2', 150],
      ['2025Q3', 170],
      ['2025Q4', 180],
    ]);
  });

  it('중간 보고서가 없으면 그 뒤 분기를 만들지 않고 gap 으로 남긴다', () => {
    const rows = new Map<DartReportCode, DartFinancialRow[]>([
      ['11013', [incomeRow('11013', 100)]],
      // 반기 누락
      ['11014', [incomeRow('11014', 420)]],
    ]);
    const { facts, gaps } = parseFinancialRows('005930', rows);
    const periods = facts.filter((f) => f.field === 'OPERATING_INCOME').map((f) => f.periodKey);
    expect(periods).toEqual(['2025Q1']);
    expect(gaps.some((gap) => gap.periodKey === '2025Q3')).toBe(true);
  });

  it('재무상태표 계정은 차분하지 않고 시점값을 그대로 쓴다', () => {
    const rows = new Map<DartReportCode, DartFinancialRow[]>([
      ['11013', [balanceRow('11013', 500)]],
      ['11012', [balanceRow('11012', 520)]],
    ]);
    const { facts } = parseFinancialRows('005930', rows);
    const assets = facts
      .filter((fact) => fact.field === 'CURRENT_ASSETS')
      .sort((a, b) => (a.periodKey < b.periodKey ? -1 : 1));
    expect(assets.map((fact) => [fact.periodKey, fact.value])).toEqual([
      ['2025Q1', 500],
      ['2025Q2', 520],
    ]);
  });

  it('각 분기의 asOfTsMs 는 그 분기 보고서의 접수일이다', () => {
    const rows = new Map<DartReportCode, DartFinancialRow[]>([
      ['11013', [incomeRow('11013', 100)]],
      ['11012', [incomeRow('11012', 250)]],
    ]);
    const { facts } = parseFinancialRows('005930', rows);
    const q2 = facts.find((f) => f.periodKey === '2025Q2' && f.field === 'OPERATING_INCOME');
    // Q2 단독값은 반기보고서가 나온 뒤에야 알 수 있다
    expect(q2?.asOfTsMs).toBe(receiptDateToAsOfTsMs('20250814000001'));
  });

  it('thstrm_add_amount 가 없으면 thstrm_amount 를 누적으로 본다', () => {
    const rows = new Map<DartReportCode, DartFinancialRow[]>([
      [
        '11013',
        [
          {
            rcept_no: RECEIPTS['11013'],
            reprt_code: '11013',
            bsns_year: '2025',
            sj_div: 'IS',
            account_id: 'ifrs-full_ProfitLossFromOperatingActivities',
            account_nm: '영업이익',
            thstrm_amount: '100',
          },
        ],
      ],
    ]);
    const { facts } = parseFinancialRows('005930', rows);
    expect(facts.find((f) => f.periodKey === '2025Q1')?.value).toBe(100);
  });

  it('매핑되지 않는 계정은 조용히 버리지 않고 gap 으로 남긴다', () => {
    const rows = new Map<DartReportCode, DartFinancialRow[]>([
      [
        '11013',
        [
          {
            rcept_no: RECEIPTS['11013'],
            reprt_code: '11013',
            bsns_year: '2025',
            sj_div: 'BS',
            account_id: 'unknown_tag',
            account_nm: '알수없는계정',
            thstrm_amount: '1',
          },
        ],
      ],
    ]);
    const { facts, gaps } = parseFinancialRows('005930', rows);
    expect(facts).toEqual([]);
    expect(gaps).toHaveLength(1);
    expect(gaps[0]?.reason).toContain('알수없는계정');
  });

  it('금액이 파싱되지 않으면 gap 으로 남긴다', () => {
    const rows = new Map<DartReportCode, DartFinancialRow[]>([
      ['11013', [{ ...balanceRow('11013', 0), thstrm_amount: '해당사항없음' }]],
    ]);
    const { facts, gaps } = parseFinancialRows('005930', rows);
    expect(facts).toEqual([]);
    expect(gaps).toHaveLength(1);
  });
});

describe('parseIssuanceRows — 자본변동', () => {
  const priorShares = () => 1_000_000;

  it('무상증자·분할은 비율 팩트가 된다', () => {
    const rows: DartIssuanceRow[] = [
      {
        isu_dcrs_de: '2025년 03월 14일',
        isu_dcrs_stle: '주식분할',
        isu_dcrs_qy: '4,000,000',
        rcept_no: '20250310000001',
      },
    ];
    const { facts } = parseIssuanceRows('005930', rows, priorShares);
    expect(facts).toHaveLength(1);
    expect(facts[0]).toMatchObject({
      scope: 'SYMBOL',
      key: '005930',
      field: 'SPLIT_RATIO',
      periodKey: '2025-03-14',
      unit: 'RATIO',
    });
    // (1,000,000 + 4,000,000) / 1,000,000 = 5
    expect(facts[0]?.value).toBe(5);
    expect(facts[0]?.asOfTsMs).toBe(receiptDateToAsOfTsMs('20250310000001'));
  });

  it('무상증자도 같은 방식으로 보정한다', () => {
    const rows: DartIssuanceRow[] = [
      {
        isu_dcrs_de: '2025-06-02',
        isu_dcrs_stle: '무상증자',
        isu_dcrs_qy: '100,000',
        rcept_no: '20250520000001',
      },
    ];
    const { facts } = parseIssuanceRows('005930', rows, priorShares);
    expect(facts[0]?.value).toBeCloseTo(1.1);
  });

  it('주식병합은 비율이 1 보다 작다', () => {
    const rows: DartIssuanceRow[] = [
      {
        isu_dcrs_de: '2025-06-02',
        isu_dcrs_stle: '주식병합',
        isu_dcrs_qy: '500,000',
        rcept_no: '20250520000001',
      },
    ];
    const { facts } = parseIssuanceRows('005930', rows, priorShares);
    expect(facts[0]?.value).toBeCloseTo(0.5);
  });

  it('유상증자는 가격 보정 대상이 아니다 — 팩트를 만들지 않는다', () => {
    const rows: DartIssuanceRow[] = [
      {
        isu_dcrs_de: '2025-06-02',
        isu_dcrs_stle: '유상증자(주주배정)',
        isu_dcrs_qy: '100,000',
        rcept_no: '20250520000001',
      },
    ];
    const { facts, gaps } = parseIssuanceRows('005930', rows, priorShares);
    expect(facts).toEqual([]);
    expect(gaps).toEqual([]); // 의도된 제외이므로 gap 도 아니다
  });

  it('이벤트 직전 발행주식수를 모르면 gap 으로 남긴다', () => {
    const rows: DartIssuanceRow[] = [
      {
        isu_dcrs_de: '2025-06-02',
        isu_dcrs_stle: '주식분할',
        isu_dcrs_qy: '100,000',
        rcept_no: '20250520000001',
      },
    ];
    const { facts, gaps } = parseIssuanceRows('005930', rows, () => null);
    expect(facts).toEqual([]);
    expect(gaps).toHaveLength(1);
    expect(gaps[0]?.reason).toContain('발행주식수');
  });

  it('날짜를 읽을 수 없으면 gap 으로 남긴다', () => {
    const rows: DartIssuanceRow[] = [
      {
        isu_dcrs_de: '미정',
        isu_dcrs_stle: '주식분할',
        isu_dcrs_qy: '100,000',
        rcept_no: '20250520000001',
      },
    ];
    const { facts, gaps } = parseIssuanceRows('005930', rows, priorShares);
    expect(facts).toEqual([]);
    expect(gaps).toHaveLength(1);
  });
});
```

- [ ] **Step 3: 테스트가 실패하는 것을 확인**

Run: `pnpm vitest run tests/unit/dart-report-parser.test.ts`
Expected: FAIL — `Failed to resolve import ".../dart-report-parser.js"`

- [ ] **Step 4: 파서 구현**

`src/server/modules/facts/infrastructure/dart/dart-report-parser.ts`:

```ts
import { KR_SESSION } from '../../../market-data/domain/exchange-session.js';
import type { FactIngestionGap } from '../../application/ports.js';
import { CORPORATE_ACTION_FIELD, type Fact } from '../../domain/fact.js';
import { resolveAccount } from './dart-account-map.js';

/** 정기보고서 코드 (DART reprt_code) */
export type DartReportCode = '11013' | '11012' | '11014' | '11011';

/** 보고서가 커버하는 누적 분기 수. 1Q=1, 반기=2, 3Q=3, 사업보고서=4 */
export const REPORT_CODE_TO_QUARTER: Record<DartReportCode, 1 | 2 | 3 | 4> = {
  '11013': 1,
  '11012': 2,
  '11014': 3,
  '11011': 4,
};

const REPORT_ORDER: readonly DartReportCode[] = ['11013', '11012', '11014', '11011'];

export interface DartFinancialRow {
  readonly rcept_no: string;
  readonly reprt_code: string;
  readonly bsns_year: string;
  /** BS = 재무상태표, IS/CIS = 손익계산서, CF = 현금흐름표, SCE = 자본변동표 */
  readonly sj_div: string;
  readonly account_id: string;
  readonly account_nm: string;
  /** 당기 금액 (보고서에 따라 3개월 또는 누적) */
  readonly thstrm_amount: string;
  /** 당기 누적 금액. 있으면 이것을 누적으로 쓴다 */
  readonly thstrm_add_amount?: string;
}

export interface DartIssuanceRow {
  /** 주식발행·감소 일자. '2025년 03월 14일' / '2025-03-14' 등 표기가 섞인다 */
  readonly isu_dcrs_de: string;
  /** 발행·감소 형태. '주식분할' / '무상증자' / '유상증자(주주배정)' / '주식병합' 등 */
  readonly isu_dcrs_stle: string;
  readonly isu_dcrs_qy: string;
  readonly rcept_no: string;
}

export interface ParsedFinancials {
  readonly facts: readonly Fact[];
  readonly gaps: readonly FactIngestionGap[];
}

const MS_PER_MINUTE = 60_000;
/**
 * 공시 접수일 18:00 KST 를 asOf 로 쓴다. 1d 봉 마감이 15:30 KST 이므로 공시일 당일
 * 봉에는 반영되지 않고 다음 봉부터 쓰인다 — 보수적이고 룩어헤드를 완전히 차단한다.
 */
const AS_OF_MINUTE_OF_DAY = 18 * 60;

export function parseAmount(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed === '' || trimmed === '-') return null;
  const negative = /^\(.*\)$/.test(trimmed);
  const digits = trimmed.replace(/[(),\s]/g, '');
  if (!/^-?\d+(\.\d+)?$/.test(digits)) return null;
  const value = Number(digits);
  if (!Number.isFinite(value)) return null;
  return negative ? -Math.abs(value) : value;
}

/** 'YYYYMMDD...' 접수번호 → 접수일 18:00 KST 의 UTC epoch ms */
export function receiptDateToAsOfTsMs(rceptNo: string): number | null {
  const match = /^(\d{4})(\d{2})(\d{2})/.exec(rceptNo.trim());
  if (!match) return null;
  const [, year, month, day] = match as unknown as [string, string, string, string];
  const utcMidnight = Date.parse(`${year}-${month}-${day}T00:00:00Z`);
  if (Number.isNaN(utcMidnight)) return null;
  // 현지 자정 → UTC 로 옮기고 18:00 만큼 더한다
  return (
    utcMidnight -
    KR_SESSION.utcOffsetMinutes * MS_PER_MINUTE +
    AS_OF_MINUTE_OF_DAY * MS_PER_MINUTE
  );
}

/** '2025년 03월 14일' / '2025-03-14' / '2025.03.14' → 'YYYY-MM-DD' */
function normalizeDateKey(raw: string): string | null {
  const match = /(\d{4})\D+(\d{1,2})\D+(\d{1,2})/.exec(raw.trim());
  if (!match) return null;
  const [, year, month, day] = match as unknown as [string, string, string, string];
  const key = `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
  return Number.isNaN(Date.parse(`${key}T00:00:00Z`)) ? null : key;
}

function isReportCode(value: string): value is DartReportCode {
  return value in REPORT_CODE_TO_QUARTER;
}

/**
 * 정기보고서 4종을 분기 단독값 팩트로 바꾼다.
 *
 * 손익 계정은 누적이다 — 분기 단독값 = 당기 누적 − 전기 누적. 어느 컬럼이 3개월
 * 금액인지는 제출사마다 갈리므로 누적값만 믿고 차분한다. 중간 보고서가 빠지면 그
 * 뒤 분기를 만들지 않고 gap 으로 남긴다 (틀린 값보다 없는 값이 낫다).
 *
 * 재무상태표 계정은 시점값이라 그대로 쓴다.
 */
export function parseFinancialRows(
  symbol: string,
  rowsByReport: ReadonlyMap<DartReportCode, readonly DartFinancialRow[]>,
): ParsedFinancials {
  const facts: Fact[] = [];
  const gaps: FactIngestionGap[] = [];

  /** field → quarter(1~4) → 누적값 */
  const cumulative = new Map<string, Map<number, number>>();
  /** report → asOfTsMs */
  const asOfByReport = new Map<DartReportCode, number>();

  for (const report of REPORT_ORDER) {
    const rows = rowsByReport.get(report);
    if (!rows || rows.length === 0) continue;
    const quarter = REPORT_CODE_TO_QUARTER[report];
    const year = rows[0]?.bsns_year ?? '';
    const periodKey = `${year}Q${quarter}`;

    const asOf = receiptDateToAsOfTsMs(rows[0]?.rcept_no ?? '');
    if (asOf === null) {
      gaps.push({ symbol, periodKey, reason: `접수번호를 읽을 수 없습니다: ${rows[0]?.rcept_no}` });
      continue;
    }
    asOfByReport.set(report, asOf);

    for (const row of rows) {
      const rule = resolveAccount(row.account_id, row.account_nm);
      if (!rule) {
        gaps.push({
          symbol,
          periodKey,
          reason: `매핑되지 않은 계정: ${row.account_nm} (${row.account_id})`,
        });
        continue;
      }

      if (rule.statement === 'BS') {
        const amount = parseAmount(row.thstrm_amount);
        if (amount === null) {
          gaps.push({ symbol, periodKey, reason: `금액을 읽을 수 없습니다: ${row.account_nm}` });
          continue;
        }
        facts.push({
          scope: 'SYMBOL',
          key: symbol,
          field: rule.field,
          periodKey,
          asOfTsMs: asOf,
          value: amount,
          unit: 'KRW',
        });
        continue;
      }

      // IS — 누적값을 모아두고 아래에서 차분한다
      const amount = parseAmount(row.thstrm_add_amount ?? row.thstrm_amount);
      if (amount === null) {
        gaps.push({ symbol, periodKey, reason: `금액을 읽을 수 없습니다: ${row.account_nm}` });
        continue;
      }
      const byQuarter = cumulative.get(rule.field) ?? new Map<number, number>();
      byQuarter.set(quarter, amount);
      cumulative.set(rule.field, byQuarter);
    }
  }

  for (const [field, byQuarter] of cumulative) {
    for (const report of REPORT_ORDER) {
      const quarter = REPORT_CODE_TO_QUARTER[report];
      const current = byQuarter.get(quarter);
      const asOf = asOfByReport.get(report);
      if (current === undefined || asOf === undefined) continue;

      const year = (rowsByReport.get(report) ?? [])[0]?.bsns_year ?? '';
      const periodKey = `${year}Q${quarter}`;

      if (quarter === 1) {
        facts.push({
          scope: 'SYMBOL',
          key: symbol,
          field,
          periodKey,
          asOfTsMs: asOf,
          value: current,
          unit: 'KRW',
        });
        continue;
      }

      const previous = byQuarter.get(quarter - 1);
      if (previous === undefined) {
        gaps.push({
          symbol,
          periodKey,
          reason: `직전 분기 누적값이 없어 ${field} 단독값을 만들 수 없습니다`,
        });
        continue;
      }
      facts.push({
        scope: 'SYMBOL',
        key: symbol,
        field,
        periodKey,
        asOfTsMs: asOf,
        value: current - previous,
        unit: 'KRW',
      });
    }
  }

  return { facts, gaps };
}

/**
 * 증자·감자 현황을 가격 보정 비율로 바꾼다.
 *
 * 비율 = (직전 발행주식수 ± 변동 수량) / 직전 발행주식수. 분할·무상증자·병합은
 * 주주가 낸 돈 없이 주식수만 바뀌므로 가격을 이 비율로 보정해야 과거·현재를 비교할
 * 수 있다. **유상증자는 제외한다** — 현금이 들어온 것이라 가격 보정 대상이 아니다.
 *
 * `sharesBefore` 는 이벤트 직전 발행주식수를 준다. 분기 공시값을 쓰므로 같은 분기에
 * 여러 이벤트가 있으면 근사가 된다 — 이 한계는 결과 화면 경고에 남는다.
 */
export function parseIssuanceRows(
  symbol: string,
  rows: readonly DartIssuanceRow[],
  sharesBefore: (dateKey: string) => number | null,
): ParsedFinancials {
  const facts: Fact[] = [];
  const gaps: FactIngestionGap[] = [];

  for (const row of rows) {
    const style = row.isu_dcrs_stle.replace(/\s/g, '');
    // 유상증자는 가격 보정 대상이 아니다 — 의도된 제외이므로 gap 을 남기지 않는다
    if (style.includes('유상')) continue;

    const isSplitLike = style.includes('분할') || style.includes('무상');
    const isMerge = style.includes('병합') || style.includes('감자');
    if (!isSplitLike && !isMerge) continue;

    const dateKey = normalizeDateKey(row.isu_dcrs_de);
    if (dateKey === null) {
      gaps.push({
        symbol,
        periodKey: row.isu_dcrs_de,
        reason: `자본변동 일자를 읽을 수 없습니다: ${row.isu_dcrs_de}`,
      });
      continue;
    }

    const quantity = parseAmount(row.isu_dcrs_qy);
    if (quantity === null || quantity <= 0) {
      gaps.push({ symbol, periodKey: dateKey, reason: `변동 수량을 읽을 수 없습니다: ${row.isu_dcrs_qy}` });
      continue;
    }

    const prior = sharesBefore(dateKey);
    if (prior === null || prior <= 0) {
      gaps.push({
        symbol,
        periodKey: dateKey,
        reason: '이벤트 직전 발행주식수를 알 수 없어 보정 비율을 만들 수 없습니다',
      });
      continue;
    }

    const ratio = isMerge ? (prior - quantity) / prior : (prior + quantity) / prior;
    if (!Number.isFinite(ratio) || ratio <= 0) {
      gaps.push({ symbol, periodKey: dateKey, reason: `보정 비율이 유효하지 않습니다: ${ratio}` });
      continue;
    }

    const asOf = receiptDateToAsOfTsMs(row.rcept_no);
    if (asOf === null) {
      gaps.push({ symbol, periodKey: dateKey, reason: `접수번호를 읽을 수 없습니다: ${row.rcept_no}` });
      continue;
    }

    facts.push({
      scope: 'SYMBOL',
      key: symbol,
      field: CORPORATE_ACTION_FIELD,
      periodKey: dateKey,
      asOfTsMs: asOf,
      value: ratio,
      unit: 'RATIO',
    });
  }

  return { facts, gaps };
}
```

- [ ] **Step 5: 테스트 통과 확인**

Run: `pnpm vitest run tests/unit/dart-report-parser.test.ts`
Expected: PASS

`중간 보고서가 없으면 ... gap 으로 남긴다` 가 실패하면 차분 루프에서 `byQuarter.get(quarter - 1)` 이 `undefined` 일 때 gap 을 남기는 분기를 확인한다.

- [ ] **Step 6: 타입·린트·경계 확인**

Run: `pnpm typecheck && pnpm lint && pnpm vitest run tests/architecture/module-boundaries.test.ts`
Expected: PASS. `facts/infrastructure/dart` 는 `facts/domain`·`facts/application`·`market-data/domain` 만 import 한다 — `broker` 를 건드리지 않으므로 Task 7 에서 추가한 `facts-no-broker` 규칙을 지킨다.

- [ ] **Step 7: 커밋**

```bash
git add src/server/modules/facts/infrastructure/dart tests/unit/dart-report-parser.test.ts
git commit -m "feat(facts): DART 응답 파서 (계정 매핑 + 누적 차분 + asOf)

정확성 함정 세 개를 HTTP 없이 테스트할 수 있는 순수 계층으로 분리한다.

- 손익 계정은 누적값만 믿고 차분한다 — 어느 컬럼이 3개월 금액인지는
  제출사마다 갈린다. 중간 보고서가 빠지면 gap 으로 남기고 값을 만들지 않는다
- account_id(IFRS 표준 태그) 우선, account_nm 은 정확 일치만 폴백.
  부분 일치는 유동성장기차입금을 단기차입금으로 잡아 차입금을 이중 계상한다
- asOf = 접수일 18:00 KST. 1d 봉 마감(15:30)보다 늦어 공시일 당일 봉에
  반영되지 않는다
- 자본변동은 유상증자를 제외하고 (직전주식수 ± 변동수량)/직전주식수 로 비율화

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01KFoDKRngmr3EM4tEVudeQ4"
```

---

## Task 10: DART HTTP 어댑터 + 수집 서비스 + CLI

**Files:**
- Create: `src/server/modules/facts/infrastructure/dart/dart-corp-code-cache.ts`
- Create: `src/server/modules/facts/infrastructure/dart/dart-fact-source.ts`
- Create: `src/server/modules/facts/application/fact-sync-service.ts`
- Test: `tests/unit/dart-corp-code-cache.test.ts`
- Modify: `src/server/bootstrap/config.ts:38`(env 스키마), `:66`(AppConfig), `:120`(반환)
- Modify: `src/server/cli.ts:139-155`
- Test: `tests/unit/dart-fact-source.test.ts`
- Test: `tests/unit/config.test.ts`

**Interfaces:**
- Consumes: Task 7 의 `BrokerRestClient`(tokenProvider 없이); Task 8 의 `FactSource`·`FactRepository`·`FactIngestionResult`·`FactSourceNotConfiguredError`; Task 9 의 파서 전부
- Produces:
  - `interface DartConfig { baseUrl: string; apiKey: string }`
  - `interface CorpCodeResolver { resolve(symbol: string): Promise<string | null> }`
  - `function extractSingleFileFromZip(zip: Buffer): Buffer` — CORPCODE.zip 안의 단일 엔트리를 푼다
  - `function parseCorpCodeXml(xml: string): Map<string, string>` — `stock_code → corp_code`
  - `function createDartCorpCodeCache(fetchXmlZip: () => Promise<Buffer>): CorpCodeResolver` — 첫 호출에서 1회만 내려받아 캐시
  - `function createDartFactSource(config: DartConfig | null, logger: Logger, options?: { fetchImpl?: typeof fetch; sleep?: (ms: number) => Promise<void>; corpCodeResolver?: CorpCodeResolver }): FactSource`
  - `class FactSyncService { constructor(source: FactSource, repository: FactRepository, logger: Logger); sync(request: FactSyncRequest): Promise<FactSyncReport> }`
  - `interface FactSyncRequest { datasetId: string; symbols: readonly string[]; fromYear: number; toYear: number; consolidated: boolean }`
  - `interface FactSyncReport { savedFacts: number; gaps: readonly FactIngestionGap[] }`
  - `AppConfig.dartBaseUrl: string`, `AppConfig.dartApiKey: string | null`

- [ ] **Step 1: 실패하는 어댑터 테스트 작성**

`tests/unit/dart-fact-source.test.ts`:

> 이 파일의 **모든** `createDartFactSource` 호출에는 `corpCodeResolver: STUB_RESOLVER` 를
> 함께 넘긴다. 넘기지 않으면 기본 corp_code 캐시가 `corpCode.xml` 을 내려받으려 하고,
> 테스트의 `fetchImpl` 은 JSON 만 주므로 zip 파싱에서 터진다. 아래 스니펫의 호출들에도
> 이 옵션을 추가해서 작성한다.

```ts
import { describe, expect, it } from 'vitest';
import { FactSourceNotConfiguredError } from '../../src/server/modules/facts/application/ports.js';
import type { CorpCodeResolver } from '../../src/server/modules/facts/infrastructure/dart/dart-corp-code-cache.js';
import { createDartFactSource } from '../../src/server/modules/facts/infrastructure/dart/dart-fact-source.js';

const LOGGER = { debug() {}, info() {}, warn() {}, error() {} } as never;

/** corp_code 매핑은 별도 테스트가 다룬다 — 여기서는 종목코드에 접두사만 붙인다 */
const STUB_RESOLVER: CorpCodeResolver = {
  resolve: async (symbol) => `corp-${symbol}`,
};

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

describe('createDartFactSource — 미설정', () => {
  it('설정이 없으면 FactSourceNotConfiguredError 를 던진다', async () => {
    const source = createDartFactSource(null, LOGGER);
    await expect(
      source.fetchFinancials({ symbols: ['005930'], fromYear: 2025, toYear: 2025, consolidated: true }),
    ).rejects.toBeInstanceOf(FactSourceNotConfiguredError);
    await expect(
      source.fetchCorporateActions({ symbols: ['005930'], fromYear: 2025, toYear: 2025, consolidated: true }),
    ).rejects.toBeInstanceOf(FactSourceNotConfiguredError);
  });
});

describe('createDartFactSource — 요청 구성', () => {
  it('crtfc_key 를 쿼리로 보내고 Authorization 헤더는 붙이지 않는다', async () => {
    const urls: string[] = [];
    const headers: Array<Record<string, string>> = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      urls.push(String(url));
      headers.push((init?.headers ?? {}) as Record<string, string>);
      return jsonResponse({ status: '013', message: '조회된 데이타가 없습니다.' });
    }) as unknown as typeof fetch;

    const source = createDartFactSource(
      { baseUrl: 'https://opendart.fss.or.kr', apiKey: 'KEY123' },
      LOGGER,
      { fetchImpl, sleep: async () => undefined },
    );
    await source.fetchFinancials({
      symbols: ['005930'],
      fromYear: 2025,
      toYear: 2025,
      consolidated: true,
    });

    expect(urls.length).toBeGreaterThan(0);
    expect(urls[0]).toContain('crtfc_key=KEY123');
    expect(headers[0]).not.toHaveProperty('authorization');
  });

  it('연결/별도를 fs_div 로 보낸다', async () => {
    const urls: string[] = [];
    const fetchImpl = (async (url: string) => {
      urls.push(String(url));
      return jsonResponse({ status: '013', message: 'no data' });
    }) as unknown as typeof fetch;

    const source = createDartFactSource(
      { baseUrl: 'https://opendart.fss.or.kr', apiKey: 'K' },
      LOGGER,
      { fetchImpl, sleep: async () => undefined },
    );
    await source.fetchFinancials({
      symbols: ['005930'],
      fromYear: 2025,
      toYear: 2025,
      consolidated: false,
    });
    expect(urls.some((url) => url.includes('fs_div=OFS'))).toBe(true);
  });

  it('네 개 보고서 코드를 모두 조회한다', async () => {
    const urls: string[] = [];
    const fetchImpl = (async (url: string) => {
      urls.push(String(url));
      return jsonResponse({ status: '013', message: 'no data' });
    }) as unknown as typeof fetch;

    const source = createDartFactSource(
      { baseUrl: 'https://opendart.fss.or.kr', apiKey: 'K' },
      LOGGER,
      { fetchImpl, sleep: async () => undefined },
    );
    await source.fetchFinancials({
      symbols: ['005930'],
      fromYear: 2025,
      toYear: 2025,
      consolidated: true,
    });
    for (const code of ['11013', '11012', '11014', '11011']) {
      expect(urls.some((url) => url.includes(`reprt_code=${code}`))).toBe(true);
    }
  });

  it('"데이터 없음"(status 013)은 에러가 아니라 빈 결과다', async () => {
    const fetchImpl = (async () =>
      jsonResponse({ status: '013', message: '조회된 데이타가 없습니다.' })) as unknown as typeof fetch;
    const source = createDartFactSource(
      { baseUrl: 'https://opendart.fss.or.kr', apiKey: 'K' },
      LOGGER,
      { fetchImpl, sleep: async () => undefined },
    );
    const result = await source.fetchFinancials({
      symbols: ['005930'],
      fromYear: 2025,
      toYear: 2025,
      consolidated: true,
    });
    expect(result.facts).toEqual([]);
  });

  it('인증 실패(status 020)는 던진다 — 조용히 빈 결과로 만들지 않는다', async () => {
    const fetchImpl = (async () =>
      jsonResponse({ status: '020', message: '요청 제한을 초과하였습니다.' })) as unknown as typeof fetch;
    const source = createDartFactSource(
      { baseUrl: 'https://opendart.fss.or.kr', apiKey: 'K' },
      LOGGER,
      { fetchImpl, sleep: async () => undefined },
    );
    await expect(
      source.fetchFinancials({ symbols: ['005930'], fromYear: 2025, toYear: 2025, consolidated: true }),
    ).rejects.toThrow(/020/);
  });

  it('재무 응답을 팩트로 바꾼다', async () => {
    const fetchImpl = (async (url: string) => {
      const target = String(url);
      if (target.includes('fnlttSinglAcntAll') && target.includes('reprt_code=11013')) {
        return jsonResponse({
          status: '000',
          message: '정상',
          list: [
            {
              rcept_no: '20250515000001',
              reprt_code: '11013',
              bsns_year: '2025',
              sj_div: 'BS',
              account_id: 'ifrs-full_CurrentAssets',
              account_nm: '유동자산',
              thstrm_amount: '500,000',
            },
          ],
        });
      }
      if (target.includes('stockTotqySttus')) {
        return jsonResponse({
          status: '000',
          message: '정상',
          list: [
            {
              rcept_no: '20250515000001',
              se: '보통주',
              istc_totqy: '1,000,000',
            },
          ],
        });
      }
      return jsonResponse({ status: '013', message: 'no data' });
    }) as unknown as typeof fetch;

    const source = createDartFactSource(
      { baseUrl: 'https://opendart.fss.or.kr', apiKey: 'K' },
      LOGGER,
      { fetchImpl, sleep: async () => undefined },
    );
    const result = await source.fetchFinancials({
      symbols: ['005930'],
      fromYear: 2025,
      toYear: 2025,
      consolidated: true,
    });

    const assets = result.facts.find((fact) => fact.field === 'CURRENT_ASSETS');
    expect(assets).toMatchObject({ key: '005930', periodKey: '2025Q1', value: 500_000 });

    const shares = result.facts.find((fact) => fact.field === 'SHARES_OUTSTANDING');
    expect(shares).toMatchObject({ value: 1_000_000, unit: 'SHARES' });
  });

  // 이 fake 는 reprt_code 로 좁혀야 한다. 좁히지 않으면 네 보고서 코드에 같은 행을
  // 네 번 돌려주므로 팩트가 4개 나오고, 그걸 1개로 단정하면 "발행주식수를 사업보고서
  // 에서만 수집" 하는 잘못된 구현이 초록으로 통과한다 — 실제로 한 번 그렇게 됐다.
  // 발행주식수는 정기보고서 4종 모두에서 수집한다 (stockTotqySttus 는 reprt_code 필수).
  it('우선주 발행주식수는 합산하지 않는다', async () => {
    const fetchImpl = (async (url: string) => {
      if (String(url).includes('stockTotqySttus') && String(url).includes('reprt_code=11012')) {
        return jsonResponse({
          status: '000',
          message: '정상',
          list: [
            { rcept_no: '20250515000001', se: '보통주', istc_totqy: '1,000,000' },
            { rcept_no: '20250515000001', se: '우선주', istc_totqy: '200,000' },
            { rcept_no: '20250515000001', se: '합계', istc_totqy: '1,200,000' },
          ],
        });
      }
      return jsonResponse({ status: '013', message: 'no data' });
    }) as unknown as typeof fetch;

    const source = createDartFactSource(
      { baseUrl: 'https://opendart.fss.or.kr', apiKey: 'K' },
      LOGGER,
      { fetchImpl, sleep: async () => undefined },
    );
    const result = await source.fetchFinancials({
      symbols: ['005930'],
      fromYear: 2025,
      toYear: 2025,
      consolidated: true,
    });
    const shares = result.facts.filter((fact) => fact.field === 'SHARES_OUTSTANDING');
    expect(shares).toHaveLength(1);
    expect(shares[0]?.value).toBe(1_000_000);
    // periodKey 도 단정한다 — 수집 주기가 테스트에 보이지 않으면 잘못된 주기가 통과한다
    expect(shares[0]?.periodKey).toBe('2025Q2');
  });

  it('네 보고서 코드에서 각각 발행주식수를 수집한다', async () => {
    const byCode: Record<string, string> = {
      '11013': '1,000,000',
      '11012': '1,100,000',
      '11014': '1,200,000',
      '11011': '1,300,000',
    };
    const fetchImpl = (async (url: string) => {
      const target = String(url);
      if (target.includes('stockTotqySttus')) {
        const code = /reprt_code=(\d+)/.exec(target)?.[1] ?? '';
        const total = byCode[code];
        if (!total) return jsonResponse({ status: '013', message: 'no data' });
        return jsonResponse({
          status: '000',
          message: '정상',
          list: [{ rcept_no: '20250515000001', se: '보통주', istc_totqy: total }],
        });
      }
      return jsonResponse({ status: '013', message: 'no data' });
    }) as unknown as typeof fetch;

    const source = createDartFactSource(
      { baseUrl: 'https://opendart.fss.or.kr', apiKey: 'K' },
      LOGGER,
      { fetchImpl, sleep: async () => undefined, corpCodeResolver: STUB_RESOLVER },
    );
    const result = await source.fetchFinancials({
      symbols: ['005930'],
      fromYear: 2025,
      toYear: 2025,
      consolidated: true,
    });
    const shares = result.facts
      .filter((fact) => fact.field === 'SHARES_OUTSTANDING')
      .sort((a, b) => (a.periodKey < b.periodKey ? -1 : 1));
    expect(shares.map((fact) => fact.periodKey)).toEqual([
      '2025Q1',
      '2025Q2',
      '2025Q3',
      '2025Q4',
    ]);
    expect(shares.map((fact) => fact.value)).toEqual([1_000_000, 1_100_000, 1_200_000, 1_300_000]);
  });
});
```

- [ ] **Step 2: 테스트가 실패하는 것을 확인**

Run: `pnpm vitest run tests/unit/dart-fact-source.test.ts`
Expected: FAIL — `Failed to resolve import ".../dart-fact-source.js"`

- [ ] **Step 3: 어댑터 구현**

`src/server/modules/facts/infrastructure/dart/dart-fact-source.ts`:

```ts
import type { Logger } from '../../../../shared/logger.js';
import { BrokerRestClient } from '../../../../shared/rest-client.js';
import {
  FactSourceNotConfiguredError,
  type FactIngestionGap,
  type FactIngestionResult,
  type FactSource,
  type FetchFinancialsRequest,
} from '../../application/ports.js';
import type { Fact } from '../../domain/fact.js';
import {
  parseAmount,
  parseFinancialRows,
  parseIssuanceRows,
  receiptDateToAsOfTsMs,
  REPORT_CODE_TO_QUARTER,
  type DartFinancialRow,
  type DartIssuanceRow,
  type DartReportCode,
} from './dart-report-parser.js';

export interface DartConfig {
  /** 예: https://opendart.fss.or.kr */
  readonly baseUrl: string;
  readonly apiKey: string;
}

interface DartEnvelope<T> {
  readonly status: string;
  readonly message: string;
  readonly list?: readonly T[];
}

interface DartShareRow {
  readonly rcept_no: string;
  /** 주식 종류 구분. '보통주' / '우선주' / '합계' */
  readonly se: string;
  /** 발행한 주식의 총수 */
  readonly istc_totqy: string;
}

const REPORT_CODES = Object.keys(REPORT_CODE_TO_QUARTER) as DartReportCode[];

/** 조회 결과 없음 — 에러가 아니다 (신규 상장·미제출 분기) */
const NO_DATA_STATUS = '013';
const OK_STATUS = '000';

/**
 * DART OpenAPI 어댑터.
 *
 * 인증은 `crtfc_key` 쿼리 파라미터다 — 공용 REST 클라이언트를 `tokenProvider` 없이
 * 쓴다 (Authorization 헤더를 붙이지 않는다). rate limit·backoff·재시도는 클라이언트가
 * 담당한다.
 *
 * 엔드포인트 경로·응답 필드 이름은 **API 키 발급 후 실제 응답으로 검증해 조정한다**
 * (kiwoom-market-data-source.ts 와 같은 관례). 필드 이름이 틀리면 파싱이 gap 으로
 * 남으므로 수집 리포트에 드러난다 — 조용히 0 이 되지 않는다.
 */
export function createDartFactSource(
  config: DartConfig | null,
  logger: Logger,
  options: { fetchImpl?: typeof fetch; sleep?: (ms: number) => Promise<void> } = {},
): FactSource {
  if (!config) {
    return {
      fetchFinancials: () => Promise.reject(new FactSourceNotConfiguredError()),
      fetchCorporateActions: () => Promise.reject(new FactSourceNotConfiguredError()),
    };
  }

  const client = new BrokerRestClient({
    baseUrl: config.baseUrl,
    logger,
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    ...(options.sleep ? { sleep: options.sleep } : {}),
    // DART 일일 한도(2만 건)를 아끼기보다 초당 폭주를 막는 것이 목적이다
    groupMinIntervalMs: { default: 120 },
  });

  async function call<T>(
    path: string,
    params: Record<string, string>,
  ): Promise<readonly T[]> {
    const query = new URLSearchParams({ crtfc_key: config.apiKey, ...params });
    const envelope = await client.request<DartEnvelope<T>>('default', `${path}?${query.toString()}`);
    if (envelope.status === NO_DATA_STATUS) return [];
    if (envelope.status !== OK_STATUS) {
      // 인증 실패·한도 초과를 빈 결과로 흡수하면 "수집했는데 0건" 으로 오해된다
      throw new Error(`DART 응답 오류 ${envelope.status}: ${envelope.message}`);
    }
    return envelope.list ?? [];
  }

  // 종목코드 → DART corp_code. 주입되지 않으면 corpCode.xml 을 1회 내려받아 캐시한다.
  const corpCodes: CorpCodeResolver =
    options.corpCodeResolver ??
    createDartCorpCodeCache(async () => {
      const query = new URLSearchParams({ crtfc_key: config.apiKey });
      const response = await (options.fetchImpl ?? fetch)(
        `${config.baseUrl}/api/corpCode.xml?${query.toString()}`,
      );
      if (!response.ok) {
        throw new Error(`corpCode.xml 다운로드 실패: ${response.status}`);
      }
      return Buffer.from(await response.arrayBuffer());
    });

  async function fetchFinancials(request: FetchFinancialsRequest): Promise<FactIngestionResult> {
    const facts: Fact[] = [];
    const gaps: FactIngestionGap[] = [];
    const fsDiv = request.consolidated ? 'CFS' : 'OFS';

    for (const symbol of request.symbols) {
      const corpCode = await corpCodes.resolve(symbol);
      if (corpCode === null) {
        // 조용히 건너뛰면 "수집했는데 이 종목만 0건" 이 되고 원인을 알 수 없다
        gaps.push({ symbol, periodKey: '-', reason: 'DART corp_code 매핑에 없는 종목코드입니다' });
        continue;
      }

      for (let year = request.fromYear; year <= request.toYear; year += 1) {
        const rowsByReport = new Map<DartReportCode, readonly DartFinancialRow[]>();

        for (const reportCode of REPORT_CODES) {
          const rows = await call<DartFinancialRow>('/api/fnlttSinglAcntAll.json', {
            corp_code: corpCode,
            bsns_year: String(year),
            reprt_code: reportCode,
            fs_div: fsDiv,
          });
          // 손익·재무상태표만 쓴다 — 현금흐름표·자본변동표는 이 전략들이 보지 않는다
          const relevant = rows.filter((row) => row.sj_div === 'BS' || row.sj_div === 'IS' || row.sj_div === 'CIS');
          if (relevant.length > 0) rowsByReport.set(reportCode, relevant);
        }

        if (rowsByReport.size > 0) {
          const parsed = parseFinancialRows(symbol, rowsByReport);
          facts.push(...parsed.facts);
          gaps.push(...parsed.gaps);
        }

        // 발행주식수 — 정기보고서별로 조회하고 그 보고서의 분기에 붙인다
        for (const reportCode of REPORT_CODES) {
          const shareRows = await call<DartShareRow>('/api/stockTotqySttus.json', {
            corp_code: corpCode,
            bsns_year: String(year),
            reprt_code: reportCode,
          });
          // 보통주만 쓴다 — 시가총액은 봉 종가(보통주 가격) × 보통주 수다.
          // '합계' 행을 쓰면 우선주가 섞여 시가총액이 과대계상된다.
          const common = shareRows.find((row) => row.se.replace(/\s/g, '') === '보통주');
          if (!common) continue;
          const value = parseAmount(common.istc_totqy);
          const asOf = receiptDateToAsOfTsMs(common.rcept_no);
          const periodKey = `${year}Q${REPORT_CODE_TO_QUARTER[reportCode]}`;
          if (value === null || value <= 0 || asOf === null) {
            gaps.push({ symbol, periodKey, reason: `발행주식수를 읽을 수 없습니다: ${common.istc_totqy}` });
            continue;
          }
          facts.push({
            scope: 'SYMBOL',
            key: symbol,
            field: 'SHARES_OUTSTANDING',
            periodKey,
            asOfTsMs: asOf,
            value,
            unit: 'SHARES',
          });
        }
      }
    }

    return { facts, gaps };
  }

  async function fetchCorporateActions(
    request: FetchFinancialsRequest,
  ): Promise<FactIngestionResult> {
    const facts: Fact[] = [];
    const gaps: FactIngestionGap[] = [];

    /** 같은 (field, periodKey) 자본변동을 종목 단위로 접는다 — 아래 루프 주석 참고 */
    const actionByKey = new Map<string, Fact>();

    for (const symbol of request.symbols) {
      const corpCode = await corpCodes.resolve(symbol);
      if (corpCode === null) {
        gaps.push({ symbol, periodKey: '-', reason: 'DART corp_code 매핑에 없는 종목코드입니다' });
        continue;
      }
      /** 'YYYY-MM-DD' → 그 시점 직전 발행주식수. 분기 공시값 중 이벤트 이전 최신값 */
      const sharesByPeriod: Array<{ dateKey: string; shares: number }> = [];

      for (let year = request.fromYear; year <= request.toYear; year += 1) {
        for (const reportCode of REPORT_CODES) {
          const shareRows = await call<DartShareRow>('/api/stockTotqySttus.json', {
            corp_code: corpCode,
            bsns_year: String(year),
            reprt_code: reportCode,
          });
          const common = shareRows.find((row) => row.se.replace(/\s/g, '') === '보통주');
          if (!common) continue;
          const shares = parseAmount(common.istc_totqy);
          const asOf = receiptDateToAsOfTsMs(common.rcept_no);
          if (shares === null || shares <= 0 || asOf === null) continue;
          sharesByPeriod.push({ dateKey: new Date(asOf).toISOString().slice(0, 10), shares });
        }
      }
      sharesByPeriod.sort((a, b) => (a.dateKey < b.dateKey ? -1 : 1));

      const sharesBefore = (dateKey: string): number | null => {
        let found: number | null = null;
        for (const entry of sharesByPeriod) {
          if (entry.dateKey >= dateKey) break;
          found = entry.shares;
        }
        return found;
      };

      for (let year = request.fromYear; year <= request.toYear; year += 1) {
        const rows = await call<DartIssuanceRow>('/api/irdsSttus.json', {
          corp_code: corpCode,
          bsns_year: String(year),
          reprt_code: '11011', // 자본변동 이력은 사업보고서 기준으로 누적 제공된다
        });
        if (rows.length === 0) continue;
        const parsed = parseIssuanceRows(symbol, rows, sharesBefore);
        for (const fact of parsed.facts) {
          // irdsSttus 는 자본변동 이력을 연도별로 누적 제공한다 — 같은 분할이 해마다
          // 다른 rcept_no 로 반복되고, asOfTsMs 가 다르면 저장소 dedupe 를 통과한다.
          // 그대로 두면 adjusted-price 가 비율을 곱해 2:1 분할이 2년치에서 factor 4 가
          // 된다. 같은 (field, periodKey) 는 가장 이른 공시만 남긴다.
          const key = `${fact.field} ${fact.periodKey}`;
          const existing = actionByKey.get(key);
          if (!existing) {
            actionByKey.set(key, fact);
            continue;
          }
          if (existing.value !== fact.value) {
            gaps.push({
              symbol,
              periodKey: fact.periodKey,
              reason: `같은 기준일의 자본변동 비율이 공시마다 다릅니다 (${existing.value} vs ${fact.value})`,
            });
            continue;
          }
          if (fact.asOfTsMs < existing.asOfTsMs) actionByKey.set(key, fact);
        }
        gaps.push(...parsed.gaps);
      }

      facts.push(...actionByKey.values());
      actionByKey.clear();
    }

    return { facts, gaps };
  }

  return { fetchFinancials, fetchCorporateActions };
}
```

import 블록에 캐시를 추가한다:

```ts
import {
  createDartCorpCodeCache,
  type CorpCodeResolver,
} from './dart-corp-code-cache.js';
```

> **키 발급 후 실제 응답으로 확인할 것** (수집 리포트가 전부 gap 이면 여기를 본다):
> `irdsSttus` 의 `reprt_code` 가 연도별 누적을 주는지, 분기별로 나눠 주는지. 나눠 주면
> 네 코드를 모두 돌려야 한다. 계정 태그·필드 이름도 같은 이유로 검증 대상이다 —
> 틀리면 gap 으로 드러나므로 조용히 0 이 되지는 않는다.

- [ ] **Step 3b: corp_code 캐시 — 실패하는 테스트 먼저**

DART 는 종목코드가 아니라 8자리 `corp_code` 로 조회한다. 매핑은 `corpCode.xml` 로만
얻을 수 있고, 그 응답은 **단일 엔트리 ZIP** 이다.

새 의존성을 넣지 않는다 — 엔트리가 하나이고 XML 이 속성 없는 평면 구조라 Node 내장
`zlib` 로 충분하다. zip 리더와 XML 추출기를 각각 순수 함수로 분리해 픽스처로 검증한다.

`tests/unit/dart-corp-code-cache.test.ts`:

```ts
import { deflateRawSync } from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';
import {
  createDartCorpCodeCache,
  extractSingleFileFromZip,
  parseCorpCodeXml,
} from '../../src/server/modules/facts/infrastructure/dart/dart-corp-code-cache.js';

/** 단일 엔트리 ZIP 을 손으로 만든다 (local file header + deflate + central directory 없음) */
function makeZip(name: string, content: string): Buffer {
  const nameBytes = Buffer.from(name, 'utf8');
  const raw = Buffer.from(content, 'utf8');
  const compressed = deflateRawSync(raw);

  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0); // local file header signature
  header.writeUInt16LE(20, 4); // version needed
  header.writeUInt16LE(0, 6); // flags
  header.writeUInt16LE(8, 8); // method: deflate
  header.writeUInt16LE(0, 10); // mod time
  header.writeUInt16LE(0, 12); // mod date
  header.writeUInt32LE(0, 14); // crc32 (검증하지 않는다)
  header.writeUInt32LE(compressed.length, 18);
  header.writeUInt32LE(raw.length, 22);
  header.writeUInt16LE(nameBytes.length, 26);
  header.writeUInt16LE(0, 28); // extra field length

  return Buffer.concat([header, nameBytes, compressed]);
}

const XML = `<?xml version="1.0" encoding="UTF-8"?>
<result>
  <list>
    <corp_code>00126380</corp_code>
    <corp_name>삼성전자</corp_name>
    <stock_code>005930</stock_code>
    <modify_date>20250401</modify_date>
  </list>
  <list>
    <corp_code>00164779</corp_code>
    <corp_name>SK하이닉스</corp_name>
    <stock_code>000660</stock_code>
    <modify_date>20250401</modify_date>
  </list>
  <list>
    <corp_code>00999999</corp_code>
    <corp_name>비상장회사</corp_name>
    <stock_code> </stock_code>
    <modify_date>20250401</modify_date>
  </list>
</result>`;

describe('extractSingleFileFromZip', () => {
  it('deflate 로 압축된 단일 엔트리를 푼다', () => {
    const unzipped = extractSingleFileFromZip(makeZip('CORPCODE.xml', XML));
    expect(unzipped.toString('utf8')).toBe(XML);
  });

  it('무압축(stored) 엔트리도 푼다', () => {
    const raw = Buffer.from('hello', 'utf8');
    const nameBytes = Buffer.from('a.txt', 'utf8');
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(0, 8); // method: stored
    header.writeUInt32LE(raw.length, 18);
    header.writeUInt32LE(raw.length, 22);
    header.writeUInt16LE(nameBytes.length, 26);
    const zip = Buffer.concat([header, nameBytes, raw]);
    expect(extractSingleFileFromZip(zip).toString('utf8')).toBe('hello');
  });

  it('ZIP 시그니처가 아니면 던진다 — DART 가 XML 에러를 그대로 줄 때가 있다', () => {
    const notZip = Buffer.from('<result><status>020</status></result>', 'utf8');
    expect(() => extractSingleFileFromZip(notZip)).toThrow(/ZIP/);
  });
});

describe('parseCorpCodeXml', () => {
  it('stock_code → corp_code 맵을 만든다', () => {
    const map = parseCorpCodeXml(XML);
    expect(map.get('005930')).toBe('00126380');
    expect(map.get('000660')).toBe('00164779');
  });

  it('상장코드가 빈 회사는 넣지 않는다', () => {
    const map = parseCorpCodeXml(XML);
    expect(map.size).toBe(2);
  });

  it('빈 XML 은 빈 맵', () => {
    expect(parseCorpCodeXml('<result></result>').size).toBe(0);
  });
});

describe('createDartCorpCodeCache', () => {
  it('여러 번 조회해도 한 번만 내려받는다', async () => {
    const fetchZip = vi.fn(async () => makeZip('CORPCODE.xml', XML));
    const cache = createDartCorpCodeCache(fetchZip);

    expect(await cache.resolve('005930')).toBe('00126380');
    expect(await cache.resolve('000660')).toBe('00164779');
    expect(fetchZip).toHaveBeenCalledTimes(1);
  });

  it('동시 호출도 한 번만 내려받는다', async () => {
    const fetchZip = vi.fn(async () => makeZip('CORPCODE.xml', XML));
    const cache = createDartCorpCodeCache(fetchZip);

    const [a, b] = await Promise.all([cache.resolve('005930'), cache.resolve('000660')]);
    expect(a).toBe('00126380');
    expect(b).toBe('00164779');
    expect(fetchZip).toHaveBeenCalledTimes(1);
  });

  it('매핑에 없는 종목코드는 null', async () => {
    const cache = createDartCorpCodeCache(async () => makeZip('CORPCODE.xml', XML));
    expect(await cache.resolve('999999')).toBeNull();
  });

  it('다운로드가 실패하면 다음 호출에서 다시 시도한다 — 실패를 캐시하지 않는다', async () => {
    let attempt = 0;
    const fetchZip = vi.fn(async () => {
      attempt += 1;
      if (attempt === 1) throw new Error('네트워크 오류');
      return makeZip('CORPCODE.xml', XML);
    });
    const cache = createDartCorpCodeCache(fetchZip);

    await expect(cache.resolve('005930')).rejects.toThrow(/네트워크 오류/);
    expect(await cache.resolve('005930')).toBe('00126380');
    expect(fetchZip).toHaveBeenCalledTimes(2);
  });
});
```

Run: `pnpm vitest run tests/unit/dart-corp-code-cache.test.ts`
Expected: FAIL — `Failed to resolve import ".../dart-corp-code-cache.js"`

- [ ] **Step 3c: corp_code 캐시 구현**

`src/server/modules/facts/infrastructure/dart/dart-corp-code-cache.ts`:

```ts
import { inflateRawSync } from 'node:zlib';

export interface CorpCodeResolver {
  /** 종목코드 → DART corp_code. 매핑에 없으면 null */
  resolve(symbol: string): Promise<string | null>;
}

const LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50;
const FIXED_HEADER_BYTES = 30;
const METHOD_STORED = 0;
const METHOD_DEFLATE = 8;

/**
 * 단일 엔트리 ZIP 의 첫 파일을 푼다.
 *
 * 새 의존성을 넣지 않는 이유: DART `corpCode.xml` 응답은 엔트리가 하나인 ZIP 이고,
 * local file header 하나만 읽으면 된다 (central directory 를 볼 필요가 없다).
 * 범용 ZIP 리더가 필요해지면 그때 라이브러리를 넣는다.
 *
 * CRC32 는 검증하지 않는다 — inflate 가 깨진 데이터에서 이미 던진다.
 */
export function extractSingleFileFromZip(zip: Buffer): Buffer {
  if (zip.length < FIXED_HEADER_BYTES || zip.readUInt32LE(0) !== LOCAL_FILE_HEADER_SIGNATURE) {
    // DART 는 인증 실패 시 ZIP 대신 XML 에러 본문을 준다 — 여기서 명확히 실패시킨다
    throw new Error(
      'ZIP 형식이 아닙니다. DART 가 오류 응답을 보냈을 수 있습니다 (API 키를 확인하세요).',
    );
  }

  const method = zip.readUInt16LE(8);
  const compressedSize = zip.readUInt32LE(18);
  const nameLength = zip.readUInt16LE(26);
  const extraLength = zip.readUInt16LE(28);
  const start = FIXED_HEADER_BYTES + nameLength + extraLength;

  // compressedSize 가 0(스트리밍 기록)이면 남은 바이트 전부를 쓴다
  const end = compressedSize > 0 ? start + compressedSize : zip.length;
  const payload = zip.subarray(start, end);

  if (method === METHOD_STORED) return Buffer.from(payload);
  if (method === METHOD_DEFLATE) return inflateRawSync(payload);
  throw new Error(`지원하지 않는 ZIP 압축 방식입니다: ${method}`);
}

const LIST_PATTERN = /<list>([\s\S]*?)<\/list>/g;

function tagValue(block: string, tag: string): string | null {
  const match = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(block);
  return match ? (match[1] as string).trim() : null;
}

/**
 * `stock_code → corp_code` 맵.
 *
 * XML 파서를 쓰지 않는 이유: CORPCODE.xml 은 속성·네임스페이스·CDATA 가 없는 평면
 * `<result><list>...</list></result>` 구조다. 이 파일 하나를 위해 XML 의존성을
 * 넣는 것보다 태그 추출이 낫다. 구조가 바뀌면 맵이 비고 수집 리포트가 전부 gap 이
 * 되므로 조용히 틀리지 않는다.
 *
 * 상장코드가 빈 회사(비상장)는 넣지 않는다 — 빈 키가 모든 종목을 잡아버린다.
 */
export function parseCorpCodeXml(xml: string): Map<string, string> {
  const map = new Map<string, string>();
  LIST_PATTERN.lastIndex = 0;
  for (let match = LIST_PATTERN.exec(xml); match !== null; match = LIST_PATTERN.exec(xml)) {
    const block = match[1] as string;
    const stockCode = tagValue(block, 'stock_code');
    const corpCode = tagValue(block, 'corp_code');
    if (!stockCode || !corpCode) continue;
    map.set(stockCode, corpCode);
  }
  return map;
}

/**
 * corp_code 매핑을 1회만 내려받아 캐시한다. 전 종목이 한 파일에 들어 있어 종목별
 * 조회가 없다.
 *
 * 진행 중인 다운로드를 공유하므로 동시 조회가 여러 번 내려받지 않는다. 실패는
 * 캐시하지 않는다 — 일시적 네트워크 오류로 수집 전체가 영구히 막히면 안 된다.
 */
export function createDartCorpCodeCache(
  fetchXmlZip: () => Promise<Buffer>,
): CorpCodeResolver {
  let pending: Promise<Map<string, string>> | null = null;

  const load = (): Promise<Map<string, string>> => {
    if (pending) return pending;
    pending = (async () => parseCorpCodeXml(extractSingleFileFromZip(await fetchXmlZip()).toString('utf8')))().catch(
      (error: unknown) => {
        pending = null; // 실패는 캐시하지 않는다
        throw error;
      },
    );
    return pending;
  };

  return {
    async resolve(symbol: string): Promise<string | null> {
      return (await load()).get(symbol) ?? null;
    },
  };
}
```

Run: `pnpm vitest run tests/unit/dart-corp-code-cache.test.ts`
Expected: PASS

- [ ] **Step 4: 수집 서비스 구현**

`src/server/modules/facts/application/fact-sync-service.ts`:

```ts
import type { Logger } from '../../../shared/logger.js';
import type { FactIngestionGap, FactRepository, FactSource } from './ports.js';

export interface FactSyncRequest {
  readonly datasetId: string;
  readonly symbols: readonly string[];
  readonly fromYear: number;
  readonly toYear: number;
  readonly consolidated: boolean;
}

export interface FactSyncReport {
  readonly savedFacts: number;
  readonly gaps: readonly FactIngestionGap[];
}

/**
 * 재무·자본변동 수집 오케스트레이션.
 * 누락(gap)은 삼키지 않고 리포트로 되돌린다 — 조용히 빠진 계정은 랭킹을 소리 없이
 * 왜곡한다 (설계 §4.1-2).
 */
export class FactSyncService {
  constructor(
    private readonly source: FactSource,
    private readonly repository: FactRepository,
    private readonly logger: Logger,
  ) {}

  async sync(request: FactSyncRequest): Promise<FactSyncReport> {
    const financials = await this.source.fetchFinancials(request);
    const actions = await this.source.fetchCorporateActions(request);
    const facts = [...financials.facts, ...actions.facts];
    const gaps = [...financials.gaps, ...actions.gaps];

    await this.repository.saveFacts(request.datasetId, facts);

    this.logger.info(
      {
        module: 'facts',
        event: 'facts.synced',
        datasetId: request.datasetId,
        savedFacts: facts.length,
        gapCount: gaps.length,
      },
      'fact sync finished',
    );

    return { savedFacts: facts.length, gaps };
  }
}
```

- [ ] **Step 5: config 에 DART 설정 추가**

`src/server/bootstrap/config.ts` 세 곳:

(a) env 스키마 — `SYNC_MIN_FREE_DISK_MB` 위에 넣는다:

```ts
  /** DART OpenAPI (전자공시). 미설정이면 재무 수집이 비활성 — 봉 데이터는 영향 없다 */
  DART_BASE_URL: z.string().url().default('https://opendart.fss.or.kr'),
  DART_API_KEY: z.string().min(1).optional(),
```

(b) `AppConfig` — `syncMinFreeDiskMb` 위:

```ts
  readonly dartBaseUrl: string;
  readonly dartApiKey: string | null;
```

(c) 반환 객체 — `syncMinFreeDiskMb` 위:

```ts
    dartBaseUrl: raw.DART_BASE_URL,
    dartApiKey: raw.DART_API_KEY ?? null,
```

`tests/unit/config.test.ts` 에 추가:

```ts
describe('DART 설정', () => {
  it('DART_API_KEY 미설정이면 null 이고 로드는 성공한다', () => {
    const config = loadConfig({ ...BASE_ENV });
    expect(config.dartApiKey).toBeNull();
    expect(config.dartBaseUrl).toBe('https://opendart.fss.or.kr');
  });

  it('DART_API_KEY 를 읽는다', () => {
    expect(loadConfig({ ...BASE_ENV, DART_API_KEY: 'abc' }).dartApiKey).toBe('abc');
  });

  it('빈 DART_API_KEY 는 거부한다 — 설정했다고 믿는 비활성 상태를 만들지 않는다', () => {
    expect(() => loadConfig({ ...BASE_ENV, DART_API_KEY: '' })).toThrow(/DART_API_KEY/);
  });
});
```

`BASE_ENV` 는 기존 테스트가 쓰는 최소 환경 객체다. 이름이 다르면 그 파일의 관례를 따른다.

- [ ] **Step 6: CLI 명령 추가**

`src/server/cli.ts` 에 함수를 추가한다 (`totpEnroll` 아래):

```ts
/** 인자 파싱: --dataset ds-1 --from 2015 --to 2026 [--fs-div OFS] */
function parseFactsSyncArgs(argv: readonly string[]): {
  datasetId: string;
  fromYear: number;
  toYear: number;
  consolidated: boolean;
} {
  const flags = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (key?.startsWith('--') && value !== undefined) flags.set(key.slice(2), value);
  }

  const datasetId = flags.get('dataset');
  if (!datasetId) throw new Error('--dataset <데이터셋 id> 가 필요합니다');

  const fromYear = Number(flags.get('from'));
  const toYear = Number(flags.get('to'));
  if (!Number.isInteger(fromYear) || !Number.isInteger(toYear) || fromYear > toYear) {
    throw new Error('--from <연도> --to <연도> 를 올바르게 지정하세요 (예: --from 2015 --to 2026)');
  }

  const fsDiv = (flags.get('fs-div') ?? 'CFS').toUpperCase();
  if (fsDiv !== 'CFS' && fsDiv !== 'OFS') {
    throw new Error('--fs-div 는 CFS(연결) 또는 OFS(별도) 입니다');
  }

  return { datasetId, fromYear, toYear, consolidated: fsDiv === 'CFS' };
}

async function factsSync(argv: readonly string[]): Promise<void> {
  const { datasetId, fromYear, toYear, consolidated } = parseFactsSyncArgs(argv);
  const config = loadConfig();
  if (!config.dartApiKey) {
    throw new Error('DART_API_KEY 가 설정되지 않았습니다. .env 에 추가한 뒤 다시 실행하세요.');
  }

  const container = createContainer(config);
  try {
    // 컨테이너는 `database: DatabaseHandle` 을 노출한다 — Drizzle 인스턴스는 그 안의 `.db` 다
    const dataset = container.database.db
      .select()
      .from(datasets)
      .where(eq(datasets.id, datasetId))
      .get();
    if (!dataset) throw new Error(`데이터셋을 찾을 수 없습니다: ${datasetId}`);
    if (dataset.market !== 'KR') {
      throw new Error('DART 수집은 KR 시장 데이터셋만 지원합니다.');
    }

    const symbols = JSON.parse(dataset.symbolsJson) as string[];
    console.log(
      `${dataset.name}: ${symbols.length}종목, ${fromYear}~${toYear}년, ` +
        `${consolidated ? '연결(CFS)' : '별도(OFS)'} 기준으로 수집합니다.`,
    );

    const report = await container.factSyncService.sync({
      datasetId,
      symbols,
      fromYear,
      toYear,
      consolidated,
    });

    console.log(`\n저장된 팩트: ${report.savedFacts}건`);
    if (report.gaps.length === 0) {
      console.log('누락 없음.');
      return;
    }
    // 누락을 조용히 넘기면 랭킹이 소리 없이 왜곡된다 — 전부 보여준다
    console.log(`\n누락 ${report.gaps.length}건:`);
    for (const gap of report.gaps.slice(0, 50)) {
      console.log(`  ${gap.symbol} ${gap.periodKey}: ${gap.reason}`);
    }
    if (report.gaps.length > 50) {
      console.log(`  ... 그 외 ${report.gaps.length - 50}건`);
    }
  } finally {
    container.close();
  }
}
```

파일 상단 import 에 추가:

```ts
import { eq } from 'drizzle-orm';
import { datasets } from './shared/db/schema.js';
```

`main()` 의 `switch` 에 케이스와 사용법을 추가한다:

```ts
    case 'facts:sync':
      await factsSync(process.argv.slice(3));
      break;
```

```ts
      console.log('  facts:sync     DART 재무·자본변동 수집 (--dataset <id> --from <연도> --to <연도> [--fs-div CFS|OFS])');
```

- [ ] **Step 7: 컨테이너 배선**

`src/server/bootstrap/container.ts` 에 `factSyncService` 를 추가한다. 기존 배선 관례
(리포지터리·서비스 생성 순서, `close()` 목록)를 그대로 따른다:

```ts
  const factRepository = new ParquetFactRepository(config.dataRoot, duckdb);
  const factSource = createDartFactSource(
    config.dartApiKey ? { baseUrl: config.dartBaseUrl, apiKey: config.dartApiKey } : null,
    logger,
  );
  const factSyncService = new FactSyncService(factSource, factRepository, logger);
```

`AppContainer` 인터페이스(`container.ts:43-65` 의 `readonly` 목록)에 두 줄을 추가하고,
`return {...}` 객체에도 넣는다:

```ts
  readonly factRepository: FactRepository;
  readonly factSyncService: FactSyncService;
```

`duckdb` 는 이미 컨테이너에 있는 인스턴스(`readonly duckdb: DuckDbService`)를 그대로
재사용한다 — 새로 만들면 DuckDB 메모리 상한이 두 배로 잡힌다.

- [ ] **Step 8: 검증**

Run: `pnpm vitest run tests/unit/dart-fact-source.test.ts tests/unit/config.test.ts && pnpm vitest run && pnpm typecheck && pnpm lint`
Expected: 전부 PASS

CLI 를 실제로 눌러 본다 (키 없이도 에러 메시지가 나와야 한다):

```bash
pnpm cli facts:sync --dataset nope --from 2025 --to 2025
```
Expected: `DART_API_KEY 가 설정되지 않았습니다...` 또는 데이터셋 없음 메시지. 스택 트레이스가 아니라 사람이 읽는 한 줄이어야 한다.

- [ ] **Step 9: 커밋**

```bash
git add src/server tests/unit/dart-fact-source.test.ts tests/unit/config.test.ts
git commit -m "feat(facts): DART 어댑터 + 수집 서비스 + facts:sync CLI

crtfc_key 쿼리 인증으로 공용 REST 클라이언트를 tokenProvider 없이 쓴다.

- status 013(데이터 없음)은 빈 결과, 그 외 비정상 status 는 던진다 —
  인증 실패를 '수집했는데 0건' 으로 오해하지 않게 한다
- 발행주식수는 보통주만 쓴다. '합계' 행은 우선주가 섞여 시가총액을 과대계상한다
- 누락(gap)은 CLI 가 전부 출력한다. 조용히 빠진 계정은 랭킹을 소리 없이 왜곡한다
- corp_code 매핑은 corpCode.xml(단일 엔트리 ZIP)을 1회 내려받아 캐시한다.
  새 의존성 없이 node:zlib 로 푼다 — 엔트리가 하나이고 XML 이 평면 구조다
- 실패는 캐시하지 않는다. 일시적 네트워크 오류로 수집이 영구히 막히면 안 된다

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01KFoDKRngmr3EM4tEVudeQ4"
```

---

## Task 11: 실행부 배선 + 제출 검증

마지막 조각 — 저장된 팩트가 실제 백테스트에 흘러 들어가고, 재무가 없는 데이터셋에
재무 전략을 걸면 **실행 후 빈 결과가 아니라 제출 단계에서** 거부된다.

**Files:**
- Modify: `src/server/modules/strategy/domain/strategy.ts` (`TradingStrategy.requiresFundamentals`)
- Modify: `src/server/modules/strategy/strategies/value-quality-rank.ts` (플래그 설정)
- Modify: `src/server/modules/strategy/application/strategy-registry.ts` (`requiresFundamentals` 조회)
- Modify: `src/workers/backtest-child.ts` (팩트 로드 → 엔진 전달)
- Modify: `src/server/modules/backtest/presentation/backtest-routes.ts` (제출 검증)
- Test: `tests/integration/backtest-facts.test.ts`

**Interfaces:**
- Consumes: Task 8 의 `ParquetFactRepository`·`FactRepository`; Task 5 의 `valueQualityRankStrategy`
- Produces:
  - `TradingStrategy.requiresFundamentals?: boolean`
  - `StrategyRegistry.requiresFundamentals(strategyId: string): boolean`
  - 제출 검증이 422 로 거부한다 (400 이 아니다 — 요청 형식은 맞고 데이터 상태가 안 맞는다)

- [ ] **Step 1: 실패하는 통합 테스트 작성**

`tests/integration/backtest-facts.test.ts`:

```ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runBacktest } from '../../src/server/modules/backtest/domain/engine.js';
import type { ExecutionProfile } from '../../src/server/modules/backtest/domain/types.js';
import type { Fact } from '../../src/server/modules/facts/domain/fact.js';
import { ParquetFactRepository } from '../../src/server/modules/facts/infrastructure/parquet-fact-repository.js';
import { DuckDbService } from '../../src/server/modules/market-data/infrastructure/duckdb-service.js';
import type { Candle } from '../../src/server/modules/market-data/domain/candle.js';
import { StrategyRegistry } from '../../src/server/modules/strategy/application/strategy-registry.js';
import { valueQualityRankStrategy } from '../../src/server/modules/strategy/strategies/value-quality-rank.js';

const DAY = 86_400_000;
const START = Date.UTC(2025, 0, 2);

const ZERO_COST: ExecutionProfile = {
  cost: { id: 'zero', version: '1', buyCommissionRate: 0, sellCommissionRate: 0, sellTaxRate: 0 },
  slippage: { id: 'zero', version: '1', bps: 0, fixed: 0 },
  rules: { tickSize: 0, minOrderQty: 1 },
};

let dataRoot: string;
let duckdb: DuckDbService;
let repository: ParquetFactRepository;

beforeEach(() => {
  dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-facts-'));
  duckdb = new DuckDbService({ threads: 1, memoryLimit: '256MB' });
  repository = new ParquetFactRepository(dataRoot, duckdb);
});

afterEach(() => {
  duckdb.close();
  fs.rmSync(dataRoot, { recursive: true, force: true });
});

describe('StrategyRegistry.requiresFundamentals', () => {
  it('밸류 전략은 재무를 요구한다', () => {
    expect(new StrategyRegistry().requiresFundamentals('value-quality-rank')).toBe(true);
  });

  it('봉만 쓰는 전략은 요구하지 않는다', () => {
    const registry = new StrategyRegistry();
    expect(registry.requiresFundamentals('hourly-breakout')).toBe(false);
    expect(registry.requiresFundamentals('cross-sectional-momentum')).toBe(false);
  });

  it('모르는 전략은 false — 여기서 예외를 던지면 제출 검증 순서가 뒤바뀐다', () => {
    expect(new StrategyRegistry().requiresFundamentals('nope')).toBe(false);
  });
});

describe('저장소 → 엔진 왕복', () => {
  const disclosed = START + 5 * DAY;

  function factsFor(symbol: string, quarterlyIncome: number): Fact[] {
    const facts: Fact[] = [];
    for (const periodKey of ['2024Q2', '2024Q3', '2024Q4', '2025Q1']) {
      facts.push({
        scope: 'SYMBOL',
        key: symbol,
        field: 'OPERATING_INCOME',
        periodKey,
        asOfTsMs: disclosed,
        value: quarterlyIncome,
        unit: 'KRW',
      });
    }
    const balance: Array<[string, number, string]> = [
      ['SHARES_OUTSTANDING', 1_000, 'SHARES'],
      ['CURRENT_ASSETS', 500_000, 'KRW'],
      ['CURRENT_LIABILITIES', 200_000, 'KRW'],
      ['TANGIBLE_ASSETS', 400_000, 'KRW'],
    ];
    for (const [field, value, unit] of balance) {
      facts.push({
        scope: 'SYMBOL',
        key: symbol,
        field,
        periodKey: '2025Q1',
        asOfTsMs: disclosed,
        value,
        unit,
      });
    }
    return facts;
  }

  function candles(bars: number): Candle[] {
    const out: Candle[] = [];
    for (let index = 0; index < bars; index += 1) {
      for (const symbol of ['CHEAP', 'RICH']) {
        out.push({
          symbol,
          market: 'KR',
          timeframe: '1d',
          tsMs: START + index * DAY,
          open: 1_000,
          high: 1_000,
          low: 1_000,
          close: 1_000,
          volume: 1_000,
        });
      }
    }
    return out;
  }

  it('저장한 팩트로 랭킹이 돌아간다', async () => {
    await repository.saveFacts('ds-1', [
      ...factsFor('CHEAP', 50_000),
      ...factsFor('RICH', 5_000),
    ]);

    const facts = await repository.getFacts({
      datasetId: 'ds-1',
      scope: 'SYMBOL',
      keys: ['CHEAP', 'RICH'],
      asOfMaxTsMs: START + 40 * DAY,
    });
    expect(facts.length).toBeGreaterThan(0);

    const result = runBacktest(valueQualityRankStrategy, {
      candles: candles(40),
      initialCash: 10_000_000,
      execution: ZERO_COST,
      parameters: { topN: 1, rebalanceMonths: 3, staleQuarters: 2 },
      randomSeed: 1,
      maxPositions: 1,
      facts,
    });

    const buys = result.fills.filter((fill) => fill.side === 'BUY');
    expect(buys.map((fill) => fill.symbol)).toEqual(['CHEAP']);
  });

  it('asOfMaxTsMs 가 기간 종료 시각이면 그 이후 공시는 로드되지 않는다', async () => {
    await repository.saveFacts('ds-1', factsFor('CHEAP', 50_000));
    const facts = await repository.getFacts({
      datasetId: 'ds-1',
      scope: 'SYMBOL',
      asOfMaxTsMs: START + 2 * DAY, // 공시(5봉)보다 이르다
    });
    expect(facts).toEqual([]);
  });
});
```

- [ ] **Step 2: 테스트가 실패하는 것을 확인**

Run: `pnpm vitest run tests/integration/backtest-facts.test.ts`
Expected: FAIL — `registry.requiresFundamentals is not a function`

- [ ] **Step 3: 전략 계약에 플래그 추가**

`src/server/modules/strategy/domain/strategy.ts` 의 `TradingStrategy` 에 필드를 추가한다
(`description` 아래):

```ts
  /**
   * 상장시점 재무 없이는 의미 있는 신호를 낼 수 없는 전략. 제출 검증이 데이터셋의
   * 재무 수집 여부를 확인해 거부한다 — 실행 후 "거래 0건" 으로 끝나면 원인을
   * 알 수 없다. 봉만 쓰는 전략은 이 필드를 생략한다.
   */
  readonly requiresFundamentals?: boolean;
```

`src/server/modules/strategy/strategies/value-quality-rank.ts` 의 전략 객체에 추가
(`description` 아래):

```ts
  requiresFundamentals: true,
```

`src/server/modules/strategy/application/strategy-registry.ts` 에 조회 메서드를 추가한다:

```ts
  /** 모르는 전략은 false — 여기서 던지면 "알 수 없는 전략" 검증보다 먼저 터진다 */
  requiresFundamentals(strategyId: string): boolean {
    return this.get(strategyId)?.requiresFundamentals === true;
  }
```

- [ ] **Step 4: 실행부에서 팩트 로드**

`src/workers/backtest-child.ts` — import 를 추가한다:

```ts
import { ParquetFactRepository } from '../server/modules/facts/infrastructure/parquet-fact-repository.js';
import type { Fact } from '../server/modules/facts/domain/fact.js';
```

캔들 로드 직후(`emptySymbols` 경고 블록 다음, `const startedAtMs` 앞)에 팩트를 읽는다:

```ts
    // 상장시점 팩트 로드. 기간 종료 이후에 공시된 것은 어차피 쓰이지 않으므로 잘라
    // 메모리를 아낀다. 봉 시점별 컷오프는 엔진의 PitFactView 가 담당한다.
    const factRepository = new ParquetFactRepository(dataRoot, duckdb);
    const facts: Fact[] = await factRepository.getFacts({
      datasetId: dataset.id,
      scope: 'SYMBOL',
      keys: request.universe.symbols,
      asOfMaxTsMs: toTsMs,
    });
    if (strategy.requiresFundamentals === true && facts.length === 0) {
      // 제출 검증이 걸렀어야 하는 상태다. 실행 중 데이터가 지워진 경우의 뒤늦은 방어선.
      throw new Error(
        '이 전략은 상장시점 재무 데이터가 필요합니다. `pnpm cli facts:sync` 로 수집한 뒤 다시 실행하세요.',
      );
    }
    if (strategy.requiresFundamentals === true) {
      datasetWarnings.push(
        '재무 데이터는 수집 시점 기준입니다. 누락된 계정이 있으면 해당 종목은 랭킹에서 조용히 빠집니다 — facts:sync 리포트를 확인하세요.',
      );
    }
```

`runBacktest` 호출에 `facts` 를 넘긴다:

```ts
      randomSeed: request.randomSeed,
      maxPositions: request.risk.maxPositions,
      facts,
    }, {
```

- [ ] **Step 5: 제출 검증 추가**

`src/server/modules/backtest/presentation/backtest-routes.ts` 의 제출 핸들러에서, 전략·
데이터셋 검증이 끝난 뒤(봉 수 추정 검증 앞)에 넣는다:

```ts
    // 재무 전략은 데이터셋에 재무가 수집돼 있어야 한다. 통과시키면 실행 후 "거래 0건"
    // 으로 끝나 원인을 알 수 없다 (D-025 와 같은 원칙: 조용히 빠지지 않는다).
    if (
      strategyRegistry.requiresFundamentals(request.strategyId) &&
      !factRepository.hasFacts(request.datasetId, 'SYMBOL')
    ) {
      return reply.code(422).send({
        error:
          '이 전략은 상장시점 재무 데이터가 필요합니다. 이 데이터셋에는 아직 수집되지 않았습니다. ' +
          'SSH 에서 `pnpm cli facts:sync --dataset <데이터셋 id> --from <연도> --to <연도>` 를 실행하세요.',
      });
    }
```

`factRepository` 는 라우트 등록 시 주입한다 — 이 파일이 이미 받는 다른 의존성과 같은
방식으로 옵션 객체에 추가하고, `container.ts` 에서 Task 10 Step 7 에 만든
`factRepository` 를 넘긴다.

422 를 쓰는 이유: 요청 형식은 올바르고(400 아님) 서버 자원 문제도 아니다(507 아님).
데이터 상태가 요청과 맞지 않는다.

- [ ] **Step 6: 테스트 통과 확인**

Run: `pnpm vitest run tests/integration/backtest-facts.test.ts`
Expected: PASS

- [ ] **Step 7: 제출 거부 경로 테스트 추가**

`tests/integration/backtest-daily-dataset.test.ts` (또는 제출 라우트를 다루는 기존 통합
테스트 파일) 에 추가한다. 기존 파일의 앱 부트스트랩 헬퍼(`tests/helpers/test-app.ts`)를
그대로 쓴다:

```ts
it('재무가 없는 데이터셋에 밸류 전략을 제출하면 422 로 거부한다', async () => {
  const response = await app.inject({
    method: 'POST',
    url: '/api/backtests',
    headers: authHeaders,
    payload: {
      strategyId: 'value-quality-rank',
      strategyVersion: '1.0.0',
      parameters: { topN: 20, rebalanceMonths: 3, staleQuarters: 2 },
      datasetId: dailyDatasetId,
      timeframe: '1d',
      universe: { type: 'SYMBOLS', symbols: ['005930'] },
      period: { from: '2025-01-01', to: '2025-03-31' },
      capital: { initialCash: 10_000_000, currency: 'KRW' },
      execution: {
        fillTiming: 'NEXT_BAR_OPEN',
        commissionProfileId: 'kr-default',
        slippageProfileId: 'kr-default',
      },
      risk: { maxPositions: 20 },
      randomSeed: 42,
    },
  });

  expect(response.statusCode).toBe(422);
  expect(response.json().error).toContain('facts:sync');
});

it('봉만 쓰는 전략은 재무 없이도 제출된다', async () => {
  const response = await app.inject({
    method: 'POST',
    url: '/api/backtests',
    headers: authHeaders,
    payload: {
      strategyId: 'cross-sectional-momentum',
      strategyVersion: '1.0.0',
      parameters: {
        formationDays: 20,
        skipDays: 0,
        topN: 1,
        rebalanceMonths: 1,
        absoluteMomentumFilter: true,
      },
      datasetId: dailyDatasetId,
      timeframe: '1d',
      universe: { type: 'SYMBOLS', symbols: ['005930'] },
      period: { from: '2025-01-01', to: '2025-03-31' },
      capital: { initialCash: 10_000_000, currency: 'KRW' },
      execution: {
        fillTiming: 'NEXT_BAR_OPEN',
        commissionProfileId: 'kr-default',
        slippageProfileId: 'kr-default',
      },
      risk: { maxPositions: 20 },
      randomSeed: 42,
    },
  });

  expect(response.statusCode).toBeLessThan(400);
});
```

`authHeaders`·`dailyDatasetId`·`app` 은 그 파일이 이미 만드는 픽스처 이름을 따른다.
`kr-default` 라는 프로파일 id 가 실제와 다르면 `listCostProfiles()` 가 주는 id 로 바꾼다.

- [ ] **Step 8: 전체 검증**

Run: `pnpm vitest run && pnpm typecheck && pnpm lint && pnpm vitest run tests/architecture/module-boundaries.test.ts`
Expected: 전부 PASS

`backtest → facts` 방향이 새로 생긴다. `.dependency-cruiser.cjs` 에 이를 금지하는 규칙은
없다(금지 목록은 `broker` 어댑터 방향만 막는다). 만약 경계 테스트가 실패하면 규칙을
느슨하게 만들지 말고, `backtest/presentation` 이 `facts/application/ports` 만 참조하는지
확인한다 — `facts/infrastructure` 를 직접 참조하면 안 된다 (주입으로 받는다).

- [ ] **Step 9: 커밋**

```bash
git add src tests
git commit -m "feat(backtest): 팩트를 실행부에 배선 + 재무 전략 제출 검증

TradingStrategy.requiresFundamentals 로 선언하고 제출 검증이 데이터셋의
재무 수집 여부를 확인해 422 로 거부한다 — 통과시키면 실행 후 '거래 0건'
으로 끝나 원인을 알 수 없다 (D-025 와 같은 원칙).

- 실행부는 기간 종료 이후 공시를 잘라 로드한다. 봉 시점 컷오프는 엔진 담당
- 실행 중 데이터가 지워진 경우의 뒤늦은 방어선도 둔다
- 재무 전략에는 '누락 계정이 있으면 조용히 빠진다' 경고를 결과에 남긴다

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01KFoDKRngmr3EM4tEVudeQ4"
```

---

## 완료 후 확인

- [ ] `pnpm vitest run && pnpm typecheck && pnpm lint` 전부 통과
- [ ] `pnpm build` 통과 (`tsconfig.build.json` 에 새 파일이 포함되는지)
- [ ] 웹 위저드에서 새 전략 2개가 목록에 보이고, 파라미터 폼이 한국어 라벨과 ⓘ 설명을 렌더링한다 (`/run` 으로 앱을 띄워 확인)
- [ ] `docs/IMPLEMENTATION_STATUS.md` 에 이번 작업 상태를 반영한다 (그 파일의 기존 형식을 따른다)
- [ ] `docs/SPEC.md` §32 는 "첫 전략" 절이다. 등록 전략이 3개가 되었으므로 절 제목·내용을 갱신하거나 §33 "정량 전략" 을 추가한다 — 스펙과 코드가 어긋나면 다음 사람이 스펙을 믿는다

## 남은 한계 (결과 화면 경고로 노출됨)

생존 편향, 시점별 지수 구성 미반영, 배당·권리락 미보정, 거래정지·유동성 부족, 공휴일
캘린더, 재무 계정 누락 종목의 조용한 제외. 액면분할은 분할 이력이 수집된 데이터셋에서
신호 계산 시 보정된다 — 체결가는 항상 실제 거래 가격이다.

## 이번 범위가 아닌 것

거시 지표 수집(`FactScope.MACRO` 는 스키마만 준비), 시점별 지수 구성 종목, 생존편향
제거, 배당 보정, US 재무제표(SEC EDGAR), 업종 분류. `facts:sync` 웹 라우트화.
