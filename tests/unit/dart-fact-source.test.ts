import { describe, expect, it } from 'vitest';
import { FactSourceNotConfiguredError } from '../../src/server/modules/facts/application/ports.js';
import type { CorpCodeResolver } from '../../src/server/modules/facts/infrastructure/dart/dart-corp-code-cache.js';
import { createDartFactSource } from '../../src/server/modules/facts/infrastructure/dart/dart-fact-source.js';

const LOGGER = { debug() {}, info() {}, warn() {}, error() {} } as never;

/** corp_code 매핑은 별도 테스트가 다룬다 — 여기서는 종목코드에 접두사만 붙인다 */
const STUB_RESOLVER: CorpCodeResolver = {
  resolve: async (symbol) => `corp-${symbol}`,
};

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

describe('createDartFactSource — 미설정', () => {
  it('설정이 없으면 FactSourceNotConfiguredError 를 던진다', async () => {
    const source = createDartFactSource(null, LOGGER);
    await expect(
      source.fetchFinancials({ symbols: ['005930'], fromYear: 2025, toYear: 2025, consolidated: true }),
    ).rejects.toBeInstanceOf(FactSourceNotConfiguredError);
    await expect(
      source.fetchCorporateActions({ symbols: ['005930'], fromYear: 2025, toYear: 2025, consolidated: true }),
    ).rejects.toBeInstanceOf(FactSourceNotConfiguredError);
  });
});

