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

  it('갭 메우기: 사이에 무변화(이벤트 0개) 커버 거래일이 있어도 다음 커버 구간을 정확히 찾는다', async () => {
    const ctx = await setup();

    // 01-02: 기준 상태 (상장주식수 1,000,000)
    ctx.fake.setResponse('stk_bydd_trd', '20230102', { body: krxEnvelope([dailyFixture()]) });
    ctx.fake.setResponse('stk_isu_base_info', '20230102', { body: krxEnvelope([baseInfoFixture()]) });
    await ctx.svc.ingestDate('2023-01-02');

    // 01-04: 01-03 을 건너뛰고 수집 — 값이 01-02 와 같아 이벤트가 0개다. coverage 에는
    // 남지만 symbol_master_events 에는 행이 생기지 않는 "무변화 커버 거래일"이 된다.
    ctx.fake.setResponse('stk_bydd_trd', '20230104', { body: krxEnvelope([dailyFixture()]) });
    ctx.fake.setResponse('stk_isu_base_info', '20230104', { body: krxEnvelope([baseInfoFixture()]) });
    const day4 = await ctx.svc.ingestDate('2023-01-04');
    expect(day4).toEqual({ kind: 'TRADING_DAY', eventCount: 0, checkpointSaved: false });

    // 01-06: 01-05 를 건너뛰고 수집 — 상장주식수가 1,500,000 으로 바뀐다. 직전 커버일이
    // 01-04(무변화 거래일)이므로 span 이 01-04 를 기준으로 기록된다.
    ctx.fake.setResponse('stk_bydd_trd', '20230106', { body: krxEnvelope([dailyFixture()]) });
    ctx.fake.setResponse('stk_isu_base_info', '20230106', {
      body: krxEnvelope([baseInfoFixture({ LIST_SHRS: '1,500,000' })]),
    });
    const day6 = await ctx.svc.ingestDate('2023-01-06');
    expect(day6).toEqual({ kind: 'TRADING_DAY', eventCount: 1, checkpointSaved: false });
    expect(ctx.svc.listEvents('2023-01-06', '2023-01-06')[0]).toMatchObject({
      observedSpanStart: '2023-01-04',
    });

    // 01-03 온디맨드 수집: 값이 01-02 와 같아 그 자체로는 이벤트가 없다. "이벤트가 있는
    // 날"로 D2 를 찾으면 무변화 거래일 01-04 를 건너뛰고 01-06 을 잘못 재계산하게 된다 —
    // coverage 구간 기준으로 찾으면 01-04 를 정확히 짚어야 한다.
    ctx.fake.setResponse('stk_bydd_trd', '20230103', { body: krxEnvelope([dailyFixture()]) });
    ctx.fake.setResponse('stk_isu_base_info', '20230103', { body: krxEnvelope([baseInfoFixture()]) });
    const day3 = await ctx.svc.ingestDate('2023-01-03');

    expect(day3).toEqual({ kind: 'TRADING_DAY', eventCount: 0, checkpointSaved: false });
    // D2 는 01-04 다 — 값이 01-03 과 같아 재계산 결과도 이벤트 0개고, 기존에도 없었으니 그대로다.
    expect(ctx.svc.listEvents('2023-01-04', '2023-01-04')).toHaveLength(0);
    // 01-06 이벤트는 01-04 가 여전히 진짜 직전 커버일이라 손대지 않아야 한다 — span 이 01-03 으로
    // 퇴보하면 이 버그가 다시 생긴 것이다.
    const day6Events = ctx.svc.listEvents('2023-01-06', '2023-01-06');
    expect(day6Events).toHaveLength(1);
    expect(day6Events[0]).toMatchObject({
      eventType: 'SHARES_CHANGED',
      observedSpanStart: '2023-01-04',
    });
    // 01-03~04 는 이제 커버됐고 01-05 는 여전히 갭이다
    expect(ctx.svc.isCovered('2023-01-03')).toBe(true);
    expect(ctx.svc.isCovered('2023-01-04')).toBe(true);
    expect(ctx.svc.isCovered('2023-01-05')).toBe(false);
    await teardown(ctx);
  });

  it('체크포인트만 남고 coverage 가 비어 있어도 재수집이 UNIQUE 위반 없이 복구한다', async () => {
    const ctx = await setup();
    ctx.fake.setResponse('stk_bydd_trd', '20230102', { body: krxEnvelope([dailyFixture()]) });
    ctx.fake.setResponse('stk_isu_base_info', '20230102', { body: krxEnvelope([baseInfoFixture()]) });

    // 체크포인트 저장과 coverage 갱신이 두 트랜잭션으로 나뉘어 있던 시절에 그 사이에서
    // 죽으면 남았을 상태를 흉내낸다 — checkpointDate 는 있는데 coverage 는 비어 있다.
    ctx.svc.saveCheckpoint('2023-01-02', new Map(), true);
    expect(ctx.svc.isCovered('2023-01-02')).toBe(false);

    const result = await ctx.svc.ingestDate('2023-01-02');

    expect(result).toEqual({ kind: 'TRADING_DAY', eventCount: 0, checkpointSaved: true });
    expect(ctx.svc.isCovered('2023-01-02')).toBe(true);
    await teardown(ctx);
  });
});
