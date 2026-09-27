import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type DatabaseHandle } from '../../src/runtime/shared/db/database.js';
import { readRuntimeVersions } from '../../src/runtime/shared/runtime-versions.js';
import { StrategyRegistry } from '../../src/runtime/modules/strategy/application/strategy-registry.js';
import { strategySourceHash } from '../../src/runtime/modules/strategy/application/strategy-source-hash.js';
import { ENGINE_VERSION } from '../../src/runtime/modules/backtest/domain/engine.js';
import { getCostProfile, getSlippageProfile } from '../../src/runtime/modules/backtest/domain/cost-profiles.js';
import { computeMetrics } from '../../src/runtime/modules/backtest/domain/metrics.js';
import { calculatePinnedScheduleHash } from '../../src/runtime/modules/backtest/application/backtest-symbol-identity.js';
import {
  BacktestResultArtifactRejectedError,
  type BacktestResultArtifact,
  type BacktestResultWriteContext,
} from '../../src/runtime/modules/backtest/application/backtest-result-artifact.js';
import {
  BACKTEST_RESULT_ARTIFACT_SCHEMA_VERSION,
  SqliteBacktestResultArtifactWriter,
} from '../../src/runtime/modules/backtest/infrastructure/sqlite-backtest-result-artifact-writer.js';
import { SqliteBacktestResultArtifactImporter } from '../../src/server/modules/backtest/infrastructure/sqlite-backtest-result-artifact-importer.js';
import { ForkedBacktestResultCompleter } from '../../src/server/modules/backtest/infrastructure/forked-backtest-result-completer.js';
import { JobQueue } from '../../src/server/modules/backtest/application/job-queue.js';
import { summarizeBacktestWarnings } from '../../src/runtime/modules/backtest/application/backtest-warning-summary.js';
import { ResultsService } from '../../src/server/modules/backtest/application/results-service.js';
import type { BacktestRequest } from '../../src/shared/schemas/backtest-request.js';

const request: BacktestRequest = {
  strategyId: 'range-breakout', parameters: {},
  universeRule: { markets: ['KOSPI'], stages: [{ criterion: 'MARKET_CAP', direction: 'HIGH', limit: 1 }], rebalanceInterval: { unit: 'DAY', value: 1 } },
  period: { from: '2026-01-05', to: '2026-01-05' },
  capital: { initialCash: 1_000_000, currency: 'KRW' },
  execution: { fillTiming: 'NEXT_BAR_OPEN', commissionProfileId: 'zero-cost', slippageProfileId: 'zero-slippage' },
  risk: { maxPositions: 1 }, randomSeed: 1,
};

