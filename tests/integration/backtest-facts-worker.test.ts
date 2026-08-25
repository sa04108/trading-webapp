import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, gt, inArray } from 'drizzle-orm';
import type { Candle } from '../../src/server/modules/market-data/domain/candle.js';
import type { Fact } from '../../src/server/modules/facts/domain/fact.js';
import {
  facts as factRows,
  krxDailyBars,
  symbolFactsState,
  symbolMasterVersions,
} from '../../src/server/shared/db/schema.js';
import type { BacktestRequest } from '../../src/shared/schemas/backtest-request.js';
import {
  createTestAdmin,
  createTestApp,
  installPreparedSubmissionFixture,
  type TestApp,
} from '../helpers/test-app.js';
import { registerSymbols, seedCorporateActionCoverage,
  seedFinancialCoverage, seedDailyBars, yearRange } from '../helpers/seed.js';
import { seedSymbolMasterUniverse } from '../helpers/symbol-master-seed.js';

const DAY = 86_400_000;
const START = Date.UTC(2025, 0, 2);

/**
 * Task 11 인접 위험 점검: `tests/integration/backtest-facts.test.ts` 의
 * '저장소 → 엔진 왕복' 은 `runBacktest` 를 직접 호출하며 facts 도 테스트가 직접
 * 조회해 넘긴다 — `src/workers/backtest-child.ts` 의 `factRepository.getFacts(...)`
 * 호출도, 그 결과를 `runBacktest` 에 넘기는 배선도 실행되지 않는다. 이 파일은 실제
 * HTTP 제출 → 큐 → 자식 프로세스 경로로 같은 시나리오를 검증해 그 배선 자체를 덮는다.
 * `facts,` 인자를 실수로 지우면 이 테스트가 실패해야 한다 (수동으로 지우고 실패 확인함,
 * task-11-report.md 참고).
 *
 * 유니버스는 이제 데이터셋이 아니라 유니버스 규칙이 정한다(스펙 2026-08-05) —
 * `universeRule.topN` 은 전략 파라미터의 `topN`(보유 종목 수)과 별개다: 여기서는
 * "이 종목들이 후보군에 들어온다" 는 뜻이고, 전략이 그 후보군 안에서 다시 랭킹한다.
 */

const disclosed = START + 5 * DAY;

function factsFor(symbol: string, quarterlyIncome: number): Fact[] {
  const facts: Fact[] = [];
  for (const periodKey of ['2024Q2', '2024Q3', '2024Q4', '2025Q1']) {
    facts.push({
      scope: 'SYMBOL',
      key: symbol,
      field: 'OPERATING_INCOME',
      periodKey,
      asOfTsMs: disclosed,
      value: quarterlyIncome,
      unit: 'KRW',
    });
  }
  const balance: Array<[string, number, string]> = [
    ['SHARES_OUTSTANDING', 1_000, 'SHARES'],
    ['CURRENT_ASSETS', 500_000, 'KRW'],
    ['CURRENT_LIABILITIES', 200_000, 'KRW'],
    ['TANGIBLE_ASSETS', 400_000, 'KRW'],
  ];
  for (const [field, value, unit] of balance) {
    facts.push({
      scope: 'SYMBOL',
      key: symbol,
      field,
      periodKey: '2025Q1',
      asOfTsMs: disclosed,
      value,
      unit,
    });
  }
  return facts;
}

function candles(bars: number): Candle[] {
  const out: Candle[] = [];
  for (let index = 0; index < bars; index += 1) {
    for (const symbol of ['CHEAP', 'RICH']) {
      out.push({
        symbol,
        market: 'KR',
        timeframe: '1d',
        tsMs: START + index * DAY,
        open: 1_000,
        high: 1_000,
        low: 1_000,
        close: 1_000,
        volume: 1_000,
      });
    }
  }
  return out;
}

