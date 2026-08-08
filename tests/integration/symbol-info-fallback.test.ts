import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestAdmin, createTestApp, type TestApp } from '../helpers/test-app.js';
import { registerSymbols } from '../helpers/seed.js';
import type { SymbolInfoService } from '../../src/server/modules/market-data/application/symbol-info-service.js';
import type {
  StockInfo,
  StockInfoBatchResult,
  StockInfoSource,
} from '../../src/server/modules/market-data/application/ports.js';

/**
 * `/symbols/info` 의 로컬 폴백 (원인 1·2·3 통합 확인).
 *
 * 대전제: 상장폐지 종목뿐 아니라 **멀쩡히 상장된 종목도** 증권사 응답 문제로 이름을
 * 잃을 수 있었다 — 청크 하나의 실패가 같은 요청의 다른 종목까지 지웠기 때문이다.
 * 여기서는 그 상황에서도 로컬 종목 마스터(`symbols.name`)가 아는 이름은 화면에
 * 나와야 한다는 계약을 확인한다. 청크 격리 자체는
 * `tests/unit/toss-stock-info-source.test.ts`, 캐시·폴백 병합 로직은
 * `tests/unit/symbol-info-service.test.ts` 가 소스 단위로 확인한다 — 여기서는 라우트부터
 * 실제 `SymbolService`(DB) 까지 이어지는 전체 경로만 본다.
 */
function injectFakeStockInfoSource(
  symbolInfoService: SymbolInfoService,
  source: StockInfoSource,
): void {
  (symbolInfoService as unknown as { source: StockInfoSource }).source = source;
}

/**
 * 청크 하나에 "오염된" 코드가 섞이면 그 청크 전체를 실패로 돌린다 — 실제 토스 응답이
 * 상장폐지 코드 하나 때문에 청크 전체를 404 로 던지는 상황을 흉내낸다. 어댑터가
 * 청크를 격리해 잡아내므로(원인 2 수정) 이 소스는 예외를 던지지 않고 그냥 뺀다.
 */
function buildChunkedFakeSource(config: {
  chunkSize: number;
  poisoned: ReadonlySet<string>;
  known: Record<string, { name: string; market: string }>;
}): StockInfoSource {
  return {
    async getStockInfo(symbols): Promise<StockInfoBatchResult> {
      const stocks: StockInfo[] = [];
      const failedSymbols: string[] = [];
      for (let offset = 0; offset < symbols.length; offset += config.chunkSize) {
        const chunk = symbols.slice(offset, offset + config.chunkSize);
        if (chunk.some((code) => config.poisoned.has(code))) {
          // 청크 전체 실패 — 조회 자체를 못 한 것이지 "모른다" 가 아니다
          failedSymbols.push(...chunk);
          continue;
        }
        for (const code of chunk) {
          const found = config.known[code];
          if (found) {
            stocks.push({
              symbol: code,
              name: found.name,
              englishName: null,
              market: found.market,
              status: 'ACTIVE',
              sharesOutstanding: null,
            });
          }
        }
      }
      return { stocks, failedSymbols };
    },
  };
}

describe('GET /symbols/info — 로컬 종목 마스터 폴백', () => {
  let ctx: TestApp;

  beforeEach(async () => {
    ctx = await createTestApp();
  });
  afterEach(async () => {
    await ctx.close();
  });

  async function loginCookie(): Promise<string> {
    const { username, password } = await createTestAdmin(ctx.container);
    const login = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username, password },
    });
    return login.cookies.find((c) => c.name === 'qp_session')!.value;
  }

  it(
    '증권사가 코드 하나(같은 청크)를 통째로 실패시켜도 나머지 종목 이름은 정상 반환하고, ' +
      '실패한 종목도 로컬 이름이 있으면 그것으로 채운다',
    async () => {
      const cookie = await loginCookie();
      registerSymbols(ctx.container, 'KR', ['005930', '000660', '999999']);
      // 유니버스 미리보기 자동 등록이 미리 채워 둔 로컬 이름 — 999999 는 증권사 청크가
      // 실패하는 코드지만 로컬은 이미 이름을 안다.
      ctx.container.symbolService.setName('999999', '상장폐지테스트');

      injectFakeStockInfoSource(
        ctx.container.symbolInfoService,
        buildChunkedFakeSource({
          chunkSize: 1,
          poisoned: new Set(['999999']),
          known: {
            '005930': { name: '삼성전자', market: 'KOSPI' },
            '000660': { name: 'SK하이닉스', market: 'KOSPI' },
          },
        }),
      );

      const res = await ctx.app.inject({
        method: 'GET',
        url: '/api/v1/symbols/info?symbols=005930,000660,999999',
        cookies: { qp_session: cookie },
      });

      expect(res.statusCode).toBe(200);
      const byCode = new Map(
        (res.json().stocks as Array<{ symbol: string; name: string }>).map((s) => [
          s.symbol,
          s.name,
        ]),
      );
      expect(byCode.get('005930')).toBe('삼성전자');
      expect(byCode.get('000660')).toBe('SK하이닉스');
      // 증권사 청크가 실패한 종목 — 로컬 폴백이 메운다
      expect(byCode.get('999999')).toBe('상장폐지테스트');
    },
  );

  it('증권사 자격 증명이 미설정이어도 로컬 종목 마스터의 이름은 그대로 나온다', async () => {
    const cookie = await loginCookie();
    // 이 테스트 앱은 TOSS_CLIENT_ID/SECRET 을 넘기지 않으므로 소스가 비활성(미설정) 상태다
    registerSymbols(ctx.container, 'KR', ['005930']);
    ctx.container.symbolService.setName('005930', '로컬종목마스터이름');

    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/symbols/info?symbols=005930',
      cookies: { qp_session: cookie },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().stocks).toEqual([
      {
        symbol: '005930',
        name: '로컬종목마스터이름',
        englishName: null,
        market: 'KR',
        status: '',
        sharesOutstanding: null,
      },
    ]);
  });

  it('로컬에도 이름이 없는 코드는 여전히 빈 목록이다 (기존 계약 유지)', async () => {
    const cookie = await loginCookie();
    registerSymbols(ctx.container, 'KR', ['005930']); // 이름 없이 등록

    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/symbols/info?symbols=005930',
      cookies: { qp_session: cookie },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().stocks).toEqual([]);
  });
});
