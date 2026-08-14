import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { strategySourceHash } from '../../src/server/modules/strategy/application/strategy-source-hash.js';
import { rangeBreakoutStrategy } from '../../src/server/modules/strategy/strategies/range-breakout.js';
import type { AnyTradingStrategy } from '../../src/server/modules/strategy/domain/strategy.js';

const bareParameters = z.object({
  lookbackBars: z.number().int().min(2).max(200).default(20),
  atrPeriod: z.number().int().min(2).max(100).default(14),
  stopAtrMultiplier: z.number().positive().max(20).default(2),
  trailAtrMultiplier: z.number().positive().max(20).default(2),
  takeProfitAtrMultiplier: z.number().positive().max(50).optional(),
  maxHoldBars: z.number().int().min(1).max(10_000).optional(),
  riskPerTradePercent: z.number().positive().max(5).default(1),
  maxPositionWeightPercent: z.number().min(1).max(100).default(20),
});

describe('strategySourceHash', () => {
  it('문구를 바꿔도 해시는 그대로다', () => {
    const reworded = {
      ...rangeBreakoutStrategy,
      parameterSchema: z.object({
        lookbackBars: z
          .number()
          .int()
          .min(2)
          .max(200)
          .default(20)
          .meta({ title: '완전히 다른 라벨', description: '완전히 다른 설명' }),
        atrPeriod: z.number().int().min(2).max(100).default(14),
        stopAtrMultiplier: z.number().positive().max(20).default(2),
        trailAtrMultiplier: z.number().positive().max(20).default(2),
        takeProfitAtrMultiplier: z.number().positive().max(50).optional(),
        maxHoldBars: z.number().int().min(1).max(10_000).optional(),
        riskPerTradePercent: z.number().positive().max(5).default(1),
        maxPositionWeightPercent: z.number().min(1).max(100).default(20),
      }),
    } as unknown as AnyTradingStrategy;
    expect(strategySourceHash(reworded)).toBe(
      strategySourceHash(rangeBreakoutStrategy as AnyTradingStrategy),
    );
  });

  it('검증 규칙이 바뀌면 해시가 바뀐다', () => {
    const changed = {
      ...rangeBreakoutStrategy,
      parameterSchema: bareParameters.extend({
        lookbackBars: z.number().int().min(2).max(500).default(20),
      }),
    } as unknown as AnyTradingStrategy;
    expect(strategySourceHash(changed)).not.toBe(
      strategySourceHash(rangeBreakoutStrategy as AnyTradingStrategy),
    );
  });
});
