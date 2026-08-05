import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createKrxHistoricalUniverseSource } from '../../src/server/modules/market-data/infrastructure/krx/krx-historical-universe-source.js';
import {
  SymbolMasterNotCoveredError,
  SymbolMasterService,
  type SymbolMasterServiceDeps,
} from '../../src/server/modules/market-data/application/symbol-master-service.js';
import { symbolMasterMarketCaps } from '../../src/server/shared/db/schema.js';
import { createTestApp, type TestApp } from '../helpers/test-app.js';
import {
  baseInfoFixture,
  dailyFixture,
  krxEnvelope,
  startKrxFakeServer,
  type KrxFakeServer,
} from '../helpers/krx-fixtures.js';

const API_KEY = 'SYMBOL_MASTER_MARKET_CAPS_TEST_KEY';
const NOOP_SLEEP = async () => undefined;

interface Ctx {
  readonly t: TestApp;
  readonly fake: KrxFakeServer;
  readonly svc: SymbolMasterService;
}

async function setup(): Promise<Ctx> {
  const t = await createTestApp();
  const fake = await startKrxFakeServer();
  const source = createKrxHistoricalUniverseSource(
    { baseUrl: fake.baseUrl, apiKey: API_KEY, approvalExpiry: null },
    t.container.clock,
    t.container.logger,
    { sleep: NOOP_SLEEP },
  );
  const deps: SymbolMasterServiceDeps = {
    db: t.container.database.db,
    source,
    clock: t.container.clock,
    logger: t.container.logger,
  };
  return { t, fake, svc: new SymbolMasterService(deps) };
}

async function teardown(ctx: Ctx): Promise<void> {
  await ctx.fake.close();
  await ctx.t.close();
}

/** 종목 마스터가 2023-01-02 하루를 커버하도록 최초 수집을 태운다 — 삼성전자 하나뿐인 유니버스다 */
async function ingestSingleSymbolUniverse(ctx: Ctx, date: string, basDd: string): Promise<void> {
  ctx.fake.setResponse('stk_bydd_trd', basDd, { body: krxEnvelope([dailyFixture()]) });
  ctx.fake.setResponse('stk_isu_base_info', basDd, { body: krxEnvelope([baseInfoFixture()]) });
  await ctx.svc.ingestDate(date);
}

describe('SymbolMasterService.getMarketCapsAt', () => {
  it('캐시 미스: KRX 를 2회(KOSPI·KOSDAQ) 조회해 맵을 반환하고 캐시 테이블에 저장한다', async () => {
    const ctx = await setup();
    await ingestSingleSymbolUniverse(ctx, '2023-01-02', '20230102');

    // 일별 거래 응답을 다시 세팅한다 — ingestDate 가 이미 같은 basDd 를 한 번 조회했으므로
    // 이번 호출이 정말 새로 조회하는지는 요청 수 델타로 확인한다.
    ctx.fake.setResponse('stk_bydd_trd', '20230102', { body: krxEnvelope([dailyFixture()]) });
    const before = ctx.fake.requests.length;

    const marketCaps = await ctx.svc.getMarketCapsAt('2023-01-02');

    const daily = ctx.fake.requests.slice(before);
    expect(daily).toHaveLength(2);
    expect(daily.map((r) => r.path).sort()).toEqual(['ksq_bydd_trd', 'stk_bydd_trd']);
    expect(marketCaps.get('KR7005930003')).toBe('350000000000000');
    expect(marketCaps.size).toBe(1);

    const rows = ctx.t.container.database.db
      .select()
      .from(symbolMasterMarketCaps)
      .where(eq(symbolMasterMarketCaps.date, '2023-01-02'))
      .all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ standardCode: 'KR7005930003', marketCapKrw: '350000000000000' });

    await teardown(ctx);
  });

  it('캐시 히트: 재호출해도 fake 서버 요청 수가 늘지 않는다', async () => {
    const ctx = await setup();
    await ingestSingleSymbolUniverse(ctx, '2023-01-02', '20230102');
    ctx.fake.setResponse('stk_bydd_trd', '20230102', { body: krxEnvelope([dailyFixture()]) });
    const first = await ctx.svc.getMarketCapsAt('2023-01-02');

    const before = ctx.fake.requests.length;
    const second = await ctx.svc.getMarketCapsAt('2023-01-02');

    expect(ctx.fake.requests.length).toBe(before);
    expect(second.get('KR7005930003')).toBe(first.get('KR7005930003'));

    await teardown(ctx);
  });

  it('커버 밖 date 는 SymbolMasterNotCoveredError 를 던진다', async () => {
    // 체크포인트가 하나도 없는 초기 상태다 — getUniverseAsOf 가 커버 여부를 가르는
    // 유일한 근거라 어떤 날짜를 물어도 SymbolMasterNotCoveredError 로 걸러진다.
    const ctx = await setup();

    const before = ctx.fake.requests.length;
    await expect(ctx.svc.getMarketCapsAt('2023-01-02')).rejects.toThrow(SymbolMasterNotCoveredError);
    // 유니버스 조회에서 먼저 걸러져야 한다 — KRX 를 헛되이 부르지 않는다.
    expect(ctx.fake.requests.length).toBe(before);

    await teardown(ctx);
  });

  it('체크포인트는 있지만 coverage 갭인 날짜도 SymbolMasterNotCoveredError — 캐시에 이미 값이 있어도 반환하지 않는다', async () => {
    const ctx = await setup();
    // 01-02 최초 수집(체크포인트 생성) 후 01-03~04 를 건너뛰고 01-05 를 수집한다 —
    // symbol-master-ingest.test.ts 의 갭 메우기 시나리오와 같은 모양이다. 체크포인트는
    // 이미 존재하므로 getUniverseAsOf('2023-01-03') 는 (틀리게) 재구성에 성공하지만,
    // isCovered('2023-01-03') 는 false 다 — coverage 구간이 [01-02,01-02], [01-05,01-05]
    // 뿐이라 01-03 은 갭이다.
    await ingestSingleSymbolUniverse(ctx, '2023-01-02', '20230102');
    await ingestSingleSymbolUniverse(ctx, '2023-01-05', '20230105');
    expect(ctx.svc.isCovered('2023-01-03')).toBe(false);

    // 캐시 검사보다 커버 게이트가 먼저라는 것을 증명하기 위해, 갭 날짜에 캐시 행이 이미
    // 있는 상태(예: 이 가드가 없던 과거에 잘못 쌓인 값)를 직접 만들어 둔다.
    ctx.t.container.database.db.insert(symbolMasterMarketCaps).values({
      date: '2023-01-03',
      standardCode: 'KR7005930003',
      marketCapKrw: '999999999999999',
    }).run();

    const before = ctx.fake.requests.length;
    await expect(ctx.svc.getMarketCapsAt('2023-01-03')).rejects.toThrow(SymbolMasterNotCoveredError);
    // 캐시 행이 있어도 그걸 반환하지 않았으니, 그 캐시를 읽으러 가는 것 외에 KRX 조회도
    // 당연히 일어나지 않는다.
    expect(ctx.fake.requests.length).toBe(before);

    await teardown(ctx);
  });
});
