import { createHash } from 'node:crypto';
import { asc, desc, eq, sql } from 'drizzle-orm';
import type { BacktestRequest, BacktestPeriod } from '../../../../shared/schemas/backtest-request.js';
import type { UniverseRule } from '../../../../shared/schemas/universe-rule.js';
import type { Clock } from '../../../shared/clock.js';
import type { DatabaseHandle } from '../../../shared/db/database.js';
import { backtestPreparationJobs } from '../../../shared/db/schema.js';
import { newId } from '../../../shared/ids.js';
import type { Logger } from '../../../shared/logger.js';
import type { FactSyncService, FactSyncReport } from '../../facts/application/fact-sync-service.js';
import type { FactSyncWorkUnit } from '../../facts/domain/sync-plan.js';
import type { CandleCoverageService } from '../../market-data/application/candle-coverage-service.js';
import type { SymbolMasterService } from '../../market-data/application/symbol-master-service.js';
import { addCalendarDays, kstDateOf } from '../../market-data/domain/kst-date.js';
import type { SymbolService } from '../../market-data/application/symbol-service.js';
import type { StrategyRegistry } from '../../strategy/application/strategy-registry.js';
import type { AnyTradingStrategy } from '../../strategy/domain/strategy.js';
import {
  backtestPreparationRequestHash,
  buildBacktestPreparationPlan,
  type BacktestPreparationPlan,
} from './backtest-preparation-plan.js';
import type {
  RebalanceDiagnostic,
  UniverseDataNeed,
  UniverseResolveAttempt,
  UniverseRuleResolver,
  UniverseScheduleEntry,
} from './universe-rule-resolver.js';

export type PreparationStatus =
  | 'QUEUED'
  | 'RUNNING'
  | 'WAITING_DAILY_QUOTA'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED';

export type PreparationPhase =
  | 'MARKET_DATA'
  | 'RESOLVING_STAGES'
  | 'SYNCING_FACTS'
  | 'FINALIZING';

export interface PreparationInput {
  readonly universeRule: UniverseRule;
  readonly period: BacktestPeriod;
  readonly strategyId: string;
  readonly parameters: Record<string, unknown>;
}

export interface BacktestPreparationJobDto {
  readonly id: string;
  readonly requestHash: string;
  readonly status: PreparationStatus;
  readonly phase: PreparationPhase;
  readonly doneSymbols: number;
  readonly totalSymbols: number;
  readonly savedFacts: number;
  readonly gapCount: number;
  readonly nextResumeAtMs: number | null;
  readonly error: string | null;
}

export interface BacktestUniversePreview {
  readonly schedule: readonly UniverseScheduleEntry[];
  readonly diagnostics: readonly RebalanceDiagnostic[];
  readonly stages: UniverseRule['stages'];
  readonly unionSymbols: readonly string[];
  readonly scheduleHash: string;
  readonly uncoveredDates: readonly string[];
  readonly periodCovered: boolean;
  readonly missingCandleSymbols: readonly string[];
}

type PreparationJobRow = typeof backtestPreparationJobs.$inferSelect;
type PreparationJobPatch = Partial<typeof backtestPreparationJobs.$inferInsert>;

const ACTIVE_STATUSES: readonly PreparationStatus[] = [
  'QUEUED', 'RUNNING', 'WAITING_DAILY_QUOTA',
];
const TERMINAL_STATUSES: readonly PreparationStatus[] = ['COMPLETED', 'FAILED', 'CANCELLED'];

const ALLOWED_TRANSITIONS: Readonly<Record<PreparationStatus, readonly PreparationStatus[]>> = {
  QUEUED: ['RUNNING'],
  RUNNING: ['WAITING_DAILY_QUOTA', 'COMPLETED', 'FAILED', 'CANCELLED'],
  WAITING_DAILY_QUOTA: ['QUEUED', 'CANCELLED'],
  COMPLETED: [],
  FAILED: [],
  CANCELLED: [],
};

const EMPTY_NEEDS: UniverseDataNeed = {
  factSymbols: [],
  actionSymbols: [],
  priceSymbols: [],
  selectionMetricDates: [],
  priceRange: null,
};

