import { openDatabase } from '../server/shared/db/database.js';
import { systemClock } from '../server/shared/clock.js';
import { JobQueue } from '../server/modules/backtest/application/job-queue.js';
import { SqliteBacktestResultArtifactImporter } from '../server/modules/backtest/infrastructure/sqlite-backtest-result-artifact-importer.js';
import type { RemoteResultCompletionOutput } from '../server/modules/backtest/application/backtest-result-artifact.js';
import { backtestRequestSchema } from '../shared/schemas/backtest-request.js';
import type { ProvenancePin } from '../shared/schemas/provenance-pin.js';
import { ENGINE_VERSION } from '../server/modules/backtest/domain/engine.js';
import {
  getCostProfile,
  getSlippageProfile,
} from '../server/modules/backtest/domain/cost-profiles.js';
import { StrategyRegistry } from '../server/modules/strategy/application/strategy-registry.js';
import { strategySourceHash } from '../server/modules/strategy/application/strategy-source-hash.js';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} 환경변수가 필요합니다`);
  return value;
}

function requiredInteger(name: string): number {
  const value = Number(required(name));
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} 값이 올바르지 않습니다`);
  return value;
}

function send(output: RemoteResultCompletionOutput): void {
  process.send?.({ type: 'completed', output });
}

function main(): void {
  const databasePath = required('DATABASE_PATH');
  const artifactPath = required('BACKTEST_RESULT_ARTIFACT_PATH');
  const jobId = required('BACKTEST_JOB_ID');
  const attempt = requiredInteger('BACKTEST_ATTEMPT');
  const leaseTokenHash = required('BACKTEST_LEASE_TOKEN_HASH');
  const checksum = required('BACKTEST_RESULT_CHECKSUM');
  const expectedRunnerVersion = required('BACKTEST_EXPECTED_RUNNER_VERSION');

  const destination = openDatabase(databasePath);
  try {
    const queue = new JobQueue(destination, systemClock);
    const importer = new SqliteBacktestResultArtifactImporter(destination);
    const artifact = importer.validate(artifactPath, jobId);
    const job = queue.getJob(jobId);
    if (job === null) throw new Error(`job not found: ${jobId}`);
    const request = backtestRequestSchema.parse(JSON.parse(job.requestJson));
    const registry = new StrategyRegistry();
    const strategy = registry.get(request.strategyId);
    if (strategy === null || job.strategyId !== request.strategyId) {
      throw new Error('server job의 전략 pin이 올바르지 않습니다');
    }
    const validatedParameters = registry.validateParameters(request.strategyId, request.parameters);
    if (!validatedParameters.ok) throw new Error(`server job 파라미터가 올바르지 않습니다: ${validatedParameters.error}`);
    const costProfile = getCostProfile(request.execution.commissionProfileId);
    const slippageProfile = getSlippageProfile(request.execution.slippageProfileId);
    if (costProfile === null || slippageProfile === null) {
      throw new Error('server job의 비용·슬리피지 pin이 올바르지 않습니다');
    }
    const provenancePin = job.provenancePinJson === null
      ? null
      : JSON.parse(job.provenancePinJson) as ProvenancePin;
    const expectedScheduleHash = provenancePin?.scheduleHash ?? 'unknown';
    if (artifact.context.gitCommitSha !== expectedRunnerVersion) {
      throw new Error(
        `artifact runner version 불일치: ${artifact.context.gitCommitSha} != ${expectedRunnerVersion}`,
      );
    }
    const contextMatchesJob = artifact.context.strategyId === strategy.id
      && artifact.context.strategyVersion === strategy.version
      && artifact.context.strategySourceHash === strategySourceHash(strategy)
      && artifact.context.parameterJson === JSON.stringify(validatedParameters.value)
      && artifact.context.universeRuleJson === job.universeRuleJson
      && artifact.context.scheduleHash === expectedScheduleHash
      && artifact.context.universeJson === (job.universeJson ?? '[]')
      && artifact.context.universeHash === (job.universeHash ?? 'unknown')
      && artifact.context.provenancePinJson === job.provenancePinJson
      && artifact.context.engineVersion === ENGINE_VERSION
      && artifact.context.feeModelVersion === `${costProfile.id}@${costProfile.version}`
      && artifact.context.slippageModelVersion === `${slippageProfile.id}@${slippageProfile.version}`
      && artifact.context.randomSeed === request.randomSeed
      && artifact.summary.metrics.initialCash === request.capital.initialCash
      && artifact.context.startedAtMs <= artifact.context.completedAtMs;
    if (!contextMatchesJob) throw new Error('artifact 실행 context가 server job pin과 일치하지 않습니다');
    const status = queue.completeRemote({
      jobId,
      attempt,
      leaseTokenHash,
      nowMs: systemClock.now(),
      resultSchemaVersion: artifact.schemaVersion,
      resultChecksum: checksum,
      processedBars: artifact.summary.processedBars,
      persist: () => importer.write(artifact),
    });
    send({
      status,
      schemaVersion: artifact.schemaVersion,
      rowCount: artifact.rowCount,
      processedBars: artifact.summary.processedBars,
      completedAtMs: systemClock.now(),
    });
  } finally {
    destination.close();
  }
}

try {
  main();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