async function waitFor(condition: () => boolean, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timeout');
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

/** value-quality-rank 는 rebalanceMonths=3 — 이 3개월짜리 period 는 리밸런스가 하나뿐이다 */
const FACTS_MASTER_DATE = '2025-01-02';

function factsUniverseRule(topN: number): BacktestRequest['universeRule'] {
  return {
    markets: ['KOSPI'],
    stages: [{ criterion: 'MARKET_CAP', direction: 'HIGH', limit: topN }],
    rebalanceInterval: { value: 1, unit: 'MONTH' },
  };
}

describe('워커(backtest-child.ts) 의 팩트 배선 — 실제 자식 프로세스', () => {
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

    registerSymbols(ctx.container, 'KR', ['CHEAP', 'RICH']);
    // 시총 내림차순: CHEAP > RICH > NOFACTS — topN=2 면 앞의 둘, topN=3 이면 셋 다 들어온다.
    // NOFACTS 는 두 번째 테스트에서만 로컬 등록·봉을 더하지만, 마스터에는 미리 둔다.
    seedSymbolMasterUniverse(ctx.container, [FACTS_MASTER_DATE], [
      { standardCode: 'KR7000001000', shortCode: 'CHEAP', name: 'CHEAP', market: 'KOSPI', marketCapKrw: '300000000000' },
      { standardCode: 'KR7000002000', shortCode: 'RICH', name: 'RICH', market: 'KOSPI', marketCapKrw: '200000000000' },
      { standardCode: 'KR7000003000', shortCode: 'NOFACTS', name: 'NOFACTS', market: 'KOSPI', marketCapKrw: '100000000000' },
    ]);
    seedDailyBars(ctx.container.database.db, candles(40));
    // 실제 변경일 역투영 창이 기간 시작보다 90일 앞까지 보므로 인접 2024년도 닫는다.
    await seedCorporateActionCoverage(ctx.container, ['CHEAP', 'RICH'], yearRange(2024, 2025));

    // 컨테이너가 조립한 factRepository로 저장한다 — 워커가 같은 SQLite DB에서
    // 이 팩트를 다시 읽어야 하므로, 테스트 전용 repository 를 새로 만들지 않는다.
    await ctx.container.factRepository.saveFacts([
      ...factsFor('CHEAP', 50_000),
      ...factsFor('RICH', 5_000),
    ]);
    // 재무 요구 검사(422)는 파일 존재가 아니라 재무 coverage 를 본다 — 운영에서는
    // FactSyncService 가 저장과 동시에 남기는 기록이므로 픽스처도 함께 심는다.
    seedFinancialCoverage(ctx.container, ['CHEAP', 'RICH'], yearRange(2024, 2025));
  });

  afterEach(async () => {
    await ctx.close();
  });

  it(
    '제출된 밸류 전략이 저장된 팩트로 완주해 예상 종목을 매수한다 (실제 큐·자식 프로세스)',
    { timeout: 90_000 },
    async () => {
      const payload: BacktestRequest = {
        strategyId: 'value-quality-rank',
        parameters: { topN: 1, rebalanceMonths: 3, staleQuarters: 2 },
        universeRule: factsUniverseRule(2),
        timeframe: '1d',
        period: { from: '2025-01-02', to: '2025-03-01' },
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

      ctx.container.jobOrchestrator.tick();
      await waitFor(() => {
        const job = ctx.container.jobQueue.getJob(jobId);
        return job !== null && ctx.container.jobQueue.isTerminal(job.status);
      }, 60_000);

      const job = ctx.container.jobQueue.getJob(jobId)!;
      // 회귀 지점: facts 배선이 빠지면 재무가 없어 후보가 비어 거래 0건으로 "성공"
      // 하거나(runBacktest 에 facts 를 안 넘기면 fundamentals() 가 항상 null),
      // requiresFundamentals 방어선에 걸려 FAILED 로 끝난다 — 둘 다 여기서 걸린다.
      expect(job.error).toBeNull();
      expect(job.status).toBe('COMPLETED');

      // 기간 끝까지 청산되지 않고 보유가 이어지므로 backtestTrades(완결 거래)가 아니라
      // openPositions(미청산 포지션)에 남는다 — direct-engine 테스트가 fills.BUY 로
      // 확인하던 것과 같은 사실을 실제 저장 결과에서 확인한다.
      const run = ctx.container.resultsService.getRun(jobId)!;
      const openPositions = JSON.parse(run.openPositionsJson ?? '[]') as Array<{
        symbol: string;
      }>;
      const openSymbols = openPositions.map((p) => p.symbol);
      expect(openSymbols).toContain('CHEAP');
      expect(openSymbols).not.toContain('RICH');

      // 두 종목 모두 재무가 있으므로 "재무 없는 종목" 목록은 나오지 않아야 한다
      const warnings = JSON.parse(run.warningsJson ?? '[]') as string[];
      expect(warnings.some((w) => w.includes('재무 데이터가 하나도 없어'))).toBe(false);
    },
  );

  it(
    '제출 뒤 한 종목의 필수 연도 coverage가 사라지면 worker가 결과 생성 전에 중단한다',
    { timeout: 90_000 },
    async () => {
      const payload: BacktestRequest = {
        strategyId: 'value-quality-rank',
        parameters: { topN: 1, rebalanceMonths: 3, staleQuarters: 2 },
        universeRule: factsUniverseRule(2),
        timeframe: '1d',
        period: { from: '2025-01-02', to: '2025-03-01' },
        capital: { initialCash: 10_000_000, currency: 'KRW' },
        execution: {
          fillTiming: 'NEXT_BAR_OPEN',
          commissionProfileId: 'zero-cost',
          slippageProfileId: 'zero-slippage',
        },
        risk: { maxPositions: 1 },
        randomSeed: 2,
      };
      const created = await ctx.app.inject({
        method: 'POST', url: '/api/v1/backtests', cookies: { qp_session: cookie }, payload,
      });
      expect(created.statusCode).toBe(201);
      const jobId = (created.json().job as { id: string }).id;

      ctx.container.database.db.update(symbolFactsState)
        .set({ coveredYearsJson: JSON.stringify([2025]) })
        .where(eq(symbolFactsState.code, 'RICH'))
        .run();
      ctx.container.jobOrchestrator.tick();
      await waitFor(() => {
        const job = ctx.container.jobQueue.getJob(jobId);
        return job !== null && ctx.container.jobQueue.isTerminal(job.status);
      }, 60_000);

      const job = ctx.container.jobQueue.getJob(jobId)!;
      expect(job.status).toBe('FAILED');
      expect(job.error).toMatch(/coverage.*2024~2025년.*RICH/);
      expect(ctx.container.resultsService.getRun(jobId)).toBeNull();
    },
  );

  it(
    '다른 종목의 늦은 봉이 있어도 해당 종목 마지막 봉 뒤 공시만으로 worker 재무 게이트를 통과하지 않는다',
    { timeout: 90_000 },
    async () => {
      const payload: BacktestRequest = {
        strategyId: 'value-quality-rank',
        parameters: { topN: 1, rebalanceMonths: 3, staleQuarters: 2 },
        universeRule: factsUniverseRule(2),
        timeframe: '1d',
        period: { from: '2025-01-02', to: '2025-03-01' },
        capital: { initialCash: 10_000_000, currency: 'KRW' },
        execution: {
          fillTiming: 'NEXT_BAR_OPEN',
          commissionProfileId: 'zero-cost',
          slippageProfileId: 'zero-slippage',
        },
        risk: { maxPositions: 1 },
        randomSeed: 3,
      };
      const created = await ctx.app.inject({
        method: 'POST', url: '/api/v1/backtests', cookies: { qp_session: cookie }, payload,
      });
      expect(created.statusCode).toBe(201);
      const jobId = (created.json().job as { id: string }).id;

      // 제출 뒤 CHEAP은 일찍 거래가 끝나고 RICH만 더 늦게 봉이 남는 상태를 만든다.
      // CHEAP의 뒤늦은 공시는 union 전체 max 봉보다 이르지만 CHEAP 자신의 마지막
      // 실행 봉보다 늦으므로, 실제 엔진에서 CHEAP을 평가할 때 쓸 수 없다.
      ctx.container.database.db.delete(factRows)
        .where(and(
          eq(factRows.scope, 'SYMBOL'),
          inArray(factRows.key, ['CHEAP', 'RICH']),
        ))
        .run();
      ctx.container.database.db.delete(krxDailyBars)
        .where(and(
          eq(krxDailyBars.shortCode, 'CHEAP'),
          gt(krxDailyBars.date, '2025-01-11'),
        ))
        .run();
      await ctx.container.factRepository.saveFacts([{
        scope: 'SYMBOL', key: 'CHEAP', field: 'NET_INCOME', periodKey: '2024Q4',
        asOfTsMs: Date.parse('2025-01-22T00:00:00Z'), value: 1, unit: 'KRW',
      }]);

      ctx.container.jobOrchestrator.tick();
      await waitFor(() => {
        const job = ctx.container.jobQueue.getJob(jobId);
        return job !== null && ctx.container.jobQueue.isTerminal(job.status);
      }, 60_000);

      const job = ctx.container.jobQueue.getJob(jobId)!;
      expect(job.status).toBe('FAILED');
      expect(job.error).toMatch(/마지막 실행 봉.*재무 데이터/);
      expect(ctx.container.resultsService.getRun(jobId)).toBeNull();
    },
  );

  it(
    '동적 유니버스 편출 뒤의 고아 봉·공시만으로 worker 재무 게이트를 통과하지 않는다',
    { timeout: 90_000 },
    async () => {
      const payload: BacktestRequest = {
        strategyId: 'value-quality-rank',
        parameters: { topN: 1, rebalanceMonths: 3, staleQuarters: 2 },
        universeRule: factsUniverseRule(1),
        timeframe: '1d',
        period: { from: '2025-01-02', to: '2025-03-01' },
        capital: { initialCash: 10_000_000, currency: 'KRW' },
        execution: {
          fillTiming: 'NEXT_BAR_OPEN',
          commissionProfileId: 'zero-cost',
          slippageProfileId: 'zero-slippage',
        },
        risk: { maxPositions: 1 },
        randomSeed: 4,
      };
      const queued = ctx.container.jobQueue.enqueue(payload, [
        {
          rebalanceDate: '2025-01-02',
          effectiveTradingDate: '2025-01-02',
          symbols: ['CHEAP'],
          excludedNonTradingCount: 0,
        },
        {
          rebalanceDate: '2025-01-20',
          effectiveTradingDate: '2025-01-20',
          symbols: ['RICH'],
          excludedNonTradingCount: 0,
        },
      ]);

      // CHEAP은 편출 뒤에도 raw 봉이 계속 남아 있다. 그 뒤 공시만 남기면 종목별 raw
      // 마지막 봉 기준 구현은 통과하지만, 실제 엔진은 CHEAP을 다시 평가하지 않는다.
      ctx.container.database.db.delete(factRows)
        .where(and(
          eq(factRows.scope, 'SYMBOL'),
          inArray(factRows.key, ['CHEAP', 'RICH']),
        ))
        .run();
      await ctx.container.factRepository.saveFacts([{
        scope: 'SYMBOL', key: 'CHEAP', field: 'NET_INCOME', periodKey: '2024Q4',
        asOfTsMs: Date.parse('2025-01-22T00:00:00Z'), value: 1, unit: 'KRW',
      }]);

      ctx.container.jobOrchestrator.tick();
      await waitFor(() => {
        const job = ctx.container.jobQueue.getJob(queued.id);
        return job !== null && ctx.container.jobQueue.isTerminal(job.status);
      }, 60_000);

      const job = ctx.container.jobQueue.getJob(queued.id)!;
      expect(job.status).toBe('FAILED');
      expect(job.error).toMatch(/마지막 실행 봉.*재무 데이터/);
      expect(ctx.container.resultsService.getRun(queued.id)).toBeNull();
    },
  );

  /** 재무가 없어 제외된 종목은 이름과 함께 경고한다. */
  it(
    '재무가 없는 종목을 이름으로 밝힌다',
    { timeout: 90_000 },
    async () => {
      // 데이터셋·봉은 있지만 팩트가 없는 종목을 하나 더한다 — topN 을 3으로 올려
      // 마스터에 미리 둔 NOFACTS 도 유니버스에 들어오게 한다
      registerSymbols(ctx.container, 'KR', ['NOFACTS']);
      // NOFACTS 도 unionSymbols 에 들어오므로 자본변동 게이트도 통과해 둬야 한다
      await seedCorporateActionCoverage(ctx.container, ['NOFACTS'], yearRange(2024, 2025));
      // DART가 필수 연도를 모두 조회했지만 공시 행이 0건인 정상 상태다. 미수집
      // coverage 결측과 달리 실행을 허용하고 해당 종목만 랭킹에서 제외해야 한다.
      seedFinancialCoverage(ctx.container, ['NOFACTS'], yearRange(2024, 2025));
      const extra: Candle[] = [];
      for (let index = 0; index < 40; index += 1) {
        extra.push({
          symbol: 'NOFACTS',
          market: 'KR',
          timeframe: '1d',
          tsMs: START + index * DAY,
          open: 1_000,
          high: 1_000,
          low: 1_000,
          close: 1_000,
          volume: 1_000,
        });
      }
      seedDailyBars(ctx.container.database.db, extra);

      const created = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/backtests',
        cookies: { qp_session: cookie },
        payload: {
          strategyId: 'value-quality-rank',
          parameters: { topN: 1, rebalanceMonths: 3, staleQuarters: 2 },
          universeRule: factsUniverseRule(3),
          timeframe: '1d',
          period: { from: '2025-01-02', to: '2025-03-01' },
          capital: { initialCash: 10_000_000, currency: 'KRW' },
          execution: {
            fillTiming: 'NEXT_BAR_OPEN',
            commissionProfileId: 'zero-cost',
            slippageProfileId: 'zero-slippage',
          },
          risk: { maxPositions: 1 },
          randomSeed: 1,
        } satisfies BacktestRequest,
      });
      expect(created.statusCode).toBe(201);
      const jobId = (created.json().job as { id: string }).id;

      ctx.container.jobOrchestrator.tick();
      await waitFor(() => {
        const job = ctx.container.jobQueue.getJob(jobId);
        return job !== null && ctx.container.jobQueue.isTerminal(job.status);
      }, 60_000);

      const job = ctx.container.jobQueue.getJob(jobId)!;
      expect(job.error).toBeNull();
      expect(job.status).toBe('COMPLETED');

      const run = ctx.container.resultsService.getRun(jobId)!;
      const warnings = JSON.parse(run.warningsJson ?? '[]') as string[];
      const factWarning = warnings.find((w) => w.includes('재무 데이터가 하나도 없어'));
      expect(factWarning).toBeDefined();
      expect(factWarning).toContain('NOFACTS');
      // 재무가 있는 종목은 이 목록에 끼지 않는다
      expect(factWarning).not.toContain('CHEAP');
      expect(factWarning).not.toContain('RICH');
    },
  );
});

