import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SymbolMasterService, type SymbolMasterServiceDeps } from '../../src/server/modules/market-data/application/symbol-master-service.js';
import { createKrxHistoricalUniverseSource } from '../../src/server/modules/market-data/infrastructure/krx/krx-historical-universe-source.js';
import { createTestApp, type TestApp } from '../helpers/test-app.js';
import {
  baseInfoFixture,
  dailyFixture,
  krxEnvelope,
  startKrxFakeServer,
  type KrxFakeServer,
} from '../helpers/krx-fixtures.js';

const API_KEY = 'SHARES_CHANGE_TEST_KEY';
const NOOP_SLEEP = async () => undefined;

interface Ctx {
  readonly t: TestApp;
  readonly fake: KrxFakeServer;
  readonly service: SymbolMasterService;
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
  return { t, fake, service: new SymbolMasterService(deps) };
}

function setTradingDay(ctx: Ctx, date: string, listedShares: string): void {
  const basDd = date.replaceAll('-', '');
  ctx.fake.setResponse('stk_bydd_trd', basDd, { body: krxEnvelope([dailyFixture()]) });
  ctx.fake.setResponse('stk_isu_base_info', basDd, {
    body: krxEnvelope([baseInfoFixture({ LIST_SHRS: listedShares })]),
  });
}

describe('SymbolMasterService.sharesChangesBetween', () => {
  let ctx: Ctx;

  beforeEach(async () => {
    ctx = await setup();
  });

  afterEach(async () => {
    await ctx.fake.close();
    await ctx.t.close();
  });

  it('상장주식수가 늘어난 날을 단축코드·비율과 함께 돌려준다', async () => {
    setTradingDay(ctx, '2024-09-26', '1,000,000');
    setTradingDay(ctx, '2024-09-27', '1,000,000');
    setTradingDay(ctx, '2024-10-08', '5,000,000');
    await ctx.service.ingestDate('2024-09-26');
    await ctx.service.ingestDate('2024-09-27');
    await ctx.service.ingestDate('2024-10-08');

    expect(ctx.service.sharesChangesBetween('2024-09-01', '2024-10-31')).toEqual([
      {
        shortCode: '005930',
        effectiveDate: '2024-10-08',
        ratio: 5,
        beforeShares: 1_000_000,
        afterShares: 5_000_000,
      },
    ]);
  });

  it('주식수가 그대로면 아무것도 돌려주지 않는다', async () => {
    setTradingDay(ctx, '2024-09-26', '1,000,000');
    setTradingDay(ctx, '2024-09-27', '1,000,000');
    await ctx.service.ingestDate('2024-09-26');
    await ctx.service.ingestDate('2024-09-27');

    expect(ctx.service.sharesChangesBetween('2024-09-01', '2024-10-31')).toEqual([]);
  });

  it('구간 밖의 변경은 돌려주지 않는다', async () => {
    setTradingDay(ctx, '2024-09-26', '1,000,000');
    setTradingDay(ctx, '2024-10-08', '5,000,000');
    await ctx.service.ingestDate('2024-09-26');
    await ctx.service.ingestDate('2024-10-08');

    expect(ctx.service.sharesChangesBetween('2024-09-01', '2024-09-30')).toEqual([]);
  });

  it('처음 관측한 종목을 주식수 변경으로 보지 않는다', async () => {
    setTradingDay(ctx, '2024-09-26', '1,000,000');
    await ctx.service.ingestDate('2024-09-26');

    expect(ctx.service.sharesChangesBetween('2024-09-01', '2024-10-31')).toEqual([]);
  });
});
