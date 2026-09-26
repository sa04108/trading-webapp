import { datasetIdentity } from "../../../../runtime/shared/db/database-layout.js";
import { withDiagnostics, measureAsync } from "../../../../runtime/shared/diagnostics.js";
import { MAX_BACKTEST_BARS } from "../domain/bar-estimate.js";
import { createSubmissionValidator, preparedPreviewToResolved, pinnedScheduleIdentityError, validateStaticSubmission as validateStatic, type FundamentalsRequirementIssue, type SubmissionValidator } from "../application/submission-validation.js";
import type { PeriodValidationDto } from "../../../../shared/schemas/period-validation.js";
import type { DatabaseHandle } from "../../../../runtime/shared/db/database.js";
import { registerPeriodValidationRoutes } from "./period-validation-routes.js";
import { PreparationReferenceService } from "../application/preparation-reference-service.js";
import { createHash, randomUUID } from "node:crypto";
import type { EventEmitter } from "node:events";
import os from "node:os";
import fs from "node:fs";
import type {
  FastifyBaseLogger,
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
} from "fastify";
import { z } from "zod";
import {
  backtestRequestSchema,
  periodToTsRange,
  type BacktestRequest,
} from "../../../../shared/schemas/backtest-request.js";
import type { ProvenancePin } from "../../../../shared/schemas/provenance-pin.js";
import {
  universeCriterionSchema,
  universeDirectionSchema,
  universeRuleSchema,
} from "../../../../shared/schemas/universe-rule.js";
import type { UniverseRebalancingEntryDto } from "../../../../shared/schemas/universe-rebalancing.js";
import {
  DEFAULT_TRADE_SORT_DIRECTION,
  DEFAULT_TRADE_SORT_KEY,
  SORT_DIRECTIONS,
  TRADE_SORT_KEYS,
} from "../../../../shared/schemas/trade-sort.js";
import { SECURITY_HEADERS } from "../../../shared/security.js";
import type { Clock } from "../../../../runtime/shared/clock.js";
import type { AuditLogService } from "../../../../runtime/modules/audit/audit-service.js";
import type { FactCoverageStore } from "../../../../runtime/modules/facts/application/fact-coverage-store.js";
import type { FinancialFactAvailabilityService } from "../../../../runtime/modules/facts/application/financial-fact-availability.js";
import type { FactRepository } from "../../../../runtime/modules/facts/application/ports.js";
import type {
  ConsumedVersionSnapshot,
  SymbolService,
} from "../../../../runtime/modules/market-data/application/symbol-service.js";
import type { SymbolMasterService } from "../../../../runtime/modules/market-data/application/symbol-master-service.js";
import { sendIfKrxError, sendIfNotCovered } from "./krx-error-mapping.js";
import type {
  CandleCoverageService,
} from "../../../../runtime/modules/market-data/application/candle-coverage-service.js";
import type { StrategyRegistry } from "../../../../runtime/modules/strategy/application/strategy-registry.js";
import { strategyRequiresFinancialData } from "../../../../runtime/modules/strategy/domain/strategy.js";
import type { BenchmarkService } from "../../market-data/application/benchmark-service.js";
import { benchmarkPinSchema } from "../../../../shared/schemas/benchmark.js";

import {
  listCostProfiles,
  listSlippageProfiles,
} from "../../../../runtime/modules/backtest/domain/cost-profiles.js";
import type {
  JobOrchestrator,
  JobEvent,
} from "../application/job-orchestrator.js";
import type { BacktestJobRow, JobQueue } from "../application/job-queue.js";
import type { ExecutionProgress } from "../../../../shared/execution-progress.js";
import type { ResultsService } from "../application/results-service.js";
import { rebaseStoredRequest } from "../application/stored-request.js";
import { summarizeUniverseRebalancing } from "../application/universe-rebalancing.js";
import type {
  LegacyUniverseScheduleEntry,
} from "../../../../runtime/modules/backtest/application/universe-rule-resolver.js";
import {
  PreparationInputError,
  UnsafeBacktestSymbolIdentityError,
  type BacktestPreparationOrchestrator,
  type BacktestUniversePreview,
  type PreparationInput,
} from "../../../../runtime/modules/backtest/application/backtest-preparation-orchestrator.js";
import { backtestPreparationRequestHash } from "../../../../runtime/modules/backtest/application/backtest-preparation-plan.js";
import {
  delistedEventsToTsMsBySymbol,
  financialFactCutoffsFromCoverage,
} from "../../../../runtime/modules/backtest/application/backtest-financial-execution-window.js";
import { findIncompleteFundamentalCheckpointsFromCoverage } from "../../../../runtime/modules/backtest/application/backtest-financial-data-readiness.js";
import type {
  SeedCloneBatchDetail,
  SeedCloneBatchService,
} from "../application/seed-clone-batch-service.js";

type PreHandler = (
  request: FastifyRequest,
  reply: FastifyReply,
) => Promise<void>;

export interface BacktestRouteDeps {
  readonly database: DatabaseHandle;
  readonly submissionValidator?: SubmissionValidator;
  readonly onValidationFinished?: (experiment: PeriodValidationDto) => void;
  readonly queue: JobQueue;
  readonly orchestrator: JobOrchestrator;
  /** 로컬·원격 에이전트의 임대 관리가 발행하는 작업 상태·진행 이벤트. */
  readonly jobEvents: readonly EventEmitter[];
  readonly results: ResultsService;
  readonly strategies: StrategyRegistry;
  readonly symbolService: SymbolService;
  readonly symbolMaster: SymbolMasterService;
  /** 종목별 일봉 보유 구간 — `krx_daily_bars` 를 직접 집계한다(Task 6) */
  readonly candleCoverage: CandleCoverageService;
  readonly preparation: BacktestPreparationOrchestrator;
  readonly audit: AuditLogService;
  /** 재무 요구 검사(422)가 보는 SQLite coverage store. */
  readonly factCoverage: FactCoverageStore;
  /** 자본변동을 제외한 실제 재무 fact가 종목별 PIT cutoff까지 존재하는 종목. */
  readonly financialFacts: Pick<
    FinancialFactAvailabilityService,
    "symbolsWithFinancialFacts"
  >;
  readonly facts: Pick<FactRepository, "getFacts">;
  readonly dataRoot: string;
  readonly maxQueuedBacktests: number;
  readonly maxBacktestBars?: () => number;
  readonly executionProgress?: (job: BacktestJobRow) => ExecutionProgress | null;
  readonly clock: Clock;
  readonly benchmarks: BenchmarkService;
  readonly seedCloneBatches: SeedCloneBatchService;
}

const MIN_FREE_DISK_BYTES = 500 * 1024 * 1024;
const MIN_FREE_MEMORY_BYTES = 75 * 1024 * 1024;

/**
 * 회수 가능 메모리 (§34 리소스 가드).
 * Linux 의 os.freemem() 은 MemFree 라 페이지 캐시를 제외한다 — 장기 구동 서버에서
 * 항상 낮게 나와 건강한 호스트가 영구적으로 507 을 반환하게 된다.
 * /proc/meminfo 의 MemAvailable 을 우선 사용하고, 없는 플랫폼은 freemem 으로 fallback.
 */
function availableMemoryBytes(): number {
  try {
    const meminfo = fs.readFileSync("/proc/meminfo", "utf8");
    const match = /MemAvailable:\s+(\d+)\s*kB/.exec(meminfo);
    if (match) return Number(match[1]) * 1024;
  } catch {
    // /proc 이 없는 플랫폼 (Windows, macOS)
  }
  return os.freemem();
}

