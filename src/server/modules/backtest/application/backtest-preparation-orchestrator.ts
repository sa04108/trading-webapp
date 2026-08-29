import { createHash } from 'node:crypto';
import { asc, desc, eq, sql } from 'drizzle-orm';
import {
  periodToTsRange,
  type BacktestRequest,
} from '../../../../shared/schemas/backtest-request.js';
import type { UniverseRule } from '../../../../shared/schemas/universe-rule.js';
import {
  preparationInputSchema,
  type PreparationInput as SharedPreparationInput,
} from '../../../../shared/schemas/backtest-preparation.js';
import type { Clock } from '../../../shared/clock.js';
import type { DatabaseHandle } from '../../../shared/db/database.js';
import { backtestPreparationJobs } from '../../../shared/db/schema.js';
import { newId } from '../../../shared/ids.js';
import type { Logger } from '../../../shared/logger.js';
import type { ExternalApiUsage } from '../../../shared/db/external-api-usage.js';
import type { CorporateActionCoverageStore } from '../../facts/application/corporate-action-coverage.js';
import type { FactCoverageStore } from '../../facts/application/fact-coverage-store.js';
import type { FactSyncService, FactSyncReport } from '../../facts/application/fact-sync-service.js';
import { DART_DAILY_CALL_LIMIT } from '../../facts/domain/sync-plan.js';
import type { CandleCoverageService } from '../../market-data/application/candle-coverage-service.js';
import { KrxQuotaError } from '../../market-data/application/ports.js';
import type { SymbolMasterService } from '../../market-data/application/symbol-master-service.js';
import { addCalendarDays, kstDateOf } from '../../market-data/domain/kst-date.js';
import type { SymbolService } from '../../market-data/application/symbol-service.js';
import type { SymbolMasterEntry } from '../../market-data/domain/symbol-master.js';
import type { StrategyRegistry } from '../../strategy/application/strategy-registry.js';
import type { AnyTradingStrategy } from '../../strategy/domain/strategy.js';
import { UnsafeBacktestSymbolIdentityError } from './backtest-symbol-identity.js';
import {
  findRelevantCorporateActionGaps,
  readCorporateActionGapDetails,
} from './backtest-corporate-action-gaps.js';
import {
  financialCoverageGapMessage,
  findFinancialCoverageGap,
} from './backtest-financial-coverage.js';
import {
  backtestPreparationRequestHash,
  buildBacktestPreparationPlan,
  type BacktestPreparationPlan,
} from './backtest-preparation-plan.js';
import { UniverseResolutionCancelledError } from './universe-rule-resolver.js';
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

export type PreparationInput = SharedPreparationInput;

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
  readonly warnings: readonly string[];
}

type PreparationJobRow = typeof backtestPreparationJobs.$inferSelect;
type PreparationJobPatch = Partial<typeof backtestPreparationJobs.$inferInsert>;

const ACTIVE_STATUSES: readonly PreparationStatus[] = [
  'QUEUED', 'RUNNING', 'WAITING_DAILY_QUOTA',
];
const TERMINAL_STATUSES: readonly PreparationStatus[] = ['COMPLETED', 'FAILED', 'CANCELLED'];
const MAX_FINAL_STABILIZATION_PASSES = 8;
const MAX_RESOLUTION_PROGRESS_UPDATES = 100;

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

/** 요청 입력 자체의 문제(미지 전략, 파라미터 형식) — 라우트가 400 으로 매핑한다. */
export class PreparationInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PreparationInputError';
  }
}

/** 현재 shortCode 기반 저장 구조로 안전하게 분리할 수 없는 종목 identity 조합. */
export { UnsafeBacktestSymbolIdentityError } from './backtest-symbol-identity.js';

/** needsDart 계획에만 쓰고 저장·sync하지 않는 미상 future candidate probe. */
const UNKNOWN_CANDIDATE_PROBE = '__UNKNOWN_FUTURE_UNIVERSE_CANDIDATE__';

export interface BacktestPreparationOrchestratorDeps {
  readonly database: DatabaseHandle;
  readonly resolver: Pick<UniverseRuleResolver, 'resolveOrDescribeNeeds' | 'isPeriodCovered'>;
  readonly factSync: Pick<
    FactSyncService,
    'sync' | 'syncCorporateActions' | 'planFinancialSync' | 'planCorporateActionSync'
  >;
  readonly actionCoverage: Pick<
    CorporateActionCoverageStore,
    'getCoveredYears' | 'getGapYears' | 'getGapDetails'
  >;
  readonly factCoverage: Pick<FactCoverageStore, 'getCoverageState'>;
  readonly symbolMaster: Pick<
    SymbolMasterService,
    | 'ensureTradingDay'
    | 'ensureSelectionMetrics'
    | 'ingestDate'
    | 'isRangeCovered'
    | 'nonTradingDaysBetween'
    | 'delistedEventsBetween'
    | 'sharesChangesBetween'
  >;
  readonly strategies: Pick<StrategyRegistry, 'get'>;
  readonly symbolService: Pick<
    SymbolService,
    'exists' | 'addSymbol' | 'getRegisteredIdentity' | 'getRegisteredIdentityByStandardCode'
  >;
  readonly candleCoverage?: Pick<CandleCoverageService, 'getCoverageBetween'>;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly dartDailyCallLimit?: number;
  /** 모든 DART 경로가 공유하는 영속 일일 호출 원장. */
  readonly externalApiUsage?: ExternalApiUsage;
}

