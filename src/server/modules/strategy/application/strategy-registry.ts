import { z } from 'zod';
import type { AnyTradingStrategy } from '../domain/strategy.js';
import { crossSectionalMomentumStrategy } from '../strategies/cross-sectional-momentum.js';
import { hourlyBreakoutStrategy } from '../strategies/hourly-breakout.js';

/**
 * 코드 등록식 전략 레지스트리 (스펙 §2.5):
 * 전략은 코드로 등록하고 검토·테스트·배포한다. UI 는 검증된 파라미터만 변경한다.
 */
const STRATEGIES: readonly AnyTradingStrategy[] = [
  hourlyBreakoutStrategy as AnyTradingStrategy,
  crossSectionalMomentumStrategy as AnyTradingStrategy,
];

export interface StrategySummary {
  readonly id: string;
  readonly version: string;
  readonly name: string;
  readonly description: string;
}

export class StrategyRegistry {
  private readonly byId = new Map<string, AnyTradingStrategy>();

  constructor(strategies: readonly AnyTradingStrategy[] = STRATEGIES) {
    for (const strategy of strategies) this.byId.set(strategy.id, strategy);
  }

  list(): StrategySummary[] {
    return [...this.byId.values()].map(({ id, version, name, description }) => ({
      id,
      version,
      name,
      description,
    }));
  }

  get(strategyId: string): AnyTradingStrategy | null {
    return this.byId.get(strategyId) ?? null;
  }

  /** JSON Schema 형태의 파라미터 스키마 (웹 폼 렌더링용) */
  getParameterJsonSchema(strategyId: string): Record<string, unknown> | null {
    const strategy = this.get(strategyId);
    if (!strategy) return null;
    return z.toJSONSchema(strategy.parameterSchema as z.ZodType) as Record<string, unknown>;
  }

  validateParameters(strategyId: string, parameters: unknown): { ok: true; value: unknown } | { ok: false; error: string } {
    const strategy = this.get(strategyId);
    if (!strategy) return { ok: false, error: `알 수 없는 전략: ${strategyId}` };
    const result = (strategy.parameterSchema as z.ZodType).safeParse(parameters);
    if (!result.success) {
      return {
        ok: false,
        error: result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
      };
    }
    return { ok: true, value: result.data };
  }
}
