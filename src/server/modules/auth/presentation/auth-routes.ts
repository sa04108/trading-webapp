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
      return reply.code(400).send({ error: '요청 본문이 올바르지 않습니다' });
    }
    const { username, password } = parsed.data;
    const result = await authService.login(username, password, request.ip);

    switch (result.status) {
      case 'LOCKED':
        return reply.code(429).send({ error: '로그인 실패가 누적되어 잠겼습니다. 잠시 후 다시 시도하세요.' });
      case 'INVALID_CREDENTIALS':
        return reply.code(401).send({ error: '아이디 또는 비밀번호가 올바르지 않습니다' });
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
      return reply.code(400).send({ error: '요청 본문이 올바르지 않습니다' });
    }
    const sessionId = readSessionId(request);
    if (!sessionId) return reply.code(401).send({ error: '진행 중인 로그인 세션이 없습니다' });

    const result = await authService.verifyTotp(sessionId, parsed.data.token, request.ip);
    switch (result.status) {
      // /auth/login 과 같은 상태에는 같은 응답을 준다 — 잠금을 401 로 접으면
      // 운영자가 맞는 코드를 넣고도 "코드가 틀렸다" 만 보게 된다
      case 'LOCKED':
        return reply
          .code(429)
          .send({ error: '로그인 실패가 누적되어 잠겼습니다. 잠시 후 다시 시도하세요.' });
      case 'INVALID':
        return reply.code(401).send({ error: '인증 코드가 올바르지 않습니다' });
      case 'SUCCESS':
        setSessionCookie(reply, deps, result.sessionId);
        return reply.send({ status: 'OK' });
    }
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
    if (!user) return reply.code(401).send({ error: '인증이 필요합니다' });
    return reply.send({ id: user.id, username: user.username });
  });
}

/** 보호 라우트용 preHandler — request.authUser 를 채운다. */
export function createRequireAuth(deps: AuthRouteDeps) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const sessionId = readSessionId(request);
    const user = sessionId ? deps.authService.authenticate(sessionId) : null;
    if (!user) {
      await reply.code(401).send({ error: '인증이 필요합니다' });
      return;
    }
    request.authUser = user;
  };
}
