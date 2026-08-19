import { describe, expect, it } from 'vitest';
import { FactSourceNotConfiguredError } from '../../src/server/modules/facts/application/ports.js';
import type { CorpCodeResolver } from '../../src/server/modules/facts/infrastructure/dart/dart-corp-code-cache.js';
import { createDartFactSource } from '../../src/server/modules/facts/infrastructure/dart/dart-fact-source.js';
import { receiptDateToAsOfTsMs } from '../../src/server/modules/facts/infrastructure/dart/dart-report-parser.js';

const LOGGER = { debug() {}, info() {}, warn() {}, error() {} } as never;

/** 로그 라인을 캡처하는 로거 — 비밀값이 로그로 새지 않는지 검증할 때 쓴다 */
function createCapturingLogger(): { logger: never; lines: string[] } {
  const lines: string[] = [];
  const capture = (...args: unknown[]) => lines.push(JSON.stringify(args));
  return {
    logger: { debug: capture, info: capture, warn: capture, error: capture } as never,
    lines,
  };
}

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
      source.fetchFinancials({ symbols: ['005930'], years: [2025], shareYears: [2024, 2025], consolidated: true }),
    ).rejects.toBeInstanceOf(FactSourceNotConfiguredError);
    await expect(
      source.fetchCorporateActions({ symbols: ['005930'], years: [2025], shareYears: [2024, 2025], consolidated: true }),
    ).rejects.toBeInstanceOf(FactSourceNotConfiguredError);
  });
});

describe('createDartFactSource — 연도 목록 포트', () => {
  it('불연속 연도를 요청하면 그 연도만 호출한다', async () => {
    const calls: string[] = [];
    const source = createDartFactSource(
      { baseUrl: 'https://dart.test', apiKey: 'k' },
      LOGGER,
      {
        fetchImpl: async (url) => {
          calls.push(String(url));
          return jsonResponse({ status: '013', message: '조회된 데이터가 없습니다' });
        },
        sleep: async () => {},
        corpCodeResolver: { resolve: async () => '00126380' },
      },
    );

    await source.fetchFinancials({
      symbols: ['005930'],
      years: [2020, 2024],
      shareYears: [2019, 2020, 2024],
      consolidated: true,
    });

    const accountYears = calls
      .filter((url) => url.includes('fnlttSinglAcntAll'))
      .map((url) => new URL(url).searchParams.get('bsns_year'));
    expect([...new Set(accountYears)].sort()).toEqual(['2020', '2024']);

    const shareYears = calls
      .filter((url) => url.includes('stockTotqySttus'))
      .map((url) => new URL(url).searchParams.get('bsns_year'));
    expect([...new Set(shareYears)].sort()).toEqual(['2019', '2020', '2024']);
  });

  it('자본변동은 years 로, 주식총수 시계열은 shareYears 로 읽는다', async () => {
    const calls: string[] = [];
    const source = createDartFactSource(
      { baseUrl: 'https://dart.test', apiKey: 'k' },
      LOGGER,
      {
        fetchImpl: async (url) => {
          calls.push(String(url));
          return jsonResponse({ status: '013', message: '조회된 데이터가 없습니다' });
        },
        sleep: async () => {},
        corpCodeResolver: { resolve: async () => '00126380' },
      },
    );

    await source.fetchCorporateActions({
      symbols: ['005930'],
      years: [2024],
      shareYears: [2023, 2024],
      consolidated: true,
    });

    const issuanceYears = calls
      .filter((url) => url.includes('irdsSttus'))
      .map((url) => new URL(url).searchParams.get('bsns_year'));
    expect([...new Set(issuanceYears)]).toEqual(['2024']);
    expect(issuanceYears).toHaveLength(4);

    const shareYears = calls
      .filter((url) => url.includes('stockTotqySttus'))
      .map((url) => new URL(url).searchParams.get('bsns_year'));
    expect([...new Set(shareYears)].sort()).toEqual(['2023', '2024']);
  });
});

