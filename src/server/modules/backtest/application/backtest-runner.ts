import type { AnyTradingStrategy } from '../../strategy/domain/strategy.js';
import {
  runBacktestCancellable,
  type BacktestRunInput,
  type BacktestRunResult,
  type EngineHooks,
} from '../domain/engine.js';
import type { BacktestResultArtifact } from './backtest-result-artifact.js';

export type BacktestEngineExecutor = (
  strategy: AnyTradingStrategy,
  input: BacktestRunInput,
  hooks?: EngineHooks,
) => Promise<BacktestRunResult>;

export type BacktestRunnerOutcome =
  | { readonly status: 'CANCELLED'; readonly processedBars: number }
  | { readonly status: 'COMPLETED'; readonly artifact: BacktestResultArtifact };

/**
 * 준비가 끝난 입력을 계산하고 저장소 독립적인 artifact로 바꾸는 실행 경계.
 * 입력 로더와 SQLite writer를 모르게 해 로컬 child와 향후 원격 worker가 같은 코어를 쓴다.
 */
export class BacktestRunner {
  constructor(private readonly execute: BacktestEngineExecutor = runBacktestCancellable) {}

  async run(
    strategy: AnyTradingStrategy,
    input: BacktestRunInput,
    hooks: EngineHooks,
    inputWarnings: readonly string[] = [],
  ): Promise<BacktestRunnerOutcome> {
    const result = await this.execute(strategy, input, hooks);
    if (result.cancelled) {
      return { status: 'CANCELLED', processedBars: result.processedBars };
    }

    return {
      status: 'COMPLETED',
      artifact: {
        schemaVersion: 1,
        metrics: result.metrics,
        openPositions: result.openPositions,
        equityPoints: result.equityPoints,
        drawdownPoints: result.drawdownPoints,
        trades: result.trades,
        monthlyReturns: result.monthlyReturns,
        warnings: [...inputWarnings, ...result.warnings],
        processedBars: result.processedBars,
      },
    };
  }
}
