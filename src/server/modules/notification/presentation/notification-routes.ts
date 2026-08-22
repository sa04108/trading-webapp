import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { SECURITY_HEADERS } from '../../../shared/security.js';
import type {
  NotificationRow,
  NotificationService,
} from '../application/notification-service.js';

type PreHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

export function registerNotificationRoutes(
  app: FastifyInstance,
  service: NotificationService,
  requireAuth: PreHandler,
): void {
  app.get('/notifications', { preHandler: requireAuth }, async () => ({
    notifications: service.list(),
  }));

  app.get('/notifications/unread-count', { preHandler: requireAuth }, async () => ({
    count: service.unreadCount(),
  }));

  app.post('/notifications/read-all', { preHandler: requireAuth }, async (_request, reply) => {
    service.markAllRead();
    return reply.code(204).send();
  });

  app.delete('/notifications', { preHandler: requireAuth }, async (request, reply) => {
    const body = request.body as { ids?: unknown; all?: unknown } | null;
    if (body?.all === true) {
      service.removeAll();
      return reply.code(204).send();
    }
    const ids = Array.isArray(body?.ids)
      ? body.ids.filter((value): value is string => typeof value === 'string')
      : [];
    if (ids.length === 0) return reply.code(400).send({ error: '삭제할 알림을 지정하세요' });
    service.remove(ids);
    return reply.code(204).send();
  });

  /**
   * 새 알림 SSE (설계 2026-08-03-notification-center). 백테스트 SSE 와 같은 방식 —
   * 연결이 끊기면 클라이언트는 unread-count 폴링으로 fallback 한다.
   */
  app.get('/notifications/events', { preHandler: requireAuth }, async (request, reply) => {
    reply.hijack();
    // hijack 은 onSend hook 을 우회하므로 §16 보안 헤더를 직접 포함한다
    reply.raw.writeHead(200, {
      ...SECURITY_HEADERS,
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    const listener = (row: NotificationRow): void => {
      reply.raw.write(`data: ${JSON.stringify(row)}\n\n`);
    };
    // 리스너를 먼저 붙이고 sync 이벤트를 보낸다. 화면의 최초 unread-count 조회와
    // SSE 구독 사이에 알림이 생겨도 sync 뒤 재조회 또는 listener 중 하나가 반드시
    // 잡는다. 예전 ':connected' 주석 heartbeat는 이 짧은 구간을 메우지 못했다.
    service.events.on('notification', listener);
    reply.raw.write('event: sync\ndata: {}\n\n');

    const heartbeat = setInterval(() => reply.raw.write(':heartbeat\n\n'), 15_000);
    heartbeat.unref();

    request.raw.on('close', () => {
      clearInterval(heartbeat);
      service.events.off('notification', listener);
    });
  });
}
