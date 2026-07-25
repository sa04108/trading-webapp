import { describe, expect, it } from 'vitest';
import { hourlyBreakoutParameters } from '../../src/server/modules/strategy/strategies/hourly-breakout.js';
import { StrategyRegistry } from '../../src/server/modules/strategy/application/strategy-registry.js';

describe('hourly-breakout parameters (스펙 §32)', () => {
  it('accepts the spec §15 example parameters', () => {
    const result = hourlyBreakoutParameters.safeParse({
      lookbackBars: 20,
      atrPeriod: 14,
      stopAtrMultiplier: 2,
      riskPerTradePercent: 1,
      maxPositions: 5,
    });
    expect(result.success).toBe(true);
  });

  it('rejects out-of-range parameters', () => {
    expect(
      hourlyBreakoutParameters.safeParse({
        lookbackBars: 1, // min 2
        atrPeriod: 14,
        stopAtrMultiplier: 2,
        riskPerTradePercent: 1,
        maxPositions: 5,
      }).success,
    ).toBe(false);
    expect(
      hourlyBreakoutParameters.safeParse({
        lookbackBars: 20,
        atrPeriod: 14,
        stopAtrMultiplier: 2,
        riskPerTradePercent: 10, // max 5
        maxPositions: 5,
      }).success,
    ).toBe(false);
  });
});

describe('StrategyRegistry', () => {
  it('lists registered strategies and validates parameters', () => {
    const registry = new StrategyRegistry();
    const list = registry.list();
    expect(list.map((s) => s.id)).toContain('hourly-breakout');

    const valid = registry.validateParameters('hourly-breakout', {
      lookbackBars: 20,
      atrPeriod: 14,
      stopAtrMultiplier: 2,
      riskPerTradePercent: 1,
      maxPositions: 5,
    });
    expect(valid.ok).toBe(true);

    const invalid = registry.validateParameters('hourly-breakout', { lookbackBars: 'x' });
    expect(invalid.ok).toBe(false);

    const unknown = registry.validateParameters('nope', {});
    expect(unknown.ok).toBe(false);
  });

  it('produces a JSON schema for the web form', () => {
    const registry = new StrategyRegistry();
    const schema = registry.getParameterJsonSchema('hourly-breakout');
    expect(schema).not.toBeNull();
    expect((schema as { properties: Record<string, unknown> }).properties).toHaveProperty(
      'lookbackBars',
    );
  });
});
