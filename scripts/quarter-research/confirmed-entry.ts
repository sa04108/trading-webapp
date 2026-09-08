import type { AnyTradingStrategy } from '../../src/server/modules/strategy/domain/strategy.js';
import type { MacroPoint } from './quarter-engine.js';

/** 미래 관측을 앞선 날짜의 연속 확인 일수에 반영하지 않는다. */
export function recoveryStreaks(points: readonly MacroPoint[], minimumVolatility: number) {
  if (!Number.isFinite(minimumVolatility) || minimumVolatility <= 0) throw new Error('변동성 문턱 오류');
  let streak = 0;
  const result = new Map<number, number>();
  for (const point of [...points].sort((a, b) => a.tsMs - b.tsMs)) {
    if (result.has(point.tsMs)) throw new Error('시장 관측 날짜 중복');
    streak = point.kospiVol20 >= minimumVolatility && point.kospiRet20 > 0 && point.kospi > point.kospiSma20 ? streak + 1 : 0;
    result.set(point.tsMs, streak);
  }
  return result;
}

/** 최초 진입만 연속 회복 확인까지 기다리고 원래 계좌 만기 안에서 운용한다. */
export function withConfirmedEntry(strategy: AnyTradingStrategy, points: readonly MacroPoint[], tradeFromTsMs: number,
  confirmationBars: number, minimumVolatility = .30) {
  if (!Number.isSafeInteger(confirmationBars) || confirmationBars < 1) throw new Error('연속 확인 봉 수 오류');
  const streaks = recoveryStreaks(points, minimumVolatility);
  let activation: { date: string; streak: number } | null = null;
  const wrapped: AnyTradingStrategy = {
    ...strategy,
    version: `${strategy.version}+confirmed-entry.1`,
    onBars(context, state, parameters) {
      if (context.tsMs < tradeFromTsMs) return { orders: [] };
      let first = false;
      if (!activation) {
        const streak = streaks.get(context.tsMs) ?? 0;
        if (streak < confirmationBars) return { orders: [] };
        activation = { date: new Date(context.tsMs).toISOString().slice(0, 10), streak };
        first = true;
      }
      return strategy.onBars({ ...context, isRebalanceBar: first || context.isRebalanceBar }, state, parameters);
    },
  };
  return { strategy: wrapped, audit: () => activation };
}
