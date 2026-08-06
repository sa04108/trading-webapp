import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { createKrxHistoricalUniverseSource } from '../../src/server/modules/market-data/infrastructure/krx/krx-historical-universe-source.js';
import {
  SymbolMasterService,
  type SymbolMasterServiceDeps,
} from '../../src/server/modules/market-data/application/symbol-master-service.js';
import { symbolMasterCheckpoints, symbolMasterEvents } from '../../src/server/shared/db/schema.js';
import { createTestApp, type TestApp } from '../helpers/test-app.js';
import {
  baseInfoFixture,
  dailyFixture,
  krxEnvelope,
  startKrxFakeServer,
  type KrxFakeServer,
} from '../helpers/krx-fixtures.js';

const API_KEY = 'SYMBOL_MASTER_CHECKPOINT_TEST_KEY';
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

describe('SymbolMasterService — 분기 경계 체크포인트 검증', () => {
  it('분기 경계를 넘는 ingest 가 체크포인트를 만든다', async () => {
    const ctx = await setup();

    // 03-31: 최초 수집 — 1분기 앵커 체크포인트가 생긴다
    ctx.fake.setResponse('stk_bydd_trd', '20230331', { body: krxEnvelope([dailyFixture()]) });
    ctx.fake.setResponse('stk_isu_base_info', '20230331', { body: krxEnvelope([baseInfoFixture()]) });
    const r1 = await ctx.svc.ingestDate('2023-03-31');
    expect(r1).toEqual({ kind: 'TRADING_DAY', eventCount: 0, checkpointSaved: true });

    // 04-03: 값 변화는 없지만 분기가 바뀌었다(Q1 → Q2) — 이 자체로 체크포인트를 새로 만든다
    ctx.fake.setResponse('stk_bydd_trd', '20230403', { body: krxEnvelope([dailyFixture()]) });
    ctx.fake.setResponse('stk_isu_base_info', '20230403', { body: krxEnvelope([baseInfoFixture()]) });
    const r2 = await ctx.svc.ingestDate('2023-04-03');

    expect(r2).toEqual({ kind: 'TRADING_DAY', eventCount: 0, checkpointSaved: true });
    const cp = ctx.t.container.database.db
      .select()
      .from(symbolMasterCheckpoints)
      .where(eq(symbolMasterCheckpoints.checkpointDate, '2023-04-03'))
      .get();
    expect(cp).toBeDefined();
    expect(cp!.verifiedAtMs).not.toBeNull();
    expect(cp!.mismatchJson).toBeNull();
    await teardown(ctx);
  });

  it('저장 손상 시 mismatch 를 기록하고 실측으로 교정한다', async () => {
    const ctx = await setup();
    const bFixture = baseInfoFixture({
      ISU_CD: 'KR7000660001',
      ISU_SRT_CD: '000660',
      ISU_NM: 'SK하이닉스',
      LIST_DD: '19961210',
      LIST_SHRS: '500,000',
    });

    // 01-02: 최초 수집 — A(삼성전자) 하나뿐인 1분기 앵커 체크포인트
    ctx.fake.setResponse('stk_bydd_trd', '20230102', { body: krxEnvelope([dailyFixture()]) });
    ctx.fake.setResponse('stk_isu_base_info', '20230102', { body: krxEnvelope([baseInfoFixture()]) });
    await ctx.svc.ingestDate('2023-01-02');

    // 02-01: 같은 1분기 안 — B(SK하이닉스)가 신규 상장돼 LISTED 이벤트가 하나 생긴다.
    // 이미 1분기 체크포인트가 있어 여기서는 체크포인트를 새로 만들지 않는다.
    ctx.fake.setResponse('stk_bydd_trd', '20230201', { body: krxEnvelope([dailyFixture()]) });
    ctx.fake.setResponse('stk_isu_base_info', '20230201', {
      body: krxEnvelope([baseInfoFixture(), bFixture]),
    });
    const day2 = await ctx.svc.ingestDate('2023-02-01');
    expect(day2).toEqual({ kind: 'TRADING_DAY', eventCount: 1, checkpointSaved: false });

    // B의 LISTED 이벤트를 직접 UPDATE 로 오염시킨다 — shortCode 는 diffUniverse 가 추적하는
    // 필드가 아니라(FIELD_EVENTS 미포함) 이후 어떤 정상 ingest 로도 스스로 고쳐지지 않는다.
    const listedEvent = ctx.t.container.database.db
      .select()
      .from(symbolMasterEvents)
      .where(
        and(
          eq(symbolMasterEvents.standardCode, 'KR7000660001'),
          eq(symbolMasterEvents.eventType, 'LISTED'),
        ),
      )
      .get()!;
    const corrupted = { ...JSON.parse(listedEvent.newValue!), shortCode: '999999' };
    ctx.t.container.database.db
      .update(symbolMasterEvents)
      .set({ newValue: JSON.stringify(corrupted) })
      .where(eq(symbolMasterEvents.id, listedEvent.id))
      .run();

    // 04-03: 분기가 바뀌어(Q1 → Q2) 재구성 결과를 KRX 실측과 비교한다. 오염된 이벤트 때문에
    // 재구성된 B의 shortCode(999999)가 실측(000660)과 어긋난다.
    ctx.fake.setResponse('stk_bydd_trd', '20230403', { body: krxEnvelope([dailyFixture()]) });
    ctx.fake.setResponse('stk_isu_base_info', '20230403', {
      body: krxEnvelope([baseInfoFixture(), bFixture]),
    });
    const day3 = await ctx.svc.ingestDate('2023-04-03');
    expect(day3).toEqual({ kind: 'TRADING_DAY', eventCount: 0, checkpointSaved: true });

    const cp = ctx.t.container.database.db
      .select()
      .from(symbolMasterCheckpoints)
      .where(eq(symbolMasterCheckpoints.checkpointDate, '2023-04-03'))
      .get();
    expect(cp).toBeDefined();
    expect(cp!.verifiedAtMs).toBeNull();
    const mismatch = JSON.parse(cp!.mismatchJson!);
    expect(mismatch.added).toEqual([]);
    expect(mismatch.removed).toEqual([]);
    expect(mismatch.changed).toEqual([
      {
        code: 'KR7000660001',
        field: 'shortCode',
        reconstructed: '999999',
        actual: '000660',
      },
    ]);

    // 체크포인트가 실측 스냅샷으로 교정됐으니 같은 날짜 재구성은 실측과 같다.
    expect(ctx.svc.getUniverseAsOf('2023-04-03').get('KR7000660001')!.shortCode).toBe('000660');
    await teardown(ctx);
  });
});
