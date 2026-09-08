import { z } from 'zod';
import type { TradingStrategy } from '../../src/server/modules/strategy/domain/strategy.js';
import {
  crossSectionalMomentumParameters,
  crossSectionalMomentumStrategy,
  momentumScore,
  type CrossSectionalMomentumState,
} from '../../src/server/modules/strategy/strategies/cross-sectional-momentum.js';
import { rankDescending, type Scored } from '../../src/server/modules/strategy/strategies/shared/rank.js';
import { planSellPhase } from '../../src/server/modules/strategy/strategies/shared/two-phase-rebalance.js';

export const rankRetentionParameters = crossSectionalMomentumParameters.extend({
  retentionRank: z.number().int().min(1).max(200).default(10),
}).refine((p) => p.retentionRank >= p.topN, { message: '보유 유지 순위는 보유 수 이상이어야 합니다', path: ['retentionRank'] });

type Parameters = z.infer<typeof rankRetentionParameters>;

/** 적격 보유를 더 넓은 순위까지 유지하고 비어 있는 자리만 신규 상위 종목으로 채운다. */
export const rankRetentionMomentum: TradingStrategy<Parameters, CrossSectionalMomentumState> = {
  ...crossSectionalMomentumStrategy,
  id: 'rank-retention-momentum',
  version: '0.1.0',
  name: '보유 순위 완충 모멘텀 (연구)',
  description: '보유 종목이 적격 순위 경계 안에 있으면 유지하고 남은 자리만 높은 순위로 채웁니다.',
  parameterSchema: rankRetentionParameters,
  onBars(context, state, parameters) {
    // 매수 단계와 회전일 밖의 동작은 기존 전략에 그대로 맡긴다.
    if (state.pendingTargets !== null || !context.isRebalanceBar) {
      return crossSectionalMomentumStrategy.onBars(context, state, parameters);
    }
    const minBars = parameters.formationDays + parameters.skipDays + 1;
    if (!state.symbols.some((symbol) => context.getHistory(symbol).length >= minBars)) return { orders: [] };

    const scored: Scored[] = [];
    for (const symbol of state.symbols) {
      if (context.tradableSymbols !== null && !context.tradableSymbols.has(symbol)) continue;
      const score = momentumScore(context.getHistory(symbol), context.corporateActions(symbol), parameters.formationDays, parameters.skipDays);
      if (score === null || (parameters.absoluteMomentumFilter && score <= 0)) continue;
      scored.push({ symbol, score });
    }
    const ranked = [...rankDescending(scored, context.rng).entries()].sort((a, b) => a[1] - b[1]);
    const retained = ranked.filter(([symbol, rank]) => rank <= parameters.retentionRank
      && (context.portfolio.positions.get(symbol)?.quantity ?? 0) > 0).slice(0, parameters.topN).map(([symbol]) => symbol);
    const chosen = new Set(retained);
    for (const [symbol] of ranked) {
      if (chosen.size === parameters.topN) break;
      chosen.add(symbol);
    }
    const targets = [...chosen].sort();
    const orders = planSellPhase({ targets, positions: context.portfolio.positions, bars: context.bars,
      equity: context.portfolio.equity, topN: parameters.topN });
    state.pendingTargets = targets.length > 0 ? targets : null;
    return { orders };
  },
};