describe('createDartFactSource — 미래 보고서 생략', () => {
  /**
   * 기간이 끝나지 않은 보고서 조회는 항상 013 이다 (2026-08-11 운영 DART 검증).
   * 그 호출을 생략해야 현재 연도 work unit 이 최대 12회를 무조건 쓰지 않고 실제로 존재할 수
   * 있는 보고서만 요청한다 — sync-plan 의 estimateDartCalls 와 같은 판정을 쓴다.
   */
  it('현재 연도는 분기말이 지난 재무·주식총수·자본변동 보고서만 조회한다', async () => {
    const calls: string[] = [];
    const options = {
      fetchImpl: (async (url: string | URL) => {
        calls.push(String(url));
        return jsonResponse({ status: '013', message: '조회된 데이타가 없습니다.' });
      }) as typeof fetch,
      sleep: async () => {},
      corpCodeResolver: { resolve: async () => '00126380' },
      clock: { now: () => Date.parse('2026-08-11T03:00:00Z') }, // KST 2026-08-11 12:00
    };
    const source = createDartFactSource({ baseUrl: 'https://dart.test', apiKey: 'k' }, LOGGER, options);

    await source.fetchFinancials({
      symbols: ['005930'],
      years: [2026],
      shareYears: [2025, 2026],
      consolidated: true,
    });

    const reportsByEndpoint = (endpoint: string, year: string): string[] => calls
      .filter((url) => url.includes(endpoint))
      .filter((url) => new URL(url).searchParams.get('bsns_year') === year)
      .map((url) => new URL(url).searchParams.get('reprt_code') as string)
      .sort();
    // 1Q(11013)·반기(11012)만 — 3Q·사업보고서는 기간이 끝나지 않았다
    expect(reportsByEndpoint('fnlttSinglAcntAll', '2026')).toEqual(['11012', '11013']);
    expect(reportsByEndpoint('stockTotqySttus', '2026')).toEqual(['11012', '11013']);
    // 지난 연도는 4개 전부
    expect(reportsByEndpoint('stockTotqySttus', '2025')).toEqual(['11011', '11012', '11013', '11014']);

    calls.length = 0;
    // 주식총수 캐시가 첫 fetch 의 응답을 재사용하므로 새 인스턴스로 확인한다
    const freshSource = createDartFactSource(
      { baseUrl: 'https://dart.test', apiKey: 'k' },
      LOGGER,
      options,
    );
    await freshSource.fetchCorporateActions({
      symbols: ['005930'],
      years: [2026],
      shareYears: [2025, 2026],
      consolidated: true,
    });
    expect(reportsByEndpoint('irdsSttus', '2026')).toEqual(['11012', '11013']);
    expect(reportsByEndpoint('stockTotqySttus', '2026')).toEqual(['11012', '11013']);
  });
});

