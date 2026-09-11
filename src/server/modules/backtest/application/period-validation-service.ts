import { PreparationExecutionBusyError } from './backtest-preparation-execution.js';
import { and, asc, eq, inArray } from 'drizzle-orm';
import {
  buildPeriodValidationPlan, periodValidationConfigSchema, selectValidationCandidate,
  type PeriodValidationConfig, type PeriodValidationDto, type PeriodValidationPlan,
  type ValidationMetrics, type ValidationRole, type ValidationStatus,
} from '../../../../shared/schemas/period-validation.js';
import { backtestRequestSchema, type BacktestRequest } from '../../../../shared/schemas/backtest-request.js';
import type { DatabaseHandle } from '../../../shared/db/database.js';
import { backtestPreparationJobs, backtestValidations, backtestValidationTrials } from '../../../shared/db/schema.js';
import type { Clock } from '../../../shared/clock.js';
import { newId } from '../../../shared/ids.js';
import { readGitCommitSha } from '../../../shared/build-info.js';
import type { StrategyRegistry } from '../../strategy/application/strategy-registry.js';
import { strategySourceHash } from '../../strategy/application/strategy-source-hash.js';
import { ENGINE_VERSION } from '../domain/engine.js';
import type { BacktestJobRow, JobQueue } from './job-queue.js';
import type { BacktestPreparationOrchestrator, BacktestUniversePreview } from './backtest-preparation-orchestrator.js';
import type { ResultsService } from './results-service.js';
import { PreparationPreviewCache } from './preparation-preview-cache.js';
import { PreparationReferenceService } from './preparation-reference-service.js';

type Experiment = typeof backtestValidations.$inferSelect;
type Trial = typeof backtestValidationTrials.$inferSelect;

export interface PeriodValidationDeps {
  database: DatabaseHandle;
  clock: Clock;
  queue: JobQueue;
  results: ResultsService;
  strategies: StrategyRegistry;
  preparation: BacktestPreparationOrchestrator;
  validateRequest(request: BacktestRequest): readonly string[];
  buildEnqueue(request: BacktestRequest, preview: BacktestUniversePreview): Promise<(() => BacktestJobRow | null) | null>;
  cancelJob(jobId: string): void;
  onFinished?(experiment: PeriodValidationDto): void;
}

/** 후보 선택과 실행 순서를 DB에 보관해 브라우저 종료·서버 재시작 후에도 이어간다. */
export class PeriodValidationService {
  private pumping: Promise<void> | null = null;
  private stopping = false;
  private readonly cache: PreparationPreviewCache;

  constructor(private readonly deps: PeriodValidationDeps) {
    this.cache = new PreparationPreviewCache(deps.database);
  }

  plan(sourceJobId: string, rawConfig: unknown) {
    const sourceJob = this.deps.queue.getJob(sourceJobId);
    if (!sourceJob || sourceJob.status !== 'COMPLETED') throw new Error('완료된 백테스트에서 검증을 시작할 수 있습니다.');
    const source = backtestRequestSchema.parse(JSON.parse(sourceJob.requestJson));
    const config = periodValidationConfigSchema.parse(rawConfig);
    const strategy = this.deps.strategies.get(source.strategyId);
    if (!strategy) throw new Error('전략을 찾을 수 없습니다.');
    const run = this.deps.results.getRun(sourceJobId);
    if (!run || run.strategyVersion !== strategy.version || run.strategySourceHash !== strategySourceHash(strategy)) {
      throw new Error('원본과 현재 전략 버전이 다릅니다. 현재 전략으로 백테스트를 다시 실행하세요.');
    }
    if (config.mode !== 'HOLDOUT') {
      const schema = this.deps.strategies.getParameterJsonSchema(source.strategyId);
      const properties = schema?.properties as Record<string, { type?: string }> | undefined;
      for (const axis of config.optimization.axes) {
        if (!['number', 'integer'].includes(properties?.[axis.key]?.type ?? '')) {
          throw new Error(`숫자 매개변수만 탐색할 수 있습니다: ${axis.key}`);
        }
      }
    }
    const plan = buildPeriodValidationPlan(source, config);
    for (const parameters of [...plan.candidates, source.parameters]) {
      const validated = this.deps.strategies.validateParameters(source.strategyId, parameters);
      if (!validated.ok) throw new Error(validated.error);
      for (const fold of plan.folds) {
        for (const period of [fold.train, fold.test]) {
          const errors = this.deps.validateRequest({ ...source, parameters, period });
          if (errors.length) throw new Error(errors[0]);
        }
      }
    }
    return { source, config, plan, strategy };
  }

