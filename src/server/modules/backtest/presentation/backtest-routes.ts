import os from 'node:os';
import fs from 'node:fs';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  backtestRequestSchema,
  periodToTsRange,
  type BacktestRequest,
} from '../../../../shared/schemas/backtest-request.js';
import { SECURITY_HEADERS } from '../../../shared/security.js';
import type { AuditLogService } from '../../audit/audit-service.js';
import type { FactRepository } from '../../facts/application/ports.js';
import type { DatasetService } from '../../market-data/application/dataset-service.js';
import {
  legacyConsumeDefault,
  sliceForTimeframe,
  sliceTimeframes,
  type DatasetSlice,
} from '../../market-data/domain/dataset-slice.js';
import type { StrategyRegistry } from '../../strategy/application/strategy-registry.js';
import { estimateBars, MAX_BACKTEST_BARS } from '../domain/bar-estimate.js';
import {
  getCostProfile,
  getSlippageProfile,
  listCostProfiles,
  listSlippageProfiles,
} from '../domain/cost-profiles.js';
import type { JobOrchestrator, JobEvent } from '../application/job-orchestrator.js';
import type { BacktestJobRow, JobQueue } from '../application/job-queue.js';
import type { ResultsService } from '../application/results-service.js';
import { rebaseStoredRequest } from '../application/stored-request.js';

type PreHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

export interface BacktestRouteDeps {
  readonly queue: JobQueue;
  readonly orchestrator: JobOrchestrator;
  readonly results: ResultsService;
  readonly strategies: StrategyRegistry;
  readonly datasets: DatasetService;
  readonly audit: AuditLogService;
  readonly factRepository: FactRepository;
  readonly dataRoot: string;
  readonly maxQueuedBacktests: number;
}

const MIN_FREE_DISK_BYTES = 500 * 1024 * 1024;
const MIN_FREE_MEMORY_BYTES = 75 * 1024 * 1024;

const isoDate = (tsMs: number): string => new Date(tsMs).toISOString().slice(0, 10);

/**
 * 회수 가능 메모리 (§34 리소스 가드).
 * Linux 의 os.freemem() 은 MemFree 라 페이지 캐시를 제외한다 — 장기 구동 서버에서
 * 항상 낮게 나와 건강한 호스트가 영구적으로 507 을 반환하게 된다.
 * /proc/meminfo 의 MemAvailable 을 우선 사용하고, 없는 플랫폼은 freemem 으로 fallback.
 */
function availableMemoryBytes(): number {
  try {
    const meminfo = fs.readFileSync('/proc/meminfo', 'utf8');
    const match = /MemAvailable:\s+(\d+)\s*kB/.exec(meminfo);
    if (match) return Number(match[1]) * 1024;
  } catch {
    // /proc 이 없는 플랫폼 (Windows, macOS)
  }
  return os.freemem();
}

function serializeJob(job: BacktestJobRow) {
  return {
    id: job.id,
    status: job.status,
    strategyId: job.strategyId,
    datasetId: job.datasetId,
    request: JSON.parse(job.requestJson) as unknown,
    progressBars: job.progressBars,
    totalBars: job.totalBars,
    progressLabel: job.progressLabel,
    error: job.error,
    createdAtMs: job.createdAtMs,
    startedAtMs: job.startedAtMs,
    completedAtMs: job.completedAtMs,
  };
}

async function checkResources(dataRoot: string): Promise<string | null> {
  if (availableMemoryBytes() < MIN_FREE_MEMORY_BYTES) {
    return '여유 메모리가 부족해 새 백테스트를 시작할 수 없습니다. 실행 중인 작업이 끝난 뒤 다시 시도하세요.';
  }
  try {
    const stats = await fs.promises.statfs(dataRoot);
    if (stats.bavail * stats.bsize < MIN_FREE_DISK_BYTES) {
      return '디스크 공간이 부족해 새 백테스트를 시작할 수 없습니다. 저장 공간을 확보한 뒤 다시 시도하세요.';
    }
  } catch {
    // statfs 실패 시 가드를 건너뛴다
  }
  return null;
}