describe('createDartFactSource — 정기공시 목록 (list.json)', () => {
  const filing = (over: Record<string, string>) => ({
    corp_code: '00126380',
    corp_name: '삼성전자',
    stock_code: '005930',
    corp_cls: 'Y',
    report_nm: '분기보고서 (2026.03)',
    rcept_no: '20260515000001',
    flr_nm: '삼성전자',
    rcept_dt: '20260515',
    rm: '',
    ...over,
  });

  it('페이지를 모두 읽고 종목코드·사업연도·접수일로 매핑한다', async () => {
    const urls: string[] = [];
    const source = createDartFactSource(
      { baseUrl: 'https://dart.test', apiKey: 'k' },
      LOGGER,
      {
        fetchImpl: async (url) => {
          urls.push(String(url));
          const pageNo = new URL(String(url)).searchParams.get('page_no');
          return jsonResponse({
            status: '000',
            message: '정상',
            page_no: Number(pageNo),
            total_page: 2,
            list: pageNo === '1'
              ? [
                  filing({}),
                  // 종목코드 없는 비상장 제출자는 걸러진다
                  filing({ stock_code: ' ', corp_name: '비상장' }),
                ]
              : [
                  filing({
                    report_nm: '[기재정정]사업보고서 (2025.12)',
                    stock_code: '000660',
                    rcept_no: '20260601000002',
                    rcept_dt: '20260601',
                  }),
                  // 사업연도 표기가 예상과 다르면 null 로 넘긴다
                  filing({
                    report_nm: '분기보고서',
                    stock_code: '000100',
                    rcept_no: '20260515000003',
                  }),
                ],
          });
        },
        sleep: async () => {},
        corpCodeResolver: STUB_RESOLVER,
      },
    );

    const filings = await source.listRecentPeriodicFilings('2026-05-01', '2026-06-02');

    expect(filings).toEqual([
      {
        receiptNo: '20260515000001',
        stockCode: '005930',
        businessYear: 2026,
        receiptDate: '2026-05-15',
      },
      {
        receiptNo: '20260601000002',
        stockCode: '000660',
        businessYear: 2025,
        receiptDate: '2026-06-01',
      },
      {
        receiptNo: '20260515000003',
        stockCode: '000100',
        businessYear: null,
        receiptDate: '2026-05-15',
      },
    ]);

    // 정기공시만, 요청 구간 그대로, 페이지 2개
    const first = new URL(urls[0] as string);
    expect(first.pathname).toBe('/api/list.json');
    expect(first.searchParams.get('pblntf_ty')).toBe('A');
    expect(first.searchParams.get('bgn_de')).toBe('20260501');
    expect(first.searchParams.get('end_de')).toBe('20260602');
    expect(urls).toHaveLength(2);
  });

  it('조회 없음(013)은 빈 목록이다', async () => {
    const source = createDartFactSource(
      { baseUrl: 'https://dart.test', apiKey: 'k' },
      LOGGER,
      {
        fetchImpl: async () => jsonResponse({ status: '013', message: '조회된 데이타가 없습니다.' }),
        sleep: async () => {},
        corpCodeResolver: STUB_RESOLVER,
      },
    );
    expect(await source.listRecentPeriodicFilings('2026-05-01', '2026-05-02')).toEqual([]);
  });

  it('상장사 공시에 접수번호가 없으면 중복 판정을 계속하지 않는다', async () => {
    const source = createDartFactSource(
      { baseUrl: 'https://dart.test', apiKey: 'k' },
      LOGGER,
      {
        fetchImpl: async () => jsonResponse({
          status: '000',
          message: '정상',
          total_page: 1,
          list: [filing({ rcept_no: '' })],
        }),
        sleep: async () => {},
        corpCodeResolver: STUB_RESOLVER,
      },
    );

    await expect(source.listRecentPeriodicFilings('2026-05-01', '2026-05-02'))
      .rejects.toThrow('접수번호가 올바르지 않습니다');
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
      years: [2025],
      shareYears: [2024, 2025],
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
      years: [2025],
      shareYears: [2024, 2025],
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
      years: [2025],
      shareYears: [2024, 2025],
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
      years: [2025],
      shareYears: [2024, 2025],
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
      source.fetchFinancials({ symbols: ['005930'], years: [2025], shareYears: [2024, 2025], consolidated: true }),
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
              stlm_dt: '2025-03-31',
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
      years: [2025],
      shareYears: [2024, 2025],
      consolidated: true,
    });

    const assets = result.facts.find((fact) => fact.field === 'CURRENT_ASSETS');
    expect(assets).toMatchObject({ key: '005930', periodKey: '2025Q1', value: 500_000 });

    // 이 픽스처는 bsns_year 를 가리지 않으므로 앵커 연도(2024)도 같은 주식총수를
    // 돌려준다 — periodKey 를 함께 단정하지 않으면 요청 연도가 아닌 앵커 연도의
    // 팩트를 검사하고도 통과한다
    const shares = result.facts.find(
      (fact) => fact.field === 'SHARES_OUTSTANDING' && fact.periodKey === '2025Q1',
    );
    expect(shares).toMatchObject({ key: '005930', periodKey: '2025Q1', value: 1_000_000, unit: 'SHARES' });
  });

  it('우선주 발행주식수는 합산하지 않는다', async () => {
    // stockTotqySttus 는 reprt_code 로 스코프한다 — 딱 한 보고서(11013)만 응답을 주고
    // 나머지 세 보고서는 데이터 없음(013)으로 응답해, 이 테스트가 실제로 검증하는
    // 것("합계"·"우선주" 행을 섞지 않는다)과 보고서별 반복 조회가 뒤섞이지 않게 한다.
    const fetchImpl = (async (url: string) => {
      if (String(url).includes('stockTotqySttus') && String(url).includes('reprt_code=11013')) {
        return jsonResponse({
          status: '000',
          message: '정상',
          list: [
            { rcept_no: '20250515000001', se: '보통주', istc_totqy: '1,000,000', stlm_dt: '2025-03-31' },
            { rcept_no: '20250515000001', se: '우선주', istc_totqy: '200,000', stlm_dt: '2025-03-31' },
            { rcept_no: '20250515000001', se: '합계', istc_totqy: '1,200,000', stlm_dt: '2025-03-31' },
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
      years: [2025],
      // 앵커 연도(2024)를 넣으면 이 픽스처가 연도를 가리지 않아 같은 응답이 두 번
      // 팩트가 된다 — 이 테스트가 세는 대상은 '보통주 한 행' 이므로 대상 연도만 읽는다
      shareYears: [2025],
      consolidated: true,
    });
    const shares = result.facts.filter((fact) => fact.field === 'SHARES_OUTSTANDING');
    expect(shares).toHaveLength(1);
    expect(shares[0]?.value).toBe(1_000_000);
    expect(shares[0]?.periodKey).toBe('2025Q1');
  });

  it('보고서 네 개가 각각 다른 발행주식수를 주면 분기별로 네 개의 팩트가 된다', async () => {
    // stockTotqySttus 는 사업보고서뿐 아니라 분기·반기보고서에도 '주식의 총수 현황'
    // 섹션을 담고 있다 — 네 보고서 모두 조회하고 각자의 분기에 붙인다(연 1회로 줄이면
    // 안 되는 이유는 dart-fact-source.ts 상단 주석·task-10-report.md 참고).
    const byReport: Record<string, string> = {
      '11013': '1,000,000',
      '11012': '1,010,000',
      '11014': '1,020,000',
      '11011': '1,030,000',
    };
    const fetchImpl = (async (url: string) => {
      const target = String(url);
      if (target.includes('stockTotqySttus')) {
        for (const [reportCode, quantity] of Object.entries(byReport)) {
          if (target.includes(`reprt_code=${reportCode}`)) {
            return jsonResponse({
              status: '000',
              message: '정상',
              list: [{
                rcept_no: '20250515000001',
                se: '보통주',
                istc_totqy: quantity,
                stlm_dt: {
                  '11013': '2025-03-31',
                  '11012': '2025-06-30',
                  '11014': '2025-09-30',
                  '11011': '2025-12-31',
                }[reportCode],
              }],
            });
          }
        }
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
      years: [2025],
      // 앵커 연도를 넣으면 보고서별 픽스처가 2년치로 8개 팩트가 된다 — 이 테스트가
      // 고정하는 것은 '보고서 네 개 → 분기 네 개' 이므로 대상 연도만 읽는다
      shareYears: [2025],
      consolidated: true,
    });
    const shares = result.facts.filter((fact) => fact.field === 'SHARES_OUTSTANDING');
    expect(shares).toHaveLength(4);
    expect(shares.map((fact) => fact.periodKey).sort()).toEqual([
      '2025Q1',
      '2025Q2',
      '2025Q3',
      '2025Q4',
    ]);
    expect(shares.find((fact) => fact.periodKey === '2025Q1')?.value).toBe(1_000_000);
    expect(shares.find((fact) => fact.periodKey === '2025Q2')?.value).toBe(1_010_000);
    expect(shares.find((fact) => fact.periodKey === '2025Q3')?.value).toBe(1_020_000);
    expect(shares.find((fact) => fact.periodKey === '2025Q4')?.value).toBe(1_030_000);
  });

  it('필터를 전부 걸러낸 응답은 gap 을 남긴다 — 조용히 0 이 되지 않는다', async () => {
    // sj_div 가 파서가 소비하는 값(BS/IS/CIS)이 아닌 행만 왔다고 가정한다. 행 자체는
    // 있으므로 013(데이터 없음)이 아니라, "필터를 통과한 게 없다"는 별도 gap 이어야 한다.
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
              sj_div: 'CF', // 파서가 소비하지 않는 통계 — 의도적으로 전부 이 값
              account_id: 'x',
              account_nm: '영업활동현금흐름',
              thstrm_amount: '1',
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
      years: [2025],
      shareYears: [2024, 2025],
      consolidated: true,
    });
    expect(
      result.gaps.some(
        (gap) => gap.periodKey === '2025Q1' && gap.reason.includes('필터에서 제외'),
      ),
    ).toBe(true);
  });

  it('bsns_year 가 요청 연도와 다른 행뿐이면 gap 을 남긴다', async () => {
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
              bsns_year: '2024', // 요청 연도(2025)와 다르다 — 통째로 필터에서 빠진다
              sj_div: 'BS',
              account_id: 'ifrs-full_CurrentAssets',
              account_nm: '유동자산',
              thstrm_amount: '500,000',
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
      years: [2025],
      shareYears: [2024, 2025],
      consolidated: true,
    });
    expect(
      result.gaps.some(
        (gap) => gap.periodKey === '2025Q1' && gap.reason.includes('필터에서 제외'),
      ),
    ).toBe(true);
    expect(result.facts.some((fact) => fact.field === 'CURRENT_ASSETS')).toBe(false);
  });

  it('API 키는 실패 메시지에도 로그에도 나타나지 않는다', async () => {
    const SECRET = 'SECRET_KEY_ABC';
    const { logger, lines } = createCapturingLogger();
    const fetchImpl = (async () =>
      jsonResponse({ status: '020', message: '요청 제한을 초과하였습니다.' })) as unknown as typeof fetch;
    const source = createDartFactSource(
      { baseUrl: 'https://opendart.fss.or.kr', apiKey: SECRET },
      logger,
      { fetchImpl, sleep: async () => undefined, corpCodeResolver: STUB_RESOLVER },
    );

    let rejection: unknown;
    try {
      await source.fetchFinancials({ symbols: ['005930'], years: [2025], shareYears: [2024, 2025], consolidated: true });
    } catch (error) {
      rejection = error;
    }
    expect(rejection).toBeInstanceOf(Error);
    expect(String((rejection as Error).message)).not.toContain(SECRET);
    for (const line of lines) {
      expect(line).not.toContain(SECRET);
    }
  });
});