/**
 * R1 회귀: 워커의 팩트 질의가 `asOfMaxTsMs: toTsMs` 하나로 자본변동까지 잘라내면
 * PitFactView 의 효력발생일 게이트(설계 §3.4)가 프로덕션에 닿지 않는다.
 *
 * 기존 자본변동 테스트는 전부 `runBacktest` 나 `PitFactView` 에 팩트를 직접 넣어
 * 저장소 질의를 건너뛰므로 이 결함을 구조적으로 볼 수 없다. 그래서 실제 HTTP 제출 →
 * 큐 → 자식 프로세스 → SQLite 질의 경로로만 검증한다.
 *
 * 시나리오: 2025-03-14 기준 2:1 분할이 2026-03-31 접수 사업보고서로 들어온다.
 * 백테스트 기간은 2025-04-30 에 끝나므로 접수일 컷오프를 걸면 그 행이 SQL 에서 사라진다.
 */
const SPLIT_EFFECTIVE_INDEX = 71; // 2025-03-14 (= START + 71일)
/** 분할 접수일 — 기간 종료(2025-04-30)보다 11개월 늦다. 컷오프를 걸면 행이 사라진다 */
const SPLIT_RECEIPT_TS = Date.UTC(2026, 2, 31, 9, 0);

/**
 * cross-sectional-momentum 은 rebalanceMonths=1 — 2025-01-02~2025-04-30(4개월) 구간에서
 * 매달 첫 리밸런스 4회가 나온다. 종목 마스터 시총 캐시를 이 네 날짜 모두 채워야 한다.
 */
