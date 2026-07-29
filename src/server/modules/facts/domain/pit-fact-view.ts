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
  /**
   * 이 계정에서 흡수한 가장 큰 분기 서수 — 계정별로 따로 추적한다. 계정마다
   * 공시 주기가 다를 수 있어서(예: 발행주식수는 사업보고서에서만 갱신) 다른
   * 계정이 커서를 앞서 밀어도 이 계정의 "최신"이 흔들리면 안 된다.
   */
  latestQuarter: number | null;
}

interface SymbolEntry {
  readonly fields: Map<string, FieldEntry>;
  readonly actions: CorporateAction[];
  /** 흡수한 재무 팩트 중 가장 큰 분기 서수 (계정 전체를 통틀어) — 보고 신선도 신호 */
  latestQuarter: number | null;
  /** latestQuarter 에 대응하는 periodKey */
  latestPeriodKey: string | null;
  /** latestPeriodKey 를 그 값으로 만든 공시의 asOfTsMs — 항상 latestPeriodKey 와 짝을 이룬다 */
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

    return {
      latestPeriodKey: entry.latestPeriodKey,
      latestAsOfTsMs: entry.latestAsOfTsMs,
      get(field: FundamentalField): number | null {
        const fieldEntry = entry.fields.get(field);
        if (!fieldEntry || fieldEntry.latestQuarter === null) return null;
        // 이 계정 자신의 최신 분기를 쓴다 — 전역 커서가 아니다. 다른 계정이
        // 커서를 몇 분기 앞서 밀었어도 느린 주기의 계정은 값을 잃지 않는다.
        const found = fieldEntry.byPeriod.get(ordinalToPeriodKey(fieldEntry.latestQuarter));
        return found ? found.value : null;
      },
      ttm(field: FundamentalField): number | null {
        if (!FLOW_FIELDS.includes(field)) return null;
        const fieldEntry = entry.fields.get(field);
        if (!fieldEntry || fieldEntry.latestQuarter === null) return null;
        const latestQuarter = fieldEntry.latestQuarter;
        let sum = 0;
        for (let ordinal = latestQuarter; ordinal > latestQuarter - 4; ordinal -= 1) {
          const found = fieldEntry.byPeriod.get(ordinalToPeriodKey(ordinal));
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

    // 분기 키('YYYYQn')만 재무 스냅샷에 들어간다. 연간('YYYYFY')은 스코프 밖 —
    // 이 플랜의 두 전략 모두 분기 데이터만 쓴다. SPLIT_RATIO 는 위에서 이미
    // 처리했고 'YYYY-MM-DD' 키를 쓴다.
    const ordinal = quarterOrdinal(fact.periodKey);
    if (ordinal === null) return;

    let field = entry.fields.get(fact.field);
    if (!field) {
      field = { byPeriod: new Map(), latestQuarter: null };
      entry.fields.set(fact.field, field);
    }
    const existing = field.byPeriod.get(fact.periodKey);
    // asOfTsMs 오름차순으로 흡수하므로 뒤에 온 것이 더 늦은 공시 = 재집계다
    if (!existing || fact.asOfTsMs >= existing.asOfTsMs) {
      field.byPeriod.set(fact.periodKey, { value: fact.value, asOfTsMs: fact.asOfTsMs });
    }
    if (field.latestQuarter === null || ordinal > field.latestQuarter) {
      field.latestQuarter = ordinal;
    }

    // latestAsOfTsMs 는 latestPeriodKey 와 짝이다 — 그 값을 만든 공시의 asOf 여야
    // 한다. 더 오래된 분기로의 뒤늦은 정정은 latestPeriodKey 를 바꾸지 않으므로
    // latestAsOfTsMs 도 건드리지 않는다. 다만 "지금 최신인 바로 그 분기"에 대한
    // 재집계라면 latestPeriodKey 는 그대로여도 그 재집계가 더 늦게 알려진
    // 것이므로 latestAsOfTsMs 는 갱신되어야 한다 — 아래 첫 블록이 그 경우.
    if (
      ordinal === entry.latestQuarter &&
      (entry.latestAsOfTsMs === null || fact.asOfTsMs > entry.latestAsOfTsMs)
    ) {
      entry.latestAsOfTsMs = fact.asOfTsMs;
    }
    if (entry.latestQuarter === null || ordinal > entry.latestQuarter) {
      entry.latestQuarter = ordinal;
      entry.latestPeriodKey = fact.periodKey;
      entry.latestAsOfTsMs = fact.asOfTsMs;
    }
  }
}
