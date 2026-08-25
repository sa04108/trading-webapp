import { describe, expect, it } from 'vitest';
import { createKrxHistoricalUniverseSource } from '../../src/server/modules/market-data/infrastructure/krx/krx-historical-universe-source.js';
import {
  SymbolMasterService,
  type SymbolMasterServiceDeps,
} from '../../src/server/modules/market-data/application/symbol-master-service.js';
import { createTestApp, type TestApp } from '../helpers/test-app.js';
import {
  symbolMasterCoverage,
  symbolMasterTradingDays,
} from '../../src/server/shared/db/schema.js';
import {
  baseInfoFixture,
  dailyFixture,
  krxEnvelope,
  startKrxFakeServer,
  type KrxFakeServer,
} from '../helpers/krx-fixtures.js';

const API_KEY = 'SYMBOL_MASTER_TRADING_DAYS_TEST_KEY';
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

function setTradingDay(fake: KrxFakeServer, basDd: string): void {
  fake.setResponse('stk_bydd_trd', basDd, { body: krxEnvelope([dailyFixture()]) });
  fake.setResponse('stk_isu_base_info', basDd, { body: krxEnvelope([baseInfoFixture()]) });
}

async function teardown(ctx: Ctx): Promise<void> {
  await ctx.fake.close();
  await ctx.t.close();
}

describe('SymbolMasterService.effectiveTradingDate', () => {
  it('거래일 수집은 거래일로 기록한다', async () => {
    const ctx = await setup();
    setTradingDay(ctx.fake, '20230102');

    await ctx.svc.ingestDate('2023-01-02');

    expect(ctx.svc.effectiveTradingDate('2023-01-02')).toBe('2023-01-02');
    await teardown(ctx);
  });

  it('휴장일 수집은 거래일로 기록하지 않는다', async () => {
    const ctx = await setup();

    const result = await ctx.svc.ingestDate('2023-01-01');

    expect(result).toEqual({ kind: 'HOLIDAY' });
    expect(ctx.svc.effectiveTradingDate('2023-01-01')).toBeUndefined();
    await teardown(ctx);
  });

  it('휴장일의 적용 거래일은 직전 거래일이다', async () => {
    const ctx = await setup();
    setTradingDay(ctx.fake, '20230102');
    await ctx.svc.ingestDate('2023-01-02');

    const result = await ctx.svc.ingestDate('2023-01-03');

    expect(result).toEqual({ kind: 'HOLIDAY' });
    expect(ctx.svc.effectiveTradingDate('2023-01-03')).toBe('2023-01-02');
    await teardown(ctx);
  });

  it('거래일 이전 날짜는 적용 거래일이 없다', async () => {
    const ctx = await setup();
    setTradingDay(ctx.fake, '20230102');

    await ctx.svc.ingestDate('2023-01-02');

    expect(ctx.svc.effectiveTradingDate('2023-01-01')).toBeUndefined();
    await teardown(ctx);
  });

  it('legacy 주말 경계를 적용 거래일로 사용하지 않는다', async () => {
    const ctx = await setup();
    ctx.t.container.database.db.insert(symbolMasterTradingDays).values([
      { date: '2016-03-18' }, // 금요일
      { date: '2016-03-20' }, // legacy 이벤트에서 유입된 일요일
    ]).run();
    ctx.t.container.database.db.insert(symbolMasterCoverage).values({
      startDate: '2016-03-18',
      endDate: '2016-03-20',
      syncedAtMs: ctx.t.container.clock.now(),
    }).run();

    expect(ctx.svc.effectiveTradingDate('2016-03-20')).toBe('2016-03-18');
    expect(ctx.svc.effectiveTradingDateWithinCoverage('2016-03-20')).toBe('2016-03-18');
    await teardown(ctx);
  });

  it('legacy 이행에서 섞인 주말은 화면용 실제 거래일 목록에서 제외한다', async () => {
    const ctx = await setup();
    ctx.t.container.database.db.insert(symbolMasterTradingDays).values([
      { date: '2016-03-20' },
      { date: '2016-03-21' },
    ]).run();

    expect(ctx.svc.tradingDates()).toEqual(['2016-03-21']);
    await teardown(ctx);
  });
});