const BACKTEST_PROGRESS_EPOCH = randomUUID();
const BACKTEST_PROGRESS_REVISIONS = new Map<
  string,
  { signature: string; revision: number }
>();

function serializeJob(job: BacktestJobRow, database?: DatabaseHandle, queuedProgress?: ExecutionProgress | null) {
  const agentName =
    job.agentId && job.agentId !== "server-local" && database
      ? (database.sqlite
          .prepare("SELECT name FROM agent_clients WHERE id = ?")
          .get(job.agentId) as { name: string } | undefined)?.name
      : null;
  const actorKind =
    job.agentId === "server-local" ? "SERVER_AGENT" : "REMOTE_AGENT";
  const activity =
    (job.agentId && (job.status === "STARTING" || job.status === "RUNNING") && job.lastProgressAtMs === null
      ? "STARTING_WORKER"
      : job.executionActivity) ??
    (job.status === "QUEUED"
      ? "WAITING_FOR_EXECUTOR"
      : job.status === "STARTING"
        ? "LOADING_BACKTEST_INPUT"
        : null);
  const signature = JSON.stringify([
    job.status,
    job.executionActivity,
    job.progressBars,
    job.totalBars,
    job.progressLabel,
    job.resultTransferBytes,
    job.resultTransferTotalBytes,
    job.lastProgressAtMs,
    job.lastReceivedAtMs,
    queuedProgress,
  ]);
  const previous = BACKTEST_PROGRESS_REVISIONS.get(job.id);
  const progressRevision =
    previous?.signature === signature
      ? previous.revision
      : (previous?.revision ?? 0) + 1;
  if (["COMPLETED", "FAILED", "CANCELLED", "INTERRUPTED"].includes(job.status))
    BACKTEST_PROGRESS_REVISIONS.delete(job.id);
  else
    BACKTEST_PROGRESS_REVISIONS.set(job.id, {
      signature,
      revision: progressRevision,
    });
  return {
    id: job.id,
    status: job.status,
    strategyId: job.strategyId,
    request: JSON.parse(job.requestJson) as unknown,
    progressBars: job.progressBars,
    totalBars: job.totalBars,
    progressLabel: job.progressLabel,
    error: job.error,
    createdAtMs: job.createdAtMs,
    startedAtMs: job.startedAtMs,
    completedAtMs: job.completedAtMs,
    cloneBatchId: job.cloneBatchId,
    cloneSourceJobId: job.cloneSourceJobId,
    progressEpoch: BACKTEST_PROGRESS_EPOCH,
    progressRevision,
    progress: queuedProgress ?? (
      activity === null
        ? null
        : {
            activity,
            detail:
              job.status === "QUEUED"
                ? "배정 가능한 계산 슬롯을 기다리는 중"
                : activity === "STARTING_WORKER"
                  ? "실행기를 배정했습니다. 계산 프로세스를 시작하고 첫 진행 보고를 기다립니다"
                  : job.progressLabel,
            actorKind: job.status === "QUEUED" ? "SERVER" : actorKind,
            actorId: job.status === "QUEUED" ? null : job.agentId,
            actorName:
              job.status === "QUEUED"
                ? "운영 서버 배정기"
                : actorKind === "SERVER_AGENT"
                  ? "운영 서버 내부 agent"
                  : (agentName ?? "원격 agent"),
            unit:
              activity === "UPLOADING_RESULT" && job.resultTransferTotalBytes
                ? "BYTES"
                : job.totalBars !== null && job.totalBars > 0
                  ? "BARS"
                  : null,
            completed:
              activity === "UPLOADING_RESULT"
                ? job.resultTransferBytes
                : job.totalBars !== null && job.totalBars > 0
                  ? job.progressBars
                  : null,
            total:
              activity === "UPLOADING_RESULT"
                ? job.resultTransferTotalBytes
                : job.totalBars !== null && job.totalBars > 0
                  ? job.totalBars
                  : null,
            currentItem: job.progressLabel,
            attempt: job.attempt || null,
            retryCount: job.leaseFailures,
            startedAtMs: job.activityStartedAtMs ?? job.startedAtMs ?? job.createdAtMs,
            lastProgressAtMs: job.lastProgressAtMs,
            lastReceivedAtMs: job.lastReceivedAtMs,
            nextResumeAtMs: null,
          }),
  };
}

function preparationInputOf(body: BacktestRequest): PreparationInput {
  return {
    universeRule: body.universeRule,
    period: body.period,
    strategyId: body.strategyId,
    parameters: body.parameters,
  };
}

function scheduleHash(
  schedule: readonly LegacyUniverseScheduleEntry[],
): string {
  return createHash("sha256").update(JSON.stringify(schedule)).digest("hex");
}

const consumedVersionSnapshotSchema = z.object({
  entries: z.array(
    z.object({
      code: z.string(),
      slice: z.string(),
      version: z.number().int().nonnegative(),
      contentHash: z.string(),
    }),
  ),
  hash: z.string(),
});

const orderedProvenancePinSchema = z.object({
  sourceKind: z.literal("SYMBOL_MASTER"),
  filterPolicyVersion: z.string().nullable(),
  selectionMethod: z.literal("ORDERED_UNIVERSE_PIPELINE"),
  universeRule: universeRuleSchema,
  scheduleHash: z.string(),
  diagnostics: z.array(
    z.object({
      rebalanceDate: z.string(),
      effectiveDate: z.string(),
      stages: z.array(
        z.object({
          criterion: universeCriterionSchema,
          direction: universeDirectionSchema,
          inputCount: z.number().int().nonnegative(),
          eligibleCount: z.number().int().nonnegative(),
          selectedCount: z.number().int().nonnegative(),
          excludedMissingCount: z.number().int().nonnegative(),
        }),
      ),
    }),
  ),
  preparedAtMs: z.number().int().nonnegative(),
});

function parseStoredSchedule(
  job: BacktestJobRow,
): LegacyUniverseScheduleEntry[] | null {
  try {
    const parsed: unknown = JSON.parse(job.universeScheduleJson);
    return Array.isArray(parsed) && parsed.length > 0
      ? (parsed as LegacyUniverseScheduleEntry[])
      : null;
  } catch {
    return null;
  }
}

/**
 * provenancePinJson 은 저장 시점에 이미 검증된 값이라 정상 상태에서는 항상 파싱된다.
 * 그래도 행이 손상돼 있으면(예: 수동 DB 편집) 상세 조회 전체를 500 으로 죽이는 대신
 * pin 만 null 로 내리고 나머지 응답(job·run·metrics)은 그대로 성공시킨다.
 */
function parseProvenancePin(
  provenancePinJson: string | null,
  jobId: string,
  logger: FastifyBaseLogger,
): ProvenancePin | null {
  if (!provenancePinJson) return null;
  try {
    return JSON.parse(provenancePinJson) as ProvenancePin;
  } catch (error) {
    logger.warn(
      { event: "backtest.provenance_pin.parse_failed", jobId, err: error },
      "provenancePinJson 파싱에 실패해 pin 없이 응답한다",
    );
    return null;
  }
}