export function registerBacktestRoutes(app: FastifyInstance, deps: BacktestRouteDeps, requireAuth: PreHandler): void {
  const { queue, orchestrator, results, strategies, datasets, audit, factRepository } = deps;

  /**
   * 기간 × 커버리지 검사 (D-025). 커버리지는 메타데이터라 Parquet 을 읽지 않는다.
   * 요청한 종목 **전부** 가 구간 밖일 때만 거부한다 — 신규 상장처럼 이력이 짧은 종목
   * 하나 때문에 유니버스 전체를 막지 않는다. 일부만 비는 경우는 실행 경고로 남는다.
   */
  const checkPeriodCoverage = (
    body: BacktestRequest,
    datasetId: string,
    slice: DatasetSlice,
  ): string | null => {
    const { fromTsMs, toTsMs } = periodToTsRange(body.period);
    const bySymbol = new Map(
      datasets
        .getCoverage(datasetId)
        .filter((row) => row.slice === slice)
        .map((row) => [row.symbol, row]),
    );

    const ranges: string[] = [];
    for (const symbol of body.universe.symbols) {
      const row = bySymbol.get(symbol);
      if (!row || row.barCount === 0 || row.firstTsMs === null || row.lastTsMs === null) {
        ranges.push(`${symbol}: 수집된 데이터 없음`);
        continue;
      }
      // 하나라도 겹치면 통과 — 나머지는 실행 경고가 알린다
      if (row.lastTsMs >= fromTsMs && row.firstTsMs <= toTsMs) return null;
      ranges.push(`${symbol}: ${isoDate(row.firstTsMs)} ~ ${isoDate(row.lastTsMs)}`);
    }

    return `선택한 기간에 데이터가 있는 종목이 없습니다. 보유 범위 — ${ranges.join(', ')}`;
  };

  /**
   * 제출 검증 — 신규 제출(POST)·복제(clone)·초안(clone-draft)이 동일한 기준을 거친다.
   * 통과 시 제출 시점의 데이터셋 버전을 함께 반환한다 (재현성 §9.5).
   * 사유를 모아 반환한다 — 초안(clone-draft)이 무엇을 고쳐야 하는지 한 번에 알려야 한다.
   * 400 메시지는 `errors[0]` 이므로 검사 순서가 곧 우선순위다.
   */
  const validateSubmission = (
    body: BacktestRequest,
  ):
    | { ok: true; datasetVersion: { version: number; contentHash: string } }
    | { ok: false; errors: string[] } => {
    const errors: string[] = [];

    // 전략 — 파라미터 검증의 전제다
    const strategy = strategies.get(body.strategyId);
    if (!strategy) {
      errors.push(`알 수 없는 전략: ${body.strategyId}`);
    } else {
      // 전략 버전은 검사하지 않는다 (D-029) — 요청이 버전을 들고 다니지 않는다.
      // 실행되는 것은 언제나 지금 등록된 전략이고, 파라미터가 그 전략과 안 맞으면
      // 바로 아래 검증이 잡는다.
      const paramCheck = strategies.validateParameters(body.strategyId, body.parameters);
      if (!paramCheck.ok) errors.push(paramCheck.error);
    }

    if (body.period.from > body.period.to) {
      errors.push('기간이 올바르지 않습니다 (from > to)');
    }

    // 데이터셋 — 심볼·버전·커버리지 검사의 전제다
    const dataset = datasets.getDataset(body.datasetId);
    let datasetVersion: { version: number; contentHash: string } | null = null;
    if (!dataset) {
      errors.push(`알 수 없는 데이터셋: ${body.datasetId}`);
    } else {
      // 데이터셋에 없는 심볼은 조용히 0 거래로 "성공" 하게 된다 — 제출 시점에 거부
      const datasetSymbols = new Set(dataset.symbols);
      const missingSymbols = body.universe.symbols.filter((s) => !datasetSymbols.has(s));
      if (missingSymbols.length > 0) {
        errors.push(`데이터셋에 없는 종목입니다: ${missingSymbols.join(', ')}`);
      }
      // 제출 시점의 데이터셋 버전을 고정 — 대기 중 import 가 끼어들어도 메타데이터가 어긋나지 않는다
      datasetVersion = datasets.getLatestVersion(body.datasetId);
      if (!datasetVersion) {
        errors.push('데이터가 없는 데이터셋입니다. 먼저 import 하세요.');
      }
      // 소비 timeframe 검사 — 미지정은 데이터셋 기본 슬라이스 (기존 동작과 같은 결과).
      // 슬라이스 자체가 없는 데이터셋에 커버리지 검사부터 돌리면 "수집된 데이터 없음" 이
      // "이 데이터셋은 timeframe X 만 제공합니다" 보다 먼저 떠 원인이 흐려진다 —
      // 그래서 허용 검사를 먼저 하고, 통과한 슬라이스에 한해 기간·봉 수를 본다.
      const consumed = body.timeframe ?? legacyConsumeDefault(dataset.defaultTimeframe);
      const slice = sliceForTimeframe(consumed);
      const allowedTimeframes = sliceTimeframes(slice);
      const sliceHasData = dataset.slices.some((s) => s.slice === slice && s.hasData);

      if (!allowedTimeframes.includes(consumed)) {
        // 방어적 분기 — zod 스키마가 이미 consumed 를 '1m'|'1h'|'1d' 로 제한하고
        // sliceForTimeframe/sliceTimeframes 는 그 timeframe 이 속한 슬라이스를
        // 되돌리므로 이 분기는 현재 값 범위에서 도달하지 않는다.
        errors.push(
          `이 데이터셋은 timeframe ${allowedTimeframes.join('/')} 만 제공합니다 (요청: ${consumed})`,
        );
      } else if (!sliceHasData) {
        // 실제로 도달 가능한 경우 — timeframe 자체는 이 데이터셋 형태에 존재할 수
        // 있지만(예: 1d 전용 데이터셋에 1m 요청) 그 슬라이스로 아직 수집된 데이터가
        // 없다. "이 데이터셋은 1m/1h 만 제공합니다 (요청: 1m)" 처럼 스스로 모순되는
        // 메시지를 내지 않도록 원인을 구분해 말한다.
        errors.push(
          `이 데이터셋에는 아직 ${consumed} 데이터가 없습니다 — 해당 봉을 동기화(또는 CSV 가져오기)한 뒤 다시 시도하세요.`,
        );
      } else {
        const coverageError = checkPeriodCoverage(body, dataset.id, slice);
        if (coverageError !== null) errors.push(coverageError);

        // 봉 수 상한 — 실행부는 전체 봉을 메모리에 올린다. 1m 소비를 열면서 생긴 밸브.
        // coverage 는 슬라이스 기준 timeframe 으로 세므로 1m 소비만 배율 60 으로 추정한다.
        const { fromTsMs, toTsMs } = periodToTsRange(body.period);
        const sliceCoverage = datasets.getCoverage(dataset.id).filter((row) => row.slice === slice);
        const estimated = estimateBars(
          sliceCoverage,
          body.universe.symbols,
          fromTsMs,
          toTsMs,
          consumed === '1m' ? 60 : 1,
        );
        if (estimated > MAX_BACKTEST_BARS) {
          errors.push(
            `예상 봉 수가 상한을 넘습니다 (추정 ${estimated.toLocaleString()}봉 > ` +
              `${MAX_BACKTEST_BARS.toLocaleString()}봉). 기간이나 종목 수를 줄이거나 1h 봉을 사용하세요.`,
          );
        }
      }
    }

    if (!getCostProfile(body.execution.commissionProfileId)) {
      errors.push('알 수 없는 수수료 프로파일');
    }
    if (!getSlippageProfile(body.execution.slippageProfileId)) {
      errors.push('알 수 없는 슬리피지 프로파일');
    }

    // datasetVersion === null 분기는 죽은 방어 코드가 아니라 타입 내로잉이다 —
    // 이 분기가 없으면 아래 { ok: true, datasetVersion } 반환에서 datasetVersion 이
    // `{version,contentHash} | null` 로 남아 typecheck 가 깨진다.
    if (errors.length > 0 || datasetVersion === null) {
      return { ok: false, errors: errors.length > 0 ? errors : ['제출을 검증할 수 없습니다'] };
    }
    return { ok: true, datasetVersion };
  };

  /**
   * 재무 전략 데이터 요구 검사 — 통과시키면 실행 후 "거래 0건" 으로 끝나 원인을 알 수
   * 없다 (D-025 와 같은 원칙: 조용히 빠지지 않는다). `validateSubmission` 이 만드는
   * `errors` 배열에 합류시키지 않는 이유: 그 배열은 항상 400 으로 변환되는데, 이 조건은
   * 요청 형식·데이터셋 상태가 아니라 "전략과 데이터셋의 조합" 문제라 422 여야 한다.
   * POST 신규 제출뿐 아니라 clone·clone-draft 도 같은 검사를 거친다 — 데이터가 제출
   * 이후 지워진 job 을 clone 하면 이 관문에서 다시 걸린다.
   */
  const checkFundamentalsRequirement = (body: BacktestRequest): string | null => {
    if (!strategies.requiresFundamentals(body.strategyId)) return null;
    if (factRepository.hasFacts(body.datasetId, 'SYMBOL')) return null;
    return (
      '이 전략은 상장시점 재무 데이터가 필요하지만 이 데이터셋에는 아직 없습니다. ' +
      '데이터 화면에서 이 데이터셋을 동기화할 때 "재무" 를 함께 선택해 수집하세요.'
    );
  };

  /**
   * 보유 종목 수(topN) × 동시 보유 상한(maxPositions) 정합성 검사.
   *
   * 두 값이 어긋나면 결과가 조용히 틀린다: 매수 단계는 topN 건의 주문을 각각
   * `equity / topN` 으로 내는데, 엔진의 리스크 검증은 상한을 넘는 주문을 `null` 로
   * 떨어뜨린다. 초과분은 폐기되고 `pendingBuys` 는 이미 비워졌으므로 다음 리밸런스까지
   * 재시도되지 않는다 — 자본의 (topN-maxPositions)/topN 이 영구히 현금으로 남는데
   * 자산 곡선은 정상적으로 보인다. 기본값 조합(value-quality-rank topN=20, 웹 마법사
   * maxPositions=10)이 정확히 이 상태다.
   *
   * 전략 id 를 특별 취급하지 않고 **검증된 파라미터에 숫자 `topN` 이 있으면** 본다 —
   * range-breakout 처럼 이 파라미터가 없는 전략은 자연히 통과한다.
   * `checkFundamentalsRequirement` 와 같은 이유로 400(요청 형식)이 아니라 422 다:
   * 요청 자체는 유효하고 "전략 파라미터와 리스크 설정의 조합" 이 문제다.
   */
  const checkPositionCapacity = (body: BacktestRequest): string | null => {
    const validated = strategies.validateParameters(body.strategyId, body.parameters);
    // 파라미터 자체가 스키마를 통과하지 못하는 경우는 validateSubmission 이 400 으로 말한다
    if (!validated.ok || typeof validated.value !== 'object' || validated.value === null) {
      return null;
    }
    const topN = (validated.value as Record<string, unknown>)['topN'];
    if (typeof topN !== 'number' || !Number.isFinite(topN)) return null;
    if (topN <= body.risk.maxPositions) return null;
    return (
      `보유 종목 수(${topN})가 최대 동시 보유 종목 수(${body.risk.maxPositions})보다 큽니다. ` +
      `초과분 ${topN - body.risk.maxPositions}종목은 편입되지 못하고 그만큼 자본이 현금으로 남습니다. ` +
      '보유 종목 수를 줄이거나 최대 동시 보유 종목 수를 그 이상으로 올리세요.'
    );
  };

  /**
   * 대기열 깊이 상한 (D-025). QUEUED 만 센다 — 실행 중은 동시 실행 상한이 이미 묶고 있다.
   * 429 는 507(호스트 자원 부족)과 구분한다: 사용자가 할 일이 다르다(기다리거나 취소).
   */
  const queueDepthError = (): string | null => {
    const queued = queue.countByStatus(['QUEUED']);
    if (queued < deps.maxQueuedBacktests) return null;
    return `대기 중인 백테스트가 ${queued}건으로 상한(${deps.maxQueuedBacktests})에 도달했습니다. 완료되거나 취소된 뒤 제출하세요.`;
  };

  app.get('/backtests/profiles', { preHandler: requireAuth }, async () => ({
    commissionProfiles: listCostProfiles(),
    slippageProfiles: listSlippageProfiles(),
  }));

  app.post('/backtests', { preHandler: requireAuth }, async (request, reply) => {
    const parsed = backtestRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
      });
    }
    const body = parsed.data;

    const validated = validateSubmission(body);
    if (!validated.ok) {
      return reply.code(400).send({ error: validated.errors[0] ?? '제출을 검증할 수 없습니다' });
    }

    const fundamentalsError = checkFundamentalsRequirement(body);
    if (fundamentalsError) {
      return reply.code(422).send({ error: fundamentalsError });
    }

    const capacityError = checkPositionCapacity(body);
    if (capacityError) {
      return reply.code(422).send({ error: capacityError });
    }

    const queueError = queueDepthError();
    if (queueError) return reply.code(429).send({ error: queueError });

    const resourceError = await checkResources(deps.dataRoot);
    if (resourceError) return reply.code(507).send({ error: resourceError });

    const job = queue.enqueue(body, validated.datasetVersion);
    audit.record(request.authUser?.username ?? 'admin', 'backtest.created', {
      jobId: job.id,
      strategyId: body.strategyId,
      datasetId: body.datasetId,
    });
    return reply.code(201).send({ job: serializeJob(job) });
  });

  app.get('/backtests', { preHandler: requireAuth }, async (request, reply) => {
    const parsedQuery = z
      .object({
        limit: z.coerce.number().int().min(1).max(200).default(50),
        offset: z.coerce.number().int().min(0).default(0),
      })
      .safeParse(request.query ?? {});
    if (!parsedQuery.success) {
      return reply.code(400).send({ error: '쿼리 파라미터가 올바르지 않습니다 (limit/offset)' });
    }
    const query = parsedQuery.data;
    const jobs = queue.listJobs(query.limit, query.offset);
    return {
      jobs: jobs.map((job) => ({
        ...serializeJob(job),
        metrics: job.status === 'COMPLETED' ? results.getMetrics(job.id) : null,
      })),
    };
  });

  app.get('/backtests/:id', { preHandler: requireAuth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const job = queue.getJob(id);
    if (!job) return reply.code(404).send({ error: '작업을 찾을 수 없습니다' });
    return {
      job: serializeJob(job),
      run: results.getRun(id),
      metrics: results.getMetrics(id),
    };
  });

  app.post('/backtests/:id/cancel', { preHandler: requireAuth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const outcome = orchestrator.cancel(id);
    if (outcome === 'NOT_CANCELLABLE') {
      return reply.code(409).send({ error: '취소할 수 없는 상태입니다' });
    }
    return { status: outcome };
  });

  app.post('/backtests/:id/clone', { preHandler: requireAuth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const job = queue.getJob(id);
    if (!job) return reply.code(404).send({ error: '작업을 찾을 수 없습니다' });
    // 복제는 §10 이 지정한 중단 작업 복구 경로다 — 스키마·전략 버전이 올라갔다고 막지 않고,
    // 현재 기준으로 재기준한 뒤 무엇이 달라졌는지 경고로 알린다.
    const rebased = rebaseStoredRequest(
      job.requestJson,
      strategies.get(job.strategyId)?.version ?? null,
    );
    if (!rebased.ok) return reply.code(400).send({ error: rebased.error });
    const cloneRequest = rebased.request;
    // 재기준 후에도 새 제출이다 — POST 와 동일한 검증 관문을 거치고 버전을 다시 고정한다
    const validated = validateSubmission(cloneRequest);
    if (!validated.ok) {
      return reply.code(400).send({ error: validated.errors[0] ?? '제출을 검증할 수 없습니다' });
    }

    const fundamentalsError = checkFundamentalsRequirement(cloneRequest);
    if (fundamentalsError) {
      return reply.code(422).send({ error: fundamentalsError });
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

    const cloned = queue.enqueue(cloneRequest, validated.datasetVersion);
    audit.record(request.authUser?.username ?? 'admin', 'backtest.cloned', {
      sourceJobId: id,
      jobId: cloned.id,
      ...(rebased.warnings.length > 0 ? { rebaseWarnings: rebased.warnings } : {}),
    });
    return reply.code(201).send({ job: serializeJob(cloned), warnings: rebased.warnings });
  });

  /**
   * 재설정 및 복제용 초안 (D-025). 읽기 전용 — 대기열에 넣지 않고 데이터셋 버전도 고정하지 않는다.
   * 검증을 **돌리되 막지 않는다**: 여기서 400 으로 끊으면 조건이 틀어진 백테스트를 고칠
   * 화면 자체가 열리지 않는다. 실제 차단은 제출 시점 POST /backtests 가 그대로 지킨다.
   */
  app.get('/backtests/:id/clone-draft', { preHandler: requireAuth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const job = queue.getJob(id);
    if (!job) return reply.code(404).send({ error: '작업을 찾을 수 없습니다' });

    const rebased = rebaseStoredRequest(
      job.requestJson,
      strategies.get(job.strategyId)?.version ?? null,
    );
    if (!rebased.ok) return reply.code(400).send({ error: rebased.error });

    const validated = validateSubmission(rebased.request);
    const blockers = validated.ok ? [] : [...validated.errors];
    const fundamentalsError = checkFundamentalsRequirement(rebased.request);
    if (fundamentalsError) blockers.push(fundamentalsError);
    const capacityError = checkPositionCapacity(rebased.request);
    if (capacityError) blockers.push(capacityError);
    return {
      request: rebased.request,
      warnings: rebased.warnings,
      blockers,
    };
  });

  app.delete('/backtests/:id', { preHandler: requireAuth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const deleted = queue.deleteJob(id);
    if (!deleted) {
      return reply.code(409).send({ error: '실행 중이거나 존재하지 않는 작업은 삭제할 수 없습니다' });
    }
    audit.record(request.authUser?.username ?? 'admin', 'backtest.deleted', { jobId: id });
    return reply.code(204).send();
  });

  app.get('/backtests/:id/trades', { preHandler: requireAuth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!queue.getJob(id)) return reply.code(404).send({ error: '작업을 찾을 수 없습니다' });
    const parsedQuery = z
      .object({
        limit: z.coerce.number().int().min(1).max(500).default(100),
        offset: z.coerce.number().int().min(0).default(0),
        symbol: z.string().optional(),
      })
      .safeParse(request.query ?? {});
    if (!parsedQuery.success) {
      return reply
        .code(400)
        .send({ error: '쿼리 파라미터가 올바르지 않습니다 (limit/offset/symbol)' });
    }
    const query = parsedQuery.data;
    return results.getTrades(id, {
      limit: query.limit,
      offset: query.offset,
      ...(query.symbol !== undefined ? { symbol: query.symbol } : {}),
    });
  });

  app.get('/backtests/:id/series', { preHandler: requireAuth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!queue.getJob(id)) return reply.code(404).send({ error: '작업을 찾을 수 없습니다' });
    return results.getChartSeries(id);
  });

  app.get('/backtests/:id/export', { preHandler: requireAuth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const job = queue.getJob(id);
    if (!job) return reply.code(404).send({ error: '작업을 찾을 수 없습니다' });
    reply.header('content-disposition', `attachment; filename="backtest-${id}.json"`);
    return { job: serializeJob(job), ...results.getFullExport(id) };
  });

  /** SSE 진행률 (스펙 §14). 연결이 끊기면 클라이언트는 polling 으로 fallback 한다. */
  app.get('/backtests/:id/events', { preHandler: requireAuth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const job = queue.getJob(id);
    if (!job) return reply.code(404).send({ error: '작업을 찾을 수 없습니다' });

    reply.hijack();
    // hijack 은 onSend hook 을 우회하므로 §16 보안 헤더를 직접 포함한다
    reply.raw.writeHead(200, {
      ...SECURITY_HEADERS,
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });

    const writeSnapshot = (): BacktestJobRow | null => {
      const current = queue.getJob(id);
      if (current) {
        reply.raw.write(`data: ${JSON.stringify(serializeJob(current))}\n\n`);
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
    const heartbeat = setInterval(() => reply.raw.write(':heartbeat\n\n'), 15_000);
    heartbeat.unref();

    const cleanup = (): void => {
      clearInterval(heartbeat);
      orchestrator.events.off('job', listener);
      reply.raw.end();
    };

    orchestrator.events.on('job', listener);
    request.raw.on('close', () => {
      clearInterval(heartbeat);
      orchestrator.events.off('job', listener);
    });
  });
}
