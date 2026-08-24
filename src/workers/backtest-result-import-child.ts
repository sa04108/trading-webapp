import { openDatabase } from '../server/shared/db/database.js';
import { systemClock } from '../server/shared/clock.js';
import { JobQueue } from '../server/modules/backtest/application/job-queue.js';
import {
  BacktestResultPersistenceError,
  InvalidBacktestResultArtifactError,
  SqliteBacktestResultArtifactImporter,
} from '../server/modules/backtest/infrastructure/sqlite-backtest-result-artifact-importer.js';
import {
  RemoteResultPersistenceUnavailableError,
  type RemoteResultCompletionOutput,
} from '../server/modules/backtest/application/backtest-result-artifact.js';
import { backtestRequestSchema } from '../shared/schemas/backtest-request.js';
import type { ProvenancePin } from '../shared/schemas/provenance-pin.js';
import { ENGINE_VERSION } from '../server/modules/backtest/domain/engine.js';
import {
  getCostProfile,
  getSlippageProfile,
} from '../server/modules/backtest/domain/cost-profiles.js';
import { StrategyRegistry } from '../server/modules/strategy/application/strategy-registry.js';
import { strategySourceHash } from '../server/modules/strategy/application/strategy-source-hash.js';
import { isPersistenceUnavailableError } from '../server/shared/db/sqlite-errors.js';
import { SymbolMasterService } from '../server/modules/market-data/application/symbol-master-service.js';
import {
  assertSafePinnedScheduleIdentityJson,
  calculatePinnedScheduleHash,
  UnsafeBacktestSymbolIdentityError,
} from '../server/modules/backtest/application/backtest-symbol-identity.js';

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