export interface BacktestPreparationOrchestratorDeps {
  readonly database: DatabaseHandle;
  readonly resolver: Pick<UniverseRuleResolver, 'resolveOrDescribeNeeds' | 'isPeriodCovered'>;
  readonly factSync: Pick<FactSyncService, 'sync' | 'syncCorporateActions'>;
  readonly symbolMaster: Pick<
    SymbolMasterService,
    'ensureTradingDay' | 'ensureSelectionMetrics' | 'ingestDate' | 'isRangeCovered'
  >;
  readonly strategies: Pick<StrategyRegistry, 'get'>;
  readonly symbolService: Pick<SymbolService, 'exists' | 'addSymbol'>;
  readonly candleCoverage?: Pick<CandleCoverageService, 'getCoverage'>;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly dartDailyCallLimit?: number;
}

/**
 * 준비 작업은 SQLite 행을 큐이자 복구 지점으로 사용하고, 한 번에 하나만 실행한다.
 * FactSyncService가 symbol-year 저장 경계를 닫으므로 quota 재개는 항상 INCREMENTAL이다.
 */
export class BacktestPreparationOrchestrator {
  private readonly listeners = new Map<string, Set<(job: BacktestPreparationJobDto) => void>>();
  private readonly resumeTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private runnerActive = false;
  private stopping = false;
  private readonly dailyLimit: number;

  constructor(private readonly deps: BacktestPreparationOrchestratorDeps) {
    this.dailyLimit = deps.dartDailyCallLimit ?? 40_000;
  }

  start(input: PreparationInput): BacktestPreparationJobDto {
    const strategy = this.requireStrategy(input);
    const requestHash = backtestPreparationRequestHash(input, strategy);
    const existing = this.deps.database.db
      .select()
      .from(backtestPreparationJobs)
      .where(eq(backtestPreparationJobs.requestHash, requestHash))
      .orderBy(desc(backtestPreparationJobs.createdAtMs))
      .all()
      .find((row) => ACTIVE_STATUSES.includes(row.status as PreparationStatus));
    if (existing) return toDto(existing);

    const now = this.deps.clock.now();
    const id = newId('prep');
    this.deps.database.db.insert(backtestPreparationJobs).values({
      id,
      requestHash,
      requestJson: JSON.stringify(input),
      status: 'QUEUED',
      phase: 'MARKET_DATA',
      doneSymbols: 0,
      totalSymbols: 0,
      savedFacts: 0,
      gapCount: 0,
      dartCallsUsed: 0,
      cancelRequested: false,
      createdAtMs: now,
      updatedAtMs: now,
    }).run();
    const created = this.persistAndEmit(id, {});
    if (!created) throw new Error('준비 작업을 저장하지 못했습니다.');
    this.queuePump();
    return created;
  }

  get(jobId: string): BacktestPreparationJobDto | null {
    const row = this.getRow(jobId);
    return row ? toDto(row) : null;
  }

  getPreview(jobId: string): BacktestUniversePreview | null {
    const row = this.getRow(jobId);
    if (!row?.previewJson) return null;
    try {
      return JSON.parse(row.previewJson) as BacktestUniversePreview;
    } catch (error) {
      this.deps.logger.warn(
        { module: 'backtest', event: 'preparation.preview.parse-failed', jobId, err: error },
        'stored preparation preview is invalid',
      );
      return null;
    }
  }

