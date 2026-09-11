import Fastify from 'fastify';
import { registerPeriodValidationRoutes } from '../../src/server/modules/backtest/presentation/period-validation-routes.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { openDatabase, type DatabaseHandle } from '../../src/server/shared/db/database.js';
import { backtestMetrics, backtestPreparationJobs, backtestRuns, backtestValidations } from '../../src/server/shared/db/schema.js';
import { readGitCommitSha } from '../../src/server/shared/build-info.js';
import { JobQueue } from '../../src/server/modules/backtest/application/job-queue.js';
import { ResultsService } from '../../src/server/modules/backtest/application/results-service.js';
import { PeriodValidationService, type PeriodValidationDeps } from '../../src/server/modules/backtest/application/period-validation-service.js';
import { PreparationPreviewCache } from '../../src/server/modules/backtest/application/preparation-preview-cache.js';
import { PreparationReferenceService } from '../../src/server/modules/backtest/application/preparation-reference-service.js';
import type { BacktestPreparationOrchestrator, BacktestUniversePreview } from '../../src/server/modules/backtest/application/backtest-preparation-orchestrator.js';
import { StrategyRegistry } from '../../src/server/modules/strategy/application/strategy-registry.js';
import { strategySourceHash } from '../../src/server/modules/strategy/application/strategy-source-hash.js';
import { ENGINE_VERSION } from '../../src/server/modules/backtest/domain/engine.js';
import type { BacktestRequest } from '../../src/shared/schemas/backtest-request.js';
import type { PeriodValidationConfig, ValidationMetrics } from '../../src/shared/schemas/period-validation.js';

const strategy = { id: 'validation-test', version: '1', name: '검증 테스트', description: '', parameterSchema: z.object({ window: z.number().int().min(1) }), initialize: () => ({}), onBars: () => ({ orders: [] }) };
const source: BacktestRequest = {
  strategyId: strategy.id, parameters: { window: 10 },
  universeRule: { markets: ['KOSPI'], stages: [{ criterion: 'MARKET_CAP', direction: 'HIGH', limit: 10 }], rebalanceInterval: { unit: 'MONTH', value: 1 } },
  period: { from: '2020-01-01', to: '2024-01-01' }, capital: { initialCash: 1_000_000, currency: 'KRW' },
  execution: { fillTiming: 'NEXT_BAR_OPEN', commissionProfileId: 'kr-equity-default', slippageProfileId: 'fixed-5bps' },
  risk: { maxPositions: 5 }, randomSeed: 42,
};
const optimization = { axes: [{ key: 'window', values: [5, 20] }], objective: 'sharpe' as const, minTrades: 5, maxDrawdownPct: 30 };
const optimized: PeriodValidationConfig = { mode: 'OPTIMIZED_HOLDOUT', splitDate: '2023-01-01', optimization };
const metrics = (sharpe = 1, tradeCount = 10): ValidationMetrics => ({ totalReturnPct: 12, cagrPct: 8, maxDrawdownPct: -5, sharpe, tradeCount });

