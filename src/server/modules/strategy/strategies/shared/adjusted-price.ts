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