  /** 같은 요청 hash의 완료 결과를 현재 resolver로 다시 확인해 stale preview를 거른다. */
  async getReadyPreview(input: PreparationInput): Promise<BacktestUniversePreview | null> {
    const strategy = this.requireStrategy(input);
    const hash = backtestPreparationRequestHash(input, strategy);
    const completed = this.deps.database.db
      .select()
      .from(backtestPreparationJobs)
      .where(eq(backtestPreparationJobs.requestHash, hash))
      .orderBy(desc(backtestPreparationJobs.createdAtMs))
      .all()
      .find((row) => row.status === 'COMPLETED' && row.previewJson !== null);
    if (!completed) return null;

    const attempt = await this.deps.resolver.resolveOrDescribeNeeds(input.universeRule, input.period);
    if (attempt.kind !== 'READY' || isEmptySchedule(attempt.schedule)) return null;
    const storedPreview = this.getPreview(completed.id);
    const currentPreview = this.buildPreview(input, attempt);
    // request hash가 같아도 종목 마스터·선정 지표가 갱신되면 최종 멤버십은 달라질
    // 수 있다. 이전 union에만 full facts/actions를 준비했으므로 다른 schedule을 완료
    // 결과처럼 돌려주지 않고 새 durable job을 시작하게 한다.
    if (!storedPreview || storedPreview.scheduleHash !== currentPreview.scheduleHash) return null;
    this.registerUniverse(attempt);
    return currentPreview;
  }

  /** 라우트가 DART 미설정 503을 실제 sync 필요 요청에만 적용할 때 쓴다. */
  async needsDart(input: PreparationInput): Promise<boolean> {
    const strategy = this.requireStrategy(input);
    const attempt = await this.deps.resolver.resolveOrDescribeNeeds(input.universeRule, input.period);
    if (attempt.kind === 'NEEDS_DATA') {
      return attempt.needs.factSymbols.length > 0 || attempt.needs.actionSymbols.length > 0;
    }
    const finalSymbols = unionSymbols(attempt.schedule);
    const plan = buildBacktestPreparationPlan({
      request: preparationRequest(input),
      resolutionNeeds: EMPTY_NEEDS,
      finalUniverseSymbols: finalSymbols,
      strategy,
    });
    return plan.financial.symbols.length > 0 || plan.actions.symbols.length > 0;
  }

  cancel(jobId: string): boolean {
    const current = this.getRow(jobId);
    if (!current) return false;
    const status = current.status as PreparationStatus;
    if (TERMINAL_STATUSES.includes(status)) return true;
    if (status === 'WAITING_DAILY_QUOTA') {
      this.clearResumeTimer(jobId);
      this.persistAndEmit(jobId, { status: 'CANCELLED', cancelRequested: true }, ['WAITING_DAILY_QUOTA']);
      return true;
    }
    // QUEUED는 허용 전이표를 지키기 위해 cancelRequested만 남긴다. runner가
    // QUEUED→RUNNING을 확보한 직후 RUNNING→CANCELLED로 닫는다.
    this.persistAndEmit(jobId, { cancelRequested: true }, ['QUEUED', 'RUNNING']);
    this.queuePump();
    return true;
  }

  recoverOrphaned(): void {
    const rows = this.deps.database.db.select().from(backtestPreparationJobs).all();
    for (const row of rows) {
      if (row.status === 'RUNNING') {
        // 복구 전이는 정상 실행 전이표의 유일한 예외다. 죽은 runner를 다시 큐에
        // 올려야 이미 저장된 symbol-year를 INCREMENTAL로 이어받을 수 있다.
        this.persistAndEmit(row.id, { status: 'QUEUED' }, ['RUNNING'], true);
      } else if (row.status === 'WAITING_DAILY_QUOTA') {
        if (row.nextResumeAtMs !== null && row.nextResumeAtMs <= this.deps.clock.now()) {
          this.persistAndEmit(
            row.id,
            { status: 'QUEUED', nextResumeAtMs: null },
            ['WAITING_DAILY_QUOTA'],
          );
        } else if (row.nextResumeAtMs !== null) {
          this.scheduleResume(row.id, row.nextResumeAtMs);
        }
      }
    }
    this.queuePump();
  }

  subscribe(jobId: string, listener: (job: BacktestPreparationJobDto) => void): () => void {
    const listeners = this.listeners.get(jobId) ?? new Set();
    listeners.add(listener);
    this.listeners.set(jobId, listeners);
    const current = this.get(jobId);
    if (current) listener(current);
    return () => {
      const currentListeners = this.listeners.get(jobId);
      currentListeners?.delete(listener);
      if (currentListeners?.size === 0) this.listeners.delete(jobId);
    };
  }