const SPLIT_MASTER_DATES = ['2025-01-02', '2025-02-02', '2025-03-02', '2025-04-02'];

function splitScenarioCandles(bars: number): Candle[] {
  const out: Candle[] = [];
  for (let index = 0; index < bars; index += 1) {
    // 분할 전 2000 → 분할 후 1100. 미보정 20봉 수익률은 −45% 라 절대 모멘텀 필터에
    // 걸려 탈락하고, 보정하면 1000 → 1100 으로 +10% 라 편입된다. 두 결과가 갈린다.
    const close = index < SPLIT_EFFECTIVE_INDEX ? 2_000 : 1_100;
    out.push({
      symbol: 'SPLIT',
      market: 'KR',
      timeframe: '1d',
      tsMs: START + index * DAY,
      open: close,
      high: close,
      low: close,
      close,
      volume: 1_000,
    });
    // 대조군 — 가격이 변하지 않아 수익률 0 이고 절대 모멘텀 필터에서 항상 탈락한다
    out.push({
      symbol: 'FLAT',
      market: 'KR',
      timeframe: '1d',
      tsMs: START + index * DAY,
      open: 1_000,
      high: 1_000,
      low: 1_000,
      close: 1_000,
      volume: 1_000,
    });
  }
  return out;
}

function seedSameDaySplitSharesChange(ctx: TestApp): void {
  const db = ctx.container.database.db;
  db.delete(symbolMasterVersions)
    .where(eq(symbolMasterVersions.standardCode, 'KR7000004000'))
    .run();
  db.insert(symbolMasterVersions).values([
    {
      standardCode: 'KR7000004000',
      validFromDate: '2000-01-01',
      validToDate: '2025-03-14',
      shortCode: 'SPLIT',
      name: 'SPLIT',
      market: 'KOSPI',
      sharesOutstanding: '1000000',
      instrumentType: 'COMMON_STOCK',
      listedDate: null,
      recordedAtMs: ctx.container.clock.now(),
    },
    {
      standardCode: 'KR7000004000',
      validFromDate: '2025-03-14',
      validToDate: null,
      shortCode: 'SPLIT',
      name: 'SPLIT',
      market: 'KOSPI',
      sharesOutstanding: '2000000',
      instrumentType: 'COMMON_STOCK',
      listedDate: null,
      recordedAtMs: ctx.container.clock.now(),
    },
  ]).run();
}

