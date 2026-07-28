import { describe, expect, it, vi } from 'vitest';
import { SymbolInfoService } from '../../src/server/modules/market-data/application/symbol-info-service.js';
import {
  MarketDataSourceNotConfiguredError,
  type StockInfo,
  type StockInfoSource,
} from '../../src/server/modules/market-data/application/ports.js';
import { createLogger } from '../../src/server/shared/logger.js';
import { loadConfig } from '../../src/server/bootstrap/config.js';

const logger = createLogger(loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'error' }));

const SAMSUNG: StockInfo = {
  symbol: '005930',
  name: '삼성전자',
  englishName: 'SamsungElec',
  market: 'KOSPI',
  status: 'ACTIVE',
};

function buildService(source: StockInfoSource, nowRef = { now: 0 }) {
  return new SymbolInfoService(source, { now: () => nowRef.now }, logger);
}

describe('SymbolInfoService (종목명 캐시)', () => {
  it('caches lookups so repeated queries hit the source once', async () => {
    const getStockInfo = vi.fn(async () => [SAMSUNG]);
    const service = buildService({ getStockInfo });

    expect(await service.lookup(['005930'])).toEqual([SAMSUNG]);
    expect(await service.lookup(['005930'])).toEqual([SAMSUNG]);
    expect(getStockInfo).toHaveBeenCalledTimes(1);
  });

  it('negative-caches unknown symbols instead of re-querying', async () => {
    const getStockInfo = vi.fn(async () => []);
    const service = buildService({ getStockInfo });

    expect(await service.lookup(['999999'])).toEqual([]);
    expect(await service.lookup(['999999'])).toEqual([]);
    expect(getStockInfo).toHaveBeenCalledTimes(1);
  });

  it('returns [] quietly when the source is not configured', async () => {
    const getStockInfo = vi.fn(() =>
      Promise.reject(new MarketDataSourceNotConfiguredError()),
    );
    const service = buildService({ getStockInfo });

    expect(await service.lookup(['005930'])).toEqual([]);
    // 미설정은 캐시하지 않는다 — 설정 후 재시도가 가능해야 한다
    expect(await service.lookup(['005930'])).toEqual([]);
    expect(getStockInfo).toHaveBeenCalledTimes(2);
  });

  it('rejects invalid symbols before touching the source', async () => {
    const getStockInfo = vi.fn(async () => []);
    const service = buildService({ getStockInfo });
    await expect(service.lookup(['bad symbol!'])).rejects.toThrow(/invalid/);
    expect(getStockInfo).not.toHaveBeenCalled();
  });
});
