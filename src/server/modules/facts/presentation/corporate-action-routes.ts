import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { SECURITY_HEADERS } from '../../../shared/security.js';
import type { SymbolService } from '../../market-data/application/symbol-service.js';
import {
  type CorporateActionSyncJobEvent,
  type CorporateActionSyncJobRow,
  type CorporateActionSyncOrchestrator,
} from '../application/corporate-action-sync-orchestrator.js';

type PreHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

export interface CorporateActionRouteDeps {
  readonly orchestrator: CorporateActionSyncOrchestrator;
  readonly symbolService: SymbolService;
}

function serializeJob(job: CorporateActionSyncJobRow) {
  return {
    id: job.id,
    status: job.status,
    symbols: JSON.parse(job.symbolsJson) as string[],
    fromYear: job.fromYear,
    toYear: job.toYear,
    doneSymbols: job.doneSymbols,
    totalSymbols: job.totalSymbols,
    savedFacts: job.savedFacts,
    gapCount: job.gapCount,
    error: job.error,
    createdAtMs: job.createdAtMs,
    completedAtMs: job.completedAtMs,
  };
}

const createRequestSchema = z.object({
  symbols: z.array(z.string()).min(1),
  fromYear: z.number().int(),
  toYear: z.number().int(),
});

/**
 * 자본변동 일괄 수집 잡·진행률 라우트 (Task 7). SSE 는 백테스트 진행률
 * (`GET /backtests/:id/events`)의 패턴을 그대로 따른다 — 새 방식을 만들지 않는다.
 */
export function registerCorporateActionRoutes(
  app: FastifyInstance,
  deps: CorporateActionRouteDeps,
  requireAuth: PreHandler,
): void {
  const { orchestrator, symbolService } = deps;

  app.post('/facts/corporate-action-sync-jobs', { preHandler: requireAuth }, async (request, reply) => {
    const parsed = createRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
      });
    }
    const body = parsed.data;
    if (body.fromYear > body.toYear) {
      return reply.code(400).send({ error: '연도 범위가 올바르지 않습니다 (fromYear > toYear)' });
    }

    // DART 수집은 로컬에 등록된 국내(KR) 종목만 지원한다 — CLI(cli.ts factsSync)와
    // 같은 전제다. 등록되지 않은 코드는 symbol_facts_state 의 FK 를 만족하지 못해
    // 커버리지 저장 자체가 실패한다.
    const unregistered = body.symbols.filter((code) => !symbolService.exists(code));
    if (unregistered.length > 0) {
      return reply
        .code(400)
        .send({ error: `등록되지 않은 종목입니다: ${unregistered.join(', ')}` });
    }
    const foreign = body.symbols.filter((code) => symbolService.getSymbol(code)?.market !== 'KR');
    if (foreign.length > 0) {
      return reply
        .code(400)
        .send({ error: `DART 수집은 KR 종목만 지원합니다: ${foreign.join(', ')}` });
    }

    const job = orchestrator.start({
      symbols: body.symbols,
      fromYear: body.fromYear,
      toYear: body.toYear,
    });
    if (job === null) {
      return reply
        .code(409)
        .send({ error: '이미 실행 중인 자본변동 수집 작업이 있습니다. 완료되거나 취소된 뒤 다시 시도하세요.' });
    }
    return reply.code(201).send({ job: serializeJob(job) });
  });

  app.get('/facts/corporate-action-sync-jobs/:id', { preHandler: requireAuth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const job = orchestrator.getJob(id);
    if (!job) return reply.code(404).send({ error: '작업을 찾을 수 없습니다' });
    return { job: serializeJob(job) };
  });

  app.post(
    '/facts/corporate-action-sync-jobs/:id/cancel',
    { preHandler: requireAuth },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const outcome = orchestrator.cancel(id);
      if (outcome === 'NOT_CANCELLABLE') {
        return reply.code(409).send({ error: '취소할 수 없는 상태입니다' });
      }
      return { status: outcome };
    },
  );

  /** SSE 진행률. `backtest-routes.ts` 의 `/backtests/:id/events` 와 같은 골격이다. */
  app.get(
    '/facts/corporate-action-sync-jobs/:id/events',
    { preHandler: requireAuth },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const job = orchestrator.getJob(id);
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

      const writeSnapshot = (): CorporateActionSyncJobRow | null => {
        const current = orchestrator.getJob(id);
        if (current) {
          reply.raw.write(`data: ${JSON.stringify(serializeJob(current))}\n\n`);
        }
        return current;
      };

      const first = writeSnapshot();
      if (!first || orchestrator.isTerminal(first.status)) {
        reply.raw.end();
        return;
      }

      const listener = (event: CorporateActionSyncJobEvent): void => {
        if (event.jobId !== id) return;
        const current = writeSnapshot();
        if (current && orchestrator.isTerminal(current.status)) cleanup();
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
    },
  );
}
