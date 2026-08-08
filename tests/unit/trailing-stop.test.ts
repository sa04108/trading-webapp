import { describe, expect, it } from 'vitest';
import {
  confirmEntry,
  holdLimitReached,
  newHolding,
  scaleHoldingPrices,
  updateTrail,
  type HoldingState,
} from '../../src/server/modules/strategy/strategies/shared/trailing-stop.js';

describe('newHolding', () => {
  it('가격 필드는 null, 나머지는 초기값으로 시작한다', () => {
    const holding = newHolding();
    expect(holding.entryAtr).toBeNull();
    expect(holding.stopLevel).toBeNull();
    expect(holding.highestClose).toBeNull();
    expect(holding.barsHeld).toBe(0);
    expect(holding.pendingEntry).toBe(false);
    expect(holding.exitPending).toBe(false);
  });
});

describe('confirmEntry / updateTrail / holdLimitReached', () => {
  it('체결가 기준으로 스톱을 고정하고 고점을 갱신하면 끌어올린다', () => {
    const holding = newHolding();
    holding.entryAtr = 1_000;
    confirmEntry(holding, 10_000, 2);
    expect(holding.stopLevel).toBe(8_000);
    expect(holding.highestClose).toBe(10_000);

    updateTrail(holding, 12_000, 2);
    expect(holding.highestClose).toBe(12_000);
    expect(holding.stopLevel).toBe(10_000); // 12_000 - 2*1_000

    // 내려간 종가는 손절선을 끌어내리지 않는다
    updateTrail(holding, 11_000, 2);
    expect(holding.stopLevel).toBe(10_000);
  });

  it('maxHoldBars 미지정이면 무제한이다', () => {
    const holding = newHolding();
    holding.barsHeld = 1_000_000;
    expect(holdLimitReached(holding, undefined)).toBe(false);
    expect(holdLimitReached(holding, 10)).toBe(true);
  });
});

describe('scaleHoldingPrices — 분할 등 자본변동 비율로 가격 상태를 조정한다', () => {
  it('세 가격 필드를 ratio 로 나눈다', () => {
    const holding: HoldingState = {
      entryAtr: 5_000,
      stopLevel: 90_000,
      highestClose: 100_000,
      barsHeld: 3,
      pendingEntry: false,
      exitPending: false,
    };

    scaleHoldingPrices(holding, 5);

    expect(holding.entryAtr).toBe(1_000);
    expect(holding.stopLevel).toBe(18_000);
    expect(holding.highestClose).toBe(20_000);
    // 가격이 아닌 필드는 손대지 않는다
    expect(holding.barsHeld).toBe(3);
  });

  it('진입 확인 전(entryAtr === null)이면 null 필드를 그대로 둔다', () => {
    // 신호는 났지만(`entryAtr` 는 이미 있을 수 있다) `stopLevel`·`highestClose` 는
    // 아직 `confirmEntry` 를 거치지 않아 `null` 이다 — 고칠 값이 없으므로 그대로 둔다.
    const holding = newHolding();
    holding.entryAtr = null;
    holding.stopLevel = null;
    holding.highestClose = null;

    scaleHoldingPrices(holding, 5);

    expect(holding.entryAtr).toBeNull();
    expect(holding.stopLevel).toBeNull();
    expect(holding.highestClose).toBeNull();
  });

  it('ratio 가 1 이어도 나눗셈을 그대로 적용한다 — 호출측이 1 필터링 책임을 진다', () => {
    const holding: HoldingState = {
      entryAtr: 1_000,
      stopLevel: 9_000,
      highestClose: 10_000,
      barsHeld: 0,
      pendingEntry: false,
      exitPending: false,
    };
    scaleHoldingPrices(holding, 1);
    expect(holding).toEqual({
      entryAtr: 1_000,
      stopLevel: 9_000,
      highestClose: 10_000,
      barsHeld: 0,
      pendingEntry: false,
      exitPending: false,
    });
  });
});