  create(sourceJobId: string, rawConfig: unknown): PeriodValidationDto {
    const { source, config, plan, strategy } = this.plan(sourceJobId, rawConfig);
    const id = newId('val');
    this.deps.database.sqlite.transaction(() => {
      if (this.deps.queue.getJob(sourceJobId)?.status !== 'COMPLETED') throw new Error('원본 백테스트 상태가 변경됐습니다.');
      const active = this.deps.database.db.select({ id: backtestValidations.id }).from(backtestValidations)
        .where(inArray(backtestValidations.status, ['ACTIVE', 'CANCELLING'])).all();
      if (active.length >= 5) throw new Error('진행 중인 검증 실험은 최대 5개입니다.');
      this.deps.database.db.insert(backtestValidations).values({
        id, sourceJobId, requestJson: JSON.stringify(source), configJson: JSON.stringify(config),
        planJson: JSON.stringify(plan), strategyVersion: strategy.version,
        strategySourceHash: strategySourceHash(strategy), engineVersion: ENGINE_VERSION,
        gitCommitSha: readGitCommitSha(), status: 'ACTIVE', createdAtMs: this.deps.clock.now(),
      }).run();
      for (const fold of plan.folds) {
        for (const [candidate, parameters] of plan.candidates.entries()) {
          this.deps.database.db.insert(backtestValidationTrials).values({
            id: newId('vtr'), validationId: id, fold: fold.ordinal, role: 'TRAIN', candidate,
            requestJson: JSON.stringify({ ...source, parameters, period: fold.train }),
          }).run();
        }
        this.deps.database.db.insert(backtestValidationTrials).values({
          id: newId('vtr'), validationId: id, fold: fold.ordinal, role: 'OOS',
        }).run();
        if (config.mode !== 'HOLDOUT') {
          this.deps.database.db.insert(backtestValidationTrials).values({
            id: newId('vtr'), validationId: id, fold: fold.ordinal, role: 'BASELINE',
            requestJson: JSON.stringify({ ...source, period: fold.test }),
          }).run();
        }
      }
    }).immediate();
    return this.get(id)!;
  }

  list(sourceJobId: string): PeriodValidationDto[] {
    return this.deps.database.db.select({ id: backtestValidations.id }).from(backtestValidations)
      .where(eq(backtestValidations.sourceJobId, sourceJobId)).orderBy(asc(backtestValidations.createdAtMs))
      .all().map(({ id }) => this.get(id)!);
  }

