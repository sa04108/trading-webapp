import { describe, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { createKrxHistoricalUniverseSource } from '../../src/server/modules/market-data/infrastructure/krx/krx-historical-universe-source.js';
import {
  SymbolMasterNotCoveredError,
  SymbolMasterService,
  type SymbolMasterServiceDeps,
} from '../../src/runtime/modules/market-data/application/symbol-master-service.js';
import { symbolMasterMarketCaps, dailySelectionMetrics, dailySelectionMetricCoverage } from '../../src/server/shared/db/schema.js';
import type { TestApp } from '../helpers/test-app.js';
import { test as it, type KrxTestFactory } from '../helpers/krx-test-fixtures.js';
import {
  baseInfoFixture,
  dailyFixture,
  krxEnvelope,
  type KrxFakeServer,
} from '../helpers/krx-fixtures.js';

const API_KEY = 'SYMBOL_MASTER_MARKET_CAPS_TEST_KEY';
const NOOP_SLEEP = async () => undefined;

interface Ctx {
  readonly t: TestApp;
  readonly fake: KrxFakeServer;
  readonly svc: SymbolMasterService;
}

async function setup(krxApps: KrxTestFactory): Promise<Ctx> {
  const { t, fake } = await krxApps.create();
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

/** 종목 마스터가 2023-01-02 하루를 커버하도록 최초 수집을 태운다 — 삼성전자 하나뿐인 유니버스다 */
async function ingestSingleSymbolUniverse(ctx: Ctx, date: string, basDd: string): Promise<void> {
  ctx.fake.setResponse('stk_bydd_trd', basDd, { body: krxEnvelope([dailyFixture()]) });
  ctx.fake.setResponse('stk_isu_base_info', basDd, { body: krxEnvelope([baseInfoFixture()]) });
  await ctx.svc.ingestDate(date);
}

describe('SymbolMasterService.getMarketCapsAt', () => {
  it('기존 선정 지표의 시총은 원문 캐시 없이 HTTP 0회로 재사용한다', async ({ krxApps }) => {
    const ctx = await setup(krxApps);
    await ingestSingleSymbolUniverse(ctx, '2023-01-02', '20230102');

    // 원문 저장소를 주입하지 않은 legacy 구성에서도 이미 저장된 지표를 재사용한다.
    ctx.fake.setResponse('stk_bydd_trd', '20230102', { body: krxEnvelope([dailyFixture()]) });
    const before = ctx.fake.requests.length;

    const marketCaps = await ctx.svc.getMarketCapsAt('2023-01-02');

    const daily = ctx.fake.requests.slice(before);
    expect(daily).toHaveLength(0);
    expect(marketCaps.get('KR7005930003')).toBe('350000000000000');
    expect(marketCaps.size).toBe(1);

    const rows = ctx.t.container.database.db
      .select()
      .from(symbolMasterMarketCaps)
      .where(eq(symbolMasterMarketCaps.date, '2023-01-02'))
      .all();
    expect(rows).toHaveLength(0);

  });

  it('기존 날짜의 필수 지표와 원문이 모두 없으면 미승인 HTTP를 차단한다', async ({ krxApps }) => {
    const ctx = await setup(krxApps);
    await ingestSingleSymbolUniverse(ctx, '2023-01-02', '20230102');
    ctx.t.container.database.db.delete(dailySelectionMetrics).run();
    ctx.t.container.database.db.delete(dailySelectionMetricCoverage).run();
    const before = ctx.fake.requests.length;
    await expect(ctx.svc.getMarketCapsAt('2023-01-02')).rejects.toThrow('BLOCKED_SOURCE_REQUIREMENT');
    await expect(ctx.svc.ensureSelectionMetrics(['2023-01-02'])).rejects.toThrow('BLOCKED_SOURCE_REQUIREMENT');
    expect(ctx.fake.requests.length).toBe(before);
  });

  it('캐시 히트: 재호출해도 fake 서버 요청 수가 늘지 않는다', async ({ krxApps }) => {
    const ctx = await setup(krxApps);
    await ingestSingleSymbolUniverse(ctx, '2023-01-02', '20230102');
    ctx.fake.setResponse('stk_bydd_trd', '20230102', { body: krxEnvelope([dailyFixture()]) });
    const first = await ctx.svc.getMarketCapsAt('2023-01-02');

    const before = ctx.fake.requests.length;
    const second = await ctx.svc.getMarketCapsAt('2023-01-02');

    expect(ctx.fake.requests.length).toBe(before);
    expect(second.get('KR7005930003')).toBe(first.get('KR7005930003'));

  });

  it('커버 밖 date 는 SymbolMasterNotCoveredError 를 던진다', async ({ krxApps }) => {
    // coverage와 거래일 anchor가 없는 초기 상태라 어떤 날짜도 조회할 수 없다.
    const ctx = await setup(krxApps);

    const before = ctx.fake.requests.length;
    await expect(ctx.svc.getMarketCapsAt('2023-01-02')).rejects.toThrow(SymbolMasterNotCoveredError);
    // 유니버스 조회에서 먼저 걸러져야 한다 — KRX 를 헛되이 부르지 않는다.
    expect(ctx.fake.requests.length).toBe(before);

  });

  it('SCD 버전이 관통해도 coverage 갭인 날짜는 캐시를 반환하지 않는다', async ({ krxApps }) => {
    const ctx = await setup(krxApps);
    // 01-02 최초 수집 후 01-03~04 를 건너뛰고 01-05 를 수집한다. 열린 SCD 버전은
    // 01-03을 관통하지만 coverage는 [01-02,01-02], [01-05,01-05]뿐이라 갭이다.
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

  });

  it('같은 날짜 동시 조회는 정상 로컬 값을 공유하며 HTTP 요청을 만들지 않는다', async ({ krxApps }) => {
    // 동시 호출도 같은 로컬 조회 결과를 공유한다.
    const ctx = await setup(krxApps);
    await ingestSingleSymbolUniverse(ctx, '2023-01-02', '20230102');
    ctx.fake.setResponse('stk_bydd_trd', '20230102', { body: krxEnvelope([dailyFixture()]) });
    const before = ctx.fake.requests.length;

    const p1 = ctx.svc.getMarketCapsAt('2023-01-02');
    const p2 = ctx.svc.getMarketCapsAt('2023-01-02');
    // 두 번째 호출은 진행 중인 로컬 조회에 합류한다.
    expect(p2).toBe(p1);

    const [marketCaps1, marketCaps2] = await Promise.all([p1, p2]);
    expect(marketCaps2).toBe(marketCaps1);
    expect(marketCaps1.get('KR7005930003')).toBe('350000000000000');

    const daily = ctx.fake.requests.slice(before);
    expect(daily).toHaveLength(0);

    const rows = ctx.t.container.database.db
      .select()
      .from(symbolMasterMarketCaps)
      .where(eq(symbolMasterMarketCaps.date, '2023-01-02'))
      .all();
    expect(rows).toHaveLength(0);

  });
});
