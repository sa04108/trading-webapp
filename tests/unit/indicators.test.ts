import { describe, expect, it } from 'vitest';
import {
  newAtr,
  newEma,
  newRsi,
  rsiValue,
  updateAtr,
  updateEma,
  updateRsi,
} from '../../src/server/modules/strategy/strategies/shared/indicators.js';

describe('updateEma', () => {
  it('첫 값으로 시딩하고 이후 alpha=2/(n+1) 로 갱신한다', () => {
    const state = newEma();
    updateEma(state, 10, 3); // seed
    expect(state.value).toBe(10);
    updateEma(state, 20, 3); // alpha = 0.5 → 10 + 0.5×(20−10) = 15
    expect(state.value).toBeCloseTo(15);
    updateEma(state, 20, 3); // 15 + 0.5×5 = 17.5
    expect(state.value).toBeCloseTo(17.5);
    expect(state.barsSeen).toBe(3);
  });
});

describe('updateAtr (Wilder)', () => {
  it('첫 봉은 high−low, 이후 (prev×(n−1)+TR)/n — hourly-breakout 과 같은 정의', () => {
    const state = newAtr();
    updateAtr(state, { high: 12, low: 8, close: 10 }, 2);
    expect(state.atr).toBe(4); // 12−8
    // TR = max(14−9, |14−10|, |9−10|) = 5 → (4×1+5)/2 = 4.5
    updateAtr(state, { high: 14, low: 9, close: 13 }, 2);
    expect(state.atr).toBeCloseTo(4.5);
    expect(state.barsSeen).toBe(2);
  });
});

describe('updateRsi (Wilder)', () => {
  it('period 개 변화가 모이기 전엔 null', () => {
    const state = newRsi();
    updateRsi(state, 100, 3);
    updateRsi(state, 101, 3);
    updateRsi(state, 102, 3);
    expect(rsiValue(state)).toBeNull(); // 변화 2개뿐
    updateRsi(state, 103, 3);
    expect(rsiValue(state)).not.toBeNull(); // 변화 3개 — 시딩 완료
  });

  it('전부 상승이면 100, 손계산 값과 일치한다', () => {
    const up = newRsi();
    for (const close of [100, 101, 102, 103]) updateRsi(up, close, 3);
    expect(rsiValue(up)).toBe(100); // avgLoss = 0

    // 변화 +1, −1, +1 → avgGain = 2/3, avgLoss = 1/3 → RS=2 → RSI = 100−100/3
    const mixed = newRsi();
    for (const close of [100, 101, 100, 101]) updateRsi(mixed, close, 3);
    expect(rsiValue(mixed)).toBeCloseTo(100 - 100 / 3);
  });

  it('시딩 후에는 Wilder 평활로 갱신한다', () => {
    const state = newRsi();
    for (const close of [100, 101, 100, 101]) updateRsi(state, close, 3);
    // avgGain=2/3, avgLoss=1/3 에서 변화 +2 → avgGain=(2/3×2+2)/3, avgLoss=(1/3×2)/3
    updateRsi(state, 103, 3);
    const avgGain = (2 / 3 * 2 + 2) / 3;
    const avgLoss = (1 / 3 * 2) / 3;
    expect(rsiValue(state)).toBeCloseTo(100 - 100 / (1 + avgGain / avgLoss));
  });
});