describe('워커의 자본변동 팩트 배선 — 접수일이 기간 종료 이후인 분할', () => {
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

    registerSymbols(ctx.container, 'KR', ['SPLIT', 'FLAT']);
    seedSymbolMasterUniverse(ctx.container, SPLIT_MASTER_DATES, [
      { standardCode: 'KR7000004000', shortCode: 'SPLIT', name: 'SPLIT', market: 'KOSPI', marketCapKrw: '300000000000' },
      { standardCode: 'KR7000005000', shortCode: 'FLAT', name: 'FLAT', market: 'KOSPI', marketCapKrw: '200000000000' },
    ]);
    // 이 시나리오는 DART 기준일과 실제 KRX 변경일이 같은 정상 사건이다.
    // fail-closed 정렬 검증이 테스트 픽스처 누락을 실제 결측으로 판단하지 않게 pin한다.
    seedSameDaySplitSharesChange(ctx);
    // 2025-01-02 ~ 2025-04-30 = 119봉
    seedDailyBars(ctx.container.database.db, splitScenarioCandles(119));
    // 실제 변경일 역투영 창이 기간 시작보다 90일 앞까지 보므로 인접 2024년도 닫는다.
    await seedCorporateActionCoverage(ctx.container, ['SPLIT', 'FLAT'], yearRange(2024, 2025));

    await ctx.container.factRepository.saveFacts([
      {
        scope: 'SYMBOL',
        key: 'SPLIT',
        field: 'SPLIT_RATIO',
        periodKey: '2025-03-14',
        asOfTsMs: SPLIT_RECEIPT_TS,
        value: 2,
        unit: 'RATIO',
      },
    ]);
  });

  afterEach(async () => {
    await ctx.close();
  });

  it(
    '기간 종료 이후 접수된 분할도 로드해 모멘텀 신호를 보정한다 (실제 큐·자식 프로세스)',
    { timeout: 90_000 },
    async () => {
      const payload: BacktestRequest = {
        strategyId: 'cross-sectional-momentum',
        parameters: {
          formationDays: 20,
          skipDays: 0,
          topN: 1,
          rebalanceMonths: 1,
          absoluteMomentumFilter: true,
        },
        universeRule: {
          markets: ['KOSPI'],
          stages: [{ criterion: 'MARKET_CAP', direction: 'HIGH', limit: 2 }],
          rebalanceInterval: { value: 1, unit: 'MONTH' },
        },
        timeframe: '1d',
        period: { from: '2025-01-02', to: '2025-04-30' },
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

      ctx.container.jobOrchestrator.tick();
      await waitFor(() => {
        const job = ctx.container.jobQueue.getJob(jobId);
        return job !== null && ctx.container.jobQueue.isTerminal(job.status);
      }, 60_000);

      const job = ctx.container.jobQueue.getJob(jobId)!;
      expect(job.error).toBeNull();
      expect(job.status).toBe('COMPLETED');

      const run = ctx.container.resultsService.getRun(jobId)!;
      // 회귀 지점 1: 자본변동 질의에 접수일 컷오프가 걸리면 분할 행이 로드되지 않아
      // 미보정 −45% 를 읽고 절대 모멘텀 필터가 SPLIT 을 떨어뜨린다 → 포지션 0건.
      const openPositions = JSON.parse(run.openPositionsJson ?? '[]') as Array<{ symbol: string }>;
      expect(openPositions.map((p) => p.symbol)).toContain('SPLIT');

      // 회귀 지점 2: 엔진의 한계 경고도 자본변동 팩트가 로드되었는지로 문구가 갈린다
      const warnings = JSON.parse(run.warningsJson ?? '[]') as string[];
      expect(warnings.some((w) => w.includes('액면분할도 이 실행에서는 보정되지 않았습니다'))).toBe(
        false,
      );
    },
  );
});

