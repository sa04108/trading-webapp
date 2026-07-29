import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Candle } from '../../src/server/modules/market-data/domain/candle.js';
import type { Fact } from '../../src/server/modules/facts/domain/fact.js';
import type { BacktestRequest } from '../../src/shared/schemas/backtest-request.js';
import { createTestAdmin, createTestApp, type TestApp } from '../helpers/test-app.js';

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

describe('워커(backtest-child.ts) 의 팩트 배선 — 실제 자식 프로세스', () => {
  let ctx: TestApp;
  let cookie: string;
  let datasetId: string;

  beforeEach(async () => {
    ctx = await createTestApp();
    const { username, password } = await createTestAdmin(ctx.container);
    const login = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username, password },
    });
    cookie = login.cookies.find((c) => c.name === 'qp_session')!.value;

    const dataset = ctx.container.datasetService.createBrokerDataset(
      'kr-daily-facts-v1',
      'KR',
      '1d',
      ['CHEAP', 'RICH'],
    );
    datasetId = dataset.id;
    await ctx.container.candleRepository.saveCandles(datasetId, candles(40));
    await ctx.container.datasetService.refreshCoverage(datasetId, 'KR', '1d');
    ctx.container.datasetService.bumpVersion(datasetId, 'broker:1d:seed', Date.now());

    // 컨테이너가 조립한 factRepository 로 저장한다 — 워커가 같은 dataRoot 를 통해
    // 이 팩트를 다시 읽어야 하므로, 테스트 전용 repository 를 새로 만들지 않는다.
    await ctx.container.factRepository.saveFacts(datasetId, [
      ...factsFor('CHEAP', 50_000),
      ...factsFor('RICH', 5_000),
    ]);
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
        strategyVersion: '1.0.0',
        parameters: { topN: 1, rebalanceMonths: 3, staleQuarters: 2 },
        datasetId,
        timeframe: '1d',
        universe: { type: 'SYMBOLS', symbols: ['CHEAP', 'RICH'] },
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

  /**
   * 워커는 재무가 없어 조용히 빠지는 종목이 있다고 경고하면서 "facts:sync 리포트를
   * 확인하세요" 라고 안내했다 — 그 리포트는 이미 닫혔을 수 있는 세션의 stdout 으로만
   * 존재했다. 실제로 로드된 팩트 키를 유니버스와 맞춰 종목 이름을 직접 밝힌다.
   */
  it(
    '재무가 없는 종목을 이름으로 밝힌다',
    { timeout: 90_000 },
    async () => {
      // 데이터셋·봉은 있지만 팩트가 없는 종목을 하나 더한다
      ctx.container.datasetService.updateSymbols(datasetId, { add: ['NOFACTS'] });
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
      await ctx.container.candleRepository.saveCandles(datasetId, extra);
      await ctx.container.datasetService.refreshCoverage(datasetId, 'KR', '1d');

      const created = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/backtests',
        cookies: { qp_session: cookie },
        payload: {
          strategyId: 'value-quality-rank',
          strategyVersion: '1.0.0',
          parameters: { topN: 1, rebalanceMonths: 3, staleQuarters: 2 },
          datasetId,
          timeframe: '1d',
          universe: { type: 'SYMBOLS', symbols: ['CHEAP', 'RICH', 'NOFACTS'] },
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
      // 더 이상 존재하지 않는 리포트를 가리키지 않는다
      expect(factWarning).not.toContain('facts:sync 리포트를 확인하세요');
    },
  );
});
