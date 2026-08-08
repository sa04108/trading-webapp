import { asc, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SymbolMasterService, type SymbolMasterServiceDeps } from '../../src/server/modules/market-data/application/symbol-master-service.js';
import { createKrxHistoricalUniverseSource } from '../../src/server/modules/market-data/infrastructure/krx/krx-historical-universe-source.js';
import { symbolMasterVersions } from '../../src/server/shared/db/schema.js';
import { createTestApp, type TestApp } from '../helpers/test-app.js';
import {
  baseInfoFixture,
  dailyFixture,
  krxEnvelope,
  startKrxFakeServer,
  type KrxFakeServer,
} from '../helpers/krx-fixtures.js';

const API_KEY = 'SYMBOL_MASTER_VERSION_TEST_KEY';
const NOOP_SLEEP = async () => undefined;
const STANDARD_CODE = 'KR7005930003';

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

function setTradingDay(
  ctx: Ctx,
  date: string,
  baseInfo: ReturnType<typeof baseInfoFixture> = baseInfoFixture(),
): void {
  const basDd = date.replaceAll('-', '');
  ctx.fake.setResponse('stk_bydd_trd', basDd, {
    body: krxEnvelope([dailyFixture()]),
  });
  ctx.fake.setResponse('stk_isu_base_info', basDd, {
    body: krxEnvelope([baseInfo]),
  });
}

function versionsOf(ctx: Ctx) {
  return ctx.t.container.database.db
    .select()
    .from(symbolMasterVersions)
    .where(eq(symbolMasterVersions.standardCode, STANDARD_CODE))
    .orderBy(asc(symbolMasterVersions.validFromDate))
    .all();
}

describe('SymbolMasterService — SCD 버전 저장 회귀', () => {
  let ctx: Ctx;

  beforeEach(async () => {
    ctx = await setup();
  });

  afterEach(async () => {
    await ctx.fake.close();
    await ctx.t.close();
  });

  it('변경 없는 다음 거래일은 버전 행을 늘리지 않는다', async () => {
    setTradingDay(ctx, '2023-01-02');
    setTradingDay(ctx, '2023-01-03');

    await ctx.service.ingestDate('2023-01-02');
    expect(versionsOf(ctx)).toHaveLength(1);

    const result = await ctx.service.ingestDate('2023-01-03');
    const versions = versionsOf(ctx);

    expect(result).toEqual({ kind: 'TRADING_DAY' });
    expect(versions).toHaveLength(1);
    expect(versions[0]).toMatchObject({
      validFromDate: '2023-01-02',
      validToDate: null,
      name: '삼성전자',
      sharesOutstanding: '1000000',
    });
  });

  it('같은 날 여러 상태 필드가 바뀌어도 새 버전은 한 행만 만든다', async () => {
    setTradingDay(ctx, '2023-01-02');
    setTradingDay(ctx, '2023-01-03', baseInfoFixture({
      ISU_SRT_CD: '005931',
      ISU_NM: '삼성전자 신주',
      LIST_DD: '19750612',
      KIND_STKCERT_TP_NM: '우선주',
      LIST_SHRS: '2,000,000',
    }));

    await ctx.service.ingestDate('2023-01-02');
    await ctx.service.ingestDate('2023-01-03');

    expect(versionsOf(ctx)).toMatchObject([
      {
        validFromDate: '2023-01-02',
        validToDate: '2023-01-03',
        shortCode: '005930',
        name: '삼성전자',
        sharesOutstanding: '1000000',
        instrumentType: 'COMMON_STOCK',
        listedDate: '1975-06-11',
      },
      {
        validFromDate: '2023-01-03',
        validToDate: null,
        shortCode: '005931',
        name: '삼성전자 신주',
        sharesOutstanding: '2000000',
        instrumentType: 'PREFERRED_STOCK',
        listedDate: '1975-06-12',
      },
    ]);

    expect(ctx.service.getUniverseAsOf('2023-01-02').get(STANDARD_CODE)?.name).toBe('삼성전자');
    expect(ctx.service.getUniverseAsOf('2023-01-03').get(STANDARD_CODE)).toMatchObject({
      shortCode: '005931',
      name: '삼성전자 신주',
      sharesOutstanding: '2000000',
      instrumentType: 'PREFERRED_STOCK',
      listedDate: '1975-06-12',
    });
    const events = ctx.service.listEvents('2023-01-03', '2023-01-03');
    expect(events.map((event) => event.eventType)).toEqual([
      'LISTED_DATE_CHANGED',
      'NAME_CHANGED',
      'SHARES_CHANGED',
      'SHORT_CODE_CHANGED',
      'TYPE_CHANGED',
    ]);
    expect(new Set(events.map((event) => event.id))).toHaveProperty('size', events.length);
  });

  it('동일 상태의 과거 날짜를 prepend하면 인접 구간을 한 버전으로 합친다', async () => {
    setTradingDay(ctx, '2023-01-03');
    setTradingDay(ctx, '2023-01-02');

    await ctx.service.ingestDate('2023-01-03');
    expect(versionsOf(ctx)).toMatchObject([
      { validFromDate: '2023-01-03', validToDate: null },
    ]);

    await ctx.service.ingestDate('2023-01-02');

    expect(versionsOf(ctx)).toMatchObject([
      {
        validFromDate: '2023-01-02',
        validToDate: null,
        name: '삼성전자',
        sharesOutstanding: '1000000',
      },
    ]);
    expect(ctx.service.getUniverseAsOf('2023-01-02').has(STANDARD_CODE)).toBe(true);
    expect(ctx.service.getUniverseAsOf('2023-01-03').has(STANDARD_CODE)).toBe(true);
  });
});
