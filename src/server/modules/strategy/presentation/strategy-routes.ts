import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { StrategyRegistry } from '../application/strategy-registry.js';

type PreHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

export function registerStrategyRoutes(
  app: FastifyInstance,
  registry: StrategyRegistry,
  requireAuth: PreHandler,
): void {
  app.get('/strategies', { preHandler: requireAuth }, async () => ({
    strategies: registry.list(),
  }));

  app.get('/strategies/:strategyId/schema', { preHandler: requireAuth }, async (request, reply) => {
    const { strategyId } = request.params as { strategyId: string };
    const schema = registry.getParameterJsonSchema(strategyId);
    if (!schema) return reply.code(404).send({ error: '전략을 찾을 수 없습니다' });
    return { schema };
  });
}