  isTerminal(status: string): boolean {
    return TERMINAL_STATUSES.includes(status as PreparationStatus);
  }

  stop(): void {
    this.stopping = true;
    for (const timer of this.resumeTimers.values()) clearTimeout(timer);
    this.resumeTimers.clear();
    this.listeners.clear();
  }

  private queuePump(): void {
    queueMicrotask(() => this.pump());
  }

  private pump(): void {
    if (this.stopping || this.runnerActive) return;
    const next = this.deps.database.db
      .select({ id: backtestPreparationJobs.id })
      .from(backtestPreparationJobs)
      .where(eq(backtestPreparationJobs.status, 'QUEUED'))
      .orderBy(asc(backtestPreparationJobs.createdAtMs))
      .get();
    if (!next) return;

    const claimed = this.persistAndEmit(
      next.id,
      () => {
        const running = this.deps.database.db
          .select({ id: backtestPreparationJobs.id })
          .from(backtestPreparationJobs)
          .where(eq(backtestPreparationJobs.status, 'RUNNING'))
          .get();
        return running ? null : { status: 'RUNNING', error: null };
      },
      ['QUEUED'],
    );
    if (!claimed || claimed.status !== 'RUNNING') return;

    this.runnerActive = true;
    void this.run(claimed.id)
      .catch((error: unknown) => {
        this.deps.logger.error(
          { module: 'backtest', event: 'preparation.unhandled', jobId: claimed.id, err: error },
          'backtest preparation rejected outside run handler',
        );
      })
      .finally(() => {
        this.runnerActive = false;
        if (!this.stopping) this.queuePump();
      });
  }

  private async run(jobId: string): Promise<void> {
    try {
      const row = this.getRow(jobId);
      if (!row) return;
      const input = JSON.parse(row.requestJson) as PreparationInput;
      const strategy = this.requireStrategy(input);
      if (this.finishCancelledIfRequested(jobId)) return;

      let attempt = await this.resolve(jobId, input);
      const seenNeeds = new Set<string>();
      for (;;) {
        if (this.finishCancelledIfRequested(jobId)) return;
        if (attempt.kind === 'READY') break;
        const signature = JSON.stringify(attempt.needs);
        if (seenNeeds.has(signature)) {
          this.fail(
            jobId,
            '필요 데이터를 모두 조회했지만 유니버스 선정 조건을 해소하지 못했습니다. 데이터 공백과 DART 응답 누락을 확인하세요.',
          );
          return;
        }
        seenNeeds.add(signature);

        const plan = buildBacktestPreparationPlan({
          request: preparationRequest(input),
          resolutionNeeds: attempt.needs,
          strategy,
        });
        const hasMarketWork = attempt.needs.selectionMetricDates.length > 0
          || (plan.price.symbols.length > 0 && attempt.needs.priceRange !== null);
        const hasDartWork = plan.financial.symbols.length > 0 || plan.actions.symbols.length > 0;
        if (!hasMarketWork && !hasDartWork) {
          this.fail(jobId, '준비할 수 있는 데이터 작업이 없어 유니버스 조건을 해소하지 못했습니다.');
          return;
        }
        if (hasMarketWork) {
          await this.syncMarketData(jobId, attempt.needs.selectionMetricDates, plan.price);
          if (this.shouldReturnFromRun(jobId)) return;
        }
        if (hasDartWork) {
          const continued = await this.syncFacts(jobId, plan);
          if (!continued) return;
        }
        attempt = await this.resolve(jobId, input);
      }

      let finalAttempt: UniverseResolveAttempt = attempt;
      if (isEmptySchedule(finalAttempt.schedule)) {
        this.fail(jobId, '모든 리밸런싱 날짜에서 선정된 종목이 없어 유니버스를 만들 수 없습니다. 조건이나 데이터 이력을 확인하세요.');
        return;
      }

      const finalSymbols = unionSymbols(finalAttempt.schedule);
      const finalPlan = buildBacktestPreparationPlan({
        request: preparationRequest(input),
        resolutionNeeds: EMPTY_NEEDS,
        finalUniverseSymbols: finalSymbols,
        strategy,
      });
      if (finalPlan.price.symbols.length > 0) {
        await this.syncMarketData(jobId, [], finalPlan.price);
        if (this.shouldReturnFromRun(jobId)) return;
      }
      if (finalPlan.financial.symbols.length > 0 || finalPlan.actions.symbols.length > 0) {
        const continued = await this.syncFacts(jobId, finalPlan);
        if (!continued) return;
      }

      finalAttempt = await this.resolve(jobId, input);
      if (finalAttempt.kind !== 'READY') {
        this.fail(jobId, '최종 데이터 준비 뒤에도 유니버스 조건이 해소되지 않았습니다. 데이터 공백을 확인하세요.');
        return;
      }
      if (isEmptySchedule(finalAttempt.schedule)) {
        this.fail(jobId, '모든 리밸런싱 날짜에서 선정된 종목이 없어 유니버스를 만들 수 없습니다. 조건이나 데이터 이력을 확인하세요.');
        return;
      }
      if (this.finishCancelledIfRequested(jobId)) return;

      this.persistAndEmit(jobId, { phase: 'FINALIZING' }, ['RUNNING']);
      this.registerUniverse(finalAttempt);
      const preview = this.buildPreview(input, finalAttempt);
      this.persistAndEmit(
        jobId,
        { status: 'COMPLETED', previewJson: JSON.stringify(preview), nextResumeAtMs: null },
        ['RUNNING'],
      );
    } catch (error) {
      if (this.stopping) return;
      const current = this.getRow(jobId);
      if (!current || current.status !== 'RUNNING') return;
      const message = error instanceof Error ? error.message : String(error);
      this.deps.logger.error(
        { module: 'backtest', event: 'preparation.failed', jobId, err: error },
        'backtest preparation failed',
      );
      this.fail(jobId, message);
    }
  }

