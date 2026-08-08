import { describe, expect, it } from 'vitest';
import { createKrxHistoricalUniverseSource } from '../../src/server/modules/market-data/infrastructure/krx/krx-historical-universe-source.js';
import {
  SymbolMasterService,
  type SymbolMasterServiceDeps,
} from '../../src/server/modules/market-data/application/symbol-master-service.js';
import {
  symbolMasterCoverage,
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
  it('최초 수집은 baseline 버전을 만들고 이벤트가 없다', async () => {
    const ctx = await setup();
    ctx.fake.setResponse('stk_bydd_trd', '20230102', { body: krxEnvelope([dailyFixture()]) });
    ctx.fake.setResponse('stk_isu_base_info', '20230102', { body: krxEnvelope([baseInfoFixture()]) });

    const result = await ctx.svc.ingestDate('2023-01-02');

    expect(result).toEqual({ kind: 'TRADING_DAY' });
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

    expect(result).toEqual({ kind: 'TRADING_DAY' });
    expect(ctx.svc.getUniverseAsOf('2023-01-03').get('KR7005930003')!.sharesOutstanding).toBe(
      '2000000',
    );
    expect(ctx.svc.listEvents('2023-01-03', '2023-01-03')).toMatchObject([
      { eventType: 'SHARES_CHANGED' },
    ]);
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

    expect(day5).toEqual({ kind: 'TRADING_DAY' });
    expect(ctx.svc.listEvents('2023-01-05', '2023-01-05')[0]).toMatchObject({
      observedSpanStart: '2023-01-02',
    });

    // 01-03 온디맨드 수집: 값이 01-02 와 같아 그 자체로는 이벤트가 없다
    ctx.fake.setResponse('stk_bydd_trd', '20230103', { body: krxEnvelope([dailyFixture()]) });
    ctx.fake.setResponse('stk_isu_base_info', '20230103', { body: krxEnvelope([baseInfoFixture()]) });
    const day3 = await ctx.svc.ingestDate('2023-01-03');

    expect(day3).toEqual({ kind: 'TRADING_DAY' });
    // 파생 이벤트의 관측 기준은 새로 확인한 01-03 으로 당겨지고 중복은 생기지 않는다.
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
    // 남지만 상태 버전은 늘지 않는 "무변화 커버 거래일"이 된다.
    ctx.fake.setResponse('stk_bydd_trd', '20230104', { body: krxEnvelope([dailyFixture()]) });
    ctx.fake.setResponse('stk_isu_base_info', '20230104', { body: krxEnvelope([baseInfoFixture()]) });
    const day4 = await ctx.svc.ingestDate('2023-01-04');
    expect(day4).toEqual({ kind: 'TRADING_DAY' });

    // 01-06: 01-05 를 건너뛰고 수집 — 상장주식수가 1,500,000 으로 바뀐다. 직전 커버일이
    // 01-04(무변화 거래일)이므로 span 이 01-04 를 기준으로 기록된다.
    ctx.fake.setResponse('stk_bydd_trd', '20230106', { body: krxEnvelope([dailyFixture()]) });
    ctx.fake.setResponse('stk_isu_base_info', '20230106', {
      body: krxEnvelope([baseInfoFixture({ LIST_SHRS: '1,500,000' })]),
    });
    const day6 = await ctx.svc.ingestDate('2023-01-06');
    expect(day6).toEqual({ kind: 'TRADING_DAY' });
    expect(ctx.svc.listEvents('2023-01-06', '2023-01-06')[0]).toMatchObject({
      observedSpanStart: '2023-01-04',
    });

    // 01-03 온디맨드 수집: 값이 01-02 와 같아 그 자체로는 이벤트가 없다. "이벤트가 있는
    // 날"로 D2 를 찾으면 무변화 거래일 01-04 를 건너뛰고 01-06 을 잘못 재계산하게 된다 —
    // coverage 구간 기준으로 찾으면 01-04 를 정확히 짚어야 한다.
    ctx.fake.setResponse('stk_bydd_trd', '20230103', { body: krxEnvelope([dailyFixture()]) });
    ctx.fake.setResponse('stk_isu_base_info', '20230103', { body: krxEnvelope([baseInfoFixture()]) });
    const day3 = await ctx.svc.ingestDate('2023-01-03');

    expect(day3).toEqual({ kind: 'TRADING_DAY' });
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

  it('baseline 버전만 남고 coverage 가 비어 있어도 재수집이 안전하게 복구한다', async () => {
    const ctx = await setup();
    ctx.fake.setResponse('stk_bydd_trd', '20230102', { body: krxEnvelope([dailyFixture()]) });
    ctx.fake.setResponse('stk_isu_base_info', '20230102', { body: krxEnvelope([baseInfoFixture()]) });

    ctx.t.container.database.db.insert(symbolMasterVersions).values({
      standardCode: 'KR7005930003',
      validFromDate: '2023-01-02',
      validToDate: null,
      shortCode: '005930',
      name: '삼성전자',
      market: 'KOSPI',
      sharesOutstanding: '1000000',
      instrumentType: 'COMMON_STOCK',
      listedDate: '1975-06-11',
      recordedAtMs: ctx.t.container.clock.now(),
    }).run();
    expect(ctx.svc.isCovered('2023-01-02')).toBe(false);

    const result = await ctx.svc.ingestDate('2023-01-02');

    expect(result).toEqual({ kind: 'TRADING_DAY' });
    expect(ctx.svc.isCovered('2023-01-02')).toBe(true);
    await teardown(ctx);
  });

  it('고립된 휴장일은 먼 과거의 열린 버전을 유니버스로 노출하지 않는다', async () => {
    const ctx = await setup();
    ctx.fake.setResponse('stk_bydd_trd', '20230102', { body: krxEnvelope([dailyFixture()]) });
    ctx.fake.setResponse('stk_isu_base_info', '20230102', { body: krxEnvelope([baseInfoFixture()]) });
    await ctx.svc.ingestDate('2023-01-02');

    expect(await ctx.svc.ingestDate('2023-01-10')).toEqual({ kind: 'HOLIDAY' });
    expect(ctx.svc.isCovered('2023-01-10')).toBe(true);
    expect(ctx.svc.canResolveUniverseAsOf('2023-01-10')).toBe(false);
    expect(() => ctx.svc.getUniverseAsOf('2023-01-10')).toThrow('커버하지 않는다');
    await teardown(ctx);
  });

  it('거래가 있는데 기본정보가 비면 기존 종목을 상폐 처리하지 않고 실패한다', async () => {
    const ctx = await setup();
    ctx.fake.setResponse('stk_bydd_trd', '20230102', { body: krxEnvelope([dailyFixture()]) });

    await expect(ctx.svc.ingestDate('2023-01-02')).rejects.toThrow(
      'KRX KOSPI 기본정보가 비어 있다',
    );
    expect(ctx.svc.isCovered('2023-01-02')).toBe(false);
    expect(ctx.t.container.database.db.select().from(symbolMasterVersions).all()).toHaveLength(0);
    await teardown(ctx);
  });

  it('같은 상태의 과거 날짜를 하루씩 prepend 해도 버전 행은 늘지 않는다', async () => {
    const ctx = await setup();
    for (const compactDate of ['20230104', '20230103', '20230102']) {
      ctx.fake.setResponse('stk_bydd_trd', compactDate, { body: krxEnvelope([dailyFixture()]) });
      ctx.fake.setResponse('stk_isu_base_info', compactDate, {
        body: krxEnvelope([baseInfoFixture()]),
      });
    }

    await ctx.svc.ingestDate('2023-01-04');
    await ctx.svc.ingestDate('2023-01-03');
    await ctx.svc.ingestDate('2023-01-02');

    const versions = ctx.t.container.database.db.select().from(symbolMasterVersions).all();
    expect(versions).toHaveLength(1);
    expect(versions[0]).toMatchObject({
      standardCode: 'KR7005930003',
      validFromDate: '2023-01-02',
      validToDate: null,
    });
    await teardown(ctx);
  });

  it('trading_days에서 빠진 미래 버전 경계도 과거 overlay가 덮지 않는다', async () => {
    const ctx = await setup();
    const db = ctx.t.container.database.db;
    const common = {
      standardCode: 'KR7005930003',
      shortCode: '005930',
      name: '삼성전자',
      market: 'KOSPI',
      instrumentType: 'COMMON_STOCK',
      listedDate: '1975-06-11',
      recordedAtMs: ctx.t.container.clock.now(),
    } as const;
    db.insert(symbolMasterVersions).values([
      { ...common, validFromDate: '2023-01-01', validToDate: '2023-01-05', sharesOutstanding: '1000000' },
      { ...common, validFromDate: '2023-01-05', validToDate: null, sharesOutstanding: '2000000' },
    ]).run();
    db.insert(symbolMasterTradingDays).values([{ date: '2023-01-01' }, { date: '2023-01-10' }]).run();
    db.insert(symbolMasterCoverage).values([
      { startDate: '2023-01-01', endDate: '2023-01-01', syncedAtMs: ctx.t.container.clock.now() },
      { startDate: '2023-01-05', endDate: '2023-01-05', syncedAtMs: ctx.t.container.clock.now() },
    ]).run();
    ctx.fake.setResponse('stk_bydd_trd', '20230103', { body: krxEnvelope([dailyFixture()]) });
    ctx.fake.setResponse('stk_isu_base_info', '20230103', {
      body: krxEnvelope([baseInfoFixture({ LIST_SHRS: '1,500,000' })]),
    });

    await ctx.svc.ingestDate('2023-01-03');

    expect(db.select().from(symbolMasterVersions).all()
      .sort((a, b) => a.validFromDate.localeCompare(b.validFromDate))).toMatchObject([
      { validFromDate: '2023-01-01', validToDate: '2023-01-03', sharesOutstanding: '1000000' },
      { validFromDate: '2023-01-03', validToDate: '2023-01-05', sharesOutstanding: '1500000' },
      { validFromDate: '2023-01-05', validToDate: null, sharesOutstanding: '2000000' },
    ]);
    await teardown(ctx);
  });
});

describe('SymbolMasterService.ingestDate 동시 호출 가드', () => {
  it('같은 날짜 동시 호출은 KRX 를 한 번만 부르고 baseline·coverage 를 하나만 남긴다', async () => {
    const ctx = await setup();
    const date = '2023-01-02';
    // KOSPI 일별매매 응답을 지연시켜 첫 호출이 KRX await 중일 때 두 번째 호출이 들어오게 한다.
    ctx.fake.setResponse('stk_bydd_trd', '20230102', {
      body: krxEnvelope([dailyFixture()]),
      delayMs: 30,
    });
    ctx.fake.setResponse('stk_isu_base_info', '20230102', { body: krxEnvelope([baseInfoFixture()]) });

    const [first, second] = await Promise.all([ctx.svc.ingestDate(date), ctx.svc.ingestDate(date)]);

    // 가드가 없으면 두 호출 모두 isCovered 게이트를 통과해 따로 수집한다 — 여기서는
    // 두 번째 호출자가 새로 수집하지 않고 첫 호출의 Promise 를 그대로 받아야 한다.
    expect(second).toBe(first);
    expect(first).toEqual({ kind: 'TRADING_DAY' });

    // 이중 수집이었다면 일별매매 2회 + 기본정보 2회를 두 번, 총 8회가 나갔을 것이다.
    expect(ctx.fake.requests.length).toBe(4);
    expect(ctx.t.container.database.db.select().from(symbolMasterVersions).all()).toHaveLength(1);
    const coverage = ctx.svc.coverageRanges();
    expect(coverage).toHaveLength(1);
    expect(coverage[0]).toMatchObject({ startDate: date, endDate: date });
    expect(ctx.svc.listEvents(date, date)).toHaveLength(0);
    await teardown(ctx);
  });

  it('다른 날짜의 동시 호출은 서로 기다리지 않고 각자 진행된다', async () => {
    const ctx = await setup();
    ctx.fake.setResponse('stk_bydd_trd', '20230102', {
      body: krxEnvelope([dailyFixture()]),
      delayMs: 80,
    });
    ctx.fake.setResponse('stk_isu_base_info', '20230102', { body: krxEnvelope([baseInfoFixture()]) });
    ctx.fake.setResponse('stk_bydd_trd', '20230301', {
      body: krxEnvelope([dailyFixture()]),
      delayMs: 80,
    });
    ctx.fake.setResponse('stk_isu_base_info', '20230301', { body: krxEnvelope([baseInfoFixture()]) });

    const [first, second] = await Promise.all([
      ctx.svc.ingestDate('2023-01-02'),
      ctx.svc.ingestDate('2023-03-01'),
    ]);

    expect(first.kind).toBe('TRADING_DAY');
    expect(second.kind).toBe('TRADING_DAY');

    // 이중 수집 가드는 date 별로 걸려야 한다. 경과 시간으로 재면 기계가 느린 날
    // 병렬인데도 임계값을 넘어 흔들리므로, 요청이 실제로 겹쳤는지를 본다 — 직렬이면
    // 한 날짜의 요청 4개가 모두 끝난 뒤에야 다른 날짜의 첫 요청이 도착한다.
    const basDds = ctx.fake.requests.map((request) => request.basDd);
    const lastOfJanuary = basDds.lastIndexOf('20230102');
    const firstOfMarch = basDds.indexOf('20230301');
    expect(firstOfMarch).toBeGreaterThanOrEqual(0);
    expect(firstOfMarch).toBeLessThan(lastOfJanuary);

    expect(ctx.fake.requests.length).toBe(8);
    expect(ctx.svc.isCovered('2023-01-02')).toBe(true);
    expect(ctx.svc.isCovered('2023-03-01')).toBe(true);
    await teardown(ctx);
  });
});