function hasUsableProvenanceScheduleHash(raw: string | null): boolean {
  if (raw === null) return true;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return false;
    const scheduleHash = (parsed as { readonly scheduleHash?: unknown }).scheduleHash;
    return typeof scheduleHash === 'string' && /^[a-f0-9]{64}$/.test(scheduleHash);
  } catch {
    return false;
  }
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
      throw new Error('app job의 전략 pin이 올바르지 않습니다');
    }
    const validatedParameters = registry.validateParameters(request.strategyId, request.parameters);
    if (!validatedParameters.ok) throw new Error(`app job 파라미터가 올바르지 않습니다: ${validatedParameters.error}`);
    const costProfile = getCostProfile(request.execution.commissionProfileId);
    const slippageProfile = getSlippageProfile(request.execution.slippageProfileId);
    if (costProfile === null || slippageProfile === null) {
      throw new Error('app job의 비용·슬리피지 pin이 올바르지 않습니다');
    }
    let expectedScheduleHash: string | null = null;
    try {
      const parsedSchedule: unknown = JSON.parse(job.universeScheduleJson);
      expectedScheduleHash = calculatePinnedScheduleHash(parsedSchedule);
    } catch {
      // 손상된 중앙 schedule은 artifact 400/내부 500으로 조기 분류하지 않는다.
      // valid lease의 authoritative IMMEDIATE validator가 같은 행을 읽고 FAILED로 확정한다.
    }
    const compareArtifactProvenancePin = hasUsableProvenanceScheduleHash(job.provenancePinJson);
    if (artifact.context.gitCommitSha !== expectedRunnerVersion) {
      throw new InvalidBacktestResultArtifactError(
        `artifact runner version 불일치: ${artifact.context.gitCommitSha} != ${expectedRunnerVersion}`,
      );
    }
    const contextMatchesJob = artifact.context.strategyId === strategy.id
      && artifact.context.strategyVersion === strategy.version
      && artifact.context.strategySourceHash === strategySourceHash(strategy)
      && artifact.context.parameterJson === JSON.stringify(validatedParameters.value)
      && artifact.context.universeRuleJson === job.universeRuleJson
      && (expectedScheduleHash === null || artifact.context.scheduleHash === expectedScheduleHash)
      && artifact.context.universeJson === (job.universeJson ?? '[]')
      && artifact.context.universeHash === (job.universeHash ?? 'unknown')
      && (
        !compareArtifactProvenancePin
        || artifact.context.provenancePinJson === job.provenancePinJson
      )
      && artifact.context.engineVersion === ENGINE_VERSION
      && artifact.context.feeModelVersion === `${costProfile.id}@${costProfile.version}`
      && artifact.context.slippageModelVersion === `${slippageProfile.id}@${slippageProfile.version}`
      && artifact.context.randomSeed === request.randomSeed
      && artifact.summary.metrics.initialCash === request.capital.initialCash
      && artifact.context.startedAtMs <= artifact.context.completedAtMs;
    if (!contextMatchesJob) {
      throw new InvalidBacktestResultArtifactError(
        'artifact 실행 context가 app job pin과 일치하지 않습니다',
      );
    }
    const symbolMaster = {
      readIdentitySnapshot: (
        shortCodes: readonly string[],
        standardCodes: readonly string[],
        includeRegistrations = true,
      ) => SymbolMasterService.readIdentitySnapshotFromDatabase(
        destination.db,
        shortCodes,
        standardCodes,
        includeRegistrations,
      ),
    };
    const status = queue.completeRemote({
      jobId,
      attempt,
      leaseTokenHash,
      nowMs: systemClock.now(),
      resultSchemaVersion: artifact.schemaVersion,
      resultChecksum: checksum,
      processedBars: artifact.summary.processedBars,
      validate: (current) => {
        try {
          // artifact context 검사는 child 시작 시 읽은 job 기준이다. 그 뒤 중앙 행이
          // 수동 수정되더라도 IMMEDIATE transaction 안의 최신 schedule/pin과 다시
          // 맞춰, 옛 hash를 단 새 계산 결과가 수락되지 않게 한다.
          if (
            current.requestJson !== job.requestJson
            || current.strategyId !== job.strategyId
            || current.universeRuleJson !== job.universeRuleJson
            || current.universeScheduleJson !== job.universeScheduleJson
            || current.provenancePinJson !== job.provenancePinJson
            || current.universeJson !== job.universeJson
            || current.universeHash !== job.universeHash
            || artifact.context.provenancePinJson !== current.provenancePinJson
          ) {
            throw new UnsafeBacktestSymbolIdentityError(
              '결과 저장 전에 백테스트 실행 pin이 변경됐습니다.',
            );
          }
          let currentPin: ProvenancePin | null;
          try {
            currentPin = current.provenancePinJson === null
              ? null
              : JSON.parse(current.provenancePinJson) as ProvenancePin;
          } catch {
            throw new UnsafeBacktestSymbolIdentityError(
              '저장된 provenance pin JSON이 손상됐습니다.',
            );
          }
          const currentScheduleHash = currentPin?.scheduleHash;
          if (
            current.provenancePinJson !== null
            && artifact.context.scheduleHash !== currentScheduleHash
          ) {
            throw new UnsafeBacktestSymbolIdentityError(
              'artifact 일정 hash가 중앙 provenance pin과 일치하지 않습니다.',
            );
          }
          assertSafePinnedScheduleIdentityJson(
            current.universeScheduleJson,
            { symbolMaster },
            { expectedScheduleHash: artifact.context.scheduleHash },
          );
          return null;
        } catch (error) {
          if (error instanceof UnsafeBacktestSymbolIdentityError) {
            return `결과 저장 직전 종목 identity 검증 실패: ${error.message}`;
          }
          if (isPersistenceUnavailableError(error)) {
            throw new RemoteResultPersistenceUnavailableError(
              '결과 import transaction에서 종목 identity를 확인할 수 없습니다.',
              { cause: error },
            );
          }
          throw error;
        }
      },
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
  const message = error instanceof Error ? error.message : String(error);
  if (
    error instanceof RemoteResultPersistenceUnavailableError
    || (
      error instanceof BacktestResultPersistenceError
      && isPersistenceUnavailableError(error)
    )
    || isPersistenceUnavailableError(error)
  ) {
    process.send?.({
      type: 'result-persistence-unavailable',
      error: message,
    });
  } else if (error instanceof InvalidBacktestResultArtifactError) {
    process.send?.({ type: 'invalid-result-artifact', error: message });
  } else {
    process.send?.({ type: 'result-import-internal-error', error: message });
  }
  console.error(error);
  process.exitCode = 1;
}