  private async resolve(jobId: string, input: PreparationInput): Promise<UniverseResolveAttempt> {
    this.persistAndEmit(jobId, { phase: 'RESOLVING_STAGES' }, ['RUNNING']);
    return this.deps.resolver.resolveOrDescribeNeeds(input.universeRule, input.period);
  }

  private async syncMarketData(
    jobId: string,
    selectionMetricDates: readonly string[],
    price: BacktestPreparationPlan['price'],
  ): Promise<void> {
    this.persistAndEmit(jobId, {
      phase: 'MARKET_DATA',
      doneSymbols: 0,
      totalSymbols: new Set(price.symbols).size,
    }, ['RUNNING']);

    for (const date of new Set(selectionMetricDates)) {
      if (this.cancelOrStopRequested(jobId)) return;
      await this.deps.symbolMaster.ensureTradingDay(date);
    }
    await this.deps.symbolMaster.ensureSelectionMetrics(selectionMetricDates);

    if (price.symbols.length === 0) return;
    if (this.deps.symbolMaster.isRangeCovered?.(price.from, price.to)) return;
    let cursor = price.from;
    while (cursor <= price.to) {
      if (this.cancelOrStopRequested(jobId)) return;
      await this.deps.symbolMaster.ingestDate(cursor);
      cursor = addCalendarDays(cursor, 1);
    }
  }

  private async syncFacts(jobId: string, plan: BacktestPreparationPlan): Promise<boolean> {
    this.persistAndEmit(jobId, { phase: 'SYNCING_FACTS' }, ['RUNNING']);
    if (plan.financial.symbols.length > 0) {
      const report = await this.runFactRequest(jobId, 'FINANCIAL', {
        symbols: plan.financial.symbols,
        fromYear: plan.financial.fromYear,
        toYear: plan.financial.toYear,
      });
      if (!this.consumeFactReport(jobId, report)) return false;
    }

    // sync()가 재무와 자본변동을 함께 받으므로, 같은 심볼을 action-only 경로로
    // 다시 청구하지 않는다. actionSymbols는 priceSymbols와 독립된 채로 여기까지 온다.
    const financial = new Set(plan.financial.symbols);
    const actionOnly = plan.actions.symbols.filter((symbol) => !financial.has(symbol));
    if (actionOnly.length > 0) {
      const report = await this.runFactRequest(jobId, 'ACTIONS', {
        symbols: actionOnly,
        fromYear: plan.actions.fromYear,
        toYear: plan.actions.toYear,
      });
      if (!this.consumeFactReport(jobId, report)) return false;
    }
    return !this.shouldReturnFromRun(jobId);
  }