/**
 * 지금까지 어떤 테스트도 이 경로를 실행하지 않았다 — 모든 테스트가 `corpCodeResolver` 를
 * 주입해 기본 corpCode.xml 다운로드 클로저를 우회한다. 그 클로저는 API 키를 쿼리로
 * 붙이고, 실패 시 `corpCode.xml 다운로드 실패: <status>` 를 던진다. 여기에 URL 을
 * 더하는 것은 디버깅용으로 가장 먼저 떠오르는 수정이고, 그 문자열은 잡 레코드를 거쳐
 * 웹 UI 까지 간다. 그러니 경로가 실행됨을 확인하면서 동시에 못박는다.
 */
describe('createDartFactSource — corpCode.xml 다운로드 (기본 resolver)', () => {
  const SECRET = 'SECRET_KEY_XYZ789';

  it('키를 쿼리로 붙여 내려받고, 실패 메시지·로그에 키가 실리지 않는다', async () => {
    const urls: string[] = [];
    const { logger, lines } = createCapturingLogger();
    const fetchImpl = (async (url: string) => {
      urls.push(String(url));
      // 다운로드 실패 경로 — 이 클로저의 throw 문을 그대로 탄다
      return new Response('nope', { status: 404 });
    }) as unknown as typeof fetch;

    // corpCodeResolver 를 **주입하지 않는다** — 기본 클로저가 실행되어야 한다
    const source = createDartFactSource(
      { baseUrl: 'https://opendart.fss.or.kr', apiKey: SECRET },
      logger,
      { fetchImpl, sleep: async () => undefined },
    );

    let rejection: unknown;
    try {
      await source.fetchFinancials({
        symbols: ['005930'],
        years: [2025],
        shareYears: [2024, 2025],
        consolidated: true,
      });
    } catch (error) {
      rejection = error;
    }

    // 경로가 실제로 실행됐음을 먼저 확인한다 — 아니면 아래 단정이 공허해진다
    expect(urls.some((url) => url.includes('/api/corpCode.xml'))).toBe(true);
    expect(urls.some((url) => url.includes(`crtfc_key=${SECRET}`))).toBe(true);

    expect(rejection).toBeInstanceOf(Error);
    expect((rejection as Error).message).toContain('DART 종목 코드 목록을 내려받지 못했습니다');
    expect((rejection as Error).message).not.toContain(SECRET);
    expect((rejection as Error).stack ?? '').not.toContain(SECRET);
    for (const line of lines) {
      expect(line).not.toContain(SECRET);
    }
  });

  it('ZIP 이 아닌 본문(인증 실패 응답)도 키를 노출하지 않고 실패한다', async () => {
    const { logger, lines } = createCapturingLogger();
    const fetchImpl = (async () =>
      new Response('<result><status>020</status></result>', { status: 200 })) as unknown as typeof fetch;

    const source = createDartFactSource(
      { baseUrl: 'https://opendart.fss.or.kr', apiKey: SECRET },
      logger,
      { fetchImpl, sleep: async () => undefined },
    );

    let rejection: unknown;
    try {
      await source.fetchCorporateActions({
        symbols: ['005930'],
        years: [2025],
        shareYears: [2024, 2025],
        consolidated: true,
      });
    } catch (error) {
      rejection = error;
    }
    expect(rejection).toBeInstanceOf(Error);
    expect((rejection as Error).message).toContain('ZIP 형식이 아닙니다');
    expect((rejection as Error).message).not.toContain(SECRET);
    for (const line of lines) {
      expect(line).not.toContain(SECRET);
    }
  });
});

