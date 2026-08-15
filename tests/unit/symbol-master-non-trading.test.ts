import { describe, expect, it } from 'vitest';
import { createKrxHistoricalUniverseSource } from '../../src/server/modules/market-data/infrastructure/krx/krx-historical-universe-source.js';
import {
  SymbolMasterService,
  type SymbolMasterServiceDeps,
} from '../../src/server/modules/market-data/application/symbol-master-service.js';
import {
  krxDailyBars,
  krxNonTradingDays,
  krxNonTradingCoverage,
  symbolMasterCoverage,
  symbolMasterEvents,
} from '../../src/server/shared/db/schema.js';
import { createTestApp, type TestApp } from '../helpers/test-app.js';
import {
  baseInfoFixture,
  dailyFixture,
  krxEnvelope,
  startKrxFakeServer,
  type KrxFakeServer,
} from '../helpers/krx-fixtures.js';

const API_KEY = 'SYMBOL_MASTER_NON_TRADING_TEST_KEY';
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

/**
 * 2026-08-08 KRX 실응답에서 받은 두 행을 그대로 쓴다 —
 * 신라젠(정지)과 오스템임플란트(정상). 한 응답에 섞여 있을 때 봉과 거래불가일로
 * 정확히 갈리는지가 이 테스트의 전부다.
 */
const NON_TRADING_ROW = dailyFixture({
  ISU_CD: '215600',
  ISU_NM: '신라젠',
  MKTCAP: '866,567,212,500',
  TDD_OPNPRC: '0',
  TDD_HGPRC: '0',
  TDD_LWPRC: '0',
  TDD_CLSPRC: '12,100',
  ACC_TRDVOL: '0',
});
/** 위 응답 원문이 파서를 거치면 나오는 모양 — 소스를 직접 스텁할 때 쓴다 */
const NON_TRADING_TRADE_ROW = {
  shortCode: '215600',
  name: '신라젠',
  marketCapRaw: '866567212500',
  tradingValueRaw: null,
  open: 0,
  high: 0,
  low: 0,
  close: 12_100,
  volume: 0,
};
const NORMAL_ROW = dailyFixture({
  ISU_CD: '048260',
  ISU_NM: '오스템임플란트',
  MKTCAP: '1,420,000,269,800',
  TDD_OPNPRC: '98,000',
  TDD_HGPRC: '99,500',
  TDD_LWPRC: '97,400',
  TDD_CLSPRC: '99,400',
  ACC_TRDVOL: '113,801',
});

describe('SymbolMasterService.ingestDate — 거래불가일', () => {
  it('정지 행은 krx_non_trading_days 로, 정상 행은 krx_daily_bars 로 간다', async () => {
    const ctx = await setup();
    const date = '2021-06-15';
    ctx.fake.setResponse('stk_bydd_trd', '20210615', { body: krxEnvelope([]) });
    ctx.fake.setResponse('stk_isu_base_info', '20210615', { body: krxEnvelope([]) });
    ctx.fake.setResponse('ksq_bydd_trd', '20210615', {
      body: krxEnvelope([NON_TRADING_ROW, NORMAL_ROW]),
    });
    ctx.fake.setResponse('ksq_isu_base_info', '20210615', {
      body: krxEnvelope([
        baseInfoFixture({ ISU_CD: 'KR7215600008', ISU_SRT_CD: '215600', ISU_NM: '신라젠', MKT_TP_NM: 'KOSDAQ' }),
        baseInfoFixture({ ISU_CD: 'KR7048260006', ISU_SRT_CD: '048260', ISU_NM: '오스템임플란트', MKT_TP_NM: 'KOSDAQ' }),
      ]),
    });

    await ctx.svc.ingestDate(date);

    const bars = ctx.t.container.database.db.select().from(krxDailyBars).all();
    expect(bars.map((row) => row.shortCode)).toEqual(['048260']);

    const nonTrading = ctx.t.container.database.db.select().from(krxNonTradingDays).all();
    expect(nonTrading).toHaveLength(1);
    expect(nonTrading[0]?.shortCode).toBe('215600');
    expect(nonTrading[0]?.date).toBe(date);
    expect(nonTrading[0]?.market).toBe('KOSDAQ');
    expect(nonTrading[0]?.lastClose).toBe(12_100);

    await teardown(ctx);
  });
});

