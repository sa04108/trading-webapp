import type { BacktestUniversePreview } from './backtest-preparation-orchestrator.js';

export interface ReadyPreviewDetails {
  readonly preview: BacktestUniversePreview;
  readonly fundamentalSymbols: readonly string[];
}