/**
 * FactSyncService 는 진행이 살아남도록 **종목 하나씩** fetchFinancials/fetchCorporateActions
 * 를 부른다. 그 배선의 전제는 "corp_code 매핑과 주식총수 응답 캐시는 소스 인스턴스
 * 클로저에 있어서 종목별 호출에서도 공유된다" 는 것이다 — 그 전제가 깨지면 종목마다
 * corpCode.xml 을 다시 내려받아 일 한도(4만)를 그만큼 더 빨리 태운다.
 */
describe('createDartFactSource — 종목별 호출에서도 캐시가 공유된다', () => {
  /** 단일 엔트리 STORED ZIP — extractSingleFileFromZip 이 읽는 최소 형태 */
  function storedZip(name: string, content: string): Buffer {
    const nameBytes = Buffer.from(name, 'utf8');
    const payload = Buffer.from(content, 'utf8');
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(0, 8); // method = STORED
    header.writeUInt32LE(payload.length, 18); // compressedSize
    header.writeUInt32LE(payload.length, 22); // uncompressedSize
    header.writeUInt16LE(nameBytes.length, 26);
    header.writeUInt16LE(0, 28);
    return Buffer.concat([header, nameBytes, payload]);
  }

  const CORP_XML =
    '<result>' +
    '<list><corp_code>00126380</corp_code><stock_code>005930</stock_code></list>' +
    '<list><corp_code>00164779</corp_code><stock_code>000660</stock_code></list>' +
    '</result>';

  it('종목마다 따로 호출해도 corpCode.xml 은 한 번만 내려받는다', async () => {
    const urls: string[] = [];
    const fetchImpl = (async (url: string) => {
      const target = String(url);
      urls.push(target);
      if (target.includes('/api/corpCode.xml')) {
        return new Response(new Uint8Array(storedZip('CORPCODE.xml', CORP_XML)), { status: 200 });
      }
      return jsonResponse({ status: '013', message: 'no data' });
    }) as unknown as typeof fetch;

    // corpCodeResolver 를 주입하지 않는다 — 기본 캐시가 실제로 캐시하는지 본다
    const source = createDartFactSource(
      { baseUrl: 'https://opendart.fss.or.kr', apiKey: 'K' },
      LOGGER,
      { fetchImpl, sleep: async () => undefined },
    );

    // FactSyncService 와 같은 모양: 종목 하나씩, 두 fetch 를 각각
    for (const symbol of ['005930', '000660']) {
      const scoped = {
        symbols: [symbol],
        years: [2025],
        shareYears: [2024, 2025],
        consolidated: true,
      };
      await source.fetchFinancials(scoped);
      await source.fetchCorporateActions(scoped);
    }

    expect(urls.filter((url) => url.includes('/api/corpCode.xml'))).toHaveLength(1);
    // 매핑이 실제로 쓰였음도 확인한다 — 그렇지 않으면 위 단정이 "아무도 안 불렀다" 와 같다
    expect(urls.some((url) => url.includes('corp_code=00126380'))).toBe(true);
    expect(urls.some((url) => url.includes('corp_code=00164779'))).toBe(true);
  });

  it('같은 종목의 주식총수 응답은 fetchFinancials·fetchCorporateActions 가 공유한다', async () => {
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

    const scoped = {
      symbols: ['005930'],
      years: [2025],
      shareYears: [2024, 2025],
      consolidated: true,
    };
    await source.fetchFinancials(scoped);
    await source.fetchCorporateActions(scoped);

    // 보고서 4종 × 주식총수 연도 2년(대상 연도 + 앵커 1년) = 8회. 두 fetch 가 각각
    // 부르면 16회가 된다 — 캐시 키에 연도가 들어 있어야 이 수가 맞는다.
    expect(urls.filter((url) => url.includes('stockTotqySttus'))).toHaveLength(8);
  });
});