  private runFactRequest(
    jobId: string,
    kind: 'FINANCIAL' | 'ACTIONS',
    request: { readonly symbols: readonly string[]; readonly fromYear: number; readonly toYear: number },
  ): Promise<FactSyncReport> {
    this.persistAndEmit(jobId, {
      doneSymbols: 0,
      totalSymbols: new Set(request.symbols).size,
    }, ['RUNNING']);
    const hooks = {
      onSymbolDone: (progress: { index: number; total: number }): void => {
        this.persistAndEmit(jobId, {
          doneSymbols: progress.index,
          totalSymbols: progress.total,
        }, ['RUNNING']);
      },
      shouldStop: (): boolean => this.cancelOrStopRequested(jobId),
      beforeWorkUnit: (work: FactSyncWorkUnit): 'CONTINUE' | 'PAUSE_DAILY_QUOTA' =>
        this.reserveDartCalls(jobId, work.estimatedDartCalls),
    };
    const input = {
      ...request,
      consolidated: true,
      mode: 'INCREMENTAL' as const,
      // coverage가 work-unit 저장 직후 닫히므로 quota/재시작 복구에서 현재 연도도
      // 다시 호출하지 않는다. 일반 수동 INCREMENTAL sync의 최신화 기본값은 유지한다.
      refreshCurrentYear: false,
    };
    return kind === 'FINANCIAL'
      ? this.deps.factSync.sync(input, hooks)
      : this.deps.factSync.syncCorporateActions(input, hooks);
  }

  private consumeFactReport(jobId: string, report: FactSyncReport): boolean {
    this.persistAndEmit(jobId, (row) => ({
      savedFacts: row.savedFacts + report.savedFacts,
      gapCount: row.gapCount + report.gaps.length,
      ...(report.failureMessage ? { error: report.failureMessage } : {}),
    }));
    if (report.stopReason === 'DAILY_QUOTA') return false;
    if (report.stopReason === 'CANCELLED') {
      this.persistAndEmit(
        jobId,
        { status: 'CANCELLED', error: report.failureMessage ?? '사용자가 준비 작업을 취소했습니다.' },
        ['RUNNING'],
      );
      return false;
    }
    if (report.stopReason === 'ERROR') {
      this.fail(jobId, report.failureMessage ?? 'DART 데이터 동기화에 실패했습니다.');
      return false;
    }
    return true;
  }

  private reserveDartCalls(
    jobId: string,
    estimatedCalls: number,
  ): 'CONTINUE' | 'PAUSE_DAILY_QUOTA' {
    const now = this.deps.clock.now();
    const quotaDate = kstDateOf(now);
    const snapshot = this.persistAndEmit(
      jobId,
      (row) => {
        const total = this.deps.database.db
          .select({ value: sql<number>`coalesce(sum(${backtestPreparationJobs.dartCallsUsed}), 0)` })
          .from(backtestPreparationJobs)
          .where(eq(backtestPreparationJobs.dartQuotaDateKst, quotaDate))
          .get()?.value ?? 0;
        if (total + estimatedCalls > this.dailyLimit) {
          return {
            status: 'WAITING_DAILY_QUOTA',
            nextResumeAtMs: nextKstMidnightMs(now),
            dartQuotaDateKst: quotaDate,
            ...(row.dartQuotaDateKst === quotaDate ? {} : { dartCallsUsed: 0 }),
          };
        }
        return {
          dartQuotaDateKst: quotaDate,
          dartCallsUsed: (row.dartQuotaDateKst === quotaDate ? row.dartCallsUsed : 0) + estimatedCalls,
        };
      },
      ['RUNNING'],
    );
    if (snapshot?.status === 'WAITING_DAILY_QUOTA') {
      this.scheduleResume(jobId, snapshot.nextResumeAtMs as number);
      return 'PAUSE_DAILY_QUOTA';
    }
    return 'CONTINUE';
  }

