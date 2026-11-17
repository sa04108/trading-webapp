import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { strategySourceHash } from '../../src/runtime/modules/strategy/application/strategy-source-hash.js';
import { rangeBreakoutStrategy, rangeBreakoutParameters } from '../../src/runtime/modules/strategy/strategies/range-breakout.js';
import type { AnyTradingStrategy } from '../../src/runtime/modules/strategy/domain/strategy.js';

describe('strategySourceHash', () => {
  it('문구를 바꿔도 해시는 그대로다', () => {
    const reworded = {
      ...rangeBreakoutStrategy,
      parameterSchema: rangeBreakoutParameters.extend({
        lookbackBars: rangeBreakoutParameters.shape.lookbackBars.meta({
          title: '완전히 다른 라벨', description: '완전히 다른 설명',
        }),
      }),
    } as unknown as AnyTradingStrategy;
    expect(strategySourceHash(reworded)).toBe(
      strategySourceHash(rangeBreakoutStrategy as AnyTradingStrategy),
    );
  });

  it('검증 규칙이 바뀌면 해시가 바뀐다', () => {
    const changed = {
      ...rangeBreakoutStrategy,
      parameterSchema: rangeBreakoutParameters.extend({
        lookbackBars: z.number().int().min(2).max(500).default(55),
      }),
    } as unknown as AnyTradingStrategy;
    expect(strategySourceHash(changed)).not.toBe(
      strategySourceHash(rangeBreakoutStrategy as AnyTradingStrategy),
    );
  });
});
