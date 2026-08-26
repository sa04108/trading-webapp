import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { SymbolInfoService } from '../application/symbol-info-service.js';
import { listMarketSupport } from '../domain/market-support.js';

type PreHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

export function registerSymbolRoutes(
  app: FastifyInstance,
  symbolInfoService: SymbolInfoService,
  requireAuth: PreHandler,
): void {
  /** 지원 시장 목록. 배포마다 고정이므로 클라이언트가 길게 캐시한다. */
  app.get('/markets', { preHandler: requireAuth }, async () => ({
    markets: listMarketSupport(),
  }));

  /** 종목 코드 → 이름. 소스 미설정이면 빈 목록 — UI 는 코드만으로도 동작한다. */
  app.get('/symbols/info', { preHandler: requireAuth }, async (request, reply) => {
    const raw = (request.query as { symbols?: string }).symbols ?? '';
    const symbols = raw
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    if (symbols.length === 0 || symbols.length > 1000) {
      return reply.code(400).send({ error: 'symbols 쿼리가 필요합니다 (콤마 구분, 최대 1000)' });
    }
    try {
      return { stocks: await symbolInfoService.lookup(symbols) };
    } catch (error) {
      return reply
        .code(400)
        .send({ error: error instanceof Error ? error.message : String(error) });
    }
  });
}