/**
 * Task 12 — 신규 재무전략(이익 가속·저PER·고ROE) 회귀. 실제 HTTP 제출 → 큐 → 자식
 * 프로세스 경로로 두 전략을 각각 검증한다: 최소 3종목으로 서로 다른 게이트(가속·
 * 모멘텀 / 순이익·자본총계)에서 제외되는 경로와, PIT 공시 경계에서 후보 편입이
 * 갈리는 경로를 함께 확인한다.
 *
 * `installPreparedSubmissionFixture` 로 DART 를 no-op 처리하고(위 CHEAP/RICH
 * 시나리오와 같은 관례) 팩트는 `factRepository.saveFacts` 로 직접 저장한다 —
 * 오케스트레이터가 실제로 DART coverage 를 판정하는 경로는 `backtest-preparation.test.ts`
 * 가 이미 촘촘히 덮으므로 여기서는 전략의 팩트 배선·PIT 게이트만 격리해 본다.
 *
 * 캘린더는 평일만 남기지 않고 하루도 거르지 않는다 — 실제 거래일력을 흉내 내는
 * 대신(이 픽스처가 스스로 정의하는 합성 캘린더이므로) 요일 계산의 부담을 없앤다.
 */
const FIN_DAY = 86_400_000;
/** priceMomentumDays(60) 최소값의 warm-up 을 여유 있게 덮는 시작점 */
const FIN_START = Date.UTC(2024, 9, 1); // 2024-10-01

function allDatesBetween(fromMs: number, toMs: number): string[] {
  const dates: string[] = [];
  for (let ts = fromMs; ts <= toMs; ts += FIN_DAY) dates.push(new Date(ts).toISOString().slice(0, 10));
  return dates;
}

/** 최신 분기를 2024Q4 에 고정한다 — 2025년 1·2월 리밸런스 모두 lag=1로 기본 staleQuarters(2) 안에 든다 */
function finQuarterPeriodKey(offset: number): string {
  const ordinal = 2024 * 4 + 3 - offset;
  return `${Math.floor(ordinal / 4)}Q${(ordinal % 4) + 1}`;
}

function operatingIncomeFacts(symbol: string, quarters: readonly number[], asOfTsMs: number): Fact[] {
  return quarters.map((value, offset) => ({
    scope: 'SYMBOL' as const,
    key: symbol,
    field: 'OPERATING_INCOME' as const,
    periodKey: finQuarterPeriodKey(offset),
    asOfTsMs,
    value,
    unit: 'KRW',
  }));
}

function netIncomeFacts(symbol: string, quarters: readonly number[], asOfTsMs: number): Fact[] {
  return quarters.map((value, offset) => ({
    scope: 'SYMBOL' as const,
    key: symbol,
    field: 'NET_INCOME' as const,
    periodKey: finQuarterPeriodKey(offset),
    asOfTsMs,
    value,
    unit: 'KRW',
  }));
}

function totalEquityFact(symbol: string, value: number, asOfTsMs: number): Fact {
  return {
    scope: 'SYMBOL',
    key: symbol,
    field: 'TOTAL_EQUITY',
    periodKey: finQuarterPeriodKey(0),
    asOfTsMs,
    value,
    unit: 'KRW',
  };
}