/**
 * 준비 작업은 SQLite 행을 큐이자 복구 지점으로 사용하고, 한 번에 하나만 실행한다.
 * FactSyncService가 symbol-year 저장 경계를 닫으므로 quota 재개는 항상 INCREMENTAL이다.
 */
export class BacktestPreparationOrchestrator {
  private readonly listeners = new Map<string, Set<(job: BacktestPreparationJobDto) => void>>();
  private readonly resumeTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private runnerActive = false;
  private runnerPromise: Promise<void> | null = null;
  private stopping = false;
  private readonly dailyLimit: number;

  constructor(private readonly deps: BacktestPreparationOrchestratorDeps) {
    this.dailyLimit = deps.dartDailyCallLimit ?? DART_DAILY_CALL_LIMIT;
  }

  start(input: PreparationInput): BacktestPreparationJobDto {
    const strategy = this.requireStrategy(input);
    const requestHash = backtestPreparationRequestHash(input, strategy);
    // 읽기와 insert 사이에 다른 프로세스가 같은 hash를 넣을 수 있으므로 write lock을
    // 먼저 잡는다. WAL의 일반 SELECT는 다른 writer와 겹칠 수 있어 transaction 없이
    // 두 문장을 잇는 것만으로는 single-flight가 아니다.
    const selected = this.deps.database.sqlite.transaction(() => {
      const existing = this.deps.database.db
        .select()
        .from(backtestPreparationJobs)
        .where(eq(backtestPreparationJobs.requestHash, requestHash))
        .orderBy(desc(backtestPreparationJobs.createdAtMs))
        .all()
        .find((row) => ACTIVE_STATUSES.includes(row.status as PreparationStatus));
      if (existing) return { row: existing, inserted: false } as const;

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
      const row = this.getRow(id);
      if (!row) throw new Error('준비 작업을 저장하지 못했습니다.');
      return { row, inserted: true } as const;
    }).immediate();
    if (!selected.inserted) return toDto(selected.row);

    const created = this.persistAndEmit(selected.row.id, {});
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

  /**
   * 같은 준비 hash로 이미 완료한 미리보기를 DB에서만 읽는다.
   *
   * `getReadyPreview`와 달리 현재 종목 마스터를 다시 해소하지 않는다. 재설정 복제가
   * 원본 job에 고정된 일정과 이 결과의 schedule hash를 대조한 뒤 원본 일정을 그대로
   * 재사용할 때만 쓴다. 호출자가 그 대조 없이 신규 제출에 사용하면 stale 유니버스를
   * 승인하게 되므로 일반 제출 경로는 계속 `getReadyPreview`를 써야 한다.
   */
  getCachedPreview(input: PreparationInput): BacktestUniversePreview | null {
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
    const preview = this.getPreview(completed.id);
    if (
      !preview
      || this.financialCoverageGap(input, strategy, preview.unionSymbols) !== null
      || this.corporateActionCoverageFailure(input, strategy, preview.unionSymbols) !== null
    ) {
      return null;
    }
    return preview;
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
    // 완료 뒤 coverage가 삭제·손상됐으면 cached 200을 계속 돌려 재준비 진입을 막지
    // 않는다. null을 돌려 라우트가 새 durable preparation을 시작하게 한다.
    if (this.financialCoverageGap(input, strategy, currentPreview.unionSymbols) !== null) return null;
    if (this.corporateActionCoverageFailure(input, strategy, currentPreview.unionSymbols) !== null) {
      return null;
    }
    this.registerUniverse(attempt);
    return currentPreview;
  }

  /** 라우트가 DART 미설정 503을 실제 sync 필요 요청에만 적용할 때 쓴다. */
  async needsDart(input: PreparationInput): Promise<boolean> {
    const strategy = this.requireStrategy(input);
    const attempt = await this.deps.resolver.resolveOrDescribeNeeds(input.universeRule, input.period);
    if (attempt.kind === 'NEEDS_DATA') {
      const candidateSymbols = [...attempt.unionEntries.keys()];
      // master 날짜 자체가 미수집이면 빈 Map은 빈 유니버스라는 뜻이 아니다.
      // 하나의 가상 후보를 planner에 넣어 rule/strategy metadata가 future fact/action을
      // 요구하는지만 본다. price-only면 plan에 DART symbol이 생기지 않는다.
      let resolutionNeeds = attempt.needs;
      if (!attempt.candidateScopeKnown) {
        candidateSymbols.push(UNKNOWN_CANDIDATE_PROBE);
        // 후보 scope 미상이면 resolver 는 PER·ROE 재무·DECLINE 자본변동 후보를 아직
        // 못 채웠다. plan 은 stage 요구를 resolutionNeeds 로만 받으므로, probe 를
        // 여기에도 넣어야 price-only 전략 + PER/ROE/DECLINE stage 요청이 DART-key
        // 게이트를 그냥 통과해 뒤늦게 raw 설정 오류로 죽지 않는다.
        const stages = input.universeRule.stages;
        resolutionNeeds = {
          ...resolutionNeeds,
          factSymbols: stages.some((stage) => stage.criterion === 'PER' || stage.criterion === 'ROE')
            ? [...resolutionNeeds.factSymbols, UNKNOWN_CANDIDATE_PROBE]
            : resolutionNeeds.factSymbols,
          actionSymbols: stages.some((stage) => stage.criterion === 'DECLINE')
            ? [...resolutionNeeds.actionSymbols, UNKNOWN_CANDIDATE_PROBE]
            : resolutionNeeds.actionSymbols,
        };
      }
      return this.planNeedsDart(buildBacktestPreparationPlan({
        request: preparationRequest(input),
        resolutionNeeds,
        // 시장 데이터가 빈 stage는 아직 최종 멤버를 정할 수 없다.
        // resolver가 알려준 현재 후보 scope를 final-union의 상한으로 계획해야
        // 뒤에 전략 fact/action이 필요해지는 요청을 DART 없이 받지 않는다.
        finalUniverseSymbols: candidateSymbols,
        strategy,
      }));
    }
    const finalSymbols = unionSymbols(attempt.schedule);
    const plan = buildBacktestPreparationPlan({
      request: preparationRequest(input),
      resolutionNeeds: EMPTY_NEEDS,
      finalUniverseSymbols: finalSymbols,
      strategy,
    });
    return this.planNeedsDart(plan);
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
      const status = row.status as PreparationStatus;
      if (!ACTIVE_STATUSES.includes(status)) continue;
      this.normalizeRecoveredRequest(row);
      if (status === 'RUNNING') {
        // 복구 전이는 정상 실행 전이표의 유일한 예외다. 죽은 runner를 다시 큐에
        // 올려야 이미 저장된 symbol-year를 INCREMENTAL로 이어받을 수 있다.
        this.persistAndEmit(row.id, { status: 'QUEUED' }, ['RUNNING'], true);
      } else if (status === 'WAITING_DAILY_QUOTA') {
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

  async stop(): Promise<void> {
    this.stopping = true;
    for (const timer of this.resumeTimers.values()) clearTimeout(timer);
    this.resumeTimers.clear();
    this.listeners.clear();
    await this.runnerPromise;
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
    const runner = this.run(claimed.id)
      .catch((error: unknown) => {
        this.deps.logger.error(
          { module: 'backtest', event: 'preparation.unhandled', jobId: claimed.id, err: error },
          'backtest preparation rejected outside run handler',
        );
      })
      .finally(() => {
        this.runnerActive = false;
        if (this.runnerPromise === runner) this.runnerPromise = null;
        if (!this.stopping) this.queuePump();
      });
    this.runnerPromise = runner;
  }

  private async run(jobId: string): Promise<void> {
    try {
      const row = this.getRow(jobId);
      if (!row) return;
      const input = parseStoredPreparationInput(row.requestJson);
      const strategy = this.requireStrategy(input);
      if (this.finishCancelledIfRequested(jobId)) return;

      let finalAttempt = await this.resolveUntilReady(
        jobId,
        input,
        strategy,
        await this.resolve(jobId, input),
      );
      if (finalAttempt === null) return;

      // 최종 전략 데이터 sync 자체가 팩트/봉을 추가해 순위와 멤버십을 바꿀 수 있다.
      // A만 준비한 뒤 B로 바뀐 결과를 바로 완료하면 B의 자본변동·warm-up이 비어도
      // 실행된다. 같은 schedule이 연속으로 확인될 때까지 새 멤버의 plan을 반복하고,
      // 데이터 이상으로 계속 진동하면 무한 외부 호출 대신 상한에서 명시적으로 실패한다.
      let stabilized = false;
      for (let pass = 0; pass < MAX_FINAL_STABILIZATION_PASSES; pass += 1) {
        if (isEmptySchedule(finalAttempt.schedule)) {
          this.fail(jobId, '모든 리밸런싱 날짜에서 선정된 종목이 없어 유니버스를 만들 수 없습니다. 조건이나 데이터 이력을 확인하세요.');
          return;
        }
        const beforeSignature = JSON.stringify(finalAttempt.schedule);
        this.registerUniverse(finalAttempt);
        const finalPlan = buildBacktestPreparationPlan({
          request: preparationRequest(input),
          resolutionNeeds: EMPTY_NEEDS,
          finalUniverseSymbols: unionSymbols(finalAttempt.schedule),
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

        const resolved = await this.resolveUntilReady(
          jobId,
          input,
          strategy,
          await this.resolve(jobId, input),
        );
        if (resolved === null) return;
        finalAttempt = resolved;
        if (JSON.stringify(finalAttempt.schedule) !== beforeSignature) continue;

        this.assertCorporateActionCoverage(finalPlan.actions);
        this.assertFinancialCoverage(input, strategy, unionSymbols(finalAttempt.schedule));
        stabilized = true;
        break;
      }
      if (!stabilized) {
        this.fail(
          jobId,
          `최종 데이터 준비 후 유니버스가 ${MAX_FINAL_STABILIZATION_PASSES}회 안에 안정되지 않았습니다. `
            + '순위 입력의 반복 변경이나 데이터 충돌을 확인하세요.',
        );
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
      if (error instanceof UniverseResolutionCancelledError) {
        if (this.finishCancelledIfRequested(jobId)) return;
      }
      const current = this.getRow(jobId);
      if (!current || current.status !== 'RUNNING') return;
      if (error instanceof KrxQuotaError) {
        this.waitForKrxDailyQuota(jobId, error.message);
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      this.deps.logger.error(
        { module: 'backtest', event: 'preparation.failed', jobId, err: error },
        'backtest preparation failed',
      );
      this.fail(jobId, message);
    }
  }

  private async resolve(jobId: string, input: PreparationInput): Promise<UniverseResolveAttempt> {
    this.persistAndEmit(jobId, {
      phase: 'RESOLVING_STAGES',
      doneSymbols: 0,
      totalSymbols: 0,
    }, ['RUNNING']);
    let lastPersistedCompleted = -1;
    return this.deps.resolver.resolveOrDescribeNeeds(input.universeRule, input.period, {
      onProgress: ({ completedRebalanceDates, totalRebalanceDates }) => {
        // DAY 10년이면 수천 날짜다. 계산보다 진행률 BEGIN IMMEDIATE/UPDATE/SSE가
        // 더 비싸지지 않도록 시작·완료는 항상 남기고 중간 durable write만 샘플링한다.
        const persistEvery = Math.max(
          1,
          Math.ceil(totalRebalanceDates / MAX_RESOLUTION_PROGRESS_UPDATES),
        );
        if (
          completedRebalanceDates !== totalRebalanceDates
          && lastPersistedCompleted >= 0
          && completedRebalanceDates - lastPersistedCompleted < persistEvery
        ) return;
        lastPersistedCompleted = completedRebalanceDates;
        this.persistAndEmit(jobId, {
          doneSymbols: completedRebalanceDates,
          totalSymbols: totalRebalanceDates,
        }, ['RUNNING']);
      },
      shouldStop: () => this.cancelOrStopRequested(jobId),
    });
  }

  private async resolveUntilReady(
    jobId: string,
    input: PreparationInput,
    strategy: AnyTradingStrategy,
    initialAttempt: UniverseResolveAttempt,
  ): Promise<Extract<UniverseResolveAttempt, { kind: 'READY' }> | null> {
    let attempt = initialAttempt;
    const seenNeeds = new Set<string>();
    for (;;) {
      if (this.finishCancelledIfRequested(jobId)) return null;
      if (attempt.kind === 'READY') return attempt;
      const signature = JSON.stringify(attempt.needs);
      if (seenNeeds.has(signature)) {
        this.fail(
          jobId,
          '필요 데이터를 모두 조회했지만 유니버스 선정 조건을 해소하지 못했습니다. 데이터 공백과 DART 응답 누락을 확인하세요.',
        );
        return null;
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
        return null;
      }
      if (hasMarketWork) {
        await this.syncMarketData(jobId, attempt.needs.selectionMetricDates, plan.price);
        if (this.shouldReturnFromRun(jobId)) return null;
        // 시장 데이터가 아직 없는 iteration 의 DART 요구는 좁혀지지 않은 상한이다.
        // 시장 데이터를 먼저 채우고 재해소한 뒤 실제 후보에만 DART quota를 쓴다.
        attempt = await this.resolve(jobId, input);
        continue;
      }
      if (hasDartWork) {
        this.registerNeededSymbols(attempt, [
          ...plan.financial.symbols,
          ...plan.actions.symbols,
        ]);
        const continued = await this.syncFacts(jobId, plan);
        if (!continued) return null;
      }
      attempt = await this.resolve(jobId, input);
    }
  }

  private async syncMarketData(
    jobId: string,
    selectionMetricDates: readonly string[],
    price: BacktestPreparationPlan['price'],
  ): Promise<void> {
    // 이 phase 의 작업 단위는 심볼이 아니라 날짜다 — 심볼 수를 분모로 두면 warm-up
    // 몇 달치를 받는 동안 진행이 끝까지 0 에 머문다 (운영 리포트, 2026-08-10).
    // 가격 구간은 아래 ingest 루프가 실제로 돌 때만 분모에 넣는다.
    const metricDates = [...new Set(selectionMetricDates)];
    const priceIngestNeeded = price.symbols.length > 0
      && this.deps.symbolMaster.isRangeCovered?.(price.from, price.to) !== true;
    const priceDays = priceIngestNeeded ? calendarDaysInclusive(price.from, price.to) : 0;
    let done = 0;
    this.persistAndEmit(jobId, {
      phase: 'MARKET_DATA',
      doneSymbols: 0,
      totalSymbols: metricDates.length + priceDays,
    }, ['RUNNING']);

    for (const date of metricDates) {
      if (this.cancelOrStopRequested(jobId)) return;
      await this.deps.symbolMaster.ensureTradingDay(date);
      done += 1;
      this.persistAndEmit(jobId, { doneSymbols: done }, ['RUNNING']);
    }
    await this.deps.symbolMaster.ensureSelectionMetrics(selectionMetricDates);

    if (!priceIngestNeeded) return;
    let cursor = price.from;
    while (cursor <= price.to) {
      if (this.cancelOrStopRequested(jobId)) return;
      await this.deps.symbolMaster.ingestDate(cursor);
      done += 1;
      this.persistAndEmit(jobId, { doneSymbols: done }, ['RUNNING']);
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

    // 재무 sync가 실행한 연도의 action coverage는 즉시 닫힌다. action 경로에는 전체
    // actionSymbols를 그대로 넘기고 그 coverage가 남은 연도만 증분 계획하게 한다.
    // 심볼만 보고 제외하면 "재무는 이미 커버됐지만 action은 비어 있는" 경우를 놓친다.
    if (plan.actions.symbols.length > 0) {
      const report = await this.runFactRequest(jobId, 'ACTIONS', {
        symbols: plan.actions.symbols,
        fromYear: plan.actions.fromYear,
        toYear: plan.actions.toYear,
      });
      if (!this.consumeFactReport(jobId, report)) return false;
    }
    return !this.shouldReturnFromRun(jobId);
  }

  /** 완료 preview가 현재 action protocol coverage를 여전히 만족하는지 부작용 없이 확인한다. */
  private corporateActionCoverageFailure(
    input: PreparationInput,
    strategy: AnyTradingStrategy,
    symbols: readonly string[],
  ): string | null {
    const plan = buildBacktestPreparationPlan({
      request: preparationRequest(input),
      resolutionNeeds: EMPTY_NEEDS,
      finalUniverseSymbols: symbols,
      strategy,
    });
    return this.corporateActionCoverageFailureForPlan(plan.actions);
  }

  private missingCorporateActionCoverageSymbols(
    actions: BacktestPreparationPlan['actions'],
  ): string[] {
    if (actions.symbols.length === 0) return [];
    const requiredYears = new Set<number>();
    for (let year = actions.fromYear; year <= actions.toYear; year += 1) requiredYears.add(year);
    const coveredBySymbol = this.deps.actionCoverage.getCoveredYears(actions.symbols);
    return actions.symbols.filter((symbol) => {
      const covered = new Set(coveredBySymbol.get(symbol) ?? []);
      return [...requiredYears].some((year) => !covered.has(year));
    });
  }

  private assertCorporateActionCoverage(actions: BacktestPreparationPlan['actions']): void {
    const failure = this.corporateActionCoverageFailureForPlan(actions);
    if (failure !== null) throw new Error(failure);
  }

  private corporateActionCoverageFailureForPlan(
    actions: BacktestPreparationPlan['actions'],
  ): string | null {
    const missing = this.missingCorporateActionCoverageSymbols(actions);
    if (missing.length > 0) {
      return '최종 유니버스의 자본변동 coverage가 부족해 백테스트 준비를 중단했습니다 — '
        + `대상: ${missing.join(', ')}. 필요한 연도 데이터를 다시 준비하세요.`;
    }
    const detailsBySymbol = readCorporateActionGapDetails(
      this.deps.actionCoverage,
      actions.symbols,
    );
    if ([...detailsBySymbol.values()].every((details) => details.length === 0)) return null;
    const executionFrom = `${actions.fromYear}-01-01`;
    const executionTo = `${actions.toYear}-12-31`;
    const relevantGaps = findRelevantCorporateActionGaps(
      detailsBySymbol,
      this.deps.symbolMaster.sharesChangesBetween(executionFrom, executionTo),
      {
        executionFrom,
        executionTo,
        rawFrom: executionFrom,
        rawTo: executionTo,
      },
    );
    if (relevantGaps.length === 0) return null;
    const affected = [...new Set(relevantGaps.map((gap) => gap.symbol))].sort();
    const causes = relevantGaps.map((gap) => (
      `${gap.symbol}(${gap.periodKey}: ${gap.reason})`
    )).join('; ');
    return `자본변동 보정 비율을 만들 수 없는 연도가 있어 백테스트 준비를 중단했습니다 — 대상: `
      + `${affected.join(', ')}. 확인된 원인: ${causes}. `
      + 'DART gap을 해소한 뒤 다시 준비하세요.';
  }

  private financialCoverageGap(
    input: PreparationInput,
    strategy: AnyTradingStrategy,
    symbols: readonly string[],
  ): ReturnType<typeof findFinancialCoverageGap> {
    return findFinancialCoverageGap({
      request: input,
      strategy,
      symbols,
      coverage: this.deps.factCoverage,
    });
  }

  private assertFinancialCoverage(
    input: PreparationInput,
    strategy: AnyTradingStrategy,
    symbols: readonly string[],
  ): void {
    const gap = this.financialCoverageGap(input, strategy, symbols);
    if (gap !== null) throw new Error(financialCoverageGapMessage(gap));
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
      beforeDartRequest: (): 'CONTINUE' | 'PAUSE_DAILY_QUOTA' =>
        this.reserveDartCall(jobId),
    };
    // 최신화는 sync 내부의 공시검색 판정이 맡는다 — coverage watermark 이후 정기공시가
    // 접수된 종목·연도만 다시 받으므로 quota/재시작 복구가 닫힌 symbol-year 를
    // 반복하지 않는 성질은 그대로다 (fact-sync-service.ts detectRedisclosedYears).
    const input = {
      ...request,
      consolidated: true,
      mode: 'INCREMENTAL' as const,
    };
    return kind === 'FINANCIAL'
      ? this.deps.factSync.sync(input, hooks)
      : this.deps.factSync.syncCorporateActions(input, hooks);
  }

  private consumeFactReport(jobId: string, report: FactSyncReport): boolean {
    if (report.stopReason === 'DAILY_QUOTA') {
      const now = this.deps.clock.now();
      const current = this.getRow(jobId);
      const snapshot = current?.status === 'WAITING_DAILY_QUOTA'
        ? this.persistAndEmit(jobId, (row) => ({
            savedFacts: row.savedFacts + report.savedFacts,
            gapCount: row.gapCount + report.gaps.length,
            ...(report.failureMessage ? { error: report.failureMessage } : {}),
          }), ['WAITING_DAILY_QUOTA'])
        : this.persistAndEmit(jobId, (row) => ({
            status: 'WAITING_DAILY_QUOTA',
            nextResumeAtMs: nextKstMidnightMs(now),
            savedFacts: row.savedFacts + report.savedFacts,
            gapCount: row.gapCount + report.gaps.length,
            ...(report.failureMessage ? { error: report.failureMessage } : {}),
          }), ['RUNNING']);
      this.deps.externalApiUsage?.reportQuotaExceeded(
        'DART',
        'daily',
        report.failureMessage ?? 'DART 일일 호출 한도에 도달했습니다.',
      );
      if (snapshot?.nextResumeAtMs !== null && snapshot?.nextResumeAtMs !== undefined) {
        this.scheduleResume(jobId, snapshot.nextResumeAtMs);
      }
      return false;
    }

    this.persistAndEmit(jobId, (row) => ({
      savedFacts: row.savedFacts + report.savedFacts,
      gapCount: row.gapCount + report.gaps.length,
      ...(report.failureMessage ? { error: report.failureMessage } : {}),
    }));
    if (report.stopReason === 'CANCELLED') {
      // 프로세스 종료는 사용자 취소가 아니다. 현재 symbol 저장 결과까지만 반영하고
      // RUNNING 복구점을 남기면 다음 부팅의 recoverOrphaned가 QUEUED로 이어받는다.
      if (this.stopping) return false;
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

  /**
   * KRX 일별 데이터는 수집 날짜가 지나도 바뀌지 않는다. 성공한 날짜는 symbol master
   * coverage에 즉시 남으므로 다음 KST 날짜에 job 전체를 다시 계획해도 ingestDate가 그
   * 날짜를 API 호출 없이 건너뛴다. DART처럼 새 공시 여부를 확인하거나 covered 날짜를
   * 강제로 다시 여는 단계는 두지 않는다.
   */
  private waitForKrxDailyQuota(jobId: string, message: string): void {
    const now = this.deps.clock.now();
    const snapshot = this.persistAndEmit(
      jobId,
      (row) => row.cancelRequested
        ? { status: 'CANCELLED', error: '사용자가 준비 작업을 취소했습니다.' }
        : {
            status: 'WAITING_DAILY_QUOTA',
            phase: 'MARKET_DATA',
            nextResumeAtMs: nextKstMidnightMs(now),
            error: message,
          },
      ['RUNNING'],
    );
    if (
      snapshot?.status === 'WAITING_DAILY_QUOTA'
      && snapshot.nextResumeAtMs !== null
    ) {
      this.scheduleResume(jobId, snapshot.nextResumeAtMs);
    }
  }

  private reserveDartCall(jobId: string): 'CONTINUE' | 'PAUSE_DAILY_QUOTA' {
    const now = this.deps.clock.now();
    const quotaDate = kstDateOf(now);
    const snapshot = this.persistAndEmit(
      jobId,
      (row) => {
        // 운영에서는 모든 실제 DART attempt가 공유하는 원장을 본다. 원장을 주입하지
        // 않는 단위 테스트·옛 조립부만 준비 job 합계를 fallback으로 사용한다.
        const total = this.deps.externalApiUsage?.callsUsed('DART', 'daily')
          ?? this.deps.database.db
            .select({ value: sql<number>`coalesce(sum(${backtestPreparationJobs.dartCallsUsed}), 0)` })
            .from(backtestPreparationJobs)
            .where(eq(backtestPreparationJobs.dartQuotaDateKst, quotaDate))
            .get()?.value
          ?? 0;
        const providerAlreadyExhausted =
          this.deps.externalApiUsage?.quotaExceeded('DART', 'daily') ?? false;
        if (providerAlreadyExhausted || total + 1 > this.dailyLimit) {
          return {
            status: 'WAITING_DAILY_QUOTA',
            nextResumeAtMs: nextKstMidnightMs(now),
            dartQuotaDateKst: quotaDate,
            ...(row.dartQuotaDateKst === quotaDate ? {} : { dartCallsUsed: 0 }),
          };
        }
        return {
          dartQuotaDateKst: quotaDate,
          dartCallsUsed: (row.dartQuotaDateKst === quotaDate ? row.dartCallsUsed : 0) + 1,
        };
      },
      ['RUNNING'],
    );
    if (snapshot?.status === 'WAITING_DAILY_QUOTA') {
      this.deps.externalApiUsage?.reportQuotaExceeded(
        'DART',
        'daily',
        'DART 일일 호출 한도에 도달해 다음 KST 날짜까지 준비 작업을 멈췄습니다.',
      );
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

  /** preparation과 같은 증분 계획에서 실제 DART 호출만 센다 (공시 재수집 전 하한). */
  private planNeedsDart(plan: BacktestPreparationPlan): boolean {
    const financialPlan = this.deps.factSync.planFinancialSync(
      plan.financial.symbols,
      plan.financial.fromYear,
      plan.financial.toYear,
    );
    if (financialPlan.calls > 0) return true;

    return this.deps.factSync.planCorporateActionSync(
      plan.actions.symbols,
      plan.actions.fromYear,
      plan.actions.toYear,
    ).calls > 0;
  }

  private registerUniverse(attempt: Extract<UniverseResolveAttempt, { kind: 'READY' }>): void {
    const checked = new Set<string>();
    for (const scheduleEntry of attempt.schedule) {
      for (const member of scheduleEntry.members) {
        const entry = attempt.unionEntries.get(member.symbol);
        if (!entry) {
          throw new UnsafeBacktestSymbolIdentityError(
            `${member.symbol} 종목의 KRX identity 원본이 준비 결과에서 누락됐습니다. 실행을 차단했습니다.`,
          );
        }
        if (entry.standardCode !== member.standardCode) {
          throw new UnsafeBacktestSymbolIdentityError(
            `단축코드 ${member.symbol}이 준비 일정에서 여러 표준코드(`
            + `${entry.standardCode}, ${member.standardCode})에 연결됐습니다. `
            + '단축코드 재사용 가능성이 있어 실행을 차단했습니다.',
          );
        }
        const identityKey = `${member.symbol}\0${member.standardCode}`;
        if (checked.has(identityKey)) continue;
        checked.add(identityKey);
        this.registerOrVerifySymbol(entry);
      }
    }
  }

  private registerNeededSymbols(
    attempt: Extract<UniverseResolveAttempt, { kind: 'NEEDS_DATA' }>,
    symbols: readonly string[],
  ): void {
    for (const symbol of new Set(symbols)) {
      const entry = attempt.unionEntries.get(symbol);
      if (!entry) {
        throw new UnsafeBacktestSymbolIdentityError(
          `${symbol} 종목의 KRX identity 원본이 데이터 준비 후보에서 누락됐습니다. `
          + '외부 데이터를 요청하지 않고 준비를 중단했습니다.',
        );
      }
      this.registerOrVerifySymbol(entry);
    }
  }

  /**
   * 단축코드가 같다는 이유만으로 기존 종목을 과거 KRX 증권과 자동 병합하지 않는다.
   * 봉·팩트가 아직 단축코드 키라 잘못 병합하면 다른 회사의 데이터가 한 상태로 이어진다.
   */
  private registerOrVerifySymbol(entry: SymbolMasterEntry): void {
    const registered = this.deps.symbolService.getRegisteredIdentity(entry.shortCode);
    const standardOwner = this.deps.symbolService
      .getRegisteredIdentityByStandardCode(entry.standardCode);
    if (standardOwner !== null && standardOwner.code !== entry.shortCode) {
      throw new UnsafeBacktestSymbolIdentityError(
        `KRX 표준코드 ${entry.standardCode}가 기존 단축코드(${standardOwner.code})와 `
        + `준비 후보 단축코드(${entry.shortCode})에 함께 연결됐습니다. `
        + '코드 변경 전후 데이터를 현재 저장 구조로 분리할 수 없어 실행을 차단했습니다.',
      );
    }
    if (registered === null) {
      this.deps.symbolService.addSymbol(
        entry.shortCode,
        'KR',
        entry.name,
        entry.standardCode,
      );
      return;
    }
    if (registered.standardCode === null) {
      throw new UnsafeBacktestSymbolIdentityError(
        `${entry.shortCode} 종목은 KRX 표준코드가 없는 기존 등록이라 같은 증권인지 확인할 수 없습니다. `
        + '기존 데이터의 종목 정체성을 검증·이관한 뒤 표준코드를 등록하세요.',
      );
    }
    if (registered.standardCode !== entry.standardCode) {
      throw new UnsafeBacktestSymbolIdentityError(
        `${entry.shortCode} 종목의 기존 KRX 표준코드(${registered.standardCode})가 `
        + `준비 유니버스의 표준코드(${entry.standardCode})와 다릅니다. `
        + '단축코드가 다른 증권에 재사용됐을 수 있어 자동 병합하지 않습니다.',
      );
    }
  }

  private buildPreview(
    input: PreparationInput,
    attempt: Extract<UniverseResolveAttempt, { kind: 'READY' }>,
  ): BacktestUniversePreview {
    const symbols = unionSymbols(attempt.schedule);
    const period = periodToTsRange(input.period);
    const coverage = this.deps.candleCoverage?.getCoverageBetween(
      symbols,
      period.fromTsMs,
      period.toTsMs,
    ) ?? [];
    const withBars = new Set(coverage.filter((row) => row.barCount > 0).map((row) => row.code));
    const missingCandleSymbols = this.deps.candleCoverage
      ? symbols.filter((symbol) => !this.deps.symbolService.exists(symbol) || !withBars.has(symbol))
      : [];
    const warnings: string[] = [];
    if (input.universeRule.rebalanceInterval.unit === 'NONE') {
      const selected = new Set(symbols);
      const nonTradingBySymbol = new Map<string, string[]>();
      for (const row of this.deps.symbolMaster.nonTradingDaysBetween(input.period.from, input.period.to)) {
        if (!selected.has(row.shortCode)) continue;
        const dates = nonTradingBySymbol.get(row.shortCode) ?? [];
        dates.push(row.date);
        nonTradingBySymbol.set(row.shortCode, dates);
      }
      const delistedBySymbol = new Map(
        this.deps.symbolMaster.delistedEventsBetween(input.period.from, input.period.to)
          .filter((event) => selected.has(event.shortCode))
          .map((event) => [event.shortCode, event.effectiveDate] as const),
      );
      for (const symbol of symbols) {
        const entry = attempt.unionEntries.get(symbol);
        const label = entry ? `${entry.name} (${symbol})` : symbol;
        const dates = nonTradingBySymbol.get(symbol) ?? [];
        if (dates.length === 1) {
          warnings.push(`${label}: ${dates[0]}에 거래정지·무거래 기록이 있습니다.`);
        } else if (dates.length > 1) {
          warnings.push(
            `${label}: ${dates[0]}~${dates[dates.length - 1]} 기간 중 거래정지·무거래 기록이 ${dates.length}일 있습니다.`,
          );
        }
        const delistedDate = delistedBySymbol.get(symbol);
        if (delistedDate !== undefined) {
          warnings.push(`${label}: ${delistedDate}에 상장폐지됐습니다.`);
        }
      }
    }
    return {
      schedule: attempt.schedule,
      diagnostics: attempt.diagnostics,
      stages: input.universeRule.stages,
      unionSymbols: symbols,
      scheduleHash: scheduleHash(attempt.schedule),
      uncoveredDates: [],
      periodCovered: this.deps.resolver.isPeriodCovered(input.period),
      missingCandleSymbols,
      warnings,
    };
  }

  private requireStrategy(input: PreparationInput): AnyTradingStrategy {
    const strategy = this.deps.strategies.get(input.strategyId);
    if (!strategy) throw new PreparationInputError(`알 수 없는 전략: ${input.strategyId}`);
    const validated = strategy.parameterSchema.safeParse(input.parameters);
    if (!validated.success) {
      throw new PreparationInputError(
        validated.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; '),
      );
    }
    return strategy;
  }

  private normalizeRecoveredRequest(row: PreparationJobRow): void {
    try {
      const input = parseStoredPreparationInput(row.requestJson);
      const strategy = this.requireStrategy(input);
      const requestJson = JSON.stringify(input);
      const requestHash = backtestPreparationRequestHash(input, strategy);
      if (row.requestJson === requestJson && row.requestHash === requestHash) return;
      this.persistAndEmit(
        row.id,
        { requestJson, requestHash },
        [row.status as PreparationStatus],
      );
    } catch (error) {
      this.deps.logger.warn(
        { module: 'backtest', event: 'preparation.recovery.request-invalid', jobId: row.id, err: error },
        'recovered preparation request is invalid and will fail when resumed',
      );
    }
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

/** from~to 를 포함하는 달력일 수 — MARKET_DATA 진행 분모가 ingest 루프와 같은 눈금을 쓴다. */
function calendarDaysInclusive(from: string, to: string): number {
  const days = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000;
  return days < 0 ? 0 : Math.round(days) + 1;
}

function preparationRequest(input: PreparationInput): BacktestRequest {
  // Planner는 이 네 필드만 읽는다. 전체 제출 요청의 자본·체결·risk는 준비 hash와
  // 데이터 범위에 의도적으로 포함되지 않는다(Task 5 contract).
  return input as BacktestRequest;
}

function parseStoredPreparationInput(requestJson: string): PreparationInput {
  let raw: unknown;
  try {
    raw = JSON.parse(requestJson);
  } catch {
    throw new PreparationInputError('저장된 준비 작업 요청 JSON을 해석할 수 없습니다.');
  }
  const parsed = preparationInputSchema.safeParse(raw);
  if (!parsed.success) {
    throw new PreparationInputError(
      parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; '),
    );
  }
  return parsed.data;
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