  get(id: string): PeriodValidationDto | null {
    const experiment = this.row(id);
    if (!experiment) return null;
    const plan = JSON.parse(experiment.planJson) as PeriodValidationPlan;
    const source = JSON.parse(experiment.requestJson) as BacktestRequest;
    return {
      id, sourceJobId: experiment.sourceJobId, status: experiment.status as ValidationStatus,
      config: JSON.parse(experiment.configJson) as PeriodValidationConfig, plan,
      initialCash: source.capital.initialCash, createdAtMs: experiment.createdAtMs, error: experiment.error,
      trials: this.trials(id).map((trial) => {
        const request = trial.requestJson ? JSON.parse(trial.requestJson) as BacktestRequest : null;
        const job = trial.jobId ? this.deps.queue.getJob(trial.jobId) : null;
        const prep = trial.preparationJobId ? this.deps.preparation.get(trial.preparationJobId) : null;
        return {
          id: trial.id, fold: trial.fold, role: trial.role as ValidationRole, candidate: trial.candidate,
          period: request?.period ?? plan.folds[trial.fold]!.test, parameters: request?.parameters ?? null,
          jobId: trial.jobId,
          status: job?.status ?? (experiment.status === 'ACTIVE'
            ? (prep && prep.status !== 'COMPLETED' ? `PREPARATION_${prep.status}` : 'PENDING')
            : experiment.status === 'COMPLETED' ? 'MISSING' : 'SKIPPED'),
          progress: job?.totalBars ? Math.min(100, (job.progressBars ?? 0) / job.totalBars * 100) : null,
          error: job?.error ?? prep?.error ?? null,
          metrics: job?.status === 'COMPLETED' ? this.metrics(job.id) : null,
          benchmarkReturnPct: job?.status === 'COMPLETED' ? this.deps.results.getBenchmark(job.id)?.totalReturnPct ?? null : null,
        };
      }),
    };
  }

  referencesJob(jobId: string): boolean {
    return this.deps.database.db.select({ id: backtestValidationTrials.id }).from(backtestValidationTrials)
      .where(eq(backtestValidationTrials.jobId, jobId)).get() !== undefined;
  }

  cancel(id: string): PeriodValidationDto | null {
    this.deps.database.db.update(backtestValidations).set({ status: 'CANCELLING' })
      .where(and(eq(backtestValidations.id, id), eq(backtestValidations.status, 'ACTIVE'))).run();
    return this.get(id);
  }

  delete(id: string): boolean {
    return this.deps.database.sqlite.transaction(() => {
      const row = this.row(id);
      if (!row) return false;
      if (row.status === 'ACTIVE' || row.status === 'CANCELLING') throw new Error('검증 실험을 취소한 뒤 삭제하세요.');
      const trials = this.trials(id);
      for (const trial of trials) {
        if (trial.jobId && this.deps.database.sqlite.prepare(`
          SELECT 1 FROM backtest_validations WHERE source_job_id = ?
          UNION ALL SELECT 1 FROM backtest_clone_batches WHERE source_job_id = ? LIMIT 1
        `).get(trial.jobId, trial.jobId)) throw new Error('하위 백테스트에서 만든 실험을 먼저 삭제하세요.');
      }
      if (trials.some((trial) => trial.jobId && !this.deps.queue.isTerminal(this.deps.queue.getJob(trial.jobId)?.status ?? 'FAILED'))) {
        throw new Error('실행 중인 하위 백테스트가 종료된 뒤 삭제하세요.');
      }
      this.deps.database.db.delete(backtestValidations).where(eq(backtestValidations.id, id)).run();
      for (const trial of trials) if (trial.jobId) this.deps.queue.deleteJob(trial.jobId);
      new PreparationReferenceService(this.deps.database).collect();
      return true;
    }).immediate();
  }

  pump(): Promise<void> {
    if (this.stopping) return Promise.resolve();
    if (this.pumping) return this.pumping;
    this.pumping = this.tick().finally(() => { this.pumping = null; });
    return this.pumping;
  }

  async stop(): Promise<void> {
    this.stopping = true;
    await this.pumping;
  }

  private row(id: string): Experiment | undefined {
    return this.deps.database.db.select().from(backtestValidations).where(eq(backtestValidations.id, id)).get();
  }

  private trials(id: string): Trial[] {
    return this.deps.database.db.select().from(backtestValidationTrials)
      .where(eq(backtestValidationTrials.validationId, id))
      .orderBy(asc(backtestValidationTrials.fold), asc(backtestValidationTrials.id)).all();
  }

  private active(id: string): boolean {
    return !this.stopping && this.row(id)?.status === 'ACTIVE';
  }