function parseUniverseRebalancing(
  universeScheduleJson: string,
  jobId: string,
  logger: FastifyBaseLogger,
): UniverseRebalancingEntryDto[] {
  try {
    const schedule = JSON.parse(
      universeScheduleJson,
    ) as LegacyUniverseScheduleEntry[];
    return summarizeUniverseRebalancing(schedule);
  } catch (error) {
    logger.warn(
      { event: "backtest.universe_schedule.parse_failed", jobId, err: error },
      "universeScheduleJson 파싱에 실패해 종목 리밸런싱 요약 없이 응답한다",
    );
    return [];
  }
}

async function checkResources(dataRoot: string): Promise<string | null> {
  if (availableMemoryBytes() < MIN_FREE_MEMORY_BYTES) {
    return "여유 메모리가 부족해 새 백테스트를 시작할 수 없습니다. 실행 중인 작업이 끝난 뒤 다시 시도하세요.";
  }
  try {
    const stats = await fs.promises.statfs(dataRoot);
    if (stats.bavail * stats.bsize < MIN_FREE_DISK_BYTES) {
      return "디스크 공간이 부족해 새 백테스트를 시작할 수 없습니다. 저장 공간을 확보한 뒤 다시 시도하세요.";
    }
  } catch {
    // statfs 실패 시 가드를 건너뛴다
  }
  return null;
}

