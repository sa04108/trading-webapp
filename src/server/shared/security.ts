import type { FastifyInstance } from 'fastify';

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * 스펙 §16 보안 헤더. onSend hook 과, hook 을 우회하는 응답(예: SSE 의
 * reply.hijack())이 같은 목록을 공유한다.
 */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'Content-Security-Policy':
    "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
};

/**
 * 스펙 §16 HTTP 보안: 보안 헤더 + Origin 고정(CSRF 방어).
 * Origin 헤더가 존재하는 변경 요청은 요청 Host 와 동일한 host 여야 한다.
 * (앱은 자신의 공인 주소를 모르므로 Host 헤더 기준으로 판정한다 — 인프라 비인지 원칙)
 */
export function registerSecurity(app: FastifyInstance): void {
  app.addHook('onSend', async (_request, reply) => {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
      reply.header(name, value);
    }
  });

  app.addHook('preHandler', async (request, reply) => {
    if (!MUTATING_METHODS.has(request.method)) return;
    const origin = request.headers.origin;
    if (!origin) return; // 브라우저가 아닌 클라이언트(CLI 등)
    let originHost: string;
    try {
      originHost = new URL(origin).host;
    } catch {
      return reply.code(403).send({ error: 'Origin 이 올바르지 않습니다' });
    }
    if (originHost !== request.headers.host) {
      return reply.code(403).send({ error: '교차 출처 요청이 거부되었습니다' });
    }
  });
}
