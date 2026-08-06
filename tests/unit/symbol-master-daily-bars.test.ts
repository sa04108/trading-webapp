import { describe, expect, it, vi } from 'vitest';
import { createKrxHistoricalUniverseSource } from '../../src/server/modules/market-data/infrastructure/krx/krx-historical-universe-source.js';
import {
  SymbolMasterService,
  type SymbolMasterServiceDeps,
} from '../../src/server/modules/market-data/application/symbol-master-service.js';
import { krxDailyBars } from '../../src/server/shared/db/schema.js';
import { createTestApp, type TestApp } from '../helpers/test-app.js';
import {
  baseInfoFixture,
  dailyFixture,
  krxEnvelope,
  startKrxFakeServer,
  type KrxFakeServer,
} from '../helpers/krx-fixtures.js';

const API_KEY = 'SYMBOL_MASTER_DAILY_BARS_TEST_KEY';
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

function allBars(ctx: Ctx) {
  return ctx.t.container.database.db
    .select()
    .from(krxDailyBars)
    .all()
    .sort((a, b) => (a.shortCode < b.shortCode ? -1 : a.shortCode > b.shortCode ? 1 : 0));
}

describe('SymbolMasterService.ingestDate — 일봉 적재', () => {
  it('최초 수집(체크포인트 분기)에서 두 시장의 일봉을 함께 저장한다', async () => {
    const ctx = await setup();
    const date = '2023-01-02';
    ctx.fake.setResponse('stk_bydd_trd', '20230102', { body: krxEnvelope([dailyFixture()]) });
    ctx.fake.setResponse('stk_isu_base_info', '20230102', { body: krxEnvelope([baseInfoFixture()]) });
    ctx.fake.setResponse('ksq_bydd_trd', '20230102', {
      body: krxEnvelope([
        dailyFixture({
          ISU_CD: '000660',
          ISU_NM: 'SK하이닉스',
          TDD_OPNPRC: '100,000',
          TDD_HGPRC: '101,000',
          TDD_LWPRC: '99,000',
          TDD_CLSPRC: '100,500',
          ACC_TRDVOL: '500,000',
        }),
      ]),
    });

    const result = await ctx.svc.ingestDate(date);

    expect(result.kind).toBe('TRADING_DAY');
    const rows = allBars(ctx);
    expect(rows).toEqual([
      {
        shortCode: '000660',
        date,
        market: 'KOSDAQ',
        open: 100_000,
        high: 101_000,
        low: 99_000,
        close: 100_500,
        volume: 500_000,
      },
      {
        shortCode: '005930',
        date,
        market: 'KOSPI',
        open: 71_500,
        high: 72_000,
        low: 71_000,
        close: 71_800,
        volume: 12_345_678,
      },
    ]);
    await teardown(ctx);
  });

  it('둘째 날 일반 diff 경로에서도 그 날의 일봉이 저장된다', async () => {
    const ctx = await setup();
    ctx.fake.setResponse('stk_bydd_trd', '20230102', { body: krxEnvelope([dailyFixture()]) });
    ctx.fake.setResponse('stk_isu_base_info', '20230102', { body: krxEnvelope([baseInfoFixture()]) });
    await ctx.svc.ingestDate('2023-01-02');

    ctx.fake.setResponse('stk_bydd_trd', '20230103', {
      body: krxEnvelope([dailyFixture({ TDD_CLSPRC: '72,500' })]),
    });
    ctx.fake.setResponse('stk_isu_base_info', '20230103', { body: krxEnvelope([baseInfoFixture()]) });

    const result = await ctx.svc.ingestDate('2023-01-03');

    expect(result.kind).toBe('TRADING_DAY');
    const row = ctx.t.container.database.db
      .select()
      .from(krxDailyBars)
      .all()
      .find((r) => r.date === '2023-01-03');
    expect(row).toMatchObject({ shortCode: '005930', date: '2023-01-03', close: 72_500 });
    // 첫날 행도 그대로 남아 있어야 한다 — 둘째 날 저장이 첫날 행을 건드리면 안 된다.
    const day1Row = ctx.t.container.database.db
      .select()
      .from(krxDailyBars)
      .all()
      .find((r) => r.date === '2023-01-02');
    expect(day1Row).toMatchObject({ shortCode: '005930', date: '2023-01-02', close: 71_800 });
    await teardown(ctx);
  });

  it('재수집 시 중복 없이 행마다 자기 값으로 갱신된다 — 배치 전체가 한 값으로 접히지 않는다', async () => {
    const ctx = await setup();
    const date = '2023-01-02';

    // 체크포인트 저장과 coverage 갱신이 원자적이지 않았던 과거에 죽었을 때 남았을 상태를
    // 흉내낸다 — checkpointDate 는 있는데 coverage 는 비어 재수집이 다시 최초 수집 분기를 탄다.
    ctx.svc.saveCheckpoint(date, new Map(), true);
    expect(ctx.svc.isCovered(date)).toBe(false);
    // 그 죽은 시도가 이미 남겨 둔 stale 일봉 행 두 개(서로 다른 종목·값) — 재수집이 각각
    // 자기 값으로 덮어써야 한다. 충돌 행이 하나뿐이면 onConflictDoUpdate 의 set 이
    // excluded.* 로 행마다 풀리는지, 아니면 배치 전체가 리터럴 한 값으로 접히는지 구분할
    // 수 없어 여기서는 반드시 서로 다른 값의 행 2개 이상을 둔다.
    ctx.t.container.database.db
      .insert(krxDailyBars)
      .values([
        { shortCode: '005930', date, market: 'KOSPI', open: 1, high: 1, low: 1, close: 1, volume: 1 },
        { shortCode: '000660', date, market: 'KOSDAQ', open: 2, high: 2, low: 2, close: 2, volume: 2 },
      ])
      .run();

    ctx.fake.setResponse('stk_bydd_trd', '20230102', { body: krxEnvelope([dailyFixture()]) });
    ctx.fake.setResponse('stk_isu_base_info', '20230102', { body: krxEnvelope([baseInfoFixture()]) });
    ctx.fake.setResponse('ksq_bydd_trd', '20230102', {
      body: krxEnvelope([
        dailyFixture({
          ISU_CD: '000660',
          ISU_NM: 'SK하이닉스',
          TDD_OPNPRC: '100,000',
          TDD_HGPRC: '101,000',
          TDD_LWPRC: '99,000',
          TDD_CLSPRC: '100,500',
          ACC_TRDVOL: '500,000',
        }),
      ]),
    });

    await ctx.svc.ingestDate(date);

    const rows = allBars(ctx);
    expect(rows).toEqual([
      {
        shortCode: '000660',
        date,
        market: 'KOSDAQ',
        open: 100_000,
        high: 101_000,
        low: 99_000,
        close: 100_500,
        volume: 500_000,
      },
      {
        shortCode: '005930',
        date,
        market: 'KOSPI',
        open: 71_500,
        high: 72_000,
        low: 71_000,
        close: 71_800,
        volume: 12_345_678,
      },
    ]);
    await teardown(ctx);
  });

  it('가격 4개나 거래량 중 하나라도 null 인 행은 건너뛰고 건수를 debug 로 남긴다', async () => {
    const ctx = await setup();
    const date = '2023-01-02';
    const debugSpy = vi.spyOn(ctx.t.container.logger, 'debug');
    ctx.fake.setResponse('stk_bydd_trd', '20230102', {
      body: krxEnvelope([
        dailyFixture(),
        dailyFixture({ ISU_CD: '005935', ISU_NM: '거래정지종목', TDD_CLSPRC: null }),
      ]),
    });
    ctx.fake.setResponse('stk_isu_base_info', '20230102', { body: krxEnvelope([baseInfoFixture()]) });

    await ctx.svc.ingestDate(date);

    const rows = allBars(ctx);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ shortCode: '005930' });
    expect(debugSpy).toHaveBeenCalledWith(
      expect.objectContaining({ skipped: 1 }),
      expect.any(String),
    );
    await teardown(ctx);
  });
});