describe('결과 artifact 실행 버전 계약', () => {
  let directory: string;
  let databasePath: string;
  let artifactPath: string;
  let database: DatabaseHandle;
  let queue: JobQueue;
  let context: BacktestResultWriteContext;
  const artifact: BacktestResultArtifact = {
    schemaVersion: 1,
    metrics: computeMetrics([], [], [], request.capital.initialCash, 0),
    equityPoints: [], drawdownPoints: [], trades: [], monthlyReturns: [], openPositions: [],
    warnings: [], processedBars: 0,
  };

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'qp-artifact-versions-'));
    databasePath = path.join(directory, 'app.sqlite');
    artifactPath = path.join(directory, 'result.sqlite');
    database = openDatabase(databasePath);
    queue = new JobQueue(database, { now: () => Date.now() });
    database.sqlite.exec(`
      INSERT INTO symbols (code, market, standard_code, created_at_ms) VALUES ('005930', 'KR', 'KR7005930003', 1);
      INSERT INTO symbol_master_versions (standard_code, valid_from_date, short_code, name, market,
        shares_outstanding, instrument_type, recorded_at_ms)
      VALUES ('KR7005930003', '2020-01-01', '005930', '테스트 종목', 'KOSPI', '100', 'COMMON_STOCK', 1);
    `);
    const schedule = [{
      rebalanceDate: '2026-01-05', effectiveTradingDate: '2026-01-05', excludedNonTradingCount: 0, symbols: ['005930'],
      members: [{ symbol: '005930', standardCode: 'KR7005930003', marketCapKrw: '100', volume: 1, tradingValueKrw: '100' }],
    }];
    const job = queue.enqueue(request, schedule);
    queue.claimNextLease({
      agentId: 'test-agent', leaseTokenHash: 'lease-hash', leaseExpiresAtMs: Date.now() + 60_000,
      runnerVersion: readRuntimeVersions().executionVersion, maxAttempts: 3,
    });
    const registry = new StrategyRegistry();
    const strategy = registry.get(request.strategyId)!;
    const parameters = registry.validateParameters(request.strategyId, request.parameters);
    if (!parameters.ok) throw new Error(parameters.error);
    const fee = getCostProfile(request.execution.commissionProfileId)!;
    const slippage = getSlippageProfile(request.execution.slippageProfileId)!;
    context = {
      jobId: job.id, strategyId: strategy.id, strategyVersion: strategy.version,
      strategySourceHash: strategySourceHash(strategy), parameterJson: JSON.stringify(parameters.value),
      universeRuleJson: job.universeRuleJson, scheduleHash: calculatePinnedScheduleHash(schedule),
      universeJson: job.universeJson ?? '[]', universeHash: job.universeHash ?? 'unknown',
      engineVersion: ENGINE_VERSION, executionVersion: readRuntimeVersions().executionVersion,
      feeModelVersion: `${fee.id}@${fee.version}`, slippageModelVersion: `${slippage.id}@${slippage.version}`,
      randomSeed: request.randomSeed, gitCommitSha: 'different-deployment-sha',
      provenancePinJson: job.provenancePinJson, startedAtMs: 1, completedAtMs: 2,
    };
  });

  afterEach(() => {
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  function complete() {
    return new ForkedBacktestResultCompleter(databasePath).complete({
      jobId: context.jobId, attempt: 1, leaseTokenHash: 'lease-hash', artifactPath,
      checksum: 'checksum', expectedRunnerVersion: readRuntimeVersions().executionVersion,
    });
  }

  it('배포 SHA가 달라도 같은 실행 버전 결과를 저장하고 출처를 보존한다', async () => {
    new SqliteBacktestResultArtifactWriter(artifactPath).write(context, artifact);
    await expect(complete()).resolves.toMatchObject({ status: 'ACCEPTED', schemaVersion: 3 });
    expect(new ResultsService(database.db).getRun(context.jobId)).toMatchObject({
      executionVersion: context.executionVersion, gitCommitSha: 'different-deployment-sha',
    });
    expect(artifact.schemaVersion).toBe(1);
    expect(BACKTEST_RESULT_ARTIFACT_SCHEMA_VERSION).toBe(3);
  });

  it('실행 버전이 다른 결과를 중앙 저장 전에 거절한다', async () => {
    new SqliteBacktestResultArtifactWriter(artifactPath).write({ ...context, executionVersion: 'old-execution' }, artifact);
    await expect(complete()).rejects.toThrow(BacktestResultArtifactRejectedError);
    expect(new ResultsService(database.db).getRun(context.jobId)).toBeNull();
    expect(queue.getJob(context.jobId)?.status).toBe('STARTING');
  });

  it('이전 저장 ABI를 실행 버전이 있는 새 결과로 간주하지 않는다', () => {
    new SqliteBacktestResultArtifactWriter(artifactPath).write(context, artifact);
    const sqlite = new Database(artifactPath);
    sqlite.pragma('user_version = 1');
    sqlite.close();
    const importer = new SqliteBacktestResultArtifactImporter(database);
    expect(() => importer.validate(artifactPath, context.jobId)).toThrow('지원하지 않는 결과 schema: 1');
  });

  it.each([null, ''])('저장 ABI가 같아도 누락·빈 실행 버전 %s는 거절한다', (executionVersion) => {
    new SqliteBacktestResultArtifactWriter(artifactPath).write(context, artifact);
    const sqlite = new Database(artifactPath);
    const changed: Record<string, unknown> = { ...context };
    if (executionVersion === null) delete changed.executionVersion;
    else changed.executionVersion = executionVersion;
    sqlite.prepare('UPDATE artifact_manifest SET context_json = ?').run(JSON.stringify(changed));
    sqlite.close();
    const importer = new SqliteBacktestResultArtifactImporter(database);
    expect(() => importer.validate(artifactPath, context.jobId)).toThrow('context');
  });

  it('1,093개·4,162자 경고도 계산 결과를 수락하고 순서와 원문을 보존한다', async () => {
    const warnings = Array.from({ length: 1093 }, (_, index) => `준비 경고 ${index}`);
    warnings[317] = '자'.repeat(4162);
    warnings[1092] = '마지막 실행 경고';
    new SqliteBacktestResultArtifactWriter(artifactPath).write(context, { ...artifact, warnings });
    await expect(complete()).resolves.toMatchObject({ status: 'ACCEPTED', schemaVersion: 3 });
    const results = new ResultsService(database.db);
    expect([...results.iterateWarningDetails(context.jobId)]).toEqual(warnings);
    const summaries = JSON.parse(results.getRun(context.jobId)!.warningsJson!);
    expect(summaries).toEqual(summarizeBacktestWarnings(warnings));
    expect(summaries.length).toBeLessThanOrEqual(1000);
    expect(summaries.every((warning: string) => warning.length <= 4000)).toBe(true);
    expect(summaries).toContain('마지막 실행 경고');
    expect(summaries[0]).toContain('전체 경고 원문');
    database.sqlite.prepare('DELETE FROM backtest_jobs WHERE id = ?').run(context.jobId);
    expect(database.sqlite.prepare('SELECT count(*) AS count FROM backtest_warning_details').get()).toEqual({ count: 0 });
  });

  it('중복·줄바꿈·유니코드 경고는 원문 그대로 저장하고 짧은 경고는 요약하지 않는다', async () => {
    const warnings = ['중복 경고', '중복 경고', '줄바꿈\n따옴표 "원문" 😀'];
    new SqliteBacktestResultArtifactWriter(artifactPath).write(context, { ...artifact, warnings });
    await expect(complete()).resolves.toMatchObject({ status: 'ACCEPTED' });
    const results = new ResultsService(database.db);
    expect(JSON.parse(results.getRun(context.jobId)!.warningsJson!)).toEqual(warnings);
    expect([...results.iterateWarningDetails(context.jobId)]).toEqual(warnings);
  });

  it('서버는 원문과 달라진 경고 요약을 수락하지 않는다', () => {
    new SqliteBacktestResultArtifactWriter(artifactPath).write(context, { ...artifact, warnings: ['원문'] });
    const sqlite = new Database(artifactPath);
    const manifest = sqlite.prepare('SELECT summary_json AS summary FROM artifact_manifest').get() as { summary: string };
    sqlite.prepare('UPDATE artifact_manifest SET summary_json = ?')
      .run(JSON.stringify({ ...JSON.parse(manifest.summary), warnings: ['다른 경고'] }));
    sqlite.close();
    expect(() => new SqliteBacktestResultArtifactImporter(database).validate(artifactPath, context.jobId))
      .toThrow('경고 요약이 전체 원문과 일치하지 않습니다');
  });

  it('원문 행이 누락되거나 순서가 끊긴 파일은 저장 전에 거부한다', () => {
    new SqliteBacktestResultArtifactWriter(artifactPath).write(context, { ...artifact, warnings: ['첫 경고', '두 번째 경고'] });
    const sqlite = new Database(artifactPath);
    sqlite.prepare('DELETE FROM warning_details WHERE sequence = 0').run();
    sqlite.close();
    expect(() => new SqliteBacktestResultArtifactImporter(database).validate(artifactPath, context.jobId))
      .toThrow('경고 원문의 순서가 올바르지 않습니다');
    expect(database.sqlite.prepare('SELECT count(*) AS count FROM backtest_warning_details').get()).toEqual({ count: 0 });
  });

});
