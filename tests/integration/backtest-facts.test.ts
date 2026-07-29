import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runBacktest } from '../../src/server/modules/backtest/domain/engine.js';
import type { ExecutionProfile } from '../../src/server/modules/backtest/domain/types.js';
import type { Fact } from '../../src/server/modules/facts/domain/fact.js';
import { ParquetFactRepository } from '../../src/server/modules/facts/infrastructure/parquet-fact-repository.js';
import { DuckDbService } from '../../src/server/modules/market-data/infrastructure/duckdb-service.js';
import type { Candle } from '../../src/server/modules/market-data/domain/candle.js';
import { StrategyRegistry } from '../../src/server/modules/strategy/application/strategy-registry.js';
import { valueQualityRankStrategy } from '../../src/server/modules/strategy/strategies/value-quality-rank.js';

const DAY = 86_400_000;
const START = Date.UTC(2025, 0, 2);

const ZERO_COST: ExecutionProfile = {
  cost: { id: 'zero', version: '1', buyCommissionRate: 0, sellCommissionRate: 0, sellTaxRate: 0 },
  slippage: { id: 'zero', version: '1', bps: 0, fixed: 0 },
  rules: { tickSize: 0, minOrderQty: 1 },
};

let dataRoot: string;
let duckdb: DuckDbService;
let repository: ParquetFactRepository;

beforeEach(() => {
  dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-facts-'));
  duckdb = new DuckDbService({ threads: 1, memoryLimit: '256MB' });
  repository = new ParquetFactRepository(dataRoot, duckdb);
});

afterEach(() => {
  duckdb.close();
  fs.rmSync(dataRoot, { recursive: true, force: true });
});

describe('StrategyRegistry.requiresFundamentals', () => {
  it('밸류 전략은 재무를 요구한다', () => {
    expect(new StrategyRegistry().requiresFundamentals('value-quality-rank')).toBe(true);
  });

  it('봉만 쓰는 전략은 요구하지 않는다', () => {
    const registry = new StrategyRegistry();
    expect(registry.requiresFundamentals('hourly-breakout')).toBe(false);
    expect(registry.requiresFundamentals('cross-sectional-momentum')).toBe(false);
  });

  it('모르는 전략은 false — 여기서 예외를 던지면 제출 검증 순서가 뒤바뀐다', () => {
    expect(new StrategyRegistry().requiresFundamentals('nope')).toBe(false);
  });
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
    await repository.saveFacts('ds-1', [
      ...factsFor('CHEAP', 50_000),
      ...factsFor('RICH', 5_000),
    ]);

    const facts = await repository.getFacts({
      datasetId: 'ds-1',
      scope: 'SYMBOL',
      keys: ['CHEAP', 'RICH'],
      asOfMaxTsMs: START + 40 * DAY,
    });
    expect(facts.length).toBeGreaterThan(0);

    const result = runBacktest(valueQualityRankStrategy, {
      candles: candles(40),
      initialCash: 10_000_000,
      execution: ZERO_COST,
      parameters: { topN: 1, rebalanceMonths: 3, staleQuarters: 2 },
      randomSeed: 1,
      maxPositions: 1,
      facts,
    });

    const buys = result.fills.filter((fill) => fill.side === 'BUY');
    expect(buys.map((fill) => fill.symbol)).toEqual(['CHEAP']);
  });

  it('asOfMaxTsMs 가 기간 종료 시각이면 그 이후 공시는 로드되지 않는다', async () => {
    await repository.saveFacts('ds-1', factsFor('CHEAP', 50_000));
    const facts = await repository.getFacts({
      datasetId: 'ds-1',
      scope: 'SYMBOL',
      asOfMaxTsMs: START + 2 * DAY, // 공시(5봉)보다 이르다
    });
    expect(facts).toEqual([]);
  });
});
