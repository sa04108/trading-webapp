import { z } from 'zod';
import {
  strategyRequiresFinancialData,
  type AnyTradingStrategy,
} from '../domain/strategy.js';
import { crossSectionalMomentumStrategy } from '../strategies/cross-sectional-momentum.js';
import { earningsAccelerationRankStrategy } from '../strategies/earnings-acceleration-rank.js';
import { emaTrendSwitchStrategy } from '../strategies/ema-trend-switch.js';
import { lowPerHighRoeRankStrategy } from '../strategies/low-per-high-roe-rank.js';
import { rangeBreakoutStrategy } from '../strategies/range-breakout.js';
import { rsiReversionStrategy } from '../strategies/rsi-reversion.js';
import { valueQualityRankStrategy } from '../strategies/value-quality-rank.js';

/**
 * 코드 등록식 전략 레지스트리 (스펙 §2.5):
 * 전략은 코드로 등록하고 검토·테스트·배포한다. UI 는 검증된 파라미터만 변경한다.
 */
const STRATEGIES: readonly AnyTradingStrategy[] = [
  rangeBreakoutStrategy as AnyTradingStrategy,
  crossSectionalMomentumStrategy as AnyTradingStrategy,
  valueQualityRankStrategy as AnyTradingStrategy,
  earningsAccelerationRankStrategy as AnyTradingStrategy,
  lowPerHighRoeRankStrategy as AnyTradingStrategy,
  emaTrendSwitchStrategy as AnyTradingStrategy,
  rsiReversionStrategy as AnyTradingStrategy,
];

export interface StrategySummary {
  readonly id: string;
  readonly version: string;
  readonly name: string;
  readonly description: string;
  /**
   * 도메인에서는 봉만 쓰는 전략이 생략하는 선택 필드지만(`requiresFundamentals?`)
   * 목록 응답에서는 항상 boolean 이다. 필드를 빼고 내리면 화면이 "재무를 안 쓴다" 와
   * "서버가 알려주지 않았다" 를 구분할 수 없고, 후자를 전자로 읽으면 재무 전략에
   * 「봉 데이터만」이 붙는다 — 사용자가 피하려던 상황을 화면이 보증해 버린다.
   */
  readonly requiresFundamentals: boolean;
}

function toSummary(strategy: AnyTradingStrategy): StrategySummary {
  return {
    id: strategy.id,
    version: strategy.version,
    name: strategy.name,
    description: strategy.description,
    requiresFundamentals: strategyRequiresFinancialData(strategy),
  };
}

export class StrategyRegistry {
  private readonly byId = new Map<string, AnyTradingStrategy>();

  constructor(strategies: readonly AnyTradingStrategy[] = STRATEGIES) {
    for (const strategy of strategies) this.byId.set(strategy.id, strategy);
  }

  list(): StrategySummary[] {
    return [...this.byId.values()].map(toSummary);
  }

  get(strategyId: string): AnyTradingStrategy | null {
    return this.byId.get(strategyId) ?? null;
  }

  /** 알림 등 내부 표시명이 필요한 호출부가 목록을 재구성하지 않도록 좁게 조회한다. */
  describe(strategyId: string): StrategySummary | null {
    const strategy = this.get(strategyId);
    return strategy === null ? null : toSummary(strategy);
  }

  /** 모르는 전략은 false — 여기서 던지면 "알 수 없는 전략" 검증보다 먼저 터진다 */
  requiresFundamentals(strategyId: string): boolean {
    const strategy = this.get(strategyId);
    return strategy !== null && strategyRequiresFinancialData(strategy);
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
