import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { universeRuleSchema } from '../../../../shared/schemas/universe-rule.js';
import { SECURITY_HEADERS } from '../../../shared/security.js';
import type {
  BacktestPreparationOrchestrator,
  PreparationInput,
} from '../application/backtest-preparation-orchestrator.js';

type PreHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

export interface BacktestPreparationRouteDeps {
  readonly orchestrator: BacktestPreparationOrchestrator;
  readonly dartApiKeyAvailable: boolean;
}

const previewRequestSchema = z.object({
  universeRule: universeRuleSchema,
  period: z.object({
    from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  }),
  strategyId: z.string().min(1),
  parameters: z.record(z.string(), z.unknown()),
});

export function registerBacktestPreparationRoutes(
  app: FastifyInstance,
  deps: BacktestPreparationRouteDeps,
  requireAuth: PreHandler,
): void {
  const { orchestrator } = deps;

  app.post('/backtests/universe-preview', { preHandler: requireAuth }, async (request, reply) => {
    const parsed = previewRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; '),
      });
    }
    const input: PreparationInput = parsed.data;
    if (input.period.from > input.period.to) {
      return reply.code(400).send({ error: '기간이 올바르지 않습니다 (from > to)' });
    }

    try {
      const preview = await orchestrator.getReadyPreview(input);
      if (preview) return reply.code(200).send(preview);
      if (!deps.dartApiKeyAvailable && await orchestrator.needsDart(input)) {
        return reply.code(503).send({
          error: 'DART API 키가 설정되지 않아 필요한 재무·자본변동 데이터를 동기화할 수 없습니다.',
        });
      }
      return reply.code(202).send({ job: orchestrator.start(input) });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return reply.code(400).send({ error: message });
    }
  });

  app.get('/backtests/preparation-jobs/:id', { preHandler: requireAuth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const job = orchestrator.get(id);
    if (!job) return reply.code(404).send({ error: '준비 작업을 찾을 수 없습니다.' });
    return { job };
  });

  app.post(
    '/backtests/preparation-jobs/:id/cancel',
    { preHandler: requireAuth },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      if (!orchestrator.cancel(id)) {
        return reply.code(404).send({ error: '준비 작업을 찾을 수 없습니다.' });
      }
      return { job: orchestrator.get(id) };
    },
  );

  app.get(
    '/backtests/preparation-jobs/:id/events',
    { preHandler: requireAuth },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const initial = orchestrator.get(id);
      if (!initial) return reply.code(404).send({ error: '준비 작업을 찾을 수 없습니다.' });

      reply.hijack();
      reply.raw.writeHead(200, {
        ...SECURITY_HEADERS,
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      const write = (job: typeof initial): void => {
        reply.raw.write(`data: ${JSON.stringify(job)}\n\n`);
      };
      let closed = false;
      let unsubscribe = (): void => {};
      let subscribing = true;
      let terminalDuringSubscribe = false;
      const heartbeat = setInterval(() => reply.raw.write(':heartbeat\n\n'), 15_000);
      heartbeat.unref();
      const cleanup = (): void => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        unsubscribe();
        reply.raw.end();
      };
      unsubscribe = orchestrator.subscribe(id, (job) => {
        // subscribe가 현재 snapshot을 동기적으로 주므로 첫 응답도 이 경계 하나에서
        // 쓴다. initial GET 뒤 terminal이 된 race도 최신 snapshot을 놓치지 않는다.
        write(job);
        if (orchestrator.isTerminal(job.status)) {
          if (subscribing) terminalDuringSubscribe = true;
          else cleanup();
        }
      });
      subscribing = false;
      if (terminalDuringSubscribe) cleanup();
      request.raw.on('close', cleanup);
    },
  );
}
