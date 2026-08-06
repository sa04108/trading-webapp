import { describe, expect, it, vi } from 'vitest';
import type { Clock } from '../../src/server/shared/clock.js';
import { createKrxHistoricalUniverseSource } from '../../src/server/modules/market-data/infrastructure/krx/krx-historical-universe-source.js';
import type { KrxHistoricalUniverseSource } from '../../src/server/modules/market-data/application/ports.js';
import { SymbolMasterBackfill } from '../../src/server/modules/market-data/application/symbol-master-backfill.js';
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

const API_KEY = 'SYMBOL_MASTER_BACKFILL_TEST_KEY';
const NOOP_SLEEP = async () => undefined;

/**
 * 테스트가 "오늘" 을 임의로 앞뒤로 옮길 수 있게 하는 시계. 백필의 today 경계(cursor
 * 상한)와 KRX 소스의 일별 호출 카운터 리셋 시점은 서로 다른 개념이라 별도 인스턴스로
 * 독립적으로 제어한다 — 예산 소진 후 재개 테스트가 날짜 범위를 건드리지 않고
 * 호출 카운터만 리셋해야 하기 때문이다.
 */
class MutableClock implements Clock {
  constructor(private value: number) {}
  now(): number { return this.value; }
  set(value: number): void { this.value = value; }
}

/** 자정 경계 오차를 피하려 KST 정오에 해당하는 UTC 시각을 쓴다. */
function kstNoonMs(isoDate: string): number {
  return Date.parse(`${isoDate}T03:00:00Z`);
}

interface Ctx {
  readonly t: TestApp;
  readonly fake: KrxFakeServer;
  readonly svc: SymbolMasterService;
  readonly source: KrxHistoricalUniverseSource;
  readonly sourceClock: MutableClock;
}

async function setup(): Promise<Ctx> {
  const t = await createTestApp();
  const fake = await startKrxFakeServer();
  const sourceClock = new MutableClock(kstNoonMs('2023-06-01'));
  const source = createKrxHistoricalUniverseSource(
    { baseUrl: fake.baseUrl, apiKey: API_KEY, approvalExpiry: null },
    sourceClock,
    t.container.logger,
    { sleep: NOOP_SLEEP },
  );
  const deps: SymbolMasterServiceDeps = {
    db: t.container.database.db,
    source,
    clock: t.container.clock,
    logger: t.container.logger,
  };
  return { t, fake, svc: new SymbolMasterService(deps), source, sourceClock };
}

function setTradingDay(fake: KrxFakeServer, basDd: string): void {
  fake.setResponse('stk_bydd_trd', basDd, { body: krxEnvelope([dailyFixture()]) });
  fake.setResponse('stk_isu_base_info', basDd, { body: krxEnvelope([baseInfoFixture()]) });
}

async function teardown(ctx: Ctx): Promise<void> {
  await ctx.fake.close();
  await ctx.t.close();
}

describe('SymbolMasterBackfill', () => {
  it('3일 범위를 예산 안에서 끝까지 채우면 IDLE + cursorDate null 로 돌아온다', async () => {
    const ctx = await setup();
    setTradingDay(ctx.fake, '20230102');
    setTradingDay(ctx.fake, '20230103');
    setTradingDay(ctx.fake, '20230104');

    const backfillClock = new MutableClock(kstNoonMs('2023-01-04'));
    const runner = new SymbolMasterBackfill({
      service: ctx.svc,
      source: ctx.source,
      clock: backfillClock,
      logger: ctx.t.container.logger,
      dailyCallBudget: 100,
    });

    runner.start('2023-01-02');
    await vi.waitFor(() => expect(runner.status().state).toBe('IDLE'));

    expect(runner.status()).toEqual({
      state: 'IDLE',
      cursorDate: null,
      targetStartDate: '2023-01-02',
      error: null,
    });
    expect(ctx.svc.isCovered('2023-01-02')).toBe(true);
    expect(ctx.svc.isCovered('2023-01-03')).toBe(true);
    expect(ctx.svc.isCovered('2023-01-04')).toBe(true);
    await teardown(ctx);
  });

  it('예산 소진으로 정지한 뒤 같은 fromDate 로 재개하면 이미 커버된 날은 공짜로 넘기고 완주한다', async () => {
    const ctx = await setup();
    setTradingDay(ctx.fake, '20230102');
    setTradingDay(ctx.fake, '20230103');

    // 이틀 범위로 고정 — 예산 소진은 호출 카운터 때문이지 날짜 범위 때문이 아니다.
    // 예산은 엔드포인트당 기준이라 1 이면 날짜 하나만 수집하고 멈춘다.
    const backfillClock = new MutableClock(kstNoonMs('2023-01-03'));
    const runner = new SymbolMasterBackfill({
      service: ctx.svc,
      source: ctx.source,
      clock: backfillClock,
      logger: ctx.t.container.logger,
      dailyCallBudget: 1,
    });

    runner.start('2023-01-02');
    await vi.waitFor(() => expect(runner.status().state).toBe('BUDGET_EXHAUSTED'));

    expect(runner.status().cursorDate).toBe('2023-01-03');
    expect(runner.status().targetStartDate).toBe('2023-01-02');
    expect(ctx.svc.isCovered('2023-01-02')).toBe(true);
    expect(ctx.svc.isCovered('2023-01-03')).toBe(false);

    // 스케줄러가 다음날 다시 부른 상황을 흉내낸다 — 호출 카운터가 새 날로 리셋된다.
    ctx.sourceClock.set(kstNoonMs('2023-06-02'));
    runner.start('2023-01-02');
    await vi.waitFor(() => expect(runner.status().state).toBe('IDLE'));

    expect(runner.status().cursorDate).toBeNull();
    expect(ctx.svc.isCovered('2023-01-02')).toBe(true);
    expect(ctx.svc.isCovered('2023-01-03')).toBe(true);
    await teardown(ctx);
  });

  it('429 응답은 BUDGET_EXHAUSTED 로 취급하고 cursorDate 를 재개 지점으로 남긴다', async () => {
    const ctx = await setup();
    ctx.fake.setResponse('stk_bydd_trd', '20230102', { status: 429, body: krxEnvelope([]) });

    const backfillClock = new MutableClock(kstNoonMs('2023-01-02'));
    const runner = new SymbolMasterBackfill({
      service: ctx.svc,
      source: ctx.source,
      clock: backfillClock,
      logger: ctx.t.container.logger,
      dailyCallBudget: 100,
    });

    runner.start('2023-01-02');
    await vi.waitFor(() => expect(runner.status().state).toBe('BUDGET_EXHAUSTED'));

    expect(runner.status().cursorDate).toBe('2023-01-02');
    expect(runner.status().targetStartDate).toBe('2023-01-02');
    expect(runner.status().error).toBeNull();
    expect(ctx.svc.isCovered('2023-01-02')).toBe(false);
    await teardown(ctx);
  });
});
