import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { SYMBOL_CODE_PATTERN } from '../../../../shared/schemas/symbol-code.js';
import type { SymbolService, SymbolSummary } from '../application/symbol-service.js';
import type { SymbolInfoService } from '../application/symbol-info-service.js';
import { listMarketSupport } from '../domain/market-support.js';

type PreHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

const symbolSchema = z.string().regex(SYMBOL_CODE_PATTERN);

/**
 * 종목 등록은 **항상 목록**을 받는다. 단건 등록과 일괄 등록을 라우트 둘로 나누면 이름
 * 조회·시장 검증·감사 기록이 두 곳에 생기고 한쪽만 고쳐진다 — 단건은 길이 1 목록이다.
 */
const addSymbolsSchema = z.object({
  codes: z.array(symbolSchema).min(1).max(1000),
  market: z.enum(['KR', 'US']),
});

const removeSymbolsSchema = z.object({
  codes: z.array(symbolSchema).min(1).max(1000),
});

export function registerSymbolRoutes(
  app: FastifyInstance,
  symbolService: SymbolService,
  symbolInfoService: SymbolInfoService,
  /**
   * 재무를 가진 종목 전체 — 조립부가 facts 모듈로 연결한다 (market-data 는 facts 를
   * 모른다, §7). 있고 없음만 답한다: 종목별·연도별로 얼마나 채워졌는지는 묻지 않는다
   * (D-033).
   *
   * 종목 하나씩 묻는 대신 집합을 받는 이유: 목록 응답이 종목마다 파일 시스템을 두드리면
   * 1,000종목에서 stat 1,000회가 되고 그 목록은 5초마다 다시 읽힌다.
   */
  symbolsWithFacts: () => ReadonlySet<string>,
  requireAuth: PreHandler,
): void {
  /**
   * 종목 화면이 쓰는 응답 = 종목 요약 + 재무 보유 여부. `SymbolSummary` 에 넣지 않는
   * 이유: 그 타입은 market-data 소관이고 재무는 facts 모듈 소관이다 (§7).
   *
   * 재무 집합을 인자로 받는다 — 요청당 한 번 읽어 목록 전체가 공유한다.
   */
  const withFacts = (summary: SymbolSummary, factCodes: ReadonlySet<string>) => ({
    ...summary,
    hasFacts: factCodes.has(summary.code),
  });

  /**
   * 표시명을 외부 조회로 채운다. 등록 경로가 둘이라(추가 dialog·종목 마스터) 한 곳에
   * 모아 둔다. 조회 실패는 등록을 막지 않는다.
   *
   * 목록으로 한 번에 묻는다 — 종목마다 부르면 100종목 일괄 등록이 외부 호출 100번이 된다.
   */
  const resolveNames = async (codes: readonly string[]): Promise<Map<string, string>> => {
    try {
      const infos = await symbolInfoService.lookup(codes);
      return new Map(infos.filter((info) => info.name).map((info) => [info.symbol, info.name]));
    } catch {
      return new Map();
    }
  };

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

  // ── 종목 ────────────────────────────────────────────────────────────

  /**
   * 종목 목록. 화면이 그리는 데 필요한 것을 한 번에 담는다 — 이름·재무 보유. 행마다
   * 별도 조회를 내면 200종목에서 요청이 폭발한다.
   */
  app.get('/symbols', { preHandler: requireAuth }, async () => {
    const factCodes = symbolsWithFacts();
    return {
      symbols: symbolService.listSymbols().map((summary) => withFacts(summary, factCodes)),
    };
  });

  /**
   * 종목 등록 (단건·일괄 공용). 이름은 여기서 외부 조회로 채운다 — 실패해도 등록은 진행한다.
   *
   * **부분 성공을 인정한다.** 20종목 중 3종목이 이미 등록돼 있을 때 전체를 되돌리면
   * 사용자가 목록에서 그 3개를 손으로 지우고 다시 붙여야 한다. 대신 무엇이 들어가고
   * 무엇이 빠졌는지를 응답에 적어 화면이 그대로 말하게 한다.
   *
   * 하나도 못 넣었으면 201 이 아니다 — 빈 성공을 돌려주면 화면이 "추가했습니다" 를
   * 띄우고 목록은 그대로인 상태가 된다.
   */
  app.post('/symbols', { preHandler: requireAuth }, async (request, reply) => {
    const parsed = addSymbolsSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: '필드가 올바르지 않습니다 (codes/market)' });
    }
    // 입력 순서를 지키며 중복만 걷어낸다 — 같은 코드를 두 번 붙였다고 실패시킬 이유가 없다
    const codes = [...new Set(parsed.data.codes)];
    const names = await resolveNames(codes);
    const factCodes = symbolsWithFacts();

    const added: Array<ReturnType<typeof withFacts>> = [];
    const skipped: Array<{ code: string; reason: string }> = [];
    for (const code of codes) {
      try {
        added.push(
          withFacts(
            symbolService.addSymbol(code, parsed.data.market, names.get(code) ?? null),
            factCodes,
          ),
        );
      } catch (error) {
        skipped.push({ code, reason: error instanceof Error ? error.message : String(error) });
      }
    }

    if (added.length === 0) {
      // 같은 이유가 수십 번 반복되므로 중복을 걷어내고 앞 몇 개만 남긴다
      const reasons = [...new Set(skipped.map((entry) => entry.reason))];
      const shown = reasons.slice(0, 3).join(' · ');
      const rest = reasons.length - 3;
      return reply
        .code(409)
        .send({ error: rest > 0 ? `${shown} 외 ${rest}건` : shown, added, skipped });
    }
    return reply.code(201).send({ added, skipped });
  });

  /** 종목 제거 — 목록에서만 뺀다. KRX 일봉은 시장 공유 자산이라 함께 지우지 않는다 */
  app.post('/symbols/remove', { preHandler: requireAuth }, async (request, reply) => {
    const parsed = removeSymbolsSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'codes 가 필요합니다' });
    try {
      await symbolService.removeSymbols(parsed.data.codes);
      return reply.code(204).send();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return reply.code(message.includes('실행 중') ? 409 : 400).send({
        error: message,
      });
    }
  });
}
