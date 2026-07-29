import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { strategySourceHash } from '../../src/server/modules/strategy/application/strategy-source-hash.js';
import { hourlyBreakoutStrategy } from '../../src/server/modules/strategy/strategies/hourly-breakout.js';
import type { AnyTradingStrategy } from '../../src/server/modules/strategy/domain/strategy.js';

/** meta 도입 이전의 해시 계산 — 라벨 없는 스키마를 그대로 직렬화했다 */
function legacyHash(id: string, version: string, schema: z.ZodType): string {
  return createHash('sha256')
    .update(id)
    .update(version)
    .update(JSON.stringify(z.toJSONSchema(schema)))
    .digest('hex');
}

const bareParameters = z.object({
  lookbackBars: z.number().int().min(2).max(200).default(20),
  atrPeriod: z.number().int().min(2).max(100).default(14),
  stopAtrMultiplier: z.number().positive().max(20).default(2),
  takeProfitAtrMultiplier: z.number().positive().max(50).optional(),
  riskPerTradePercent: z.number().positive().max(5).default(1),
});

describe('strategySourceHash', () => {
  it('라벨·설명은 해시에 영향을 주지 않는다 — meta 도입 이전 해시와 같다', () => {
    expect(strategySourceHash(hourlyBreakoutStrategy as AnyTradingStrategy)).toBe(
      legacyHash(hourlyBreakoutStrategy.id, hourlyBreakoutStrategy.version, bareParameters),
    );
  });

  it('문구를 바꿔도 해시는 그대로다', () => {
    const reworded = {
      ...hourlyBreakoutStrategy,
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
        takeProfitAtrMultiplier: z.number().positive().max(50).optional(),
        riskPerTradePercent: z.number().positive().max(5).default(1),
      }),
    } as unknown as AnyTradingStrategy;
    expect(strategySourceHash(reworded)).toBe(
      legacyHash(hourlyBreakoutStrategy.id, hourlyBreakoutStrategy.version, bareParameters),
    );
  });

  it('검증 규칙이 바뀌면 해시가 바뀐다', () => {
    const changed = {
      ...hourlyBreakoutStrategy,
      parameterSchema: bareParameters.extend({
        lookbackBars: z.number().int().min(2).max(500).default(20),
      }),
    } as unknown as AnyTradingStrategy;
    expect(strategySourceHash(changed)).not.toBe(
      strategySourceHash(hourlyBreakoutStrategy as AnyTradingStrategy),
    );
  });
});
