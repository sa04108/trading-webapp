import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SymbolMasterService, type SymbolMasterServiceDeps } from '../../src/server/modules/market-data/application/symbol-master-service.js';
import { createKrxHistoricalUniverseSource } from '../../src/server/modules/market-data/infrastructure/krx/krx-historical-universe-source.js';
import {
  symbolMasterTradingDays,
  symbolMasterVersions,
} from '../../src/server/shared/db/schema.js';
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

  it('역순 수집으로 만든 분할·병합도 listEvents 의미론과 같고 종목·날짜 범위를 SQL에서 좁힌다', async () => {
    setTradingDay(ctx, '2024-09-26', '1,000,000');
    setTradingDay(ctx, '2024-10-08', '5,000,000');
    setTradingDay(ctx, '2024-10-21', '1,000,000');

    // 미래를 먼저 넣고 과거 구간을 overlay해도 SCD 경계는 같은 결과로 수렴해야 한다.
    await ctx.service.ingestDate('2024-10-21');
    await ctx.service.ingestDate('2024-09-26');
    await ctx.service.ingestDate('2024-10-08');

    const from = '2024-09-01';
    const to = '2024-10-31';
    const legacyEquivalent = ctx.service.listEvents(from, to)
      .flatMap((event) => {
        if (event.eventType !== 'SHARES_CHANGED') return [];
        const after = Number(JSON.parse(event.newValue ?? 'null') as unknown);
        const before = Number(JSON.parse(event.oldValue ?? 'null') as unknown);
        const entry = ctx.service.getUniverseAsOf(event.effectiveDate).get(event.standardCode);
        if (
          entry === undefined
          || !Number.isFinite(before)
          || !Number.isFinite(after)
          || before <= 0
          || after <= 0
        ) return [];
        return [{
          shortCode: entry.shortCode,
          effectiveDate: event.effectiveDate,
          ratio: after / before,
          beforeShares: before,
          afterShares: after,
        }];
      })
      .sort((a, b) => (
        a.effectiveDate.localeCompare(b.effectiveDate)
        || a.shortCode.localeCompare(b.shortCode)
      ));

    expect(ctx.service.sharesChangesBetween(from, to)).toEqual(legacyEquivalent);
    expect(legacyEquivalent).toEqual([
      {
        shortCode: '005930', effectiveDate: '2024-10-08', ratio: 5,
        beforeShares: 1_000_000, afterShares: 5_000_000,
      },
      {
        shortCode: '005930', effectiveDate: '2024-10-21', ratio: 0.2,
        beforeShares: 5_000_000, afterShares: 1_000_000,
      },
    ]);
    expect(ctx.service.sharesChangesBetween(from, to, ['005930'])).toEqual(legacyEquivalent);
    expect(ctx.service.sharesChangesBetween(from, to, [])).toEqual([]);
    expect(ctx.service.sharesChangesBetween(from, to, ['999999'])).toEqual([]);
    expect(ctx.service.sharesChangesBetween('2024-10-08', '2024-10-08'))
      .toEqual(legacyEquivalent.slice(0, 1));
    expect(ctx.service.sharesChangesBetween('2024-09-26', '2024-09-26')).toEqual([]);
  });

  it('맞닿지 않은 SCD 생애 사이의 주식수 차이는 변경으로 잇지 않는다', () => {
    ctx.t.container.database.db.insert(symbolMasterTradingDays)
      .values({ date: '2024-01-02' })
      .run();
    ctx.t.container.database.db.insert(symbolMasterVersions).values([
      {
        standardCode: 'KR7000000001', shortCode: '000001', name: '옛 회사', market: 'KOSPI',
        sharesOutstanding: '100', instrumentType: 'COMMON_STOCK', listedDate: null,
        validFromDate: '2024-01-02', validToDate: '2024-02-01', recordedAtMs: 1,
      },
      {
        standardCode: 'KR7000000001', shortCode: '000001', name: '새 회사', market: 'KOSPI',
        sharesOutstanding: '500', instrumentType: 'COMMON_STOCK', listedDate: null,
        validFromDate: '2024-03-01', validToDate: null, recordedAtMs: 2,
      },
    ]).run();

    expect(ctx.service.sharesChangesBetween('2024-01-01', '2024-03-31')).toEqual([]);
  });

  it('predecessor가 있어도 최초 관측일 경계는 baseline 변경으로 만들지 않는다', () => {
    ctx.t.container.database.db.insert(symbolMasterTradingDays)
      .values({ date: '2024-01-02' })
      .run();
    ctx.t.container.database.db.insert(symbolMasterVersions).values([
      {
        standardCode: 'KR7000000001', shortCode: '000001', name: '회사', market: 'KOSPI',
        sharesOutstanding: '100', instrumentType: 'COMMON_STOCK', listedDate: null,
        validFromDate: '2023-12-01', validToDate: '2024-01-02', recordedAtMs: 1,
      },
      {
        standardCode: 'KR7000000001', shortCode: '000001', name: '회사', market: 'KOSPI',
        sharesOutstanding: '200', instrumentType: 'COMMON_STOCK', listedDate: null,
        validFromDate: '2024-01-02', validToDate: null, recordedAtMs: 2,
      },
    ]).run();

    expect(ctx.service.sharesChangesBetween('2024-01-02', '2024-01-02')).toEqual([]);
  });

  it('주식수 문자열이 달라진 경계는 숫자 비율이 1이어도 legacy 이벤트처럼 보존한다', () => {
    ctx.t.container.database.db.insert(symbolMasterTradingDays)
      .values([{ date: '2024-01-02' }, { date: '2024-02-01' }])
      .run();
    ctx.t.container.database.db.insert(symbolMasterVersions).values([
      {
        standardCode: 'KR7000000001', shortCode: '000001', name: '회사', market: 'KOSPI',
        sharesOutstanding: '100', instrumentType: 'COMMON_STOCK', listedDate: null,
        validFromDate: '2024-01-02', validToDate: '2024-02-01', recordedAtMs: 1,
      },
      {
        standardCode: 'KR7000000001', shortCode: '000001', name: '회사', market: 'KOSPI',
        sharesOutstanding: '100.0', instrumentType: 'COMMON_STOCK', listedDate: null,
        validFromDate: '2024-02-01', validToDate: null, recordedAtMs: 2,
      },
    ]).run();

    expect(ctx.service.sharesChangesBetween('2024-02-01', '2024-02-01')).toEqual([{
      shortCode: '000001', effectiveDate: '2024-02-01', ratio: 1,
      beforeShares: 100, afterShares: 100,
    }]);
  });
});