export function registerBacktestRoutes(
  app: FastifyInstance,
  deps: BacktestRouteDeps,
  requireAuth: PreHandler,
): void {
  const {
    queue,
    orchestrator,
    jobEvents,
    results,
    strategies,
    symbolService,
    symbolMaster,
    candleCoverage,
    preparation,
    audit,
    financialFacts,
    clock,
    benchmarks,
    seedCloneBatches,
  } = deps;

  const serializeJobSummary = (job: BacktestJobRow) => ({
    ...serializeJob(job, deps.database, deps.executionProgress?.(job)),
    metrics: job.status === "COMPLETED" ? results.getMetrics(job.id) : null,
  });

  const serializeBatch = (
    detail: SeedCloneBatchDetail,
    includeItems: boolean,
  ) => {
    const statuses = detail.items.map(({ item, job }) => {
      if (item.state === "PENDING") return "PENDING";
      if (item.state === "CANCELLED") return "CANCELLED";
      return job?.status ?? "DELETED";
    });
    const count = (status: string) =>
      statuses.filter((value) => value === status).length;
    const runningCount = statuses.filter(
      (status) =>
        status === "STARTING" ||
        status === "RUNNING" ||
        status === "CANCELLING",
    ).length;
    const response = {
      id: detail.batch.id,
      sourceJobId: detail.batch.sourceJobId,
      strategyId: detail.batch.strategyId,
      status: detail.batch.status,
      totalCount: detail.batch.totalCount,
      pendingCount: count("PENDING"),
      queuedCount: count("QUEUED"),
      runningCount,
      completedCount: count("COMPLETED"),
      failedCount: count("FAILED"),
      cancelledCount: count("CANCELLED"),
      interruptedCount: count("INTERRUPTED"),
      deletedCount: count("DELETED"),
      request: JSON.parse(detail.batch.requestJson) as unknown,
      error: detail.batch.error,
      createdAtMs: detail.batch.createdAtMs,
      completedAtMs: detail.batch.completedAtMs,
    };
    if (!includeItems) return response;
    return {
      ...response,
      items: detail.items.map(({ item, job }) => ({
        ordinal: item.ordinal,
        randomSeed: item.randomSeed,
        jobId: job?.id ?? null,
        status:
          item.state === "PENDING"
            ? "PENDING"
            : item.state === "CANCELLED"
              ? "CANCELLED"
              : (job?.status ?? "DELETED"),
        metrics: job ? results.getMetrics(job.id) : null,
      })),
    };
  };

  const validateStaticSubmission = (body: BacktestRequest) => validateStatic(body, strategies);
  const validateSubmission = async (
    body: BacktestRequest,
    preview: BacktestUniversePreview,
    http?: { request: FastifyRequest; reply: FastifyReply },
  ) => {
    if (!deps.submissionValidator) return createSubmissionValidator(deps).validate(body, preview);
    const abort = new AbortController();
    const onClose = () => { if (!http?.reply.raw.writableFinished) abort.abort(); };
    http?.reply.raw.once("close", onClose);
    if (http?.reply.raw.destroyed) abort.abort();
    try {
      return await withDiagnostics({ reqId: http?.request.id, preparationJobId: preview.preparationJobId },
        (fields) => {
          const logger = http?.request.log ?? app.log;
          if (fields.outcome === "FAILED") logger.warn(fields, "제출 검증 단계 실패");
          else logger.info(fields, "제출 검증 단계");
        }, () => measureAsync("submission.validation", () => deps.submissionValidator!.validate({
        body, preview, maxBars: deps.maxBacktestBars?.() ?? MAX_BACKTEST_BARS,
        nowMs: clock.now(), snapshot: datasetIdentity(deps.database.sqlite),
      }, abort.signal), { logStart: true, itemCount: preview.unionSymbols.length }));
    } finally {
      http?.reply.raw.off("close", onClose);
    }
  };

  const sendFundamentalsIssue = (
    reply: FastifyReply,
    issue: FundamentalsRequirementIssue,
  ): FastifyReply =>
    reply.code(409).send({
      error: "PREPARATION_REQUIRED",
      message: issue.message,
    });

  /**
   * 보유 종목 수(topN) × 동시 보유 상한(maxPositions) 정합성 검사.
   *
   * 두 값이 어긋나면 결과가 조용히 틀린다: 매수 단계는 topN 건의 주문을 각각
   * `equity / topN` 으로 내는데, 엔진의 리스크 검증은 상한을 넘는 주문을 `null` 로
   * 떨어뜨린다. 초과분은 폐기되고 `pendingTargets` 는 이미 비워졌으므로 다음 리밸런스까지
   * 재시도되지 않는다 — 자본의 (topN-maxPositions)/topN 이 영구히 현금으로 남는데
   * 자산 곡선은 정상적으로 보인다. 기본값 조합(value-quality-rank topN=20, 웹 마법사
   * maxPositions=10)이 정확히 이 상태다.
   *
   * 전략 id 를 특별 취급하지 않고 **검증된 파라미터에 숫자 `topN` 이 있으면** 본다 —
   * range-breakout 처럼 이 파라미터가 없는 전략은 자연히 통과한다.
   * 400(요청 형식)이 아니라 422 다. 요청 자체는 유효하고
   * "전략 파라미터와 리스크 설정의 조합" 이 문제다.
   */
  const checkPositionCapacity = (body: BacktestRequest): string | null => {
    const validated = strategies.validateParameters(
      body.strategyId,
      body.parameters,
    );
    // 파라미터 자체가 스키마를 통과하지 못하는 경우는 validateSubmission 이 400 으로 말한다
    if (
      !validated.ok ||
      typeof validated.value !== "object" ||
      validated.value === null
    ) {
      return null;
    }
    const topN = (validated.value as Record<string, unknown>)["topN"];
    if (typeof topN !== "number" || !Number.isFinite(topN)) return null;
    if (topN <= body.risk.maxPositions) return null;
    return (
      `보유 종목 수(${topN})가 최대 동시 보유 종목 수(${body.risk.maxPositions})보다 큽니다. ` +
      `초과분 ${topN - body.risk.maxPositions}종목은 편입되지 못하고 그만큼 자본이 현금으로 남습니다. ` +
      "보유 종목 수를 줄이거나 최대 동시 보유 종목 수를 그 이상으로 올리세요."
    );
  };

  /**
   * 원본 job이 소유한 exact preparation ID의 검증 결과와 고정 schedule이 일치할 때만
   * 복제 미리보기를 재사용한다. DB의 보존 snapshot과 hash를 확인하므로 종목 마스터를
   * 다시 해소하지 않는다. 현재 요청의 전략·파라미터·기간·규칙이 다르면 검증에서 거부한다.
   */
  const reusablePreviewFor = async (
    job: BacktestJobRow,
    sourceRequest: BacktestRequest,
  ): Promise<{
    preview: BacktestUniversePreview;
    schedule: LegacyUniverseScheduleEntry[];
    universe: ConsumedVersionSnapshot;
    provenancePin: ProvenancePin;
    benchmark: {
      pin: ReturnType<typeof benchmarkPinSchema.parse>;
      hash: string;
    };
    response: BacktestUniversePreview & { fundamentalSymbols: string[] };
  } | null> => {
    if (job.preparationJobId === null) return null;
    const preview = await preparation.getCachedPreviewIsolated(
      preparationInputOf(sourceRequest),
      job.preparationJobId,
    );
    const schedule = parseStoredSchedule(job);
    if (!preview || !schedule) return null;
    const resolved = preparedPreviewToResolved(preview);
    if (scheduleHash(schedule) !== resolved.scheduleHash) return null;

    if (job.universeJson === null || job.universeHash === null) return null;
    let universe: ConsumedVersionSnapshot;
    try {
      const parsed = consumedVersionSnapshotSchema.safeParse({
        entries: JSON.parse(job.universeJson) as unknown,
        hash: job.universeHash,
      });
      if (!parsed.success) return null;
      const actualHash = createHash("sha256")
        .update(
          parsed.data.entries
            .map(
              (entry) =>
                `${entry.code}:${entry.slice}:${entry.version}:${entry.contentHash}`,
            )
            .join("|"),
        )
        .digest("hex");
      if (actualHash !== parsed.data.hash) return null;
      universe = parsed.data;
    } catch {
      return null;
    }

    if (job.provenancePinJson === null) return null;
    let provenancePin: ProvenancePin;
    try {
      const parsed = orderedProvenancePinSchema.safeParse(
        JSON.parse(job.provenancePinJson),
      );
      if (!parsed.success || parsed.data.scheduleHash !== resolved.scheduleHash)
        return null;
      provenancePin = parsed.data;
    } catch {
      return null;
    }

    if (job.benchmarkJson === null || job.benchmarkHash === null) return null;
    let benchmark: {
      pin: ReturnType<typeof benchmarkPinSchema.parse>;
      hash: string;
    };
    try {
      const parsed = benchmarkPinSchema.safeParse(
        JSON.parse(job.benchmarkJson),
      );
      const requestedBenchmarkId = sourceRequest.benchmarkId ?? "KOSPI";
      if (
        !parsed.success ||
        parsed.data.benchmarkId !== requestedBenchmarkId ||
        parsed.data.period.from !== sourceRequest.period.from ||
        parsed.data.period.to !== sourceRequest.period.to
      ) {
        return null;
      }
      const actualHash = createHash("sha256")
        .update(JSON.stringify(parsed.data))
        .digest("hex");
      if (actualHash !== job.benchmarkHash) return null;
      benchmark = { pin: parsed.data, hash: job.benchmarkHash };
    } catch {
      return null;
    }

    const factCutoffs = financialFactCutoffsFromCoverage({
      period: sourceRequest.period,
      schedule,
      delistedTsMsBySymbol: delistedEventsToTsMsBySymbol(
        symbolMaster.delistedEventsBetween(
          sourceRequest.period.from,
          sourceRequest.period.to,
        ),
      ),
      candles: candleCoverage,
    });
    const codesWithFundamentals =
      financialFacts.symbolsWithFinancialFacts(factCutoffs);
    const sourceStrategy = strategies.get(sourceRequest.strategyId);
    if (sourceStrategy && strategyRequiresFinancialData(sourceStrategy)) {
      const incomplete =
        sourceStrategy.dataRequirements?.fundamentalsReady === undefined
          ? resolved.unionSymbols.filter(
              (code) => !codesWithFundamentals.has(code),
            )
          : await findIncompleteFundamentalCheckpointsFromCoverage({
              strategy: sourceStrategy,
              parameters: sourceRequest.parameters,
              facts: deps.facts,
              schedule,
              candles: candleCoverage,
              period: sourceRequest.period,
            });
      if (incomplete.length > 0) return null;
    }
    return {
      preview,
      schedule,
      universe,
      provenancePin,
      benchmark,
      response: {
        ...preview,
        fundamentalSymbols: resolved.unionSymbols.filter((code) =>
          codesWithFundamentals.has(code),
        ),
      },
    };
  };

  /**
   * 대기열 깊이 상한 (D-025). QUEUED 만 센다 — 실행 중은 동시 실행 상한이 이미 묶고 있다.
   * 429 는 507(호스트 자원 부족)과 구분한다: 사용자가 할 일이 다르다(기다리거나 취소).
   */
  const queueDepthError = (): string | null => {
    const queued = queue.countByStatus(["QUEUED"]);
    if (queued < deps.maxQueuedBacktests) return null;
    return `대기 중인 백테스트가 ${queued}건으로 상한(${deps.maxQueuedBacktests})에 도달했습니다. 완료되거나 취소된 뒤 제출하세요.`;
  };

  const validations = registerPeriodValidationRoutes(
    app,
    {
      database: deps.database,
      clock,
      queue,
      results,
      strategies,
      preparation,
      collectPreparations: () =>
        new PreparationReferenceService(deps.database).collect(),
      onFinished: deps.onValidationFinished,
      validateRequest: (body) => {
        const errors = validateStaticSubmission(body);
        const capacity = checkPositionCapacity(body);
        return capacity ? [...errors, capacity] : errors;
      },
      cancelJob: (jobId) => {
        orchestrator.cancel(jobId);
      },
      buildEnqueue: async (body, prepared) => {
        if (queueDepthError()) return null;
        const resourceError = await checkResources(deps.dataRoot);
        if (resourceError) throw new Error(resourceError);
        const validated = await validateSubmission(body, prepared);
        if (!validated.ok) throw new Error(validated.errors[0]);
        const fundamentals = validated.fundamentalsIssue;
        if (fundamentals) throw new Error(fundamentals.message);
        if (
          symbolMaster.tradingDaysBetween(body.period.from, body.period.to)
            .length < 2
        ) {
          throw new Error(
            "각 독립 평가 구간에는 실제 시장 거래일이 2개 이상 필요합니다.",
          );
        }
        const strategy = strategies.get(body.strategyId)!;
        const parameters = strategy.parameterSchema.parse(body.parameters);
        const warmupBars = Math.ceil(
          Math.max(
            0,
            strategy.dataRequirements?.priceWarmupBars?.(parameters) ?? 0,
            ...body.universeRule.stages.map((stage) =>
              stage.criterion === "DECLINE" ? stage.lookbackTradingDays : 0,
            ),
          ),
        );
        const prior = deps.database.sqlite
          .prepare(
            `
        SELECT COUNT(*) AS count FROM (
          SELECT date FROM symbol_master_trading_days WHERE date < ? ORDER BY date DESC LIMIT ?
        )
      `,
          )
          .get(body.period.from, warmupBars) as { count: number };
        if (prior.count < warmupBars) {
          throw new Error(
            `독립 평가 시작 전 지표 준비 데이터가 부족합니다 (필요 ${warmupBars}거래일, 확보 ${prior.count}거래일). 과거 데이터를 준비한 뒤 다시 실행하세요.`,
          );
        }
        const benchmarkId = body.benchmarkId ?? "KOSPI";
        const benchmark = benchmarks.pin(benchmarkId, body.period);
        return () => {
          if (queueDepthError()) return null;
          return queue.enqueue(
            { ...body, benchmarkId, timeframe: validated.timeframe },
            validated.resolved.schedule,
            validated.universe,
            validated.provenancePin,
            validated.warnings,
            benchmark,
            {
              estimatedBars: validated.estimatedBars,
              submissionSnapshot: validated.snapshot,
              preparationJobId: prepared.preparationJobId,
            },
          );
        };
      },
    },
    requireAuth,
  );

  app.get("/backtests/profiles", { preHandler: requireAuth }, async () => ({
    commissionProfiles: listCostProfiles(),
    slippageProfiles: listSlippageProfiles(),
  }));

  app.post(
    "/backtests",
    { preHandler: requireAuth },
    async (request, reply) => {
      const parsed = backtestRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({
          error: parsed.error.issues
            .map((i) => `${i.path.join(".")}: ${i.message}`)
            .join("; "),
        });
      }
      const body = parsed.data;

      // 잘못된 요청을 PREPARATION_REQUIRED로 가리면 사용자는 완료할 수 없는 준비를
      // 시작하게 된다. 외부 데이터와 무관한 검증은 preparation hash 조회보다 먼저 한다.
      const staticErrors = validateStaticSubmission(body);
      if (staticErrors.length > 0) {
        return reply.code(400).send({ error: staticErrors[0] });
      }

      // getReadyPreview 도 resolver 를 거치므로 validateSubmission 과 같은 KRX/coverage
      // 오류가 난다 — 같은 매핑(429/503/409)을 적용해야 네 줄 아래와 다른 500 이 되지 않는다.
      let prepared: Awaited<ReturnType<typeof preparation.getReadyPreview>>;
      try {
        prepared = preparation.getReadyPreviewForWizard(
          preparationInputOf(body),
          request.authUser!.id,
        );
      } catch (error) {
        if (sendIfKrxError(reply, error)) return reply;
        if (sendIfNotCovered(reply, error)) return reply;
        if (error instanceof UnsafeBacktestSymbolIdentityError) {
          return reply.code(422).send({ error: error.message });
        }
        if (error instanceof PreparationInputError) {
          return reply.code(400).send({ error: error.message });
        }
        throw error;
      }
      if (!prepared) {
        return reply.code(409).send({
          error: "PREPARATION_REQUIRED",
          message: "동일한 조건의 데이터 준비를 먼저 완료하세요.",
        });
      }

      let validated: Awaited<ReturnType<typeof validateSubmission>>;
      try {
        validated = await validateSubmission(body, prepared, { request, reply });
      } catch (error) {
        if (sendIfKrxError(reply, error)) return reply;
        if (sendIfNotCovered(reply, error)) return reply;
        throw error;
      }
      if (!validated.ok) {
        return reply.code(validated.status).send({
          error: validated.errors[0] ?? "제출을 검증할 수 없습니다",
          ...("uncoveredDates" in validated
            ? { uncoveredDates: validated.uncoveredDates }
            : {}),
        });
      }

      const fundamentalsIssue = validated.fundamentalsIssue;
      if (fundamentalsIssue) {
        return sendFundamentalsIssue(reply, fundamentalsIssue);
      }

      const capacityError = checkPositionCapacity(body);
      if (capacityError) {
        return reply.code(422).send({ error: capacityError });
      }

      const queueError = queueDepthError();
      if (queueError) return reply.code(429).send({ error: queueError });

      const resourceError = await checkResources(deps.dataRoot);
      if (resourceError) return reply.code(507).send({ error: resourceError });
      if (reply.raw.destroyed) return reply;

      // 해소한 소비 봉을 요청에 박아 저장한다 — 워커가 다시 추론하면 두 곳의 규칙이
      // 갈라질 수 있고, 실행 기록도 "무엇을 소비했나" 에 답하지 못한다.
      // provenancePin 은 여기서 조립한 것 그대로 저장한다 — 클라이언트가 준 값이 아니다.
      const benchmarkId = body.benchmarkId ?? "KOSPI";
      const benchmark = benchmarks.pin(benchmarkId, body.period);
      const job = queue.enqueue(
        { ...body, benchmarkId, timeframe: validated.timeframe },
        validated.resolved.schedule,
        validated.universe,
        validated.provenancePin,
        validated.warnings,
        benchmark,
        {
          estimatedBars: validated.estimatedBars,
          submissionSnapshot: validated.snapshot,
          preparationJobId: prepared.preparationJobId,
          wizardOwner: { userId: request.authUser!.id, requireMatch: true },
        },
      );
      audit.record(request.authUser?.username ?? "admin", "backtest.created", {
        jobId: job.id,
        strategyId: body.strategyId,
        universeRule: body.universeRule,
        scheduleHash: validated.provenancePin.scheduleHash,
        benchmarkId,
        benchmarkHash: benchmark.hash,
      });
      return reply
        .code(201)
        .send({ job: serializeJob(job, deps.database, deps.executionProgress?.(job)), warnings: validated.warnings });
    },
  );

  app.get("/backtests", { preHandler: requireAuth }, async (request, reply) => {
    const parsedQuery = z
      .object({
        limit: z.coerce.number().int().min(1).max(200).default(50),
        offset: z.coerce.number().int().min(0).default(0),
      })
      .safeParse(request.query ?? {});
    if (!parsedQuery.success) {
      return reply
        .code(400)
        .send({ error: "쿼리 파라미터가 올바르지 않습니다 (limit/offset)" });
    }
    const query = parsedQuery.data;
    const jobs = queue.listTopLevelJobs(query.limit, query.offset);
    return {
      jobs: jobs.map(serializeJobSummary),
    };
  });

  app.get(
    "/backtests/:id",
    { preHandler: requireAuth },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const job = queue.getJob(id);
      if (!job)
        return reply.code(404).send({ error: "작업을 찾을 수 없습니다" });
      return {
        job: serializeJob(job, deps.database, deps.executionProgress?.(job)),
        run: results.getRun(id),
        metrics: results.getMetrics(id),
        benchmark: results.getBenchmark(id),
        // job 이 제출 시점부터 갖고 있다 — run 완료를 기다릴 필요가 없다 (Task 12).
        // 완료 후에는 backtestRuns.provenancePinJson 에 같은 값이 복사돼 있다.
        provenancePin: parseProvenancePin(
          job.provenancePinJson,
          id,
          request.log,
        ),
        universeRebalancing: parseUniverseRebalancing(
          job.universeScheduleJson,
          id,
          request.log,
        ),
      };
    },
  );

  app.post(
    "/backtests/:id/cancel",
    { preHandler: requireAuth },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const outcome = orchestrator.cancel(id);
      if (outcome === "NOT_CANCELLABLE") {
        return reply.code(409).send({ error: "취소할 수 없는 상태입니다" });
      }
      return { status: outcome };
    },
  );

  app.post(
    "/backtests/:id/clone",
    { preHandler: requireAuth },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const job = queue.getJob(id);
      if (!job)
        return reply.code(404).send({ error: "작업을 찾을 수 없습니다" });
      // 복제는 §10 이 지정한 중단 작업 복구 경로다 — 스키마·전략 버전이 올라갔다고 막지 않고,
      // 현재 기준으로 재기준한 뒤 무엇이 달라졌는지 경고로 알린다.
      const rebased = rebaseStoredRequest(
        job.requestJson,
        strategies.get(job.strategyId)?.version ?? null,
      );
      if (!rebased.ok) return reply.code(400).send({ error: rebased.error });
      const cloneRequest = rebased.request;
      const reusable = await reusablePreviewFor(job, cloneRequest);
      let prepared: Awaited<ReturnType<typeof preparation.getReadyPreview>>;
      try {
        prepared =
          reusable?.preview ??
          preparation.getReadyPreviewForWizard(
            preparationInputOf(cloneRequest),
            request.authUser!.id,
          );
      } catch (error) {
        if (sendIfKrxError(reply, error)) return reply;
        if (sendIfNotCovered(reply, error)) return reply;
        if (error instanceof UnsafeBacktestSymbolIdentityError) {
          return reply.code(422).send({ error: error.message });
        }
        if (error instanceof PreparationInputError) {
          return reply.code(400).send({ error: error.message });
        }
        throw error;
      }
      if (!prepared) {
        return reply.code(409).send({
          error: "PREPARATION_REQUIRED",
          message: "동일한 조건의 데이터 준비를 먼저 완료하세요.",
        });
      }
      // 재기준 후에도 새 제출이다 — POST 와 동일한 검증 관문을 거치고 버전을 다시 고정한다.
      let validated: Awaited<ReturnType<typeof validateSubmission>>;
      try {
        // 완료된 preparation이 같은 staged schedule을 이미 등록·고정했다.
        validated = await validateSubmission(cloneRequest, prepared, { request, reply });
      } catch (error) {
        if (sendIfKrxError(reply, error)) return reply;
        if (sendIfNotCovered(reply, error)) return reply;
        throw error;
      }
      if (!validated.ok) {
        return reply.code(validated.status).send({
          error: validated.errors[0] ?? "제출을 검증할 수 없습니다",
          ...("uncoveredDates" in validated
            ? { uncoveredDates: validated.uncoveredDates }
            : {}),
        });
      }

      const fundamentalsIssue = validated.fundamentalsIssue;
      if (fundamentalsIssue) {
        return sendFundamentalsIssue(reply, fundamentalsIssue);
      }

      const capacityError = checkPositionCapacity(cloneRequest);
      if (capacityError) {
        return reply.code(422).send({ error: capacityError });
      }

      const queueError = queueDepthError();
      if (queueError) return reply.code(429).send({ error: queueError });

      // §34 리소스 가드도 관문의 일부다 — 복제라고 디스크·메모리 한계를 넘어설 이유는 없다
      const resourceError = await checkResources(deps.dataRoot);
      if (resourceError) return reply.code(507).send({ error: resourceError });
      if (reply.raw.destroyed) return reply;

      // 응답과 저장이 같은 합집합을 써야 한다 — 한쪽만 고치면 화면과 기록이 갈라진다
      const benchmarkId = cloneRequest.benchmarkId ?? "KOSPI";
      const benchmark = benchmarks.pin(benchmarkId, cloneRequest.period);
      const cloneWarnings = [...rebased.warnings, ...validated.warnings];
      const cloned = queue.enqueue(
        { ...cloneRequest, benchmarkId, timeframe: validated.timeframe },
        reusable?.schedule ?? validated.resolved.schedule,
        reusable?.universe ?? validated.universe,
        reusable?.provenancePin ?? validated.provenancePin,
        cloneWarnings,
        reusable?.benchmark ?? benchmark,
        {
          estimatedBars: validated.estimatedBars,
          submissionSnapshot: validated.snapshot,
          cloneSourceJobId: id,
          preparationJobId: prepared.preparationJobId,
          ...(reusable
            ? {}
            : {
                wizardOwner: {
                  userId: request.authUser!.id,
                  requireMatch: true,
                },
              }),
        },
      );
      audit.record(request.authUser?.username ?? "admin", "backtest.cloned", {
        sourceJobId: id,
        jobId: cloned.id,
        ...(rebased.warnings.length > 0
          ? { rebaseWarnings: rebased.warnings }
          : {}),
      });
      return reply
        .code(201)
        .send({ job: serializeJob(cloned, deps.database, deps.executionProgress?.(cloned)), warnings: cloneWarnings });
    },
  );

  /**
   * 재설정 위저드가 원본 준비 결과를 재사용해 제출하는 경로. 클라이언트의 "미리보기
   * 유효" 판정을 신뢰하지 않고 현재 전략 버전을 포함한 준비 hash와 원본 고정 일정을
   * 서버에서 다시 대조한다. 자본·비용·벤치마크·보유 상한·시드만 바뀐 경우에는 이
   * hash가 그대로라 전체 유니버스 해소 없이 검증 단계에서 바로 복제할 수 있다.
   */
  app.post(
    "/backtests/:id/clone-configured",
    { preHandler: requireAuth },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const sourceJob = queue.getJob(id);
      if (!sourceJob)
        return reply.code(404).send({ error: "작업을 찾을 수 없습니다" });

      const parsed = backtestRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({
          error: parsed.error.issues
            .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
            .join("; "),
        });
      }
      const body = parsed.data;
      const staticErrors = validateStaticSubmission(body);
      if (staticErrors.length > 0)
        return reply.code(400).send({ error: staticErrors[0] });

      const rebased = rebaseStoredRequest(
        sourceJob.requestJson,
        strategies.get(sourceJob.strategyId)?.version ?? null,
      );
      if (!rebased.ok) return reply.code(400).send({ error: rebased.error });
      const strategy = strategies.get(body.strategyId);
      if (!strategy)
        return reply
          .code(400)
          .send({ error: `알 수 없는 전략: ${body.strategyId}` });
      const sourceStrategy = strategies.get(rebased.request.strategyId);
      if (
        !sourceStrategy ||
        backtestPreparationRequestHash(body, strategy) !==
          backtestPreparationRequestHash(rebased.request, sourceStrategy)
      ) {
        return reply.code(409).send({
          error: "PREVIEW_REQUIRED",
          message:
            "유니버스 준비에 영향을 주는 설정이 바뀌었습니다. 미리보기를 다시 실행하세요.",
        });
      }

      const reusable = await reusablePreviewFor(sourceJob, rebased.request);
      if (!reusable) {
        return reply.code(409).send({
          error: "PREVIEW_REQUIRED",
          message:
            "원본의 준비 결과를 안전하게 재사용할 수 없습니다. 미리보기를 다시 실행하세요.",
        });
      }

      const validated = await validateSubmission(body, reusable.preview, { request, reply });
      if (!validated.ok) {
        return reply.code(validated.status).send({
          error: validated.errors[0] ?? "제출을 검증할 수 없습니다",
          ...("uncoveredDates" in validated
            ? { uncoveredDates: validated.uncoveredDates }
            : {}),
        });
      }
      const fundamentalsIssue = validated.fundamentalsIssue;
      if (fundamentalsIssue)
        return sendFundamentalsIssue(reply, fundamentalsIssue);
      const capacityError = checkPositionCapacity(body);
      if (capacityError) return reply.code(422).send({ error: capacityError });
      const queueError = queueDepthError();
      if (queueError) return reply.code(429).send({ error: queueError });
      const resourceError = await checkResources(deps.dataRoot);
      if (resourceError) return reply.code(507).send({ error: resourceError });
      if (reply.raw.destroyed) return reply;

      const benchmarkId = body.benchmarkId ?? "KOSPI";
      const sourceBenchmarkId = rebased.request.benchmarkId ?? "KOSPI";
      // 검토 단계에서 누락분을 동기화했다면 불완전한 원본 pin을 다시 복제하지 않는다.
      const benchmark =
        benchmarkId === sourceBenchmarkId && reusable.benchmark.pin.covered
          ? reusable.benchmark
          : benchmarks.pin(benchmarkId, body.period);
      const cloneWarnings = [...rebased.warnings, ...validated.warnings];
      const cloned = queue.enqueue(
        { ...body, benchmarkId, timeframe: validated.timeframe },
        reusable.schedule,
        reusable.universe,
        reusable.provenancePin,
        cloneWarnings,
        benchmark,
        {
          estimatedBars: validated.estimatedBars,
          submissionSnapshot: validated.snapshot,
          cloneSourceJobId: id,
          preparationJobId: reusable.preview.preparationJobId,
          wizardOwner: { userId: request.authUser!.id, context: id },
        },
      );
      audit.record(
        request.authUser?.username ?? "admin",
        "backtest.cloned-configured",
        {
          sourceJobId: id,
          jobId: cloned.id,
          reusedUniverse: true,
          ...(rebased.warnings.length > 0
            ? { rebaseWarnings: rebased.warnings }
            : {}),
        },
      );
      return reply
        .code(201)
        .send({ job: serializeJob(cloned, deps.database, deps.executionProgress?.(cloned)), warnings: cloneWarnings });
    },
  );

  app.post(
    "/backtests/:id/clone-random-seeds",
    { preHandler: requireAuth },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const sourceJob = queue.getJob(id);
      if (!sourceJob)
        return reply.code(404).send({ error: "작업을 찾을 수 없습니다" });
      if (sourceJob.cloneBatchId !== null) {
        return reply.code(409).send({
          error:
            "난수 시드 실험의 자식 실행에서는 새 난수 실험을 만들 수 없습니다. 원본 백테스트에서 시작하세요.",
        });
      }
      if (
        strategies.describe(sourceJob.strategyId)?.supportsRandomSeed === false
      ) {
        return reply
          .code(400)
          .send({
            error:
              "이 전략은 난수 시드의 영향을 받지 않아 새 난수로 복제할 수 없습니다.",
          });
      }
      const countBody = z
        .object({ count: z.number().int().min(1).max(100) })
        .safeParse(request.body);
      if (!countBody.success) {
        return reply
          .code(400)
          .send({ error: "실행 개수는 1~100 사이의 정수여야 합니다." });
      }

      const rebased = rebaseStoredRequest(
        sourceJob.requestJson,
        strategies.get(sourceJob.strategyId)?.version ?? null,
      );
      if (!rebased.ok) return reply.code(400).send({ error: rebased.error });
      const body = rebased.request;
      const staticErrors = validateStaticSubmission(body);
      if (staticErrors.length > 0)
        return reply.code(400).send({ error: staticErrors[0] });
      const reusable = await reusablePreviewFor(sourceJob, body);
      if (!reusable) {
        return reply.code(409).send({
          error: "PREVIEW_REQUIRED",
          message:
            "원본의 준비 결과를 안전하게 재사용할 수 없습니다. 재설정 및 복제에서 미리보기를 완료하세요.",
        });
      }
      const validated = await validateSubmission(body, reusable.preview, { request, reply });
      if (!validated.ok) {
        return reply
          .code(validated.status)
          .send({ error: validated.errors[0] });
      }
      const fundamentalsIssue = validated.fundamentalsIssue;
      if (fundamentalsIssue)
        return sendFundamentalsIssue(reply, fundamentalsIssue);
      const capacityError = checkPositionCapacity(body);
      if (capacityError) return reply.code(422).send({ error: capacityError });
      const resourceError = await checkResources(deps.dataRoot);
      if (resourceError) return reply.code(507).send({ error: resourceError });
      if (reply.raw.destroyed) return reply;

      const benchmarkId = body.benchmarkId ?? "KOSPI";
      const warnings = [...rebased.warnings, ...validated.warnings];
      const batch = seedCloneBatches.create(id, countBody.data.count, {
        submissionSnapshot: validated.snapshot,
        preparationJobId: reusable.preview.preparationJobId,
        request: { ...body, benchmarkId, timeframe: validated.timeframe },
        schedule: reusable.schedule,
        universe: reusable.universe,
        provenancePin: reusable.provenancePin,
        benchmark: reusable.benchmark,
        warnings,
      });
      audit.record(
        request.authUser?.username ?? "admin",
        "backtest.seed-clone-batch.created",
        {
          sourceJobId: id,
          batchId: batch.batch.id,
          count: countBody.data.count,
        },
      );
      return reply
        .code(201)
        .send({ batch: serializeBatch(batch, false), warnings });
    },
  );

  /**
   * 재설정 및 복제용 초안 (D-025). 첫 화면은 저장 요청과 전략만 필요하다. 여기서 전체
   * 기간의 유니버스를 다시 해소하면 전략 화면 진입이 리밸런스 횟수와 후보 종목 수에
   * 비례해 느려진다. 유니버스·coverage 검증은 위저드의 유니버스 단계와 실제 제출에서
   * 수행한다. 이 route는 저장 요청 복원과 현재 스키마 재기준만 맡는다.
   */
  app.get(
    "/backtests/:id/clone-draft",
    { preHandler: requireAuth },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const job = queue.getJob(id);
      if (!job)
        return reply.code(404).send({ error: "작업을 찾을 수 없습니다" });

      const rebased = rebaseStoredRequest(
        job.requestJson,
        strategies.get(job.strategyId)?.version ?? null,
      );
      if (!rebased.ok) return reply.code(400).send({ error: rebased.error });

      const reusable = await reusablePreviewFor(job, rebased.request);
      const identityBlocker =
        reusable === null
          ? null
          : pinnedScheduleIdentityError(reusable.schedule, symbolMaster);
      const currentMissingCandleSymbols =
        reusable === null
          ? []
          : (() => {
              const symbols = [
                ...new Set(reusable.schedule.flatMap((entry) => entry.symbols)),
              ].sort();
              const { fromTsMs, toTsMs } = periodToTsRange(
                rebased.request.period,
              );
              const withBars = new Set(
                candleCoverage
                  .getCoverageBetween(symbols, fromTsMs, toTsMs)
                  .filter((row) => row.barCount > 0)
                  .map((row) => row.code),
              );
              return symbols.filter(
                (symbol) =>
                  !symbolService.exists(symbol) || !withBars.has(symbol),
              );
            })();
      const reusablePreview =
        identityBlocker === null && reusable !== null
          ? {
              ...reusable.response,
              // cached preview는 resolver를 다시 실행하지 않는다. 전체 KRX coverage와
              // 현재 일봉 보유 상태를 모두 덮어 위저드가 낡은 성공 판정을 믿고
              // 동기화 단계를 건너뛰지 않게 한다.
              periodCovered: symbolMaster.isRangeCovered(
                rebased.request.period.from,
                rebased.request.period.to,
              ),
              missingCandleSymbols: currentMissingCandleSymbols,
            }
          : null;
      return {
        request: rebased.request,
        warnings: rebased.warnings,
        blockers: identityBlocker === null ? [] : [identityBlocker],
        reusablePreview,
      };
    },
  );

  app.get("/backtest-clone-batches", { preHandler: requireAuth }, () => {
    const batches = seedCloneBatches.list();
    const sourceJobIds = new Set(batches.map(({ batch }) => batch.sourceJobId));
    const sourceJobs = [...sourceJobIds].flatMap((sourceJobId) => {
      const source = queue.getJob(sourceJobId);
      return source ? [serializeJobSummary(source)] : [];
    });
    return {
      batches: batches.map((batch) => serializeBatch(batch, false)),
      sourceJobs,
    };
  });

  app.get(
    "/backtest-clone-batches/:id",
    { preHandler: requireAuth },
    (request, reply) => {
      const { id } = request.params as { id: string };
      const batch = seedCloneBatches.get(id);
      if (!batch)
        return reply
          .code(404)
          .send({ error: "난수 시드 실험을 찾을 수 없습니다" });
      return { batch: serializeBatch(batch, true) };
    },
  );

  app.post(
    "/backtest-clone-batches/:id/cancel",
    { preHandler: requireAuth },
    (request, reply) => {
      const { id } = request.params as { id: string };
      const batch = seedCloneBatches.cancel(id);
      if (!batch)
        return reply
          .code(404)
          .send({ error: "난수 시드 실험을 찾을 수 없습니다" });
      for (const { job } of batch.items) {
        if (job && !queue.isTerminal(job.status)) orchestrator.cancel(job.id);
      }
      audit.record(
        request.authUser?.username ?? "admin",
        "backtest.seed-clone-batch.cancelled",
        {
          batchId: id,
        },
      );
      return { batch: serializeBatch(seedCloneBatches.get(id)!, false) };
    },
  );

  app.delete(
    "/backtest-clone-batches/:id",
    { preHandler: requireAuth },
    (request, reply) => {
      const { id } = request.params as { id: string };
      const result = seedCloneBatches.delete(id);
      if (result === "NOT_FOUND") {
        return reply
          .code(404)
          .send({ error: "난수 시드 실험을 찾을 수 없습니다" });
      }
      if (result === "NOT_DELETABLE") {
        return reply
          .code(409)
          .send({
            error: "실행 중인 난수 시드 실험은 취소 완료 후 삭제할 수 있습니다",
          });
      }
      audit.record(
        request.authUser?.username ?? "admin",
        "backtest.seed-clone-batch.deleted",
        {
          batchId: id,
        },
      );
      return reply.code(204).send();
    },
  );

  app.delete(
    "/backtests/:id",
    { preHandler: requireAuth },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      if (validations.referencesJob(id) || validations.list(id).length > 0) {
        return reply
          .code(409)
          .send({ error: "연결된 기간 검증 실험을 먼저 삭제하세요." });
      }
      const result = seedCloneBatches.deleteSourceJob(id);
      if (result === "NOT_FOUND") {
        return reply.code(404).send({ error: "백테스트를 찾을 수 없습니다" });
      }
      if (result === "NOT_DELETABLE") {
        return reply.code(409).send({
          error:
            "실행 중인 백테스트나 난수 시드 실험은 취소 완료 후 삭제할 수 있습니다",
        });
      }
      audit.record(request.authUser?.username ?? "admin", "backtest.deleted", {
        jobId: id,
      });
      return reply.code(204).send();
    },
  );

  app.get(
    "/backtests/:id/trades",
    { preHandler: requireAuth },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      if (!queue.getJob(id))
        return reply.code(404).send({ error: "작업을 찾을 수 없습니다" });
      const parsedQuery = z
        .object({
          limit: z.coerce.number().int().min(1).max(500).default(100),
          offset: z.coerce.number().int().min(0).default(0),
          symbol: z.string().optional(),
          // 모르는 축은 400 이다 — 조용히 기본 정렬로 떨어뜨리면 화면은 「순손익순」을
          // 표시한 채 청산순 목록을 보여 주고, 그 어긋남은 아무 데도 적히지 않는다.
          sort: z.enum(TRADE_SORT_KEYS).default(DEFAULT_TRADE_SORT_KEY),
          dir: z.enum(SORT_DIRECTIONS).default(DEFAULT_TRADE_SORT_DIRECTION),
        })
        .safeParse(request.query ?? {});
      if (!parsedQuery.success) {
        return reply
          .code(400)
          .send({
            error:
              "쿼리 파라미터가 올바르지 않습니다 (limit/offset/symbol/sort/dir)",
          });
      }
      const query = parsedQuery.data;
      return results.getTrades(id, {
        limit: query.limit,
        offset: query.offset,
        sort: query.sort,
        direction: query.dir,
        ...(query.symbol !== undefined ? { symbol: query.symbol } : {}),
      });
    },
  );

  app.get(
    "/backtests/:id/series",
    { preHandler: requireAuth },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      if (!queue.getJob(id))
        return reply.code(404).send({ error: "작업을 찾을 수 없습니다" });
      return results.getChartSeries(id);
    },
  );

  app.get(
    "/backtests/:id/export",
    { preHandler: requireAuth },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const job = queue.getJob(id);
      if (!job)
        return reply.code(404).send({ error: "작업을 찾을 수 없습니다" });
      reply.header(
        "content-disposition",
        `attachment; filename="backtest-${id}.json"`,
      );
      const fullExport = results.getFullExport(id);
      return { job: serializeJob(job, deps.database, deps.executionProgress?.(job)), ...fullExport };
    },
  );

  /** SSE 진행률 (스펙 §14). 연결이 끊기면 클라이언트는 polling 으로 fallback 한다. */
  app.get(
    "/backtests/:id/events",
    { preHandler: requireAuth },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const job = queue.getJob(id);
      if (!job)
        return reply.code(404).send({ error: "작업을 찾을 수 없습니다" });

      reply.hijack();
      // hijack 은 onSend hook 을 우회하므로 §16 보안 헤더를 직접 포함한다
      reply.raw.writeHead(200, {
        ...SECURITY_HEADERS,
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      });

      const writeSnapshot = (): BacktestJobRow | null => {
        const current = queue.getJob(id);
        if (current) {
          reply.raw.write(
            `data: ${JSON.stringify(serializeJob(current, deps.database, deps.executionProgress?.(current)))}\n\n`,
          );
        }
        return current;
      };

      const first = writeSnapshot();
      if (!first || queue.isTerminal(first.status)) {
        reply.raw.end();
        return;
      }

      const listener = (event: JobEvent): void => {
        if (event.jobId !== id) return;
        const current = writeSnapshot();
        if (current && queue.isTerminal(current.status)) cleanup();
      };
      const heartbeat = setInterval(
        () => reply.raw.write(":heartbeat\n\n"),
        15_000,
      );
      heartbeat.unref();

      const cleanup = (): void => {
        clearInterval(heartbeat);
        for (const source of jobEvents) source.off("job", listener);
        reply.raw.end();
      };

      for (const source of jobEvents) source.on("job", listener);
      request.raw.on("close", () => {
        clearInterval(heartbeat);
        for (const source of jobEvents) source.off("job", listener);
      });
    },
  );
}