/** 두 시장 응답을 한 날짜에 심는다 — KOSDAQ 에만 종목을 두고 KOSPI 는 빈 응답이다 */
function seedDay(ctx: Ctx, basDd: string, trades: readonly Record<string, unknown>[]): void {
  ctx.fake.setResponse('stk_bydd_trd', basDd, { body: krxEnvelope([]) });
  ctx.fake.setResponse('stk_isu_base_info', basDd, { body: krxEnvelope([]) });
  ctx.fake.setResponse('ksq_bydd_trd', basDd, { body: krxEnvelope(trades) });
  ctx.fake.setResponse('ksq_isu_base_info', basDd, {
    body: krxEnvelope([
      baseInfoFixture({ ISU_CD: 'KR7215600008', ISU_SRT_CD: '215600', ISU_NM: '신라젠', MKT_TP_NM: 'KOSDAQ' }),
      baseInfoFixture({ ISU_CD: 'KR7048260006', ISU_SRT_CD: '048260', ISU_NM: '오스템임플란트', MKT_TP_NM: 'KOSDAQ' }),
    ]),
  });
}

describe('SymbolMasterService.ingestDate — 거래불가 커버리지', () => {
  it('정상 수집만으로도 커버로 남고, 하루씩 들어와도 한 구간으로 합쳐진다', async () => {
    const ctx = await setup();
    seedDay(ctx, '20210615', [NON_TRADING_ROW, NORMAL_ROW]);
    seedDay(ctx, '20210616', [NON_TRADING_ROW, NORMAL_ROW]);

    await ctx.svc.ingestDate('2021-06-15');
    await ctx.svc.ingestDate('2021-06-16');

    // 백필을 부르지 않았는데도 커버다 — 이 판정이 없으면 실행 경고가 "정보가 없다" 고
    // 거짓말하면서 동시에 그 정보로 종목을 제외한다.
    expect(ctx.svc.isNonTradingRangeCovered('2021-06-15', '2021-06-16')).toBe(true);
    // 하루씩 쌓여도 구간이 조각나지 않는다
    const ranges = ctx.t.container.database.db.select().from(krxNonTradingCoverage).all();
    expect(ranges).toHaveLength(1);
    expect(ranges[0]?.startDate).toBe('2021-06-15');
    expect(ranges[0]?.endDate).toBe('2021-06-16');
    // 실제 행도 함께 들어 있다
    expect(ctx.svc.nonTradingDaysBetween('2021-06-15', '2021-06-16')).toHaveLength(2);

    await teardown(ctx);
  });

  it('휴장일도 커버로 남아 앞뒤 거래일 구간이 이어진다', async () => {
    const ctx = await setup();
    seedDay(ctx, '20210618', [NON_TRADING_ROW, NORMAL_ROW]);
    seedDay(ctx, '20210621', [NON_TRADING_ROW, NORMAL_ROW]);
    // 6/19~6/20 은 주말이라 응답이 0행이다 — 그날도 "봤는데 없었다" 로 남아야
    // 금요일과 월요일 구간이 이어진다.

    for (const date of ['2021-06-18', '2021-06-19', '2021-06-20', '2021-06-21']) {
      await ctx.svc.ingestDate(date);
    }

    expect(ctx.svc.isNonTradingRangeCovered('2021-06-18', '2021-06-21')).toBe(true);
    expect(ctx.t.container.database.db.select().from(krxNonTradingCoverage).all()).toHaveLength(1);

    await teardown(ctx);
  });
});

