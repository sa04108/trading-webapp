import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { buildApiReference, type ApiReferenceStore } from '../application/api-reference.js';
export function registerApiReferenceRoutes(app: FastifyInstance, store: ApiReferenceStore, requireAuth: (request: FastifyRequest, reply: FastifyReply) => Promise<void>): void {
  app.get('/system/api-reference', { preHandler: requireAuth }, async (_request, reply) => {
    reply.header('cache-control', 'no-store');
    return buildApiReference(store);
  });
}
