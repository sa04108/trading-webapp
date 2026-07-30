import { describe, expect, it } from 'vitest';
import { runBacktest } from '../../src/server/modules/backtest/domain/engine.js';
import type { ExecutionProfile } from '../../src/server/modules/backtest/domain/types.js';
import type { Candle } from '../../src/server/modules/market-data/domain/candle.js';
import { StrategyRegistry } from '../../src/server/modules/strategy/application/strategy-registry.js';
import {
  rsiReversionParameters,
  rsiReversionStrategy,
} from '../../src/server/modules/strategy/strategies/rsi-reversion.js';

const DAY = 86_400_000;
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
    high: close * 1.01,
    low: close * 0.99,
    close,
    volume: 1_000,
  };
}

const FAST_PARAMS = {
  rsiPeriod: 3,
  entryRsi: 30,
  exitRsi: 55,
  atrPeriod: 3,
  stopAtrMultiplier: 5, // 되돌림 전에 스톱에 걸리지 않게 넉넉히
  riskPerTradePercent: 1,
  correlationBars: 20,
  correlationThreshold: 0.5,
};

/** 워밍업 진동(25봉) → 연속 하락(RSI 과매도) → 반등(RSI 회복) */
function vShapeCandles(): Candle[] {
  const candles: Candle[] = [];
  let close = 1_000;
  for (let index = 0; index < 55; index += 1) {
    if (index < 25) close = 1_000 + (index % 2 === 0 ? 10 : -10);
    else if (index < 35) close -= 20; // 하락 — RSI 0 근처
    else close += 40; // 가파른 반등 — RSI 가 확실히 청산선 위로 회복
    candles.push(candle('AAA', index, close));
  }
  return candles;
}

describe('rsiReversionParameters', () => {
  it('기본값만으로 파싱된다', () => {
    const parsed = rsiReversionParameters.parse({});
    expect(parsed.rsiPeriod).toBe(14);
    expect(parsed.entryRsi).toBe(30);
    expect(parsed.exitRsi).toBe(55);
    expect(parsed.maxHoldBars).toBeUndefined();
  });

  it('entryRsi ≥ exitRsi 를 거부한다', () => {
    expect(rsiReversionParameters.safeParse({ entryRsi: 45, exitRsi: 50 }).success).toBe(true);
    expect(rsiReversionParameters.safeParse({ entryRsi: 45, exitRsi: 45 }).success).toBe(false);
  });
});

describe('레지스트리 등록', () => {
  it('목록에 노출되고 JSON 스키마에 한국어 라벨이 실린다', () => {
    const registry = new StrategyRegistry();
    expect(registry.list().map((s) => s.id)).toContain('rsi-reversion');
    const schema = registry.getParameterJsonSchema('rsi-reversion');
    const properties = (schema as { properties: Record<string, Record<string, unknown>> })
      .properties;
    expect(properties.entryRsi?.title).toBe('진입 RSI');
  });
});

describe('실행 동작', () => {
  it('과매도에 사서 RSI 회복에 판다', () => {
    const result = runBacktest(rsiReversionStrategy, {
      candles: vShapeCandles(),
      initialCash: 10_000_000,
      execution: ZERO_COST,
      parameters: FAST_PARAMS,
      randomSeed: 1,
      maxPositions: 5,
    });
    const buys = result.fills.filter((fill) => fill.side === 'BUY');
    const sells = result.fills.filter((fill) => fill.side === 'SELL');
    expect(buys.length).toBeGreaterThan(0);
    expect(buys[0]?.reason).toBe('REVERSION');
    expect(sells.length).toBeGreaterThan(0);
    expect(sells[0]?.reason).toBe('RSI_EXIT');
  });

  it('maxHoldBars 를 지정하면 그 봉 수 뒤 TIME 으로 판다', () => {
    // 하락이 계속되어 RSI 회복이 없는 경로 — 시간 상한만이 청산 경로다
    const candles: Candle[] = [];
    let close = 2_000;
    for (let index = 0; index < 50; index += 1) {
      if (index < 25) close = 2_000 + (index % 2 === 0 ? 10 : -10);
      else close -= 8; // 완만한 하락 지속 (스톱 넉넉해서 안 걸림)
      candles.push(candle('AAA', index, close));
    }
    const result = runBacktest(rsiReversionStrategy, {
      candles,
      initialCash: 10_000_000,
      execution: ZERO_COST,
      parameters: { ...FAST_PARAMS, stopAtrMultiplier: 20, maxHoldBars: 3 },
      randomSeed: 1,
      maxPositions: 5,
    });
    const sells = result.fills.filter((fill) => fill.side === 'SELL');
    expect(sells.length).toBeGreaterThan(0);
    expect(sells[0]?.reason).toBe('TIME');
    // 체결 봉에서 barsHeld 1 시작 → 3봉째에 TIME 신호 → 다음 봉 시가 체결.
    // 매수 체결 봉과 매도 체결 봉의 간격 = 3봉.
    const buyTs = result.fills.find((fill) => fill.side === 'BUY')?.tsMs as number;
    expect((sells[0]?.tsMs as number) - buyTs).toBe(3 * DAY);
  });
});