  private metrics(jobId: string): ValidationMetrics | null {
    return this.deps.results.getMetrics(jobId) as unknown as ValidationMetrics | null;
  }

  private samePhase(experiment: Experiment): boolean {
    const current = this.row(experiment.id);
    return !this.stopping && current?.status === 'ACTIVE'
      && current.fold === experiment.fold && current.phase === experiment.phase;
  }

  private finish(id: string, status: 'COMPLETED' | 'FAILED' | 'CANCELLED'): void {
    const changed = this.deps.database.db.update(backtestValidations).set({ status })
      .where(and(eq(backtestValidations.id, id), inArray(backtestValidations.status, ['ACTIVE', 'CANCELLING']))).run();
    if (changed.changes > 0) this.deps.onFinished?.(this.get(id)!);
  }

  private assertVersion(experiment: Experiment): void {
    const request = JSON.parse(experiment.requestJson) as BacktestRequest;
    const strategy = this.deps.strategies.get(request.strategyId);
    if (!strategy || strategy.version !== experiment.strategyVersion
      || strategySourceHash(strategy) !== experiment.strategySourceHash
      || ENGINE_VERSION !== experiment.engineVersion || readGitCommitSha() !== experiment.gitCommitSha) {
      throw new Error('실험 도중 전략 또는 실행 버전이 변경됐습니다. 새 실험을 생성하세요.');
    }
  }

  private assertRevision(experiment: Experiment): void {
    if (experiment.dataRevision !== this.cache.revision()) {
      throw new Error('같은 회차를 비교하는 도중 시장·재무 데이터가 변경됐습니다. 서로 다른 데이터의 성과를 비교하지 않도록 실험을 중단했습니다.');
    }
  }

  private async tick(): Promise<void> {
    const experiments = this.deps.database.db.select().from(backtestValidations)
      .where(inArray(backtestValidations.status, ['ACTIVE', 'CANCELLING']))
      .orderBy(asc(backtestValidations.createdAtMs)).all();
    for (const experiment of experiments.filter((row) => row.status === 'CANCELLING')) this.finishCancellation(experiment);
    const experiment = experiments.find((row) => row.status === 'ACTIVE');
    if (!experiment || !this.active(experiment.id)) return;
    try {
      this.assertVersion(experiment);
      const training = experiment.phase.endsWith('TRAIN');
      const group = this.trials(experiment.id).filter((trial) => trial.fold === experiment.fold
        && (training ? trial.role === 'TRAIN' : trial.role !== 'TRAIN'));
      if (experiment.phase.startsWith('PREPARING_')) {
        await this.prepareGroup(experiment, group, training);
      } else {
        await this.runGroup(experiment, group, training);
      }
    } catch (error) {
      if (error instanceof PreparationExecutionBusyError) return;
      if (!this.samePhase(experiment)) return;
      this.deps.database.db.update(backtestValidations).set({
        status: 'CANCELLING', error: error instanceof Error ? error.message : String(error),
      }).where(eq(backtestValidations.id, experiment.id)).run();
      this.finishCancellation(this.row(experiment.id)!);
    }
  }

  private finishCancellation(experiment: Experiment): void {
    let pending = false;
    for (const trial of this.trials(experiment.id)) {
      if (!trial.jobId) continue;
      const job = this.deps.queue.getJob(trial.jobId);
      if (job && !this.deps.queue.isTerminal(job.status)) {
        this.deps.cancelJob(job.id);
        pending = true;
      }
    }
    // 다른 실험·위저드가 함께 쓰는 준비 작업은 취소하지 않는다.
    for (const trial of this.trials(experiment.id)) {
      if (!trial.preparationJobId) continue;
      const prep = this.deps.preparation.get(trial.preparationJobId);
      if (!prep || ['COMPLETED', 'FAILED', 'CANCELLED'].includes(prep.status)) continue;
      const shared = this.deps.database.sqlite.prepare(`
        SELECT 1 FROM backtest_validation_trials WHERE preparation_job_id = ? AND validation_id <> ?
        UNION ALL SELECT 1 FROM preparation_wizard_references WHERE preparation_job_id = ?
        UNION ALL SELECT 1 FROM backtest_jobs WHERE preparation_job_id = ?
        UNION ALL SELECT 1 FROM backtest_clone_batches WHERE preparation_job_id = ? LIMIT 1
      `).get(prep.id, experiment.id, prep.id, prep.id, prep.id);
      if (!shared) {
        this.deps.preparation.cancel(prep.id);
        pending = true;
      }
    }
    if (!pending) this.finish(experiment.id, experiment.error ? 'FAILED' : 'CANCELLED');
  }