describe('이익 가속·가격 확인 순위 워커 배선 — PIT 공시 경계 (Task 12)', () => {
  let ctx: TestApp;
  let cookie: string;
  const PERIOD = { from: '2025-01-02', to: '2025-02-06' };
  const REBALANCE_2_TS = Date.parse('2025-02-02T00:00:00Z');

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

    registerSymbols(ctx.container, 'KR', ['FUTURE_WINNER', 'NO_ACCEL', 'NO_MOMENTUM']);
    seedSymbolMasterUniverse(ctx.container, allDatesBetween(FIN_START, Date.parse(`${PERIOD.to}T00:00:00Z`)), [
      { standardCode: 'KR7000010000', shortCode: 'FUTURE_WINNER', name: 'FUTURE_WINNER', market: 'KOSPI', marketCapKrw: '300000000000' },
      { standardCode: 'KR7000020000', shortCode: 'NO_ACCEL', name: 'NO_ACCEL', market: 'KOSPI', marketCapKrw: '200000000000' },
      { standardCode: 'KR7000030000', shortCode: 'NO_MOMENTUM', name: 'NO_MOMENTUM', market: 'KOSPI', marketCapKrw: '100000000000' },
    ]);
    const candles: Candle[] = [];
    const priceAt = new Map<string, (index: number) => number>([
      ['FUTURE_WINNER', (index) => 1_000 + index * 10], // 꾸준히 상승 — 가격 모멘텀은 항상 양수다
      ['NO_ACCEL', () => 1_000], // 가격은 문제없지만 영업이익이 가속하지 않는다
      ['NO_MOMENTUM', () => 1_000], // 영업이익은 가속하지만 가격이 오르지 않는다
    ]);
    let index = 0;
    for (let ts = FIN_START; ts <= Date.parse(`${PERIOD.to}T00:00:00Z`); ts += FIN_DAY) {
      for (const [symbol, fn] of priceAt) {
        const close = fn(index);
        candles.push({ symbol, market: 'KR', timeframe: '1d', tsMs: ts, open: close, high: close, low: close, close, volume: 1_000 });
      }
      index += 1;
    }
    seedDailyBars(ctx.container.database.db, candles);
    await seedCorporateActionCoverage(ctx.container, ['FUTURE_WINNER', 'NO_ACCEL', 'NO_MOMENTUM'], yearRange(2024, 2025));

    await ctx.container.factRepository.saveFacts([
      // 영업이익이 가속하지 않는다 (8분기 모두 동일 → TTM 성장률 0, 양수 조건 불충족)
      ...operatingIncomeFacts('NO_ACCEL', [25, 25, 25, 25, 25, 25, 25, 25], FIN_START),
      // 영업이익은 FUTURE_WINNER 와 같은 가속 패턴이지만 가격이 오르지 않아 모멘텀 게이트에서 빠진다
      ...operatingIncomeFacts('NO_MOMENTUM', [40, 30, 20, 10, 20, 20, 20, 20], FIN_START),
    ]);
    seedFinancialCoverage(
      ctx.container,
      ['FUTURE_WINNER', 'NO_ACCEL', 'NO_MOMENTUM'],
      yearRange(2024, 2025),
    );
  });

  afterEach(async () => {
    await ctx.close();
  });

  /** FUTURE_WINNER 공시(8분기 배치)를 disclosureTsMs 로 저장한 뒤 제출·완주해 미청산 종목을 돌려준다 */
  async function runFutureWinnerScenario(disclosureTsMs: number): Promise<string[]> {
    await ctx.container.factRepository.saveFacts(
      operatingIncomeFacts('FUTURE_WINNER', [40, 30, 20, 10, 20, 20, 20, 20], disclosureTsMs),
    );
    const payload: BacktestRequest = {
      strategyId: 'earnings-acceleration-rank',
      parameters: { topN: 1, priceMomentumDays: 60, staleQuarters: 2 },
      universeRule: factsUniverseRule(3),
      timeframe: '1d',
      period: PERIOD,
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

    ctx.container.jobOrchestrator.tick();
    await waitFor(() => {
      const job = ctx.container.jobQueue.getJob(jobId);
      return job !== null && ctx.container.jobQueue.isTerminal(job.status);
    }, 60_000);

    const job = ctx.container.jobQueue.getJob(jobId)!;
    expect(job.error).toBeNull();
    expect(job.status).toBe('COMPLETED');

    const run = ctx.container.resultsService.getRun(jobId)!;
    const openPositions = JSON.parse(run.openPositionsJson ?? '[]') as Array<{ symbol: string }>;
    return openPositions.map((position) => position.symbol);
  }

  it(
    '두 번째 리밸런스 다음날 공시된 미래 팩트는 보이지 않아 후보에서 빠진다',
    { timeout: 90_000 },
    async () => {
      const symbols = await runFutureWinnerScenario(REBALANCE_2_TS + FIN_DAY);
      expect(symbols).not.toContain('FUTURE_WINNER');
    },
  );

  it(
    '두 번째 리밸런스 직전 공시는 보여 유일한 유효 후보로 매수된다',
    { timeout: 90_000 },
    async () => {
      const symbols = await runFutureWinnerScenario(REBALANCE_2_TS - 1);
      expect(symbols).toContain('FUTURE_WINNER');
      // 가속 실패(NO_ACCEL)·모멘텀 실패(NO_MOMENTUM)는 공시 시점과 무관하게 항상 제외된다
      expect(symbols).not.toContain('NO_ACCEL');
      expect(symbols).not.toContain('NO_MOMENTUM');
    },
  );
});