describe('createDartFactSource — 요청 구성', () => {
  it('crtfc_key 를 쿼리로 보내고 Authorization 헤더는 붙이지 않는다', async () => {
    const urls: string[] = [];
    const headers: Array<Record<string, string>> = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      urls.push(String(url));
      headers.push((init?.headers ?? {}) as Record<string, string>);
      return jsonResponse({ status: '013', message: '조회된 데이타가 없습니다.' });
    }) as unknown as typeof fetch;

    const source = createDartFactSource(
      { baseUrl: 'https://opendart.fss.or.kr', apiKey: 'KEY123' },
      LOGGER,
      { fetchImpl, sleep: async () => undefined, corpCodeResolver: STUB_RESOLVER },
    );
    await source.fetchFinancials({
      symbols: ['005930'],
      fromYear: 2025,
      toYear: 2025,
      consolidated: true,
    });

    expect(urls.length).toBeGreaterThan(0);
    expect(urls[0]).toContain('crtfc_key=KEY123');
    expect(headers[0]).not.toHaveProperty('authorization');
  });

  it('연결/별도를 fs_div 로 보낸다', async () => {
    const urls: string[] = [];
    const fetchImpl = (async (url: string) => {
      urls.push(String(url));
      return jsonResponse({ status: '013', message: 'no data' });
    }) as unknown as typeof fetch;

    const source = createDartFactSource(
      { baseUrl: 'https://opendart.fss.or.kr', apiKey: 'K' },
      LOGGER,
      { fetchImpl, sleep: async () => undefined, corpCodeResolver: STUB_RESOLVER },
    );
    await source.fetchFinancials({
      symbols: ['005930'],
      fromYear: 2025,
      toYear: 2025,
      consolidated: false,
    });
    expect(urls.some((url) => url.includes('fs_div=OFS'))).toBe(true);
  });

  it('네 개 보고서 코드를 모두 조회한다', async () => {
    const urls: string[] = [];
    const fetchImpl = (async (url: string) => {
      urls.push(String(url));
      return jsonResponse({ status: '013', message: 'no data' });
    }) as unknown as typeof fetch;

    const source = createDartFactSource(
      { baseUrl: 'https://opendart.fss.or.kr', apiKey: 'K' },
      LOGGER,
      { fetchImpl, sleep: async () => undefined, corpCodeResolver: STUB_RESOLVER },
    );
    await source.fetchFinancials({
      symbols: ['005930'],
      fromYear: 2025,
      toYear: 2025,
      consolidated: true,
    });
    for (const code of ['11013', '11012', '11014', '11011']) {
      expect(urls.some((url) => url.includes(`reprt_code=${code}`))).toBe(true);
    }
  });

  it('"데이터 없음"(status 013)은 에러가 아니라 빈 결과다', async () => {
    const fetchImpl = (async () =>
      jsonResponse({ status: '013', message: '조회된 데이타가 없습니다.' })) as unknown as typeof fetch;
    const source = createDartFactSource(
      { baseUrl: 'https://opendart.fss.or.kr', apiKey: 'K' },
      LOGGER,
      { fetchImpl, sleep: async () => undefined, corpCodeResolver: STUB_RESOLVER },
    );
    const result = await source.fetchFinancials({
      symbols: ['005930'],
      fromYear: 2025,
      toYear: 2025,
      consolidated: true,
    });
    expect(result.facts).toEqual([]);
  });

  it('인증 실패(status 020)는 던진다 — 조용히 빈 결과로 만들지 않는다', async () => {
    const fetchImpl = (async () =>
      jsonResponse({ status: '020', message: '요청 제한을 초과하였습니다.' })) as unknown as typeof fetch;
    const source = createDartFactSource(
      { baseUrl: 'https://opendart.fss.or.kr', apiKey: 'K' },
      LOGGER,
      { fetchImpl, sleep: async () => undefined, corpCodeResolver: STUB_RESOLVER },
    );
    await expect(
      source.fetchFinancials({ symbols: ['005930'], fromYear: 2025, toYear: 2025, consolidated: true }),
    ).rejects.toThrow(/020/);
  });

  it('재무 응답을 팩트로 바꾼다', async () => {
    const fetchImpl = (async (url: string) => {
      const target = String(url);
      if (target.includes('fnlttSinglAcntAll') && target.includes('reprt_code=11013')) {
        return jsonResponse({
          status: '000',
          message: '정상',
          list: [
            {
              rcept_no: '20250515000001',
              reprt_code: '11013',
              bsns_year: '2025',
              sj_div: 'BS',
              account_id: 'ifrs-full_CurrentAssets',
              account_nm: '유동자산',
              thstrm_amount: '500,000',
            },
          ],
        });
      }
      if (target.includes('stockTotqySttus')) {
        return jsonResponse({
          status: '000',
          message: '정상',
          list: [
            {
              rcept_no: '20250515000001',
              se: '보통주',
              istc_totqy: '1,000,000',
            },
          ],
        });
      }
      return jsonResponse({ status: '013', message: 'no data' });
    }) as unknown as typeof fetch;

    const source = createDartFactSource(
      { baseUrl: 'https://opendart.fss.or.kr', apiKey: 'K' },
      LOGGER,
      { fetchImpl, sleep: async () => undefined, corpCodeResolver: STUB_RESOLVER },
    );
    const result = await source.fetchFinancials({
      symbols: ['005930'],
      fromYear: 2025,
      toYear: 2025,
      consolidated: true,
    });

    const assets = result.facts.find((fact) => fact.field === 'CURRENT_ASSETS');
    expect(assets).toMatchObject({ key: '005930', periodKey: '2025Q1', value: 500_000 });

    const shares = result.facts.find((fact) => fact.field === 'SHARES_OUTSTANDING');
    expect(shares).toMatchObject({ value: 1_000_000, unit: 'SHARES' });
  });

  it('우선주 발행주식수는 합산하지 않는다', async () => {
    const fetchImpl = (async (url: string) => {
      if (String(url).includes('stockTotqySttus')) {
        return jsonResponse({
          status: '000',
          message: '정상',
          list: [
            { rcept_no: '20250515000001', se: '보통주', istc_totqy: '1,000,000' },
            { rcept_no: '20250515000001', se: '우선주', istc_totqy: '200,000' },
            { rcept_no: '20250515000001', se: '합계', istc_totqy: '1,200,000' },
          ],
        });
      }
      return jsonResponse({ status: '013', message: 'no data' });
    }) as unknown as typeof fetch;

    const source = createDartFactSource(
      { baseUrl: 'https://opendart.fss.or.kr', apiKey: 'K' },
      LOGGER,
      { fetchImpl, sleep: async () => undefined, corpCodeResolver: STUB_RESOLVER },
    );
    const result = await source.fetchFinancials({
      symbols: ['005930'],
      fromYear: 2025,
      toYear: 2025,
      consolidated: true,
    });
    const shares = result.facts.filter((fact) => fact.field === 'SHARES_OUTSTANDING');
    expect(shares).toHaveLength(1);
    expect(shares[0]?.value).toBe(1_000_000);
  });
});