  private scheduleResume(jobId: string, resumeAtMs: number): void {
    this.clearResumeTimer(jobId);
    const timer = setTimeout(() => {
      this.resumeTimers.delete(jobId);
      if (this.stopping) return;
      const current = this.getRow(jobId);
      if (
        current?.status === 'WAITING_DAILY_QUOTA'
        && current.nextResumeAtMs !== null
        && current.nextResumeAtMs <= this.deps.clock.now()
      ) {
        this.persistAndEmit(
          jobId,
          { status: 'QUEUED', nextResumeAtMs: null },
          ['WAITING_DAILY_QUOTA'],
        );
        this.queuePump();
      }
    }, Math.max(0, resumeAtMs - this.deps.clock.now()));
    timer.unref();
    this.resumeTimers.set(jobId, timer);
  }

  private clearResumeTimer(jobId: string): void {
    const timer = this.resumeTimers.get(jobId);
    if (timer) clearTimeout(timer);
    this.resumeTimers.delete(jobId);
  }

  private finishCancelledIfRequested(jobId: string): boolean {
    const row = this.getRow(jobId);
    if (!row || row.status !== 'RUNNING' || !row.cancelRequested) return false;
    this.persistAndEmit(
      jobId,
      { status: 'CANCELLED', error: '사용자가 준비 작업을 취소했습니다.' },
      ['RUNNING'],
    );
    return true;
  }

  private cancelOrStopRequested(jobId: string): boolean {
    return this.stopping || this.getRow(jobId)?.cancelRequested === true;
  }

  private shouldReturnFromRun(jobId: string): boolean {
    if (this.stopping) return true;
    if (this.finishCancelledIfRequested(jobId)) return true;
    return this.getRow(jobId)?.status !== 'RUNNING';
  }

  private fail(jobId: string, error: string): void {
    this.persistAndEmit(jobId, { status: 'FAILED', error }, ['RUNNING']);
  }

  private registerUniverse(attempt: Extract<UniverseResolveAttempt, { kind: 'READY' }>): void {
    for (const symbol of unionSymbols(attempt.schedule)) {
      if (this.deps.symbolService.exists(symbol)) continue;
      const entry = attempt.unionEntries.get(symbol);
      if (entry) this.deps.symbolService.addSymbol(symbol, 'KR', entry.name, entry.standardCode);
    }
  }

  private buildPreview(
    input: PreparationInput,
    attempt: Extract<UniverseResolveAttempt, { kind: 'READY' }>,
  ): BacktestUniversePreview {
    const symbols = unionSymbols(attempt.schedule);
    const coverage = this.deps.candleCoverage?.getCoverage(symbols) ?? [];
    const withBars = new Set(coverage.filter((row) => row.barCount > 0).map((row) => row.code));
    const missingCandleSymbols = this.deps.candleCoverage
      ? symbols.filter((symbol) => !this.deps.symbolService.exists(symbol) || !withBars.has(symbol))
      : [];
    return {
      schedule: attempt.schedule,
      diagnostics: attempt.diagnostics,
      stages: input.universeRule.stages,
      unionSymbols: symbols,
      scheduleHash: scheduleHash(attempt.schedule),
      uncoveredDates: [],
      periodCovered: this.deps.resolver.isPeriodCovered(input.period),
      missingCandleSymbols,
    };
  }