describe('독립 구간 검증 실행', () => {
  let dir: string;
  let database: DatabaseHandle;
  let queue: JobQueue;
  let results: ResultsService;
  let service: PeriodValidationService;
  let deps: PeriodValidationDeps;
  let sourceId: string;
  let preparationSequence: number;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'validation-'));
    database = openDatabase(path.join(dir, 'app.sqlite'));
    const clock = { now: () => 1_000 };
    queue = new JobQueue(database, clock);
    results = new ResultsService(database.db);
    const cache = new PreparationPreviewCache(database);
    preparationSequence = 0;
    const get = (id: string) => database.db.select().from(backtestPreparationJobs).where(eq(backtestPreparationJobs.id, id)).get() ?? null;
    const preparation = {
      get,
      getFreshPreviewDetails: (request: BacktestRequest, id?: string) => {
        const ready = cache.get(JSON.stringify(request), id);
        return ready;
      },
      getReadyPreviewDetails: async () => null,
      start: (request: BacktestRequest) => {
        const id = `prep-${++preparationSequence}`;
        const preview: BacktestUniversePreview = { preparationJobId: id, schedule: [], diagnostics: [], stages: [], unionSymbols: [], scheduleHash: 'test', uncoveredDates: [], periodCovered: true, missingCandleSymbols: [], warnings: [] };
        database.db.insert(backtestPreparationJobs).values({ id, requestHash: JSON.stringify(request), requestJson: JSON.stringify(request), status: 'COMPLETED', phase: 'FINALIZING', previewJson: JSON.stringify(preview), createdAtMs: 1, updatedAtMs: 1 }).run();
        cache.store(id, cache.beginValidation(), []);
        return get(id)!;
      },
    } as unknown as BacktestPreparationOrchestrator;
    deps = {
      database, clock, queue, results, preparation, strategies: new StrategyRegistry([strategy]),
      validateRequest: () => [],
      buildEnqueue: vi.fn(async (request, preview) => () => queue.enqueue(request, [], undefined, null, [], undefined, { preparationJobId: preview.preparationJobId })),
      cancelJob: (id) => { queue.setStatus(id, 'CANCELLED'); },
    };
    service = new PeriodValidationService(deps);
    sourceId = queue.enqueue(source).id;
    complete(sourceId);
  });

  afterEach(async () => { await service.stop(); database.close(); fs.rmSync(dir, { recursive: true, force: true }); });

  function complete(jobId: string, values = metrics()): void {
    const job = queue.getJob(jobId)!;
    const request = JSON.parse(job.requestJson) as BacktestRequest;
    database.db.insert(backtestRuns).values({
      id: `run-${jobId}`, jobId, strategyId: strategy.id, strategyVersion: strategy.version,
      strategySourceHash: strategySourceHash(strategy), parameterJson: JSON.stringify(request.parameters),
      universeRuleJson: JSON.stringify(request.universeRule), scheduleHash: 'test', universeHash: 'test', universeJson: '[]',
      engineVersion: ENGINE_VERSION, feeModelVersion: 'test', slippageModelVersion: 'test', randomSeed: request.randomSeed,
      gitCommitSha: readGitCommitSha(), startedAtMs: 1, completedAtMs: 2,
    }).run();
    database.db.insert(backtestMetrics).values({ jobId, metricsJson: JSON.stringify(values), totalReturnPct: values.totalReturnPct, cagrPct: values.cagrPct, maxDrawdownPct: values.maxDrawdownPct, sharpe: values.sharpe, tradeCount: values.tradeCount }).run();
    queue.setStatus(jobId, 'COMPLETED');
  }

  async function until(predicate: () => boolean): Promise<void> {
    for (let i = 0; i < 80; i += 1) {
      if (predicate()) return;
      await service.pump();
    }
    throw new Error('검증 실험이 기대한 상태에 도달하지 않았습니다.');
  }

  it('홀드아웃을 각각 동일 자본·시드·비용으로 다시 실행하고 원본 결과를 잘라 쓰지 않는다', async () => {
    const experiment = service.create(sourceId, { mode: 'HOLDOUT', splitDate: '2023-01-01' });
    await until(() => service.get(experiment.id)!.trials.some((trial) => trial.role === 'TRAIN' && trial.jobId));
    let detail = service.get(experiment.id)!;
    const train = detail.trials.find((trial) => trial.role === 'TRAIN')!;
    expect(train.jobId).not.toBe(sourceId);
    expect(detail.trials.find((trial) => trial.role === 'OOS')!.jobId).toBeNull();
    complete(train.jobId!);
    await until(() => service.get(experiment.id)!.trials.some((trial) => trial.role === 'OOS' && trial.jobId));
    detail = service.get(experiment.id)!;
    const test = detail.trials.find((trial) => trial.role === 'OOS')!;
    const request = JSON.parse(queue.getJob(test.jobId!)!.requestJson) as BacktestRequest;
    expect(request).toEqual({ ...source, period: { from: '2023-01-01', to: '2024-01-01' } });
    complete(test.jobId!);
    await until(() => service.get(experiment.id)!.status === 'COMPLETED');
    expect(queue.listTopLevelJobs().map((job) => job.id)).toEqual([sourceId]);
    expect(new PreparationReferenceService(database).collect()).toBe(0);
    expect(service.delete(experiment.id)).toBe(true);
    expect(queue.getJob(sourceId)).not.toBeNull();
    expect(queue.getJob(test.jobId!)).toBeNull();
  });

  it('모든 IS 후보가 끝난 뒤 선택하며 OOS 성과는 선택에 관여하지 않는다', async () => {
    const experiment = service.create(sourceId, optimized);
    await until(() => service.get(experiment.id)!.trials.filter((trial) => trial.role === 'TRAIN' && trial.jobId).length === 2);
    let detail = service.get(experiment.id)!;
    const trains = detail.trials.filter((trial) => trial.role === 'TRAIN');
    complete(trains.find((trial) => trial.candidate === 1)!.jobId!, metrics(3));
    await service.pump();
    expect(service.get(experiment.id)!.trials.find((trial) => trial.role === 'OOS')!.parameters).toBeNull();
    complete(trains.find((trial) => trial.candidate === 0)!.jobId!, metrics(1));
    await until(() => service.get(experiment.id)!.trials.filter((trial) => trial.role !== 'TRAIN' && trial.jobId).length === 2);
    detail = service.get(experiment.id)!;
    const test = detail.trials.find((trial) => trial.role === 'OOS')!;
    const baseline = detail.trials.find((trial) => trial.role === 'BASELINE')!;
    expect(test.parameters).toEqual({ window: 20 });
    expect(baseline.parameters).toEqual(source.parameters);
    complete(test.jobId!, metrics(-10));
    complete(baseline.jobId!, metrics(10));
    await until(() => service.get(experiment.id)!.status === 'COMPLETED');
    expect(service.get(experiment.id)!.trials.find((trial) => trial.role === 'OOS')!.candidate).toBe(1);
  });

  it('재시작·중복 pump 후에도 이미 생성한 후보 작업을 중복 실행하지 않는다', async () => {
    const experiment = service.create(sourceId, optimized);
    await until(() => service.get(experiment.id)!.trials.filter((trial) => trial.jobId).length === 2);
    const ids = service.get(experiment.id)!.trials.map((trial) => trial.jobId);
    await service.stop();
    service = new PeriodValidationService(deps);
    await Promise.all([service.pump(), service.pump(), service.pump()]);
    expect(service.get(experiment.id)!.trials.map((trial) => trial.jobId)).toEqual(ids);
    expect(queue.listJobs()).toHaveLength(3);
  });

  it('서로 다른 복구 인스턴스가 동시에 제출해도 같은 후보는 한 번만 생성한다', async () => {
    const experiment = service.create(sourceId, optimized);
    await until(() => database.db.select().from(backtestValidations).where(eq(backtestValidations.id, experiment.id)).get()?.phase === 'TRAIN');
    const other = new PeriodValidationService(deps);
    try {
      await Promise.all([service.pump(), other.pump()]);
      expect(service.get(experiment.id)!.trials.filter((trial) => trial.jobId)).toHaveLength(1);
      expect(queue.listJobs()).toHaveLength(2);
    } finally { await other.stop(); }
  });

  it('동시 복구가 아직 없는 준비 작업을 중복 생성하지 않는다', async () => {
    service.create(sourceId, optimized);
    const other = new PeriodValidationService(deps);
    try {
      await Promise.all([service.pump(), other.pump()]);
      expect(preparationSequence).toBe(1);
    } finally { await other.stop(); }
  });

  it('종료 알림은 반복 조회와 pump에도 한 번만 발생한다', async () => {
    deps.onFinished = vi.fn();
    const experiment = service.create(sourceId, { mode: 'HOLDOUT', splitDate: '2023-01-01' });
    for (let i = 0; i < 40 && service.get(experiment.id)!.status === 'ACTIVE'; i += 1) {
      await service.pump();
      for (const trial of service.get(experiment.id)!.trials.filter((trial) => trial.status === 'QUEUED')) complete(trial.jobId!);
    }
    await service.pump();
    service.get(experiment.id);
    expect(deps.onFinished).toHaveBeenCalledTimes(1);
    expect(deps.onFinished).toHaveBeenCalledWith(expect.objectContaining({ status: 'COMPLETED' }));
  });

  it('조건을 만족하는 후보가 없으면 회차를 건너뛰지 않고 실패한다', async () => {
    const experiment = service.create(sourceId, optimized);
    await until(() => service.get(experiment.id)!.trials.filter((trial) => trial.jobId).length === 2);
    for (const trial of service.get(experiment.id)!.trials.filter((trial) => trial.role === 'TRAIN')) complete(trial.jobId!, metrics(1, 0));
    await service.pump();
    expect(service.get(experiment.id)).toMatchObject({ status: 'FAILED', error: expect.stringContaining('만족하는 후보가 없습니다') });
    expect(service.get(experiment.id)!.trials.filter((trial) => trial.role !== 'TRAIN').every((trial) => trial.jobId === null)).toBe(true);
  });

  it('데이터 revision이 바뀌면 기존 후보를 다른 데이터로 이어 비교하지 않는다', async () => {
    const experiment = service.create(sourceId, optimized);
    await until(() => service.get(experiment.id)!.trials.some((trial) => trial.jobId));
    database.sqlite.exec('UPDATE preparation_data_revision SET revision = revision + 1');
    await service.pump();
    await service.pump();
    expect(service.get(experiment.id)).toMatchObject({ status: 'FAILED', error: expect.stringContaining('데이터가 변경') });
    expect(service.get(experiment.id)!.trials.filter((trial) => trial.jobId)).toHaveLength(1);
  });

  it('서버의 실행 버전이 달라지거나 하위 작업이 중단되면 실패한다', async () => {
    const experiment = service.create(sourceId, optimized);
    await until(() => service.get(experiment.id)!.trials.some((trial) => trial.jobId));
    const jobId = service.get(experiment.id)!.trials.find((trial) => trial.jobId)!.jobId!;
    queue.setStatus(jobId, 'INTERRUPTED');
    await service.pump();
    expect(service.get(experiment.id)!.status).toBe('FAILED');
    const another = service.create(sourceId, optimized);
    database.db.update(backtestValidations).set({ engineVersion: 'old' }).where(eq(backtestValidations.id, another.id)).run();
    await service.pump();
    expect(service.get(another.id)).toMatchObject({ status: 'FAILED', error: expect.stringContaining('버전') });
  });

  it('제출 검증을 기다리는 동안 취소하면 새 작업을 생성하지 않는다', async () => {
    const experiment = service.create(sourceId, optimized);
    await until(() => database.db.select().from(backtestValidations).where(eq(backtestValidations.id, experiment.id)).get()?.phase === 'TRAIN');
    let resume!: () => void;
    const gate = new Promise<void>((resolve) => { resume = resolve; });
    const original = deps.buildEnqueue;
    deps.buildEnqueue = async (...args) => { await gate; return original(...args); };
    const pumping = service.pump();
    service.cancel(experiment.id);
    resume();
    await pumping;
    await service.pump();
    expect(service.get(experiment.id)!.status).toBe('CANCELLED');
    expect(queue.listJobs()).toHaveLength(1);
  });

  it('HTTP 인증·미리보기·생성·취소·삭제 경로가 같은 실험 계약을 따른다', async () => {
    const app = Fastify();
    registerPeriodValidationRoutes(app, deps, async (request, reply) => {
      if (request.headers.authorization !== 'test-session') await reply.code(401).send({ error: '로그인이 필요합니다.' });
    });
    await app.ready();
    try {
      const url = `/backtests/${sourceId}/validations`;
      expect((await app.inject({ method: 'POST', url: `${url}/preview`, payload: optimized })).statusCode).toBe(401);
      const headers = { authorization: 'test-session' };
      const preview = await app.inject({ method: 'POST', url: `${url}/preview`, headers, payload: optimized });
      expect(preview.statusCode).toBe(200);
      expect(preview.json().plan.totalRuns).toBe(4);
      const invalid = await app.inject({ method: 'POST', url, headers, payload: { ...optimized, optimization: { ...optimization, axes: [{ key: 'unknown', values: [1, 2] }] } } });
      expect(invalid.statusCode).toBe(400);
      const created = await app.inject({ method: 'POST', url, headers, payload: optimized });
      expect(created.statusCode).toBe(201);
      const id = created.json().experiment.id as string;
      expect((await app.inject({ method: 'DELETE', url: `/backtest-validations/${id}`, headers })).statusCode).toBe(409);
      const cancelled = await app.inject({ method: 'POST', url: `/backtest-validations/${id}/cancel`, headers });
      expect(cancelled.statusCode).toBe(200);
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const result = await app.inject({ method: 'GET', url: `/backtest-validations/${id}`, headers });
        if (result.json().experiment.status === 'CANCELLED') break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const removed = await app.inject({ method: 'DELETE', url: `/backtest-validations/${id}`, headers });
      expect(removed.statusCode).toBe(204);
      expect((await app.inject({ method: 'GET', url, headers })).json().experiments).toEqual([]);
      expect(queue.getJob(sourceId)).not.toBeNull();
    } finally { await app.close(); }
  });

  it('워크포워드는 회차마다 새로 최적화하고 모든 구간을 독립 실행한다', async () => {
    const experiment = service.create(sourceId, { mode: 'WALK_FORWARD', trainMonths: 36, testMonths: 6, optimization });
    for (let i = 0; i < 80 && service.get(experiment.id)!.status === 'ACTIVE'; i += 1) {
      await service.pump();
      for (const trial of service.get(experiment.id)!.trials.filter((trial) => trial.status === 'QUEUED')) {
        complete(trial.jobId!, metrics(trial.candidate === trial.fold ? 3 : 1));
      }
    }
    const detail = service.get(experiment.id)!;
    expect(detail.status).toBe('COMPLETED');
    expect(detail.trials.filter((trial) => trial.role === 'OOS').map((trial) => trial.candidate)).toEqual([0, 1]);
    expect(detail.trials).toHaveLength(8);
    for (const trial of detail.trials) {
      const request = JSON.parse(queue.getJob(trial.jobId!)!.requestJson) as BacktestRequest;
      expect(request.capital).toEqual(source.capital);
      expect(request.randomSeed).toBe(source.randomSeed);
    }
  });
});
