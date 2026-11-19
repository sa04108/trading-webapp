import { newAtr, newEma, newRollingMax, newRsi } from "../../strategy/strategies/shared/indicators.js";
import { newEntryFilter } from "../../strategy/strategies/shared/entry-filters.js";
import { newHolding } from "../../strategy/strategies/shared/trailing-stop.js";

/** 미확인 자본변동이 실제 수량·가격 단위에 영향을 줄 수 있는 날짜 구간(양 끝 포함). */
export interface ActionGapPeriod { from: number; to: number; year: number }
export type ActionGapPeriods = ReadonlyMap<string, readonly ActionGapPeriod[]>;

/** 현재까지 시작된 구간 중 가장 늦게 끝나는 구간이 지표 재준비의 경계다. */
export function latestActionGap(periods: readonly ActionGapPeriod[], ts: number): ActionGapPeriod | undefined {
  let latest: ActionGapPeriod | undefined;
  for (const candidate of periods) {
    if (candidate.from <= ts && (!latest || candidate.to > latest.to)) latest = candidate;
  }
  return latest;
}

/** 확정 봉만 세어 불확실한 구간 뒤에 전략의 지표를 다시 준비한다. */
export class ActionGapEntryGate {
  private readonly state = new Map<string, { period: ActionGapPeriod; cleanBars: number }>();
  readonly atOpen = new Set<string>();
  readonly atClose = new Set<string>();

  constructor(readonly periods: ActionGapPeriods, private readonly requiredBars: number) {}

  advance(ts: number, bars: ReadonlyMap<string, unknown>, reset?: (symbol: string) => void): void {
    this.atOpen.clear();
    this.atClose.clear();
    for (const [symbol, periods] of this.periods) {
      const period = latestActionGap(periods, ts);
      if (!period) continue;
      let current = this.state.get(symbol);
      if (current?.period !== period) {
        current = { period, cleanBars: 0 };
        this.state.set(symbol, current);
        reset?.(symbol);
      }
      if (ts <= period.to || current.cleanBars < this.requiredBars) this.atOpen.add(symbol);
      if (ts > period.to && bars.has(symbol)) current.cleanBars++;
      if (ts <= period.to || current.cleanBars < this.requiredBars) this.atClose.add(symbol);
    }
  }

  priceCutoff(symbol: string): number {
    return this.state.get(symbol)?.period.to ?? -Infinity;
  }
}

/** 보유 수량을 추측할 수 없는 경우만 청산·평가까지 중단한다. */
export function holdingActionGap(periods: ActionGapPeriods, symbol: string, entered: number, now: number): ActionGapPeriod | undefined {
  return periods.get(symbol)?.find(period => period.from <= now && period.to >= entered);
}

/** 동결된 일봉 스윙 전략의 종목별 가격 지표만 새 단위로 다시 쌓는다. */
export function resetUnheldPriceState(state: unknown, symbol: string): void {
  if (!state || typeof state !== "object" || !("bySymbol" in state) || !(state.bySymbol instanceof Map)) return;
  const previous = state.bySymbol.get(symbol);
  if (previous?.entryFilter && (previous.entryFilter.wasHeld || previous.entryFilter.cooldown > 0)) {
    // 포지션 청산 기록은 가격 단위와 무관하다. 다음 유효 봉에서 전략의 대기 일수를 계속 센다.
    const entryFilter = { ...newEntryFilter(), wasHeld: previous.entryFilter.wasHeld, cooldown: previous.entryFilter.cooldown };
    const indicators = "priorHighs" in previous ? { priorHighs: newRollingMax() }
      : "rsi" in previous ? { rsi: newRsi(), previousRsi: null } : { fast: newEma(), slow: newEma() };
    state.bySymbol.set(symbol, { ...indicators, atr: newAtr(), holding: newHolding(), entryFilter });
  } else state.bySymbol.delete(symbol);
  if ("warmup" in state && state.warmup && typeof state.warmup === "object" &&
    "closesBySymbol" in state.warmup && state.warmup.closesBySymbol instanceof Map) {
    state.warmup.closesBySymbol.delete(symbol);
    if ("groupOf" in state) state.groupOf = null;
  }
}
