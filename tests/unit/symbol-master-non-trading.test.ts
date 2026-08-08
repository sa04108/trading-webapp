import { describe, expect, it } from 'vitest';
import { createKrxHistoricalUniverseSource } from '../../src/server/modules/market-data/infrastructure/krx/krx-historical-universe-source.js';
import {
  SymbolMasterService,
  type SymbolMasterServiceDeps,
} from '../../src/server/modules/market-data/application/symbol-master-service.js';
import { krxDailyBars, krxNonTradingDays } from '../../src/server/shared/db/schema.js';
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
 * 실측(2026-08-08, scripts/krx-halt-probe.ts)에서 받은 두 행을 그대로 쓴다 —
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
