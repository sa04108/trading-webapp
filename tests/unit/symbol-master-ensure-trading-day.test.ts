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

const API_KEY = 'SYMBOL_MASTER_ENSURE_TRADING_DAY_TEST_KEY';
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

describe('SymbolMasterService.ensureTradingDay', () => {
  it('휴장일 요청은 직전 거래일까지 소급 수집한다', async () => {
    const ctx = await setup();
    // 2023-01-02 거래일, 2023-01-03·01-04 휴장 세팅 (01-03·01-04 는 기본값인 빈 응답으로 둔다)
    setTradingDay(ctx.fake, '20230102');

    const result = await ctx.svc.ensureTradingDay('2023-01-04');

    expect(result.effectiveTradingDate).toBe('2023-01-02');
    expect(result.ingestedDates).toEqual(['2023-01-04', '2023-01-03', '2023-01-02']);
    await teardown(ctx);
  });

  it('이미 거래일이면 소급하지 않는다', async () => {
    const ctx = await setup();
    setTradingDay(ctx.fake, '20230102');

    const result = await ctx.svc.ensureTradingDay('2023-01-02');

    expect(result.effectiveTradingDate).toBe('2023-01-02');
    expect(result.ingestedDates).toEqual(['2023-01-02']);
    await teardown(ctx);
  });

  it('커버는 됐지만 거래일 기록이 없으면 소급한다', async () => {
    const ctx = await setup();
    setTradingDay(ctx.fake, '20230102');
    // 01-03 을 휴장으로 먼저 ingestDate — coverage 만 생기고 거래일 기록은 없다
    await ctx.svc.ingestDate('2023-01-03');
    expect(ctx.svc.isCovered('2023-01-03')).toBe(true);
    expect(ctx.svc.effectiveTradingDate('2023-01-03')).toBeUndefined();

    const result = await ctx.svc.ensureTradingDay('2023-01-03');

    expect(result.effectiveTradingDate).toBe('2023-01-02');
    // 01-03 은 이미 커버돼 ALREADY_COVERED 라 ingestedDates 에 들어가지 않는다
    expect(result.ingestedDates).toEqual(['2023-01-02']);
    await teardown(ctx);
  });

  it('상한까지 못 찾으면 null 을 반환하고 던지지 않는다', async () => {
    const ctx = await setup();
    // 전 구간 휴장 세팅 (기본값이 이미 빈 응답이라 별도 세팅이 필요 없다)

    const result = await ctx.svc.ensureTradingDay('2023-01-10', 3);

    expect(result.effectiveTradingDate).toBeNull();
    expect(result.ingestedDates).toEqual(['2023-01-10', '2023-01-09', '2023-01-08', '2023-01-07']);
    await teardown(ctx);
  });
});
