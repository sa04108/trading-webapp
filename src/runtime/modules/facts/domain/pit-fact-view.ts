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

interface FoldedAction {
  readonly effectiveTsMs: number;
  readonly ratio: number;
  /** 이 비율을 채택한 공시의 접수일 — 중복·충돌을 접을 때의 비교 기준이다 */
  readonly asOfTsMs: number;
}

interface SymbolEntry {
  readonly fields: Map<string, FieldEntry>;
  /**
   * periodKey(효력발생일) → 그 날짜의 자본변동 하나. 같은 분할이 여러 행으로 들어와도
   * 여기서 한 칸으로 접힌다 (`absorbCorporateAction` 주석).
   */
  readonly actionsByPeriod: Map<string, FoldedAction>;
  /** `actionsByPeriod` 를 효력발생일 오름차순으로 펼친 읽기용 배열 */
  actions: CorporateAction[];
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
    // 흡수 순서가 결과를 바꾸는 건 두 팩트가 같은 슬롯(key, field, periodKey)을
    // 다툴 때뿐이다 — asOfTsMs 까지 같다면 그 슬롯을 다투는 두 팩트는 값만 다른
    // 완전한 중복이고, key·field·periodKey 보조 키로도 동점이라 안정 정렬이
    // 입력 배열 순서를 그대로 보존해버린다. value 를 마지막 타이브레이커로 더해
    // 이 경우까지 결정적으로 만든다(흡수 시 `>=` 로 겹쳐쓰므로 가장 큰 value 가
    // 이긴다).
    //
    // 다만 이 정렬은 진짜 방어선이 아니라 마지막 안전망이다. 진짜 방어선은
    // 상류(fact repository, 후속 태스크)가 저장 전에 (key, field, periodKey,
    // asOfTsMs) 로 행을 접어(collapse) 엔진에 애초에 충돌하는 중복을 넘기지
    // 않는 것이다. 이 타이브레이커는 그 경로를 벗어나 조립된 팩트(테스트 등)를
    // 위한 인메모리 보강일 뿐 — 이것만 믿고 있으면 안 된다 (재현성 §9.5).
    const sorted = [...facts].sort((a, b) => {
      if (a.asOfTsMs !== b.asOfTsMs) return a.asOfTsMs - b.asOfTsMs;
      if (a.key !== b.key) return a.key < b.key ? -1 : 1;
      if (a.field !== b.field) return a.field < b.field ? -1 : 1;
      if (a.periodKey !== b.periodKey) return a.periodKey < b.periodKey ? -1 : 1;
      return a.value - b.value;
    });

