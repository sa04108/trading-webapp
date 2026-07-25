import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AuthService } from '../application/auth-service.js';

export const SESSION_COOKIE = 'qp_session';

const loginBodySchema = z.object({
  username: z.string().min(1).max(64),
  password: z.string().min(1).max(256),
});

const totpBodySchema = z.object({
  token: z.string().min(6).max(64),
});

export interface AuthRouteDeps {
  readonly authService: AuthService;
  readonly secureCookies: boolean;
}

function setSessionCookie(reply: FastifyReply, deps: AuthRouteDeps, sessionId: string): void {
  reply.setCookie(SESSION_COOKIE, sessionId, {
    httpOnly: true,
    secure: deps.secureCookies,
    sameSite: 'strict',
    path: '/',
    signed: true,
  });
}

function readSessionId(request: FastifyRequest): string | null {
  const raw = request.cookies[SESSION_COOKIE];
  if (!raw) return null;
  const unsigned = request.unsignCookie(raw);
  return unsigned.valid && unsigned.value ? unsigned.value : null;
}

export function registerAuthRoutes(app: FastifyInstance, deps: AuthRouteDeps): void {
  const { authService } = deps;

  app.post('/auth/login', async (request, reply) => {
    const parsed = loginBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid request body' });
    }
    const { username, password } = parsed.data;
    const result = await authService.login(username, password, request.ip);

    switch (result.status) {
      case 'LOCKED':
        return reply.code(429).send({ error: 'Too many failed attempts. Try again later.' });
      case 'INVALID_CREDENTIALS':
        return reply.code(401).send({ error: 'Invalid credentials' });
      case 'TOTP_REQUIRED':
        setSessionCookie(reply, deps, result.sessionId);
        return reply.send({ status: 'TOTP_REQUIRED' });
      case 'SUCCESS':
        setSessionCookie(reply, deps, result.sessionId);
        return reply.send({ status: 'OK' });
    }
  });

  app.post('/auth/totp/verify', async (request, reply) => {
    const parsed = totpBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid request body' });
    }
    const sessionId = readSessionId(request);
    if (!sessionId) return reply.code(401).send({ error: 'No pending session' });

    const result = await authService.verifyTotp(sessionId, parsed.data.token, request.ip);
    if (result.status !== 'SUCCESS') {
      return reply.code(401).send({ error: 'Invalid code' });
    }
    setSessionCookie(reply, deps, result.sessionId);
    return reply.send({ status: 'OK' });
  });

  app.post('/auth/logout', async (request, reply) => {
    const sessionId = readSessionId(request);
    if (sessionId) authService.logout(sessionId);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return reply.send({ status: 'OK' });
  });

  app.get('/auth/me', async (request, reply) => {
    const sessionId = readSessionId(request);
    const user = sessionId ? authService.authenticate(sessionId) : null;
    if (!user) return reply.code(401).send({ error: 'Unauthorized' });
    return reply.send({ id: user.id, username: user.username });
  });
}

/** 보호 라우트용 preHandler — request.authUser 를 채운다. */
export function createRequireAuth(deps: AuthRouteDeps) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const sessionId = readSessionId(request);
    const user = sessionId ? deps.authService.authenticate(sessionId) : null;
    if (!user) {
      await reply.code(401).send({ error: 'Unauthorized' });
      return;
    }
    request.authUser = user;
  };
}