  private attachPreparation(trial: Trial, preparationJobId: string): void {
    this.deps.database.db.update(backtestValidationTrials).set({ preparationJobId })
      .where(eq(backtestValidationTrials.id, trial.id)).run();
    this.deps.database.db.update(backtestPreparationJobs).set({ lifecycleManaged: true })
      .where(eq(backtestPreparationJobs.id, preparationJobId)).run();
    new PreparationReferenceService(this.deps.database).collect();
  }

  private async prepareGroup(experiment: Experiment, group: Trial[], training: boolean): Promise<void> {
    for (const trial of group) {
      const request = JSON.parse(trial.requestJson!) as BacktestRequest;
      if (trial.preparationJobId) {
        const job = this.deps.preparation.get(trial.preparationJobId);
        if (!job) throw new Error('검증 실험의 준비 작업이 삭제됐습니다.');
        if (job.status === 'FAILED' || job.status === 'CANCELLED') throw new Error(job.error ?? '데이터 준비가 종료됐습니다.');
        if (job.status !== 'COMPLETED') return;
        if (this.deps.preparation.getFreshPreviewDetails(request, trial.preparationJobId)) continue;
      }
      const revision = this.cache.beginValidation();
      const ready = this.deps.preparation.getFreshPreviewDetails(request)
        ?? await this.deps.preparation.getReadyPreviewDetails(request);
      if (!this.active(experiment.id)) return;
      this.deps.database.sqlite.transaction(() => {
        if (!this.samePhase(experiment)) return;
        const currentTrial = this.deps.database.db.select().from(backtestValidationTrials)
          .where(eq(backtestValidationTrials.id, trial.id)).get();
        if (!currentTrial || currentTrial.preparationJobId !== trial.preparationJobId) return;
        if (currentTrial.preparationJobId && this.cache.isFresh(currentTrial.preparationJobId)) return;
        if (ready && revision === this.cache.revision()) {
          const id = ready.preview.preparationJobId!;
          this.cache.store(id, revision, [...ready.fundamentalSymbols]);
          this.attachPreparation(trial, id);
        } else {
          const job = this.deps.preparation.start(request);
          this.attachPreparation(trial, job.id);
        }
      }).immediate();
      return;
    }
    this.deps.database.sqlite.transaction(() => {
      if (!this.samePhase(experiment)) return;
      const revision = this.cache.beginValidation();
      if (!group.every((trial) => trial.preparationJobId && this.cache.isFresh(trial.preparationJobId))) return;
      this.deps.database.db.update(backtestValidations).set({ phase: training ? 'TRAIN' : 'OOS', dataRevision: revision })
        .where(eq(backtestValidations.id, experiment.id)).run();
    }).immediate();
  }

