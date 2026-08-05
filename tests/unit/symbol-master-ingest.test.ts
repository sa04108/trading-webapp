import { describe, expect, it } from 'vitest';
import { createKrxHistoricalUniverseSource } from '../../src/server/modules/market-data/infrastructure/krx/krx-historical-universe-source.js';
import {
  SymbolMasterService,
  type SymbolMasterServiceDeps,
} from '../../src/server/modules/market-data/application/symbol-master-service.js';
import { createTestApp, type TestApp } from '../helpers/test-app.js';
import {
  baseInfoFixture,
  dailyFixture,
  krxEnvelope,
  startKrxFakeServer,
  type KrxFakeServer,
} from '../helpers/krx-fixtures.js';

const API_KEY = 'SYMBOL_MASTER_INGEST_TEST_KEY';
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

describe('SymbolMasterService.ingestDate', () => {
  it('최초 수집은 체크포인트를 만들고 이벤트가 없다', async () => {
    const ctx = await setup();
    ctx.fake.setResponse('stk_bydd_trd', '20230102', { body: krxEnvelope([dailyFixture()]) });
    ctx.fake.setResponse('stk_isu_base_info', '20230102', { body: krxEnvelope([baseInfoFixture()]) });

    const result = await ctx.svc.ingestDate('2023-01-02');

    expect(result).toEqual({ kind: 'TRADING_DAY', eventCount: 0, checkpointSaved: true });
    expect(ctx.svc.getUniverseAsOf('2023-01-02').size).toBe(1);
    expect(ctx.svc.isCovered('2023-01-02')).toBe(true);
    await teardown(ctx);
  });

  it('둘째 날 상장주식수 변경은 SHARES_CHANGED 하나를 만든다', async () => {
    const ctx = await setup();
    ctx.fake.setResponse('stk_bydd_trd', '20230102', { body: krxEnvelope([dailyFixture()]) });
    ctx.fake.setResponse('stk_isu_base_info', '20230102', { body: krxEnvelope([baseInfoFixture()]) });
    await ctx.svc.ingestDate('2023-01-02');

    ctx.fake.setResponse('stk_bydd_trd', '20230103', { body: krxEnvelope([dailyFixture()]) });
    ctx.fake.setResponse('stk_isu_base_info', '20230103', {
      body: krxEnvelope([baseInfoFixture({ LIST_SHRS: '2,000,000' })]),
    });

    const result = await ctx.svc.ingestDate('2023-01-03');

    expect(result).toEqual({ kind: 'TRADING_DAY', eventCount: 1, checkpointSaved: false });
    expect(ctx.svc.getUniverseAsOf('2023-01-03').get('KR7005930003')!.sharesOutstanding).toBe(
      '2000000',
    );
    await teardown(ctx);
  });

  it('두 시장 모두 빈 응답이면 휴장이다 — coverage 는 늘고 이벤트는 없다', async () => {
    const ctx = await setup();

    const result = await ctx.svc.ingestDate('2023-01-01');

    expect(result).toEqual({ kind: 'HOLIDAY' });
    expect(ctx.svc.isCovered('2023-01-01')).toBe(true);
    expect(ctx.svc.listEvents('2023-01-01', '2023-01-01')).toHaveLength(0);
    await teardown(ctx);
  });

  it('이미 커버된 날짜는 KRX 를 부르지 않는다', async () => {
    const ctx = await setup();
    ctx.fake.setResponse('stk_bydd_trd', '20230102', { body: krxEnvelope([dailyFixture()]) });
    ctx.fake.setResponse('stk_isu_base_info', '20230102', { body: krxEnvelope([baseInfoFixture()]) });
    await ctx.svc.ingestDate('2023-01-02');

    const before = ctx.fake.requests.length;
    const result = await ctx.svc.ingestDate('2023-01-02');

    expect(result).toEqual({ kind: 'ALREADY_COVERED' });
    expect(ctx.fake.requests.length).toBe(before);
    await teardown(ctx);
  });

  it('갭 메우기: 사이 날짜 수집이 다음 커버일 이벤트를 재계산한다', async () => {
    const ctx = await setup();

    // 01-02: 기준 상태 (상장주식수 1,000,000)
    ctx.fake.setResponse('stk_bydd_trd', '20230102', { body: krxEnvelope([dailyFixture()]) });
    ctx.fake.setResponse('stk_isu_base_info', '20230102', { body: krxEnvelope([baseInfoFixture()]) });
    await ctx.svc.ingestDate('2023-01-02');

    // 01-05: 01-03~04 를 건너뛰고 수집 — 상장주식수가 1,500,000 으로 바뀐 것으로 관측된다.
    // 직전 커버일이 01-02 뿐이라 span 이 01-02 를 기준으로 기록된다.
    ctx.fake.setResponse('stk_bydd_trd', '20230105', { body: krxEnvelope([dailyFixture()]) });
    ctx.fake.setResponse('stk_isu_base_info', '20230105', {
      body: krxEnvelope([baseInfoFixture({ LIST_SHRS: '1,500,000' })]),
    });
    const day5 = await ctx.svc.ingestDate('2023-01-05');

    expect(day5).toEqual({ kind: 'TRADING_DAY', eventCount: 1, checkpointSaved: false });
    expect(ctx.svc.listEvents('2023-01-05', '2023-01-05')[0]).toMatchObject({
      observedSpanStart: '2023-01-02',
    });

    // 01-03 온디맨드 수집: 값이 01-02 와 같아 그 자체로는 이벤트가 없다
    ctx.fake.setResponse('stk_bydd_trd', '20230103', { body: krxEnvelope([dailyFixture()]) });
    ctx.fake.setResponse('stk_isu_base_info', '20230103', { body: krxEnvelope([baseInfoFixture()]) });
    const day3 = await ctx.svc.ingestDate('2023-01-03');

    expect(day3).toEqual({ kind: 'TRADING_DAY', eventCount: 0, checkpointSaved: false });
    // 01-05 이벤트는 지워지고 01-03 을 기준으로 다시 계산된다 — 중복 이벤트가 남지 않는다
    const recomputed = ctx.svc.listEvents('2023-01-05', '2023-01-05');
    expect(recomputed).toHaveLength(1);
    expect(recomputed[0]).toMatchObject({
      eventType: 'SHARES_CHANGED',
      observedSpanStart: '2023-01-03',
    });
    // 01-04 는 아직 아무도 수집하지 않았다 — 갭으로 남는다
    expect(ctx.svc.isCovered('2023-01-04')).toBe(false);
    expect(ctx.svc.isCovered('2023-01-03')).toBe(true);
    await teardown(ctx);
  });
});
