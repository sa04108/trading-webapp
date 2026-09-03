import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Candle } from '../../src/server/modules/market-data/domain/candle.js';
import { CORPORATE_ACTION_FIELD, type Fact } from '../../src/server/modules/facts/domain/fact.js';
import { backtestJobs, symbolMasterVersions } from '../../src/server/shared/db/schema.js';
import { eq } from 'drizzle-orm';
import type { BacktestRequest } from '../../src/shared/schemas/backtest-request.js';
import {
  createTestAdmin,
  createTestApp,
  installPreparedSubmissionFixture,
  type TestApp,
} from '../helpers/test-app.js';
import { registerSymbols, seedCorporateActionCoverage, seedDailyBars, yearRange } from '../helpers/seed.js';
import { seedSymbolMasterUniverse } from '../helpers/symbol-master-seed.js';

/**
 * 액면분할 기준일과 변경상장일이 다를 때 자산곡선에 없던 봉우리가 서던 회귀
 * (2026-08-09). DART `isu_dcrs_de` 는 분할 **기준일**이고 KRX 일봉 주가가 분할 후
 * 값이 되는 날은 **변경상장일**이다. 엔진이 기준일 봉에서 수량에 비율을 곱해 버리면
 * 그 사이 구간은 수량만 ×5, 단가는 분할 전이라 평가금액이 5배로 뛰었다가 재개 봉에서
 * 되돌아온다.
 *
 * 워커가 자본변동 효력발생일을 KRX 상장주식수 변경일로 옮기는 배선을 덮는다 —
 * `alignCorporateActionEffectiveDates` 단위 테스트만으로는 그 호출이 사라져도 통과한다.
 */

const DAY = 86_400_000;
const SYMBOL = 'SPLIT';
const STANDARD_CODE = 'KR7000009000';
const PERIOD_FROM = '2025-01-02';
const PERIOD_TO = '2025-02-20';
const START = Date.parse(`${PERIOD_FROM}T00:00:00Z`);
const BARS = 45;

/** DART 가 주는 분할 기준일 */
const RECORD_DATE = '2025-01-24';
/** KRX 상장주식수가 실제로 바뀐 날 = 변경상장일. 이 봉부터 주가가 1/5 이다 */
const RELISTING_DATE = '2025-02-04';
const SPLIT_RATIO = 5;

function dateOf(index: number): string {
  return new Date(START + index * DAY).toISOString().slice(0, 10);
}

/**
 * 2봉째에 전고점을 넘겨 진입시키고, 그 뒤로는 변경상장일까지 값을 고정한다.
 * 변경상장일부터 종가가 1/5 이 된다 — 실제 KRX 일봉이 그렇다.
 */
function candles(): Candle[] {
  const out: Candle[] = [];
  for (let index = 0; index < BARS; index += 1) {
    const date = dateOf(index);
    const base = index < 2 ? 10_000 : 12_000;
    const price = date >= RELISTING_DATE ? base / SPLIT_RATIO : base;
    out.push({
      symbol: SYMBOL,
      market: 'KR',
      timeframe: '1d',
      tsMs: START + index * DAY,
      open: price,
      high: price,
      low: price,
      close: price,
      volume: 1_000,
    });
  }
  return out;
}

function splitFact(): Fact {
  return {
    scope: 'SYMBOL',
    key: SYMBOL,
    field: CORPORATE_ACTION_FIELD,
    // 사업보고서로 들어오므로 접수일은 효력발생일보다 한참 뒤다 — 효력발생일 게이트만 본다
    periodKey: RECORD_DATE,
    asOfTsMs: Date.parse('2026-03-20T09:00:00Z'),
    value: SPLIT_RATIO,
    unit: 'RATIO',
  };
}

