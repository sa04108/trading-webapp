import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runBacktest } from '../../src/runtime/modules/backtest/domain/engine.js';
import type { ExecutionProfile } from '../../src/runtime/modules/backtest/domain/types.js';
import { CORPORATE_ACTION_FIELD, type Fact } from '../../src/runtime/modules/facts/domain/fact.js';
import { BacktestFundamentalView } from '../../src/runtime/modules/backtest/application/backtest-fundamental-view.js';
import { SqliteFactRepository } from '../../src/runtime/modules/facts/infrastructure/sqlite-fact-repository.js';
import type { Candle } from '../../src/runtime/modules/market-data/domain/candle.js';
import { valueQualityRankStrategy } from '../../src/runtime/modules/strategy/strategies/value-quality-rank.js';
import { lowPerHighRoeRankStrategy } from '../../src/runtime/modules/strategy/strategies/low-per-high-roe-rank.js';
import { earningsAccelerationRankStrategy } from '../../src/runtime/modules/strategy/strategies/earnings-acceleration-rank.js';
import { openDatabase, type DatabaseHandle } from '../../src/runtime/shared/db/database.js';

const DAY = 86_400_000;
const START = Date.UTC(2025, 0, 2);

const ZERO_COST: ExecutionProfile = {
  cost: { id: 'zero', version: '1', buyCommissionRate: 0, sellCommissionRate: 0, sellTaxRate: 0 },
  slippage: { id: 'zero', version: '1', bps: 0, fixed: 0 },
  rules: { tickSize: 0, minOrderQty: 1 },
};

let root: string;
let database: DatabaseHandle;
let repository: SqliteFactRepository;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-facts-'));
  database = openDatabase(path.join(root, 'app.sqlite'));
  repository = new SqliteFactRepository(database.db);
});

