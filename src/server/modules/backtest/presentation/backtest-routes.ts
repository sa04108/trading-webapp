import os from 'node:os';
import fs from 'node:fs';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  backtestRequestSchema,
  type BacktestRequest,
} from '../../../../shared/schemas/backtest-request.js';
import type { AuditLogService } from '../../audit/audit-service.js';
import type { DatasetService } from '../../market-data/application/dataset-service.js';
import type { StrategyRegistry } from '../../strategy/application/strategy-registry.js';
import {
  getCostProfile,
  getSlippageProfile,
  listCostProfiles,
  listSlippageProfiles,
} from '../domain/cost-profiles.js';
import type { JobOrchestrator, JobEvent } from '../application/job-orchestrator.js';
import type { BacktestJobRow, JobQueue } from '../application/job-queue.js';
import type { ResultsService } from '../application/results-service.js';

type PreHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

export interface BacktestRouteDeps {
  readonly queue: JobQueue;
  readonly orchestrator: JobOrchestrator;
  readonly results: ResultsService;
  readonly strategies: StrategyRegistry;
  readonly datasets: DatasetService;
  readonly audit: AuditLogService;
  readonly dataRoot: string;
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
    return '여유 메모리가 부족해 신규 백테스트를 거부합니다 (스펙 §34)';
  }
  try {
    const stats = await fs.promises.statfs(dataRoot);
    if (stats.bavail * stats.bsize < MIN_FREE_DISK_BYTES) {
      return '디스크 공간이 부족해 신규 백테스트를 거부합니다 (스펙 §34)';
    }
  } catch {
    // statfs 실패 시 가드를 건너뛴다
  }
  return null;
}

export function registerBacktestRoutes(app: FastifyInstance, deps: BacktestRouteDeps, requireAuth: PreHandler): void {
  const { queue, orchestrator, results, strategies, datasets, audit } = deps;

  /**
   * 제출 검증 관문 — 신규 제출(POST)과 복제(clone)가 동일한 기준을 거친다.
   * 통과 시 제출 시점의 데이터셋 버전을 함께 반환한다 (재현성 §9.5).
   */
  const validateSubmission = (
    body: BacktestRequest,
  ):
    | { ok: true; datasetVersion: { version: number; contentHash: string } }
    | { ok: false; error: string } => {
    const strategy = strategies.get(body.strategyId);
    if (!strategy) return { ok: false, error: `알 수 없는 전략: ${body.strategyId}` };
    if (strategy.version !== body.strategyVersion) {
      return {
        ok: false,
        error: `전략 버전 불일치: 요청 ${body.strategyVersion}, 등록 ${strategy.version}`,
      };
    }
    const paramCheck = strategies.validateParameters(body.strategyId, body.parameters);
    if (!paramCheck.ok) return { ok: false, error: paramCheck.error };

    const dataset = datasets.getDataset(body.datasetId);
    if (!dataset) {
      return { ok: false, error: `알 수 없는 데이터셋: ${body.datasetId}` };
    }
    // 데이터셋에 없는 심볼은 조용히 0 거래로 "성공" 하게 된다 — 제출 시점에 거부
    const datasetSymbols = new Set(dataset.symbols);
    const missingSymbols = body.universe.symbols.filter((s) => !datasetSymbols.has(s));
    if (missingSymbols.length > 0) {
      return {
        ok: false,
        error: `데이터셋에 없는 종목입니다: ${missingSymbols.join(', ')}`,
      };
    }
    // 제출 시점의 데이터셋 버전을 고정 — 대기 중 import 가 끼어들어도 메타데이터가 어긋나지 않는다
    const datasetVersion = datasets.getLatestVersion(body.datasetId);
    if (!datasetVersion) {
      return { ok: false, error: '데이터가 없는 데이터셋입니다. 먼저 import 하세요.' };
    }
    if (!getCostProfile(body.execution.commissionProfileId)) {
      return { ok: false, error: '알 수 없는 수수료 프로파일' };
    }
    if (!getSlippageProfile(body.execution.slippageProfileId)) {
      return { ok: false, error: '알 수 없는 슬리피지 프로파일' };
    }
    if (body.period.from > body.period.to) {
      return { ok: false, error: '기간이 올바르지 않습니다 (from > to)' };
    }
    return { ok: true, datasetVersion };
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
    if (!validated.ok) return reply.code(400).send({ error: validated.error });

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
    if (!job) return reply.code(404).send({ error: 'Job not found' });
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
    if (!job) return reply.code(404).send({ error: 'Job not found' });
    const cloneRequest = backtestRequestSchema.parse(JSON.parse(job.requestJson));
    // 복제는 새 제출이다 — POST 와 동일한 검증 관문을 거치고 버전을 다시 고정한다.
    // (예: 전략 버전이 그 사이 올라갔다면 여기서 명시적으로 거부된다)
    const validated = validateSubmission(cloneRequest);
    if (!validated.ok) return reply.code(400).send({ error: validated.error });
    const cloned = queue.enqueue(cloneRequest, validated.datasetVersion);
    audit.record(request.authUser?.username ?? 'admin', 'backtest.cloned', {
      sourceJobId: id,
      jobId: cloned.id,
    });
    return reply.code(201).send({ job: serializeJob(cloned) });
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
    if (!queue.getJob(id)) return reply.code(404).send({ error: 'Job not found' });
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
    return {
      trades: results.getTrades(id, {
        limit: query.limit,
        offset: query.offset,
        ...(query.symbol !== undefined ? { symbol: query.symbol } : {}),
      }),
    };
  });

  app.get('/backtests/:id/series', { preHandler: requireAuth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!queue.getJob(id)) return reply.code(404).send({ error: 'Job not found' });
    return results.getChartSeries(id);
  });

  app.get('/backtests/:id/export', { preHandler: requireAuth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const job = queue.getJob(id);
    if (!job) return reply.code(404).send({ error: 'Job not found' });
    reply.header('content-disposition', `attachment; filename="backtest-${id}.json"`);
    return { job: serializeJob(job), ...results.getFullExport(id) };
  });

  /** SSE 진행률 (스펙 §14). 연결이 끊기면 클라이언트는 polling 으로 fallback 한다. */
  app.get('/backtests/:id/events', { preHandler: requireAuth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const job = queue.getJob(id);
    if (!job) return reply.code(404).send({ error: 'Job not found' });

    reply.hijack();
    reply.raw.writeHead(200, {
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
