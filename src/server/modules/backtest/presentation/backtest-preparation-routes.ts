import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { universeRuleSchema } from '../../../../shared/schemas/universe-rule.js';
import { isoDateSchema } from '../../../../shared/schemas/backtest-request.js';
import { rebalanceIntervalFitsPeriod } from '../../../../shared/schemas/rebalance-interval.js';
import { SECURITY_HEADERS } from '../../../shared/security.js';
import {
  PreparationInputError,
  type BacktestPreparationOrchestrator,
  type PreparationInput,
} from '../application/backtest-preparation-orchestrator.js';
import type { FactRepository } from '../../facts/application/ports.js';
import { CORPORATE_ACTION_FIELD } from '../../facts/domain/fact.js';
import { sendIfKrxError, sendIfNotCovered } from './krx-error-mapping.js';

type PreHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

export interface BacktestPreparationRouteDeps {
  readonly orchestrator: BacktestPreparationOrchestrator;
  readonly facts: Pick<FactRepository, 'getFacts'>;
  readonly dartApiKeyAvailable: boolean;
}

const previewRequestSchema = z.object({
  universeRule: universeRuleSchema,
  period: z.object({
    from: isoDateSchema,
    to: isoDateSchema,
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
  const activeStreams = new Set<() => void>();

  // Fastify는 open SSE가 있으면 일반 connection drain 전에 기다릴 수 있다. preClose는
  // 그 기다림보다 먼저 실행되므로 heartbeat·구독·reply를 라우트가 명시적으로 닫는다.
  app.addHook('preClose', async () => {
    for (const cleanup of [...activeStreams]) cleanup();
  });

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
    // 제출 스키마(backtest-request.ts superRefine)와 같은 검사다 — 여기서 걸러내지
    // 않으면 준비가 끝난 뒤 제출 시점에야 400 이 나 준비가 헛수고가 된다.
    if (!rebalanceIntervalFitsPeriod(input.period, input.universeRule.rebalanceInterval)) {
      return reply.code(400).send({ error: '리밸런싱 주기가 백테스트 전체 기간을 초과합니다.' });
    }

    try {
      const preview = await orchestrator.getReadyPreview(input);
      if (preview) {
        // 유니버스 단계의 재무 게이트는 확정된 종목의 실제 재무 행만 본다. 전체
        // `/symbols`의 hasFacts는 자본변동만 있어도 true고, 재무 coverage는 DART
        // 무자료 수집에도 생기므로 둘 다 재무 보유 근거가 될 수 없다.
        // FactRepository의 빈 keys는 "필터 없음"(전체 스코프)을 뜻한다. 빈 유니버스는
        // 저장소를 건너뛰어 전체 Parquet 파티션을 읽는 역방향 병목을 만들지 않는다.
        const storedFacts = preview.unionSymbols.length === 0
          ? []
          : await deps.facts.getFacts({
              scope: 'SYMBOL',
              keys: preview.unionSymbols,
            });
        const codesWithFundamentals = new Set(
          storedFacts
            .filter((fact) => fact.field !== CORPORATE_ACTION_FIELD)
            .map((fact) => fact.key),
        );
        const fundamentalSymbols = preview.unionSymbols.filter((code) =>
          codesWithFundamentals.has(code),
        );
        return reply.code(200).send({ ...preview, fundamentalSymbols });
      }
      if (!deps.dartApiKeyAvailable && await orchestrator.needsDart(input)) {
        return reply.code(503).send({
          error: 'DART API 키가 설정되지 않아 필요한 재무·자본변동 데이터를 동기화할 수 없습니다.',
        });
      }
      return reply.code(202).send({ job: orchestrator.start(input) });
    } catch (error) {
      // resolver 경유 오류는 제출 라우트와 같은 코드로 매핑한다. 그 밖의 오류를
      // 일괄 400 으로 접으면 내부 wiring 결함까지 사용자 요청 문제로 둔갑한다 —
      // 알려진 사용자 오류(미지 전략 등)만 400, 나머지는 500 처리기로 던진다.
      if (sendIfKrxError(reply, error)) return reply;
      if (sendIfNotCovered(reply, error)) return reply;
      if (error instanceof PreparationInputError) {
        return reply.code(400).send({ error: error.message });
      }
      throw error;
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
        activeStreams.delete(cleanup);
        reply.raw.end();
      };
      activeStreams.add(cleanup);
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