  private async runGroup(experiment: Experiment, group: Trial[], training: boolean): Promise<void> {
    this.assertRevision(experiment);
    for (const trial of group) {
      if (!trial.jobId) continue;
      const job = this.deps.queue.getJob(trial.jobId);
      if (!job || (this.deps.queue.isTerminal(job.status) && job.status !== 'COMPLETED')) throw new Error(job?.error ?? '하위 백테스트가 정상 완료되지 않았습니다.');
      if (job.status === 'COMPLETED') {
        const run = this.deps.results.getRun(job.id);
        const metrics = this.metrics(job.id);
        if (!run || run.strategySourceHash !== experiment.strategySourceHash || run.engineVersion !== experiment.engineVersion
          || run.gitCommitSha !== experiment.gitCommitSha) throw new Error('하위 백테스트의 실행 버전이 실험과 다릅니다.');
        if (!metrics || !Number.isFinite(metrics.totalReturnPct)) throw new Error('하위 백테스트의 성과 지표가 없습니다.');
      }
    }
    const pending = group.find((trial) => !trial.jobId);
    if (pending) {
      const request = JSON.parse(pending.requestJson!) as BacktestRequest;
      const preview = this.deps.preparation.getFreshPreviewDetails(request, pending.preparationJobId!)?.preview;
      if (!preview) throw new Error('고정한 준비 결과가 더 이상 유효하지 않습니다.');
      const enqueue = await this.deps.buildEnqueue(request, preview);
      if (!enqueue || !this.active(experiment.id)) return;
      this.deps.database.sqlite.transaction(() => {
        if (!this.samePhase(experiment)) return;
        const currentTrial = this.deps.database.db.select().from(backtestValidationTrials)
          .where(eq(backtestValidationTrials.id, pending.id)).get();
        if (!currentTrial || currentTrial.jobId !== null) return;
        this.assertVersion(experiment);
        this.assertRevision(experiment);
        const job = enqueue();
        if (!job) return;
        this.deps.database.db.update(backtestValidationTrials).set({ jobId: job.id })
          .where(eq(backtestValidationTrials.id, pending.id)).run();
      }).immediate();
      return;
    }
    if (!group.every((trial) => this.deps.queue.getJob(trial.jobId!)?.status === 'COMPLETED')) return;
    const config = JSON.parse(experiment.configJson) as PeriodValidationConfig;
    const plan = JSON.parse(experiment.planJson) as PeriodValidationPlan;
    if (training) {
      const candidate = config.mode === 'HOLDOUT' ? 0 : selectValidationCandidate(group.map((trial) => ({
        candidate: trial.candidate!, metrics: this.metrics(trial.jobId!)!,
      })), config.optimization);
      if (candidate === null) throw new Error(`${experiment.fold + 1}회차 IS에서 선택 조건을 만족하는 후보가 없습니다. 이 회차를 제외하지 않고 실험을 중단했습니다.`);
      const source = JSON.parse(experiment.requestJson) as BacktestRequest;
      this.deps.database.sqlite.transaction(() => {
        if (!this.samePhase(experiment)) return;
        this.assertVersion(experiment);
        this.assertRevision(experiment);
        this.deps.database.db.update(backtestValidationTrials).set({ candidate, requestJson: JSON.stringify({
          ...source, parameters: plan.candidates[candidate], period: plan.folds[experiment.fold]!.test,
        }) }).where(and(eq(backtestValidationTrials.validationId, experiment.id),
          eq(backtestValidationTrials.fold, experiment.fold), eq(backtestValidationTrials.role, 'OOS'))).run();
        this.deps.database.db.update(backtestValidations).set({ phase: 'PREPARING_OOS', dataRevision: null })
          .where(eq(backtestValidations.id, experiment.id)).run();
      }).immediate();
    } else {
      this.deps.database.sqlite.transaction(() => {
        if (!this.samePhase(experiment)) return;
        this.assertVersion(experiment);
        this.assertRevision(experiment);
        if (experiment.fold + 1 === plan.folds.length) this.finish(experiment.id, 'COMPLETED');
        else this.deps.database.db.update(backtestValidations)
          .set({ fold: experiment.fold + 1, phase: 'PREPARING_TRAIN', dataRevision: null })
          .where(eq(backtestValidations.id, experiment.id)).run();
      }).immediate();
    }
  }
}