    // 자본변동(SPLIT_RATIO)은 커서를 타지 않는다 — 생성 시점에 전부 흡수하고,
    // 노출은 `corporateActions` 의 **효력발생일** 게이트만 담당한다 (설계 §3.4).
    //
    // 왜 asOf 로 막지 않는가: 자본변동 수량은 사업보고서의 증자·감자 현황에서 읽으므로
    // 접수일(asOf)이 효력발생일보다 최대 15개월 늦다. asOf 로 막으면 2025-03-14 기준
    // 2:1 분할이 2026년 3월 사업보고서가 나올 때까지 뷰에 없고, 그 1년 동안 모멘텀은
    // 미보정 가격에서 −50% 를 읽어 기본 절대 모멘텀 필터가 그 종목을 조용히 떨어뜨린다.
    // 경제적으로도 asOf 게이트가 틀렸다: 2025-03-14 이후 어느 봉에서든 실제 시장
    // 참여자는 주가가 분할된 사실을 알고 있다. 사업보고서는 우리 쪽 데이터 출처일 뿐
    // 시장이 그 사실을 알게 된 경로가 아니다. 이미 발생한 분할로 과거 가격을 보정하는
    // 것은 룩어헤드가 아니다 (설계 §3.4 가 명시).
    const timed: Fact[] = [];
    for (const fact of sorted) {
      if (fact.scope === 'SYMBOL' && fact.field === CORPORATE_ACTION_FIELD) {
        this.absorbCorporateAction(fact);
        continue;
      }
      timed.push(fact);
    }
    this.ordered = timed;
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
      quarter(field: FundamentalField, offset = 0): { periodKey: string; value: number } | null {
        const fieldEntry = entry.fields.get(field);
        if (!fieldEntry || fieldEntry.latestQuarter === null || !Number.isInteger(offset) || offset < 0) {
          return null;
        }
        const periodKey = ordinalToPeriodKey(fieldEntry.latestQuarter - offset);
        const found = fieldEntry.byPeriod.get(periodKey);
        return found ? { periodKey, value: found.value } : null;
      },
      periodKeyOf(field: FundamentalField): string | null {
        // get() 이 반환할 값이 속한 분기 키 — 계정별 최신 분기 커서를 그대로 재사용한다.
        const fieldEntry = entry.fields.get(field);
        if (!fieldEntry || fieldEntry.latestQuarter === null) return null;
        return ordinalToPeriodKey(fieldEntry.latestQuarter);
      },
      ttm(field: FundamentalField, endOffset = 0): number | null {
        if (
          !FLOW_FIELDS.includes(field as (typeof FLOW_FIELDS)[number]) ||
          !Number.isInteger(endOffset) ||
          endOffset < 0
        ) {
          return null;
        }
        const fieldEntry = entry.fields.get(field);
        if (!fieldEntry || fieldEntry.latestQuarter === null) return null;
        const endQuarter = fieldEntry.latestQuarter - endOffset;
        let sum = 0;
        for (let ordinal = endQuarter; ordinal > endQuarter - 4; ordinal -= 1) {
          const found = fieldEntry.byPeriod.get(ordinalToPeriodKey(ordinal));
          if (!found) return null; // 구멍이 있으면 4개인 척 더하지 않는다
          sum += found.value;
        }
        return sum;
      },
    };
  }

  /**
   * 효력 발생일이 `tsMs` **이하** 인 이벤트만 (설계 §3.4).
   *
   * 게이트는 효력발생일 하나다 — 공시 접수일(asOf)은 보지 않는다. 자본변동은 사업보고서
   * 에서 읽으므로 asOf 가 효력발생일보다 최대 15개월 늦고, asOf 로도 막으면 이미 시장에
   * 반영된 분할이 1년 넘게 보정되지 않는다 (생성자 주석 참고).
   *
   * 경계는 `<=` 다: 기준일 첫 봉부터 이미 분할된 가격이 온다.
   */
  corporateActions(symbol: string, tsMs: number): readonly CorporateAction[] {
    const entry = this.bySymbol.get(symbol);
    if (!entry) return [];
    return entry.actions.filter((action) => action.effectiveTsMs <= tsMs);
  }

  /** 종목 엔트리를 만들거나 가져온다 */
  private entryFor(key: string): SymbolEntry {
    let entry = this.bySymbol.get(key);
    if (!entry) {
      entry = {
        fields: new Map(),
        actionsByPeriod: new Map(),
        actions: [],
        latestQuarter: null,
        latestPeriodKey: null,
        latestAsOfTsMs: null,
      };
      this.bySymbol.set(key, entry);
    }
    return entry;
  }

  /**
   * 자본변동 이벤트를 뷰에 넣는다 — 생성 시점에 한 번, 커서와 무관하게 (설계 §3.4).
   * 노출 시점은 `corporateActions` 의 효력발생일 게이트가 정한다.
   *
   * **(key, periodKey) 로 접는다.** 같은 분할이 두 행으로 남는 경로가 실재한다: 저장소의
   * 병합 키는 재집계(정정공시)를 새 행으로 보존하려고 asOfTsMs 를 일부러 포함하고, DART
   * 어댑터는 한 번의 `fetchCorporateActions` 호출 안에서만 중복을 접는다. 그래서 같은 2:1
   * 분할이 접수번호가 다른 두 보고서로 서로 다른 sync 구간에서 수집되면 두 행으로 남는다.
   * 부분 실패 복구 안내가 `--from`/`--to` 를 좁혀 재실행하라고 말하므로 구간을 나눈 수집은
   * 예외가 아니라 표준 경로다. 접지 않으면 `splitAdjustedClose` 가 효력발생일 이후의 ratio
   * 를 모두 곱하기 때문에 2:1 분할이 배수 4 가 되어 신호가 조용히 두 배로 왜곡된다.
   *
   * 접는 규칙은 어댑터가 아니라 이 뷰에 둔다 — 어느 sync 가 만든 행인지와 무관하게 한
   * 종목의 자본변동 전체를 볼 수 있는 마지막 지점이 여기다.
   *
   * 비율이 같은 중복은 같은 이벤트로 본다. 비율이 **다르면** 중복이 아니라 진짜 데이터
   * 충돌인데 여기서 어느 쪽이 옳은지 판정할 근거가 없다 — **가장 이른 공시(asOfTsMs 최소)**
   * 를 결정적으로 택한다. 접수일까지 같으면 비율이 작은 쪽이다. 어느 쪽을 고르는지보다
   * 입력 배열 순서에 결과를 맡기지 않는 것이 중요하다 (재현성 §9.5).
   */
  private absorbCorporateAction(fact: Fact): void {
    const effectiveTsMs = localDateToUtcMs(fact.periodKey);
    if (effectiveTsMs === null || !Number.isFinite(fact.value) || fact.value <= 0) return;
    const entry = this.entryFor(fact.key);

    const existing = entry.actionsByPeriod.get(fact.periodKey);
    if (existing) {
      if (existing.ratio === fact.value) {
        // 같은 이벤트의 중복 — 비율은 그대로 두고 접수일만 가장 이른 것으로 접는다.
        // 접수일을 접어두지 않으면 뒤이어 오는 비율 충돌의 승자가 입력 순서로 갈린다.
        if (fact.asOfTsMs < existing.asOfTsMs) {
          entry.actionsByPeriod.set(fact.periodKey, { ...existing, asOfTsMs: fact.asOfTsMs });
        }
        return;
      }
      const incomingWins =
        fact.asOfTsMs < existing.asOfTsMs ||
        (fact.asOfTsMs === existing.asOfTsMs && fact.value < existing.ratio);
      if (!incomingWins) return;
    }
    entry.actionsByPeriod.set(fact.periodKey, {
      effectiveTsMs,
      ratio: fact.value,
      asOfTsMs: fact.asOfTsMs,
    });
    // periodKey 하나당 한 칸이므로 effectiveTsMs 에 동률이 없다 — 정렬이 결정적이다
    entry.actions = [...entry.actionsByPeriod.values()]
      .map((action) => ({ effectiveTsMs: action.effectiveTsMs, ratio: action.ratio }))
      .sort((a, b) => a.effectiveTsMs - b.effectiveTsMs);
  }

  private absorb(fact: Fact): void {
    if (fact.scope !== 'SYMBOL') return; // MACRO 는 이 뷰가 다루지 않는다

    // 분기 키('YYYYQn')만 재무 스냅샷에 들어간다. 연간('YYYYFY')은 스코프 밖 —
    // 이 플랜의 두 전략 모두 분기 데이터만 쓴다. SPLIT_RATIO 는 생성 시점에 이미
    // 흡수했고 'YYYY-MM-DD' 키를 쓴다.
    const ordinal = quarterOrdinal(fact.periodKey);
    if (ordinal === null) return;

    const entry = this.entryFor(fact.key);
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