describe('거래불가일 조회', () => {
  it('구간 안의 행만 날짜·코드 오름차순으로 돌려준다', async () => {
    const ctx = await setup();
    ctx.t.container.database.db.insert(krxNonTradingDays).values([
      { date: '2021-06-14', shortCode: '215600', market: 'KOSDAQ', lastClose: 12_100 },
      { date: '2021-06-16', shortCode: '950160', market: 'KOSDAQ', lastClose: 8_010 },
      { date: '2021-06-15', shortCode: '215600', market: 'KOSDAQ', lastClose: 12_100 },
      { date: '2021-06-15', shortCode: '048260', market: 'KOSDAQ', lastClose: 99_400 },
    ]).run();

    const rows = ctx.svc.nonTradingDaysBetween('2021-06-15', '2021-06-16');

    expect(rows).toEqual([
      { date: '2021-06-15', shortCode: '048260', lastClose: 99_400 },
      { date: '2021-06-15', shortCode: '215600', lastClose: 12_100 },
      { date: '2021-06-16', shortCode: '950160', lastClose: 8_010 },
    ]);
    await teardown(ctx);
  });

  it('구간 전체를 덮는 커버 행이 있어야 covered 다', async () => {
    const ctx = await setup();
    expect(ctx.svc.isNonTradingRangeCovered('2021-06-01', '2021-06-30')).toBe(false);

    ctx.t.container.database.db.insert(krxNonTradingCoverage).values({
      startDate: '2021-01-01', endDate: '2021-12-31', syncedAtMs: 0,
    }).run();

    expect(ctx.svc.isNonTradingRangeCovered('2021-06-01', '2021-06-30')).toBe(true);
    // 시작이 커버 밖이면 덮은 것이 아니다
    expect(ctx.svc.isNonTradingRangeCovered('2020-06-01', '2021-06-30')).toBe(false);
    await teardown(ctx);
  });
});

