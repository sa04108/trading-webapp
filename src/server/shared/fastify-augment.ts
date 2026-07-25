import type { AuthenticatedUser } from '../modules/auth/application/auth-service.js';

declare module 'fastify' {
  interface FastifyRequest {
    authUser?: AuthenticatedUser;
  }
}

export {};
