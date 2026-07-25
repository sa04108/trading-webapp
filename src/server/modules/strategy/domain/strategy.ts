import type { z } from 'zod';
import type { Candle } from '../../market-data/domain/candle.js';
import type { OrderIntent, Position } from '../../backtest/domain/types.js';
import type { Rng } from '../../backtest/domain/seeded-rng.js';

/** 전략이 보는 포트폴리오 스냅샷 (읽기 전용) */
export interface PortfolioView {
  readonly cash: number;
  readonly equity: number;
  readonly positions: ReadonlyMap<string, Readonly<Position>>;
}

export interface StrategyInitializeContext {
  readonly symbols: readonly string[];
  readonly initialCash: number;
  readonly rng: Rng;
}

export interface StrategyBarContext {
  readonly tsMs: number;
  /** 이번 시점에 확정된 봉 (심볼별) */
  readonly bars: ReadonlyMap<string, Candle>;
  /** 현재 시점까지 확정된 봉 이력 — 미래 봉은 절대 포함되지 않는다 */
  getHistory(symbol: string): readonly Candle[];
  readonly portfolio: PortfolioView;
  readonly rng: Rng;
}

export interface StrategyDecision {
  readonly orders: readonly OrderIntent[];
}

/** 스펙 §8 전략 Port */
export interface TradingStrategy<TParameters, TState> {
  readonly id: string;
  readonly version: string;
  readonly name: string;
  readonly description: string;
  readonly parameterSchema: z.ZodType<TParameters>;

  initialize(context: StrategyInitializeContext): TState;

  onBars(context: StrategyBarContext, state: TState, parameters: TParameters): StrategyDecision;
}

/** 레지스트리 저장용 — 파라미터·상태 타입을 지운 형태 */
export type AnyTradingStrategy = TradingStrategy<unknown, unknown>;