  private requireStrategy(input: PreparationInput): AnyTradingStrategy {
    const strategy = this.deps.strategies.get(input.strategyId);
    if (!strategy) throw new Error(`알 수 없는 전략: ${input.strategyId}`);
    const validated = strategy.parameterSchema.safeParse(input.parameters);
    if (!validated.success) {
      throw new Error(validated.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; '));
    }
    return strategy;
  }

  private getRow(jobId: string): PreparationJobRow | null {
    return this.deps.database.db
      .select()
      .from(backtestPreparationJobs)
      .where(eq(backtestPreparationJobs.id, jobId))
      .get() ?? null;
  }

  /**
   * 모든 job UPDATE와 그 결과 event는 이 경계 하나를 통과한다. builder는
   * BEGIN IMMEDIATE 안에서 현재 row와 전역 quota 합계를 함께 읽을 수 있다.
   */
  private persistAndEmit(
    jobId: string,
    patchOrBuilder: PreparationJobPatch | ((row: PreparationJobRow) => PreparationJobPatch | null),
    expectedStatuses?: readonly PreparationStatus[],
    recoveryTransition = false,
  ): BacktestPreparationJobDto | null {
    const mutate = this.deps.database.sqlite.transaction(() => {
      const current = this.getRow(jobId);
      if (!current) return false;
      const currentStatus = current.status as PreparationStatus;
      if (expectedStatuses && !expectedStatuses.includes(currentStatus)) return false;
      const patch = typeof patchOrBuilder === 'function' ? patchOrBuilder(current) : patchOrBuilder;
      if (patch === null) return false;
      const nextStatus = patch.status as PreparationStatus | undefined;
      if (
        nextStatus !== undefined
        && nextStatus !== currentStatus
        && !(recoveryTransition && currentStatus === 'RUNNING' && nextStatus === 'QUEUED')
        && !ALLOWED_TRANSITIONS[currentStatus].includes(nextStatus)
      ) {
        throw new Error(`허용되지 않은 준비 작업 상태 전이: ${currentStatus} -> ${nextStatus}`);
      }
      const terminal = nextStatus !== undefined && TERMINAL_STATUSES.includes(nextStatus);
      this.deps.database.db.update(backtestPreparationJobs).set({
        ...patch,
        updatedAtMs: this.deps.clock.now(),
        ...(terminal ? { completedAtMs: this.deps.clock.now(), nextResumeAtMs: null } : {}),
      }).where(eq(backtestPreparationJobs.id, jobId)).run();
      return true;
    });
    const changed = mutate.immediate();
    const snapshot = this.get(jobId);
    if (!changed || !snapshot) return snapshot;
    for (const listener of this.listeners.get(jobId) ?? []) {
      try {
        listener(snapshot);
      } catch (error) {
        this.deps.logger.warn(
          { module: 'backtest', event: 'preparation.listener-failed', jobId, err: error },
          'preparation listener failed',
        );
      }
    }
    return snapshot;
  }
}

function preparationRequest(input: PreparationInput): BacktestRequest {
  // Planner는 이 네 필드만 읽는다. 전체 제출 요청의 자본·체결·risk는 준비 hash와
  // 데이터 범위에 의도적으로 포함되지 않는다(Task 5 contract).
  return input as BacktestRequest;
}

function unionSymbols(schedule: readonly UniverseScheduleEntry[]): string[] {
  return [...new Set(schedule.flatMap((entry) => entry.members.map((member) => member.symbol)))].sort();
}

function isEmptySchedule(schedule: readonly UniverseScheduleEntry[]): boolean {
  return schedule.every((entry) => entry.members.length === 0);
}

function scheduleHash(schedule: readonly UniverseScheduleEntry[]): string {
  // request hash와 달리 schedule은 resolver가 이미 결정적인 순서로 만든 JSON이다.
  return createHash('sha256').update(JSON.stringify(schedule)).digest('hex');
}

function nextKstMidnightMs(nowMs: number): number {
  const [year, month, day] = kstDateOf(nowMs).split('-').map(Number) as [number, number, number];
  return Date.UTC(year, month - 1, day + 1) - 9 * 60 * 60 * 1000;
}

function toDto(row: PreparationJobRow): BacktestPreparationJobDto {
  return {
    id: row.id,
    requestHash: row.requestHash,
    status: row.status as PreparationStatus,
    phase: row.phase as PreparationPhase,
    doneSymbols: row.doneSymbols,
    totalSymbols: row.totalSymbols,
    savedFacts: row.savedFacts,
    gapCount: row.gapCount,
    nextResumeAtMs: row.nextResumeAtMs,
    error: row.error,
  };
}