describe('createDartFactSource — fetchCorporateActions 자본변동 접기', () => {
  const SHARE_BASELINE = [{
    rcept_no: '20200515000001',
    se: '보통주',
    istc_totqy: '1,000,000',
    stlm_dt: '2020-03-31',
  }];

  it('같은 분할 이벤트가 해마다 반복되면 가장 이른 공시 하나만 남는다', async () => {
    const fetchImpl = (async (url: string) => {
      const target = String(url);
      if (target.includes('stockTotqySttus') && target.includes('reprt_code=11013') && target.includes('bsns_year=2020')) {
        return jsonResponse({ status: '000', message: '정상', list: SHARE_BASELINE });
      }
      if (target.includes('irdsSttus') && target.includes('bsns_year=2020')) {
        return jsonResponse({
          status: '000',
          message: '정상',
          list: [
            {
              isu_dcrs_de: '2020-06-15',
              isu_dcrs_stle: '주식분할',
              isu_dcrs_qy: '1,000,000',
              rcept_no: '20200620000001',
            },
          ],
        });
      }
      if (target.includes('irdsSttus') && target.includes('bsns_year=2021')) {
        return jsonResponse({
          status: '000',
          message: '정상',
          // 같은 분할을 이듬해 사업보고서가 누적 이력으로 다시 보고한다 — rcept_no 만 다르다
          list: [
            {
              isu_dcrs_de: '2020-06-15',
              isu_dcrs_stle: '주식분할',
              isu_dcrs_qy: '1,000,000',
              rcept_no: '20210620000001',
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
    const result = await source.fetchCorporateActions({
      symbols: ['005930'],
      years: [2020, 2021],
      shareYears: [2019, 2020, 2021],
      consolidated: true,
    });

    const actions = result.facts.filter((fact) => fact.field === 'SPLIT_RATIO');
    expect(actions).toHaveLength(1);
    expect(actions[0]?.periodKey).toBe('2020-06-15');
    expect(actions[0]?.value).toBe(2);
    expect(actions[0]?.asOfTsMs).toBe(receiptDateToAsOfTsMs('20200620000001'));
  });

  it('최신 누적 스냅샷의 정정값을 쓰고 이전 값은 버린다', async () => {
    const fetchImpl = (async (url: string) => {
      const target = String(url);
      if (target.includes('stockTotqySttus') && target.includes('reprt_code=11013') && target.includes('bsns_year=2020')) {
        return jsonResponse({ status: '000', message: '정상', list: SHARE_BASELINE });
      }
      if (target.includes('irdsSttus') && target.includes('bsns_year=2020')) {
        return jsonResponse({
          status: '000',
          message: '정상',
          list: [
            {
              isu_dcrs_de: '2020-06-15',
              isu_dcrs_stle: '주식분할',
              isu_dcrs_qy: '1,000,000', // ratio = 2
              rcept_no: '20200620000001',
            },
          ],
        });
      }
      if (target.includes('irdsSttus') && target.includes('bsns_year=2021')) {
        return jsonResponse({
          status: '000',
          message: '정상',
          list: [
            {
              isu_dcrs_de: '2020-06-15',
              isu_dcrs_stle: '주식분할',
              isu_dcrs_qy: '2,000,000', // ratio = 3 — 앞선 공시와 불일치
              rcept_no: '20210620000001',
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
    const result = await source.fetchCorporateActions({
      symbols: ['005930'],
      years: [2020, 2021],
      shareYears: [2019, 2020, 2021],
      consolidated: true,
    });

    const actions = result.facts.filter((fact) => fact.field === 'SPLIT_RATIO');
    expect(actions).toHaveLength(1);
    expect(actions[0]?.value).toBe(3);
    expect(
      result.gaps.some((gap) => gap.reason.includes('자본변동 비율이 공시마다 다릅니다')),
    ).toBe(false);
  });

  it('공시 접수일이 아니라 분기 기준일로 감자 직전 주식수를 고른다', async () => {
    const sharesByReport: Record<string, { rcept_no: string; istc_totqy: string; stlm_dt: string }> = {
      // 미래산업(025560) 실제 값. Q2 보고서는 감자 뒤인 8월에 접수됐지만 기준일은
      // 감자 직전인 6월 30일이므로 7월 1일 감자의 분모가 되어야 한다.
      '11013': { rcept_no: '20250514000001', istc_totqy: '59,566,032', stlm_dt: '2025-03-31' },
      '11012': { rcept_no: '20250813000001', istc_totqy: '71,722,474', stlm_dt: '2025-06-30' },
      '11014': { rcept_no: '20251114000001', istc_totqy: '4,482,654', stlm_dt: '2025-09-30' },
    };

    const fetchImpl = (async (url: string) => {
      const target = String(url);
      if (target.includes('stockTotqySttus')) {
        for (const [reportCode, row] of Object.entries(sharesByReport)) {
          if (target.includes(`reprt_code=${reportCode}`)) {
            return jsonResponse({
              status: '000',
              message: '정상',
              list: [{ ...row, se: '보통주' }],
            });
          }
        }
      }
      if (target.includes('irdsSttus') && target.includes('reprt_code=11014')) {
        return jsonResponse({
          status: '000',
          message: '정상',
          list: [
            {
              isu_dcrs_de: '2025-07-01',
              isu_dcrs_stle: '무상감자',
              isu_dcrs_stock_knd: '보통주',
              isu_dcrs_qy: '67,239,820',
              rcept_no: '20251112000133',
            },
          ],
        });
      }
      if (target.includes('irdsSttus') && target.includes('reprt_code=11011')) {
        return jsonResponse({
          status: '000',
          message: '정상',
          list: [{
            isu_dcrs_de: '2025-07-01',
            isu_dcrs_stle: '무상감자',
            isu_dcrs_stock_knd: '보통주',
            isu_dcrs_qy: '67,239,820',
            rcept_no: '20260319001166',
          }],
        });
      }
      return jsonResponse({ status: '013', message: 'no data' });
    }) as unknown as typeof fetch;

    const source = createDartFactSource(
      { baseUrl: 'https://opendart.fss.or.kr', apiKey: 'K' },
      LOGGER,
      { fetchImpl, sleep: async () => undefined, corpCodeResolver: STUB_RESOLVER },
    );
    const result = await source.fetchCorporateActions({
      symbols: ['025560'],
      years: [2025],
      shareYears: [2024, 2025],
      consolidated: true,
    });

    const actions = result.facts.filter((fact) => fact.field === 'SPLIT_RATIO');
    expect(actions).toHaveLength(1);
    expect(actions[0]?.value).toBeCloseTo(4_482_654 / 71_722_474);
    expect(actions[0]?.asOfTsMs).toBe(receiptDateToAsOfTsMs('20251112000133'));
    expect(result.gaps.some((gap) => gap.reason.includes('비율이 유효하지 않습니다'))).toBe(false);
  });

  it('최신 누적 스냅샷만 재생하고 남은 이벤트의 최초 접수일은 보존한다', async () => {
    const fetchImpl = (async (url: string) => {
      const target = String(url);
      if (target.includes('stockTotqySttus') && target.includes('reprt_code=11013')) {
        return jsonResponse({
          status: '000',
          message: '정상',
          list: [{
            rcept_no: '20250514000001',
            se: '보통주',
            istc_totqy: '1,000,000',
            stlm_dt: '2025-03-31',
          }],
        });
      }
      if (target.includes('stockTotqySttus') && target.includes('reprt_code=11014')) {
        return jsonResponse({
          status: '000',
          message: '정상',
          list: [{
            rcept_no: '20251114000001',
            se: '보통주',
            istc_totqy: '650,000',
            stlm_dt: '2025-09-30',
          }],
        });
      }
      if (target.includes('stockTotqySttus') && target.includes('reprt_code=11011')) {
        return jsonResponse({
          status: '000',
          message: '정상',
          list: [{
            rcept_no: '20260331000001',
            se: '보통주',
            istc_totqy: '650,000',
            stlm_dt: '2025-12-31',
          }],
        });
      }
      if (target.includes('irdsSttus') && target.includes('reprt_code=11014')) {
        return jsonResponse({
          status: '000',
          message: '정상',
          list: [
            {
              isu_dcrs_de: '2025-07-15',
              isu_dcrs_stle: '유상증자(제3자배정)',
              isu_dcrs_stock_knd: '보통주',
              isu_dcrs_qy: '100,000',
              rcept_no: '20251114000001',
            },
            {
              isu_dcrs_de: '2025-07-20',
              isu_dcrs_stle: '전환권행사',
              isu_dcrs_stock_knd: '보통주',
              isu_dcrs_qy: '200,000',
              rcept_no: '20251114000001',
            },
            {
              isu_dcrs_de: '2025-09-01',
              isu_dcrs_stle: '무상감자',
              isu_dcrs_stock_knd: '보통주',
              isu_dcrs_qy: '650,000',
              rcept_no: '20251114000001',
            },
          ],
        });
      }
      if (target.includes('irdsSttus') && target.includes('reprt_code=11011')) {
        return jsonResponse({
          status: '000',
          message: '정상',
          list: [
            {
              isu_dcrs_de: '2025-07-20',
              isu_dcrs_stle: '전환권행사',
              isu_dcrs_stock_knd: '보통주',
              isu_dcrs_qy: '300,000',
              rcept_no: '20260331000001',
            },
            {
              isu_dcrs_de: '2025-09-01',
              isu_dcrs_stle: '무상감자',
              isu_dcrs_stock_knd: '보통주',
              isu_dcrs_qy: '650,000',
              rcept_no: '20260331000001',
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
    const result = await source.fetchCorporateActions({
      symbols: ['005930'],
      years: [2025],
      shareYears: [2024, 2025],
      consolidated: true,
    });

    const actions = result.facts.filter((fact) => fact.field === 'SPLIT_RATIO');
    expect(actions).toHaveLength(1);
    expect(actions[0]?.value).toBeCloseTo(0.5);
    expect(actions[0]?.asOfTsMs).toBe(receiptDateToAsOfTsMs('20251114000001'));
    expect(result.gaps).toEqual([]);
  });

  it('하드코딩한 달력이 아니라 stlm_dt를 기준일로 쓴다', async () => {
    const fetchImpl = (async (url: string) => {
      const target = String(url);
      if (target.includes('stockTotqySttus') && target.includes('bsns_year=2024') && target.includes('reprt_code=11011')) {
        return jsonResponse({
          status: '000',
          message: '정상',
          list: [{ rcept_no: '20250601000001', se: '보통주', istc_totqy: '800,000', stlm_dt: '2025-03-31' }],
        });
      }
      if (target.includes('stockTotqySttus') && target.includes('bsns_year=2025') && target.includes('reprt_code=11013')) {
        return jsonResponse({
          status: '000',
          message: '정상',
          list: [{ rcept_no: '20250901000001', se: '보통주', istc_totqy: '1,000,000', stlm_dt: '2025-06-30' }],
        });
      }
      if (target.includes('irdsSttus') && target.includes('reprt_code=11013')) {
        return jsonResponse({
          status: '000',
          message: '정상',
          list: [{
            isu_dcrs_de: '2025-05-01',
            isu_dcrs_stle: '무상감자',
            isu_dcrs_stock_knd: '보통주',
            isu_dcrs_qy: '400,000',
            rcept_no: '20250901000001',
          }],
        });
      }
      return jsonResponse({ status: '013', message: 'no data' });
    }) as unknown as typeof fetch;

    const source = createDartFactSource(
      { baseUrl: 'https://opendart.fss.or.kr', apiKey: 'K' },
      LOGGER,
      { fetchImpl, sleep: async () => undefined, corpCodeResolver: STUB_RESOLVER },
    );
    const result = await source.fetchCorporateActions({
      symbols: ['005930'],
      years: [2025],
      shareYears: [2024, 2025],
      consolidated: true,
    });

    expect(result.facts.filter((fact) => fact.field === 'SPLIT_RATIO')[0]?.value).toBeCloseTo(0.5);
  });

  it('두 종목의 자본변동 접기 키가 서로 새지 않는다', async () => {
    const fetchImpl = (async (url: string) => {
      const target = String(url);
      if (target.includes('stockTotqySttus') && target.includes('reprt_code=11013')) {
        return jsonResponse({ status: '000', message: '정상', list: SHARE_BASELINE });
      }
      if (target.includes('irdsSttus') && target.includes('corp_code=corp-005930')) {
        return jsonResponse({
          status: '000',
          message: '정상',
          list: [
            {
              isu_dcrs_de: '2020-06-15',
              isu_dcrs_stle: '주식분할', // ratio = 2 (1,000,000 → 2,000,000)
              isu_dcrs_qy: '1,000,000',
              rcept_no: '20200620000001',
            },
          ],
        });
      }
      if (target.includes('irdsSttus') && target.includes('corp_code=corp-000660')) {
        return jsonResponse({
          status: '000',
          message: '정상',
          list: [
            {
              isu_dcrs_de: '2020-06-15', // 두 번째 종목도 같은 날짜 — 접기 키가 겹친다
              isu_dcrs_stle: '주식분할', // ratio = 3 (1,000,000 → 3,000,000)
              isu_dcrs_qy: '2,000,000',
              rcept_no: '20200620000002',
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
    const result = await source.fetchCorporateActions({
      symbols: ['005930', '000660'],
      years: [2020],
      shareYears: [2019, 2020],
      consolidated: true,
    });

    const actions = result.facts.filter((fact) => fact.field === 'SPLIT_RATIO');
    expect(actions).toHaveLength(2);
    expect(actions.find((fact) => fact.key === '005930')?.value).toBe(2);
    expect(actions.find((fact) => fact.key === '000660')?.value).toBe(3);
    // 두 종목이 같은 날짜의 서로 다른 비율을 냈다고 해서 "공시마다 다르다" gap 이
    // 나면 안 된다 — 그건 접기 키에 종목이 안 섞였을 때만 보장된다.
    expect(
      result.gaps.some((gap) => gap.reason.includes('자본변동 비율이 공시마다 다릅니다')),
    ).toBe(false);
  });
});
