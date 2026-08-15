import { Buffer } from 'node:buffer';
import type { BacktestRunResult } from '../domain/engine.js';

/**
 * 계산 프로세스와 영속 저장소 사이의 버전된 결과 계약.
 *
 * 엔진의 일시적인 진단값(fills, delistingLiquidations)과 취소 플래그를 그대로 DB에
 * 결합하지 않는다. 실제 결과 조회가 소비하는 값만 artifact에 담아, 이후 로컬 child가
 * 파일로 쓰거나 원격 worker가 업로드해도 같은 writer 계약을 사용할 수 있게 한다.
 */
export interface BacktestResultArtifact {
  readonly schemaVersion: 1;
  readonly metrics: BacktestRunResult['metrics'];
  readonly openPositions: BacktestRunResult['openPositions'];
  readonly equityPoints: BacktestRunResult['equityPoints'];
  readonly drawdownPoints: BacktestRunResult['drawdownPoints'];
  readonly trades: BacktestRunResult['trades'];
  readonly monthlyReturns: BacktestRunResult['monthlyReturns'];
  readonly warnings: readonly string[];
  readonly processedBars: number;
}

export interface BacktestResultWriteContext {
  readonly jobId: string;
  readonly strategyId: string;
  readonly strategyVersion: string;
  readonly strategySourceHash: string;
  readonly parameterJson: string;
  readonly universeRuleJson: string;
  readonly scheduleHash: string;
  readonly universeJson: string;
  readonly universeHash: string;
  readonly engineVersion: string;
  readonly feeModelVersion: string;
  readonly slippageModelVersion: string;
  readonly randomSeed: number;
  readonly gitCommitSha: string;
  readonly provenancePinJson: string | null;
  readonly startedAtMs: number;
  readonly completedAtMs: number;
}

/** 저장 구현을 로컬 SQLite에서 artifact importer로 교체할 때 지켜야 할 port. */
export interface BacktestResultWriter {
  write(context: BacktestResultWriteContext, artifact: BacktestResultArtifact): void;
}

export interface BacktestArtifactSize {
  readonly rowCount: number;
  /** SQLite page/index overhead를 제외한 논리 payload의 저비용 근사치. */
  readonly estimatedPayloadBytes: number;
  readonly equityPointCount: number;
  readonly drawdownPointCount: number;
  readonly tradeCount: number;
  readonly monthlyReturnCount: number;
  readonly openPositionCount: number;
}

function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

/**
 * 결과 전체를 JSON.stringify해서 메모리를 한 번 더 쓰지 않고 크기를 추정한다.
 * 1GB Lightsail에서 계측 때문에 OOM 위험을 키우지 않는 것이 정확한 직렬화 크기보다 중요하다.
 */
export function measureBacktestArtifact(artifact: BacktestResultArtifact): BacktestArtifactSize {
  let estimatedPayloadBytes = jsonBytes(artifact.metrics)
    + jsonBytes(artifact.warnings)
    + jsonBytes(artifact.openPositions);

  // equity/drawdown은 각각 숫자 두 개, monthly return은 숫자 세 개를 저장한다.
  estimatedPayloadBytes += artifact.equityPoints.length * 16;
  estimatedPayloadBytes += artifact.drawdownPoints.length * 16;
  estimatedPayloadBytes += artifact.monthlyReturns.length * 24;
  for (const trade of artifact.trades) {
    // Trade의 숫자 필드 10개 + 가변 문자열. SQLite 행/page overhead는 의도적으로 제외한다.
    estimatedPayloadBytes += 80 + Buffer.byteLength(trade.symbol, 'utf8');
    if (trade.exitReason !== undefined) {
      estimatedPayloadBytes += Buffer.byteLength(trade.exitReason, 'utf8');
    }
  }

  return {
    rowCount: 2
      + artifact.equityPoints.length
      + artifact.drawdownPoints.length
      + artifact.trades.length
      + artifact.monthlyReturns.length,
    estimatedPayloadBytes,
    equityPointCount: artifact.equityPoints.length,
    drawdownPointCount: artifact.drawdownPoints.length,
    tradeCount: artifact.trades.length,
    monthlyReturnCount: artifact.monthlyReturns.length,
    openPositionCount: artifact.openPositions.length,
  };
}