async function waitFor(condition: () => boolean, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timeout');
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

describe('액면분할 효력발생일 정렬 (워커 → 엔진)', () => {
  let ctx: TestApp;
  let cookie: string;

  beforeEach(async () => {
    ctx = await createTestApp();
    const { username, password } = await createTestAdmin(ctx.container);
    const login = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username, password },
    });
    cookie = login.cookies.find((c) => c.name === 'qp_session')!.value;
    installPreparedSubmissionFixture(ctx);

    registerSymbols(ctx.container, 'KR', [SYMBOL]);
    // 모든 봉 날짜를 거래일로 남긴다 — listEvents 가 변경일 직전 관측일을 찾아야
    // 상장주식수 변경을 이벤트로 파생한다 (첫 관측은 LISTED 라 걸리지 않는다).
    seedSymbolMasterUniverse(
      ctx.container,
      Array.from({ length: BARS }, (_, index) => dateOf(index)),
      [{
        standardCode: STANDARD_CODE,
        shortCode: SYMBOL,
        name: SYMBOL,
        market: 'KOSPI',
        marketCapKrw: '300000000000',
      }],
    );
    seedDailyBars(ctx.container.database.db, candles());
    await seedCorporateActionCoverage(ctx.container, [SYMBOL], yearRange(2024, 2025));
    await ctx.container.factRepository.saveFacts([splitFact()]);
  });

  afterEach(async () => {
    await ctx.close();
  });

  /** 변경상장일에 상장주식수가 5배가 되는 SCD 버전 두 벌 — 헬퍼는 열린 버전 하나만 심는다 */
  function seedSharesChange(): void {
    const db = ctx.container.database.db;
    db.delete(symbolMasterVersions).run();
    db.insert(symbolMasterVersions).values([
      {
        standardCode: STANDARD_CODE,
        validFromDate: '2000-01-01',
        validToDate: RELISTING_DATE,
        shortCode: SYMBOL,
        name: SYMBOL,
        market: 'KOSPI',
        sharesOutstanding: '1000000',
        instrumentType: 'COMMON_STOCK',
        listedDate: null,
        recordedAtMs: ctx.container.clock.now(),
      },
      {
        standardCode: STANDARD_CODE,
        validFromDate: RELISTING_DATE,
        validToDate: null,
        shortCode: SYMBOL,
        name: SYMBOL,
        market: 'KOSPI',
        sharesOutstanding: '5000000',
        instrumentType: 'COMMON_STOCK',
        listedDate: null,
        recordedAtMs: ctx.container.clock.now(),
      },
    ]).run();
  }

  async function submitBacktest(
    afterCreate?: (jobId: string) => void | Promise<void>,
  ): Promise<string> {
    const payload: BacktestRequest = {
      strategyId: 'range-breakout',
      // 손절·익절·보유 상한을 사실상 끄고 분할 구간까지 들고 가게 한다
      parameters: {
        lookbackBars: 2,
        atrPeriod: 2,
        stopAtrMultiplier: 20,
        trailAtrMultiplier: 20,
        riskPerTradePercent: 5,
        maxPositionWeightPercent: 100,
      },
      universeRule: {
        markets: ['KOSPI'],
        stages: [{ criterion: 'MARKET_CAP', direction: 'HIGH', limit: 1 }],
        rebalanceInterval: { value: 1, unit: 'MONTH' },
      },
      timeframe: '1d',
      period: { from: PERIOD_FROM, to: PERIOD_TO },
      capital: { initialCash: 10_000_000, currency: 'KRW' },
      execution: {
        fillTiming: 'NEXT_BAR_OPEN',
        commissionProfileId: 'zero-cost',
        slippageProfileId: 'zero-slippage',
      },
      risk: { maxPositions: 1 },
      randomSeed: 1,
    };

    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/backtests',
      cookies: { qp_session: cookie },
      payload,
    });
    expect(created.statusCode).toBe(201);
    const jobId = (created.json().job as { id: string }).id;

    await afterCreate?.(jobId);
    ctx.container.jobOrchestrator.tick();
    await waitFor(() => {
      const job = ctx.container.jobQueue.getJob(jobId);
      return job !== null && ctx.container.jobQueue.isTerminal(job.status);
    }, 60_000);

    return jobId;
  }

  async function runBacktest(): Promise<{
    equity: number[];
    warnings: string[];
    openSymbols: string[];
  }> {
    const jobId = await submitBacktest();

    const job = ctx.container.jobQueue.getJob(jobId)!;
    expect(job.error).toBeNull();
    expect(job.status).toBe('COMPLETED');

    const full = ctx.container.resultsService.getFullExport(jobId);
    const openPositions = JSON.parse(full.run?.openPositionsJson ?? '[]') as { symbol: string }[];
    return {
      equity: full.equityPoints.map((point) => point.equity),
      warnings: JSON.parse(full.run?.warningsJson ?? '[]') as string[],
      openSymbols: openPositions.map((position) => position.symbol),
    };
  }

  function maxDailyMove(equity: readonly number[]): number {
    let worst = 0;
    for (let i = 1; i < equity.length; i += 1) {
      const previous = equity[i - 1]!;
      if (previous <= 0) continue;
      worst = Math.max(worst, Math.abs(equity[i]! / previous - 1));
    }
    return worst;
  }

  it(
    '기준일과 변경상장일이 달라도 자산곡선이 튀지 않는다',
    { timeout: 90_000 },
    async () => {
      seedSharesChange();

      const { equity, warnings, openSymbols } = await runBacktest();

      // 주가는 분할 말고는 움직이지 않게 심었다. 분할이 부(富)를 만들지 않으므로
      // 자산곡선도 평평해야 한다. 정렬 전에는 기준일 봉에서 +12%, 변경상장일 봉에서
      // −11% 가 났다 (비중이 큰 포지션이었다면 그만큼 더 컸다).
      expect(maxDailyMove(equity)).toBeLessThan(0.01);
      // 아무것도 사지 않아도 곡선은 평평하다 — 진입이 실제로 일어났는지 함께 못박는다
      expect(openSymbols).toEqual([SYMBOL]);
      expect(warnings.some((w) => w.includes('짝지어지지 않아'))).toBe(false);
    },
  );

  it(
    '제출 시점의 유니버스 제외 경고를 최종 결과에 보존한다',
    { timeout: 90_000 },
    async () => {
      seedSharesChange();
      const warning =
        '자본변동 정보를 온전히 확보할 수 없어 종목 063080을 매매 대상에서 제외했습니다.';
      const jobId = await submitBacktest((createdJobId) => {
        ctx.container.database.db.update(backtestJobs)
          .set({ submitWarningsJson: JSON.stringify([warning]) })
          .where(eq(backtestJobs.id, createdJobId))
          .run();
      });

      const run = ctx.container.resultsService.getRun(jobId);
      expect(run).not.toBeNull();
      expect(JSON.parse(run?.warningsJson ?? '[]')).toContain(warning);
    },
  );

  it(
    '짝이 될 상장주식수 변경이 없으면 왜곡된 결과를 만들지 않고 실패한다',
    { timeout: 90_000 },
    async () => {
      const jobId = await submitBacktest();
      const job = ctx.container.jobQueue.getJob(jobId)!;

      expect(job.status).toBe('FAILED');
      expect(job.error).toContain('실제 효력일을 KRX 상장주식수 변경과 정렬할 수 없어');
      expect(job.error).toContain(SYMBOL);
      const full = ctx.container.resultsService.getFullExport(jobId);
      expect(full.run).toBeNull();
      expect(full.metrics).toBeNull();
      expect(full.equityPoints).toEqual([]);
      expect(full.trades).toEqual([]);
      expect(full.monthlyReturns).toEqual([]);
      expect(ctx.container.resultsService.getChartSeries(jobId).drawdown).toEqual([]);
    },
  );

  it(
    '같은 기준일의 상충 비율 공시가 있으면 KRX와 한쪽이 맞아도 실패한다',
    { timeout: 90_000 },
    async () => {
      seedSharesChange();
      await ctx.container.factRepository.saveFacts([{
        ...splitFact(),
        asOfTsMs: Date.parse('2026-04-20T09:00:00Z'),
        value: 2,
      }]);

      const jobId = await submitBacktest();
      const job = ctx.container.jobQueue.getJob(jobId)!;

      expect(job.status).toBe('FAILED');
      expect(job.error).toContain('실제 효력일을 KRX 상장주식수 변경과 정렬할 수 없어');
      expect(job.error).toContain(SYMBOL);
      expect(ctx.container.resultsService.getFullExport(jobId).run).toBeNull();
    },
  );

  it(
    'DART가 자본변동 행을 보았지만 비율을 만들지 못한 gap이면 raw fact가 없어도 실패한다',
    { timeout: 90_000 },
    async () => {
      // 파서가 fact를 만들지 못한 실제 경로를 재현한다. 기존 정상 fact는 지우지 않아도
      // gap 자체가 다른 미표현 사건일 수 있으므로 worker는 결과 생성을 막아야 한다.
      seedSharesChange();

      const jobId = await submitBacktest(() => {
        // preparation 완료 뒤 worker 시작 전에 gap이 새로 생기는 drift/원격 bundle
        // 경로를 재현해 마지막 실행 경계가 독립적으로 막는지 검증한다.
        ctx.container.actionCoverageStore.addGapYears(SYMBOL, [2025], ctx.container.clock.now());
      });
      const job = ctx.container.jobQueue.getJob(jobId)!;

      expect(job.status).toBe('FAILED');
      expect(job.error).toContain('자본변동 보정 비율을 만들 수 없는 연도');
      expect(job.error).toContain(SYMBOL);
      const full = ctx.container.resultsService.getFullExport(jobId);
      expect(full.run).toBeNull();
      expect(full.metrics).toBeNull();
      expect(full.equityPoints).toEqual([]);
      expect(full.trades).toEqual([]);
      expect(full.monthlyReturns).toEqual([]);
      expect(ctx.container.resultsService.getChartSeries(jobId).drawdown).toEqual([]);
    },
  );
});