afterEach(() => {
  database.close();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('저장소 → 엔진 왕복', () => {
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

  it('저장한 팩트로 랭킹이 돌아간다', async () => {
    await repository.saveFacts([
      ...factsFor('CHEAP', 50_000),
      ...factsFor('RICH', 5_000),
    ]);

    const facts = await repository.getFacts({
      scope: 'SYMBOL',
      keys: ['CHEAP', 'RICH'],
      asOfMaxTsMs: START + 40 * DAY,
    });
    expect(facts.length).toBeGreaterThan(0);

    const result = runBacktest(valueQualityRankStrategy, {
      candles: candles(40),
      initialCash: 10_000_000,
      execution: ZERO_COST,
      parameters: { topN: 1, staleQuarters: 2 },
      randomSeed: 1,
      maxPositions: 1,
      facts,
      // 공유 리밸런스 계약의 첫 거래 봉을 공시 시점에 맞춘다. 그 전 봉은 PIT warm-up이다.
      tradeFromTsMs: disclosed,
    });

    const buys = result.fills.filter((fill) => fill.side === 'BUY');
    expect(buys.map((fill) => fill.symbol)).toEqual(['CHEAP']);
  });

});

describe('SQLite 종목별 재무 뷰의 엔진 결과 동등성', () => {
  const symbols = ['000001', '000002', '000003'];
  const disclosureTsMs = START + 125 * DAY;
  const firstRebalanceTsMs = START + 120 * DAY;
  const secondRebalanceTsMs = START + 130 * DAY;

  function strategyFacts(symbol: string, scale: number): Fact[] {
    const rows: Fact[] = [];
    const quarters = [
      ['2023Q2', 20], ['2023Q3', 20], ['2023Q4', 20], ['2024Q1', 20],
      ['2024Q2', 10], ['2024Q3', 20], ['2024Q4', 30], ['2025Q1', 40],
    ] as const;
    for (const [periodKey, value] of quarters) {
      rows.push({
        scope: 'SYMBOL', key: symbol, field: 'OPERATING_INCOME', periodKey,
        asOfTsMs: disclosureTsMs, value: value * scale, unit: 'KRW',
      });
    }
    for (const [periodKey, value] of [
      ['2024Q2', 10], ['2024Q3', 20], ['2024Q4', 30], ['2025Q1', 40],
    ] as const) {
      rows.push({
        scope: 'SYMBOL', key: symbol, field: 'NET_INCOME', periodKey,
        asOfTsMs: disclosureTsMs, value: value * scale, unit: 'KRW',
      });
    }
    for (const [field, value, unit] of [
      ['TOTAL_EQUITY', 500_000 / scale, 'KRW'],
      ['SHARES_OUTSTANDING', 1_000, 'SHARES'],
      ['CURRENT_ASSETS', 500_000, 'KRW'],
      ['CURRENT_LIABILITIES', 200_000, 'KRW'],
      ['TANGIBLE_ASSETS', 400_000, 'KRW'],
      ['CASH_AND_EQUIVALENTS', 50_000, 'KRW'],
      ['SHORT_TERM_INVESTMENTS', 30_000, 'KRW'],
      ['SHORT_TERM_BORROWINGS', 60_000, 'KRW'],
      ['CURRENT_LONG_TERM_DEBT', 10_000, 'KRW'],
      ['BONDS', 20_000, 'KRW'],
      ['LONG_TERM_BORROWINGS', 40_000, 'KRW'],
    ] as const) {
      rows.push({
        scope: 'SYMBOL', key: symbol, field, periodKey: '2025Q1',
        asOfTsMs: disclosureTsMs, value, unit,
      });
    }
    // 실제 SQLite 읽기에 late-asOf 자본변동을 넣어도 액션은 효력일로 노출한다.
    rows.push({
      scope: 'SYMBOL', key: symbol, field: CORPORATE_ACTION_FIELD,
      periodKey: '2025-03-14', asOfTsMs: START + 200 * DAY,
      value: 2, unit: 'RATIO',
    });
    return rows;
  }

  function scenarioCandles(): Candle[] {
    const rows: Candle[] = [];
    for (let index = 0; index <= 140; index += 1) {
      for (let symbolIndex = 0; symbolIndex < symbols.length; symbolIndex += 1) {
        const symbol = symbols[symbolIndex]!;
        const tsMs = START + index * DAY;
        const splitAdjustedTrend = 1 + Math.max(0, index - 71) * 0.002;
        const close = (index < 71 ? 100 : 50) * splitAdjustedTrend * (1 + symbolIndex * 0.1);
        rows.push({
          symbol, market: 'KR', timeframe: '1d', tsMs,
          open: close, high: close, low: close, close, volume: 1_000,
        });
      }
    }
    return rows;
  }

  it.each([
    ['value-quality-rank', valueQualityRankStrategy, { topN: 2, staleQuarters: 2 }],
    ['low-per-high-roe-rank', lowPerHighRoeRankStrategy, { topN: 2, staleQuarters: 2 }],
    ['earnings-acceleration-rank', earningsAccelerationRankStrategy, { topN: 2, priceMomentumDays: 60, staleQuarters: 2 }],
  ] as const)('%s 전체 runBacktest 결과가 eager 재무 입력과 같다', async (_id, strategy, parameters) => {
    const allFacts = symbols.flatMap((symbol, index) => strategyFacts(symbol, index + 1));
    await repository.saveFacts(allFacts);
    const storedFacts = repository.getFactsSync({ scope: 'SYMBOL', keys: symbols });
    const actionFacts = storedFacts.filter((row) => row.field === CORPORATE_ACTION_FIELD);
    const fundamentals = new BacktestFundamentalView(
      (query) => repository.getFactsSync(query),
      new Map(symbols.map((symbol) => [symbol, secondRebalanceTsMs])),
    );
    const members = symbols.map((symbol, index) => ({
      symbol,
      marketCapKrw: String(Math.floor(1_000_000_000_000 / (index + 1))),
      volume: null,
      tradingValueKrw: null,
    }));
    const input = {
      candles: scenarioCandles(),
      initialCash: 10_000_000,
      execution: ZERO_COST,
      parameters,
      randomSeed: 31,
      maxPositions: 2,
      tradeFromTsMs: firstRebalanceTsMs,
      universeSchedule: [
        { fromTsMs: firstRebalanceTsMs, members },
        { fromTsMs: secondRebalanceTsMs, members },
      ],
    };
    const eager = runBacktest(strategy, { ...input, facts: storedFacts });
    const lazy = runBacktest(strategy, {
      ...input,
      facts: actionFacts,
      fundamentals: (symbol, tsMs) => fundamentals.fundamentals(symbol, tsMs),
    });

    expect(lazy).toEqual(eager);
    expect(eager.processedBars).toBeGreaterThan(0);
    expect(eager.openPositions.length).toBeGreaterThan(0);
    expect(eager.fills.length).toBeGreaterThan(0);
    expect(eager.fills.every((fill) => fill.tsMs >= disclosureTsMs)).toBe(true);
    expect(storedFacts.some((row) => row.asOfTsMs === disclosureTsMs)).toBe(true);
    expect(actionFacts.every((row) => row.field === CORPORATE_ACTION_FIELD)).toBe(true);
    expect(actionFacts.some((row) => row.asOfTsMs > secondRebalanceTsMs && row.periodKey === '2025-03-14')).toBe(true);
  });
});
