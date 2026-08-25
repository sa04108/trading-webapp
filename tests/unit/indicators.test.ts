import { describe, expect, it } from 'vitest';
import {
  newAtr,
  newEma,
  newRollingMax,
  newRsi,
  pushRollingMax,
  rollingMaxValue,
  rsiValue,
  scaleAtr,
  scaleEma,
  scaleRollingMax,
  scaleRsi,
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
  it('첫 period개 TR의 단순평균으로 시드한 뒤 Wilder 평활한다', () => {
    const state = newAtr();
    updateAtr(state, { high: 2, low: 0, close: 1 }, 3); // TR 2
    expect(state.atr).toBeNull();
    updateAtr(state, { high: 5, low: 1, close: 3 }, 3); // TR 4
    expect(state.atr).toBeNull();
    updateAtr(state, { high: 11, low: 3, close: 7 }, 3); // TR 8
    expect(state.atr).toBeCloseTo(14 / 3);
    updateAtr(state, { high: 12, low: 7, close: 10 }, 3); // TR 5
    expect(state.atr).toBeCloseTo((14 / 3 * 2 + 5) / 3);
    expect(state.barsSeen).toBe(4);
  });
});

describe('rollingMaxValue', () => {
  it('창이 window 개로 차기 전에는 null', () => {
    const state = newRollingMax();
    pushRollingMax(state, 10, 3);
    pushRollingMax(state, 12, 3);
    expect(rollingMaxValue(state, 3)).toBeNull();
    pushRollingMax(state, 11, 3);
    expect(rollingMaxValue(state, 3)).toBe(12);
  });

  it('창을 넘으면 가장 오래된 값을 버린다 — 최댓값이 창을 벗어나면 내려간다', () => {
    const state = newRollingMax();
    for (const value of [10, 20, 11]) pushRollingMax(state, value, 3);
    expect(rollingMaxValue(state, 3)).toBe(20);
    pushRollingMax(state, 12, 3); // 10 이 빠진다 — 20 은 아직 창 안
    expect(rollingMaxValue(state, 3)).toBe(20);
    pushRollingMax(state, 13, 3); // 20 이 빠진다
    expect(rollingMaxValue(state, 3)).toBe(13);
    expect(state.values).toHaveLength(3);
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

/**
 * 자본변동(액면분할)이 걸린 종목의 누적 지표를 같은 비율로 내리는 경로다.
 *
 * 기준은 하나다: 분할 전 봉만 먹인 상태를 내린 값이, 처음부터 분할 후 가격을
 * 먹인 상태와 같아야 한다. 그래야 분할을 사이에 두고 지표가 이어진다.
 */
describe('scaleEma — 자본변동 비율만큼 평활값을 내린다', () => {
  it('분할 전 가격으로 쌓은 값이 분할 후 가격으로 쌓은 값과 같아진다', () => {
    const before = newEma();
    const after = newEma();
    for (const close of [100_000, 110_000, 105_000]) {
      updateEma(before, close, 3);
      updateEma(after, close / 5, 3);
    }

    scaleEma(before, 5);

    expect(before.value).toBeCloseTo(after.value as number, 9);
  });

  it('봉 개수는 건드리지 않는다 — 분할은 워밍업 진척을 되돌리지 않는다', () => {
    const state = newEma();
    updateEma(state, 100_000, 3);
    updateEma(state, 110_000, 3);

    scaleEma(state, 5);

    expect(state.barsSeen).toBe(2);
  });

  it('아직 시딩 전이면 아무 일도 하지 않는다', () => {
    const state = newEma();
    scaleEma(state, 5);
    expect(state.value).toBeNull();
  });
});

describe('scaleAtr — 진폭과 기준 종가를 함께 내린다', () => {
  const bars = [
    { high: 102_000, low: 98_000, close: 100_000 },
    { high: 112_000, low: 104_000, close: 110_000 },
    { high: 108_000, low: 101_000, close: 105_000 },
  ];

  it('분할 전 가격으로 쌓은 값이 분할 후 가격으로 쌓은 값과 같아진다', () => {
    const before = newAtr();
    const after = newAtr();
    for (const bar of bars) {
      updateAtr(before, bar, 3);
      updateAtr(after, { high: bar.high / 5, low: bar.low / 5, close: bar.close / 5 }, 3);
    }

    scaleAtr(before, 5);

    expect(before.atr).toBeCloseTo(after.atr as number, 9);
    expect(before.prevClose).toBeCloseTo(after.prevClose as number, 9);
  });

  it('시드 중 분할이 있어도 true range 합을 같은 단위로 보정한다', () => {
    const before = newAtr();
    const after = newAtr();
    for (const bar of bars.slice(0, 2)) {
      updateAtr(before, bar, 3);
      updateAtr(after, { high: bar.high / 5, low: bar.low / 5, close: bar.close / 5 }, 3);
    }

    scaleAtr(before, 5);
    expect(before.atr).toBeNull();
    expect(before.seedTrueRangeSum).toBeCloseTo(after.seedTrueRangeSum, 9);

    const third = bars[2]!;
    updateAtr(before, { high: third.high / 5, low: third.low / 5, close: third.close / 5 }, 3);
    updateAtr(after, { high: third.high / 5, low: third.low / 5, close: third.close / 5 }, 3);
    expect(before.atr).toBeCloseTo(after.atr as number, 9);
  });

  it('prevClose 를 내리지 않으면 다음 봉의 진폭이 분할 낙폭 전체가 된다', () => {
    // 판별력 확인: 이 단언이 `scaleAtr` 의 `prevClose` 처리를 직접 겨눈다.
    const scaled = newAtr();
    const unscaled = newAtr();
    for (const bar of bars) {
      updateAtr(scaled, bar, 3);
      updateAtr(unscaled, bar, 3);
    }
    scaleAtr(scaled, 5);

    const splitBar = { high: 21_000, low: 20_000, close: 20_500 };
    updateAtr(scaled, splitBar, 3);
    updateAtr(unscaled, splitBar, 3);

    // 조정하지 않으면 `|low − prevClose|` ≈ 85_000 이 진폭으로 들어가 ATR 이 튄다
    expect(unscaled.atr as number).toBeGreaterThan(20_000);
    expect(scaled.atr as number).toBeLessThan(3_000);
  });
});

describe('scaleRollingMax — 창에 담긴 고가를 전부 내린다', () => {
  it('기준선이 분할 후 가격대로 내려온다', () => {
    const state = newRollingMax();
    for (const high of [100_000, 120_000, 110_000]) pushRollingMax(state, high, 3);

    scaleRollingMax(state, 5);

    expect(rollingMaxValue(state, 3)).toBe(24_000);
  });

  it('창 길이는 그대로다 — 분할이 워밍업을 되돌리지 않는다', () => {
    const state = newRollingMax();
    for (const high of [100_000, 120_000]) pushRollingMax(state, high, 3);

    scaleRollingMax(state, 5);

    // 아직 3개가 차지 않았으므로 여전히 판단 불가다
    expect(rollingMaxValue(state, 3)).toBeNull();
  });
});

describe('scaleRsi — 값은 그대로 두고 내부 누적만 내린다', () => {
  const closes = [100_000, 101_000, 100_000, 101_000, 103_000];

  it('RSI 값 자체는 비율이라 바뀌지 않는다', () => {
    const state = newRsi();
    for (const close of closes) updateRsi(state, close, 3);
    const before = rsiValue(state);

    scaleRsi(state, 5);

    expect(rsiValue(state)).toBeCloseTo(before as number, 9);
  });

  it('분할 전 가격으로 쌓은 누적이 분할 후 가격으로 쌓은 누적과 같아진다', () => {
    const before = newRsi();
    const after = newRsi();
    for (const close of closes) {
      updateRsi(before, close, 3);
      updateRsi(after, close / 5, 3);
    }

    scaleRsi(before, 5);

    expect(before.avgGain).toBeCloseTo(after.avgGain as number, 9);
    expect(before.avgLoss).toBeCloseTo(after.avgLoss as number, 9);
    expect(before.prevClose).toBeCloseTo(after.prevClose as number, 9);
  });

  it('prevClose 를 내리지 않으면 분할 봉이 과매도를 만든다', () => {
    // 판별력 확인: 이 단언이 `scaleRsi` 의 `prevClose` 처리를 직접 겨눈다.
    const scaled = newRsi();
    const unscaled = newRsi();
    for (const close of closes) {
      updateRsi(scaled, close, 3);
      updateRsi(unscaled, close, 3);
    }
    scaleRsi(scaled, 5);

    updateRsi(scaled, 20_600, 3);
    updateRsi(unscaled, 20_600, 3);

    // 조정하지 않으면 −80% 한 봉이 들어가 RSI 가 과매도 문턱(30) 아래로 떨어진다
    expect(rsiValue(unscaled) as number).toBeLessThan(30);
    expect(rsiValue(scaled) as number).toBeGreaterThan(30);
  });

  it('시딩 구간의 sumGain·sumLoss 도 함께 내린다', () => {
    const before = newRsi();
    const after = newRsi();
    // `rsiPeriod` 14 라 아직 시딩 중이다 — `avgGain`·`avgLoss` 는 `null` 이고 합만 쌓인다
    for (const close of closes) {
      updateRsi(before, close, 14);
      updateRsi(after, close / 5, 14);
    }

    scaleRsi(before, 5);

    expect(before.avgGain).toBeNull();
    expect(before.sumGain).toBeCloseTo(after.sumGain, 9);
    expect(before.sumLoss).toBeCloseTo(after.sumLoss, 9);
    expect(before.changesSeen).toBe(after.changesSeen);
  });
});