describe('저PER·고ROE 순위 워커 배선 — PIT 공시 경계 (Task 12)', () => {
  let ctx: TestApp;
  let cookie: string;
  const PERIOD = { from: '2025-01-02', to: '2025-02-06' };
  const REBALANCE_2_TS = Date.parse('2025-02-02T00:00:00Z');

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

    registerSymbols(ctx.container, 'KR', ['FUTURE_WINNER', 'NEG_INCOME', 'NO_EQUITY']);
    // 이 전략은 price warm-up 이 없다(dataRequirements.priceWarmupBars 미정의) — 기간
    // 안쪽 날짜만 있으면 된다.
    seedSymbolMasterUniverse(ctx.container, allDatesBetween(Date.parse(`${PERIOD.from}T00:00:00Z`), Date.parse(`${PERIOD.to}T00:00:00Z`)), [
      { standardCode: 'KR7000040000', shortCode: 'FUTURE_WINNER', name: 'FUTURE_WINNER', market: 'KOSPI', marketCapKrw: '400000000000' },
      { standardCode: 'KR7000050000', shortCode: 'NEG_INCOME', name: 'NEG_INCOME', market: 'KOSPI', marketCapKrw: '300000000000' },
      { standardCode: 'KR7000060000', shortCode: 'NO_EQUITY', name: 'NO_EQUITY', market: 'KOSPI', marketCapKrw: '200000000000' },
    ]);
    const candles: Candle[] = [];
    for (const symbol of ['FUTURE_WINNER', 'NEG_INCOME', 'NO_EQUITY']) {
      for (let ts = Date.parse(`${PERIOD.from}T00:00:00Z`); ts <= Date.parse(`${PERIOD.to}T00:00:00Z`); ts += FIN_DAY) {
        candles.push({ symbol, market: 'KR', timeframe: '1d', tsMs: ts, open: 1_000, high: 1_000, low: 1_000, close: 1_000, volume: 1_000 });
      }
    }
    seedDailyBars(ctx.container.database.db, candles);
    await seedCorporateActionCoverage(ctx.container, ['FUTURE_WINNER', 'NEG_INCOME', 'NO_EQUITY'], yearRange(2024, 2025));

    await ctx.container.factRepository.saveFacts([
      // 순이익이 음수라 PER·ROE 계산 자체가 성립하지 않는다
      ...netIncomeFacts('NEG_INCOME', [-500, -500, -500, -500], FIN_START),
      totalEquityFact('NEG_INCOME', 5_000, FIN_START),
      // 자본총계 공시가 없다 — PER은 순이익만으로 계산되지 않으므로 ROE 를 못 구해 제외된다
      ...netIncomeFacts('NO_EQUITY', [1_000, 1_000, 1_000, 1_000], FIN_START),
    ]);
    seedFinancialCoverage(
      ctx.container,
      ['FUTURE_WINNER', 'NEG_INCOME', 'NO_EQUITY'],
      yearRange(2024, 2025),
    );
  });

  afterEach(async () => {
    await ctx.close();
  });

  /** FUTURE_WINNER 공시(4분기 순이익 + 자본총계)를 disclosureTsMs 로 저장한 뒤 제출·완주해 미청산 종목을 돌려준다 */
  async function runFutureWinnerScenario(disclosureTsMs: number): Promise<string[]> {
    await ctx.container.factRepository.saveFacts([
      ...netIncomeFacts('FUTURE_WINNER', [1_000, 1_000, 1_000, 1_000], disclosureTsMs),
      totalEquityFact('FUTURE_WINNER', 5_000, disclosureTsMs),
    ]);
    const payload: BacktestRequest = {
      strategyId: 'low-per-high-roe-rank',
      parameters: { topN: 1, staleQuarters: 2 },
      universeRule: factsUniverseRule(3),
      timeframe: '1d',
      period: PERIOD,
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

    ctx.container.jobOrchestrator.tick();
    await waitFor(() => {
      const job = ctx.container.jobQueue.getJob(jobId);
      return job !== null && ctx.container.jobQueue.isTerminal(job.status);
    }, 60_000);

    const job = ctx.container.jobQueue.getJob(jobId)!;
    expect(job.error).toBeNull();
    expect(job.status).toBe('COMPLETED');

    const run = ctx.container.resultsService.getRun(jobId)!;
    const openPositions = JSON.parse(run.openPositionsJson ?? '[]') as Array<{ symbol: string }>;
    return openPositions.map((position) => position.symbol);
  }

  it(
    '두 번째 리밸런스 다음날 공시된 미래 팩트는 보이지 않아 후보에서 빠진다',
    { timeout: 90_000 },
    async () => {
      const symbols = await runFutureWinnerScenario(REBALANCE_2_TS + FIN_DAY);
      expect(symbols).not.toContain('FUTURE_WINNER');
    },
  );

  it(
    '두 번째 리밸런스 직전 공시는 보여 유일한 유효 후보로 매수된다',
    { timeout: 90_000 },
    async () => {
      const symbols = await runFutureWinnerScenario(REBALANCE_2_TS - 1);
      expect(symbols).toContain('FUTURE_WINNER');
      // 순이익 음수(NEG_INCOME)·자본총계 결측(NO_EQUITY)은 공시 시점과 무관하게 항상 제외된다
      expect(symbols).not.toContain('NEG_INCOME');
      expect(symbols).not.toContain('NO_EQUITY');
    },
  );
});
