import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { PeriodValidationService, type PeriodValidationDeps } from '../application/period-validation-service.js';

/** 실행 상태는 서버 타이머가 진행하며 GET 요청은 저장된 결과만 읽는다. */
export function registerPeriodValidationRoutes(
  app: FastifyInstance,
  deps: PeriodValidationDeps,
  requireAuth: (request: FastifyRequest, reply: FastifyReply) => Promise<void>,
): PeriodValidationService {
  const service = new PeriodValidationService(deps);
  const pump = (): void => {
    void service.pump().catch((error: unknown) => app.log.error({ err: error }, '기간 검증 작업 진행 실패'));
  };
  const timer = setInterval(pump, 1_000);
  timer.unref();
  app.addHook('onReady', async () => { pump(); });
  app.addHook('onClose', async () => { clearInterval(timer); await service.stop(); });

  app.post('/backtests/:id/validations/preview', { preHandler: requireAuth }, (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      const { plan } = service.plan(id, request.body);
      return { plan };
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : '검증 설정이 올바르지 않습니다.' });
    }
  });
  app.post('/backtests/:id/validations', { preHandler: requireAuth }, (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      const experiment = service.create(id, request.body);
      pump();
      return reply.code(201).send({ experiment });
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : '검증 실험을 생성하지 못했습니다.' });
    }
  });
  app.get('/backtests/:id/validations', { preHandler: requireAuth }, (request) => {
    return { experiments: service.list((request.params as { id: string }).id) };
  });
  app.get('/backtest-validations/:id', { preHandler: requireAuth }, (request, reply) => {
    const experiment = service.get((request.params as { id: string }).id);
    return experiment ? { experiment } : reply.code(404).send({ error: '검증 실험을 찾을 수 없습니다.' });
  });
  app.post('/backtest-validations/:id/cancel', { preHandler: requireAuth }, (request, reply) => {
    const experiment = service.cancel((request.params as { id: string }).id);
    if (!experiment) return reply.code(404).send({ error: '검증 실험을 찾을 수 없습니다.' });
    pump();
    return { experiment };
  });
  app.delete('/backtest-validations/:id', { preHandler: requireAuth }, (request, reply) => {
    try {
      return service.delete((request.params as { id: string }).id)
        ? reply.code(204).send()
        : reply.code(404).send({ error: '검증 실험을 찾을 수 없습니다.' });
    } catch (error) {
      return reply.code(409).send({ error: error instanceof Error ? error.message : '검증 실험을 삭제하지 못했습니다.' });
    }
  });
  return service;
}
