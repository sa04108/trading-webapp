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