describe('거래불가일 백필', () => {
  it('봉·이벤트·coverage 를 건드리지 않고 거래불가일만 채운다', async () => {
    const ctx = await setup();
    for (const basDd of ['20210615', '20210616']) {
      ctx.fake.setResponse('stk_bydd_trd', basDd, { body: krxEnvelope([]) });
      ctx.fake.setResponse('ksq_bydd_trd', basDd, { body: krxEnvelope([NON_TRADING_ROW, NORMAL_ROW]) });
    }

    const result = await ctx.svc.backfillNonTradingDays('2021-06-15', '2021-06-16');

    expect(result.rows).toBe(2);
    const rows = ctx.t.container.database.db.select().from(krxNonTradingDays).all();
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.shortCode === '215600')).toBe(true);

    // 백필은 봉·이벤트·마스터 coverage 를 쓰지 않는다 — 이벤트 재생성 위험이 없어야 한다
    expect(ctx.t.container.database.db.select().from(krxDailyBars).all()).toHaveLength(0);
    expect(ctx.t.container.database.db.select().from(symbolMasterEvents).all()).toHaveLength(0);
    expect(ctx.t.container.database.db.select().from(symbolMasterCoverage).all()).toHaveLength(0);

    expect(ctx.svc.isNonTradingRangeCovered('2021-06-15', '2021-06-16')).toBe(true);
    await teardown(ctx);
  });

  it('나눠 부르거나 다시 불러도 커버 구간이 겹쳐 쌓이지 않는다', async () => {
    const ctx = await setup();
    for (const basDd of ['20210615', '20210616', '20210617', '20210618', '20210619', '20210620']) {
      ctx.fake.setResponse('ksq_bydd_trd', basDd, { body: krxEnvelope([NON_TRADING_ROW]) });
    }

    await ctx.svc.backfillNonTradingDays('2021-06-15', '2021-06-16');
    await ctx.svc.backfillNonTradingDays('2021-06-16', '2021-06-18'); // 겹치는 재실행
    await ctx.svc.backfillNonTradingDays('2021-06-19', '2021-06-20'); // 맞닿는 다음 구간

    const ranges = ctx.t.container.database.db.select().from(krxNonTradingCoverage).all();
    expect(ranges).toHaveLength(1);
    expect(ranges[0]?.startDate).toBe('2021-06-15');
    expect(ranges[0]?.endDate).toBe('2021-06-20');
    expect(ctx.svc.isNonTradingRangeCovered('2021-06-15', '2021-06-20')).toBe(true);

    await teardown(ctx);
  });

  it('한 날짜도 응답을 받지 못하면 커버로 남기지 않는다', async () => {
    const ctx = await setup();
    // 어떤 날짜에도 응답을 심지 않는다 — fake 서버가 빈 OutBlock_1 을 돌려준다.
    // 잘못 설정된 소스로 10년치를 돌린 상태가 이 모양이다. 여기서 커버를 남기면
    // 아무것도 안 본 10년이 "다 봤다" 가 되고 실행 경고가 영영 사라진다.
    const result = await ctx.svc.backfillNonTradingDays('2021-06-15', '2021-06-16');

    expect(result.dates).toBe(0);
    expect(result.rows).toBe(0);
    expect(ctx.svc.isNonTradingRangeCovered('2021-06-15', '2021-06-16')).toBe(false);
    expect(ctx.t.container.database.db.select().from(krxNonTradingCoverage).all()).toHaveLength(0);
    await teardown(ctx);
  });

  it('응답은 받았고 거래불가 종목만 0건이면 커버로 남는다', async () => {
    const ctx = await setup();
    // 정상 행만 오는 날이다 — "봤는데 없었다" 는 "안 봤다" 와 갈려야 한다
    for (const basDd of ['20210615', '20210616']) {
      ctx.fake.setResponse('ksq_bydd_trd', basDd, { body: krxEnvelope([NORMAL_ROW]) });
    }

    const result = await ctx.svc.backfillNonTradingDays('2021-06-15', '2021-06-16');

    expect(result.dates).toBe(2);
    expect(result.rows).toBe(0);
    expect(ctx.svc.isNonTradingRangeCovered('2021-06-15', '2021-06-16')).toBe(true);
    await teardown(ctx);
  });

  it('도중에 실패해도 그때까지 처리한 날짜는 커버로 남는다', async () => {
    const ctx = await setup();
    // 커버를 마지막에 한 번만 쓰면 중간에 죽었을 때 행은 들어갔는데 커버는 없는
    // 날짜가 남는다. 그 날짜는 다시 백필하지 않는 한 영영 "모른다" 로 읽힌다.
    const days = ['2021-06-15', '2021-06-16', '2021-06-17'];
    const svc = new SymbolMasterService({
      db: ctx.t.container.database.db,
      source: {
        fetchIssueBaseInfo: () => Promise.reject(new Error('백필은 기초정보를 부르지 않는다')),
        fetchDailyTrades: (market, isoDate) => {
          if (isoDate === '2021-06-17') return Promise.reject(new Error('KRX 응답 실패'));
          return Promise.resolve(market === 'KOSDAQ' ? [NON_TRADING_TRADE_ROW] : []);
        },
        todayMaxEndpointCallCount: () => 0,
      },
      clock: ctx.t.container.clock,
      logger: ctx.t.container.logger,
    });

    await expect(svc.backfillNonTradingDays(days[0]!, days[2]!)).rejects.toThrow('KRX 응답 실패');

    expect(svc.isNonTradingRangeCovered('2021-06-15', '2021-06-16')).toBe(true);
    // 못 본 날까지 덮었다고 말하지는 않는다
    expect(svc.isNonTradingRangeCovered('2021-06-15', '2021-06-17')).toBe(false);
    expect(ctx.t.container.database.db.select().from(krxNonTradingDays).all()).toHaveLength(2);
    await teardown(ctx);
  });
});
