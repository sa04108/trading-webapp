import { describe, expect, it, vi } from 'vitest';
import {
  SymbolInfoService,
  type LocalSymbolNameSource,
} from '../../src/server/modules/market-data/application/symbol-info-service.js';
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
  sharesOutstanding: 5_919_637_922,
};

function buildService(source: StockInfoSource, nowRef = { now: 0 }) {
  return new SymbolInfoService(source, { now: () => nowRef.now }, logger);
}

/** 코드 → {name, market} 고정 맵으로 답하는 폴백 — 로컬 종목 마스터를 흉내낸다 */
function fakeLocalNames(
  entries: Record<string, { name: string; market: string }>,
): LocalSymbolNameSource {
  return {
    getLocalNames: (codes) =>
      new Map(codes.filter((code) => code in entries).map((code) => [code, entries[code]!])),
  };
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

  // 원인 3: 조회 중 예외가 나도 "이번 호출" 전체를 버리지 않는다 — 이미 캐시된 이름은
  // 그대로 살아남아야 한다.
  it('예외가 나도 이미 캐시된 이름은 그대로 반환한다 (부분 성공)', async () => {
    const getStockInfo = vi
      .fn()
      .mockResolvedValueOnce([SAMSUNG])
      .mockRejectedValueOnce(new Error('boom'));
    const service = buildService({ getStockInfo });

    expect(await service.lookup(['005930'])).toEqual([SAMSUNG]);
    // 두 번째 호출: 005930 은 캐시 히트, 000660 은 미스이며 그 조회가 실패한다
    expect(await service.lookup(['005930', '000660'])).toEqual([SAMSUNG]);
    expect(getStockInfo).toHaveBeenCalledTimes(2);
    expect(getStockInfo).toHaveBeenLastCalledWith(['000660']);
  });

  describe('로컬 종목 마스터 폴백 (원인 1)', () => {
    it('증권사가 모르는 코드를 로컬 이름으로 채운다', async () => {
      const getStockInfo = vi.fn(async () => []);
      const localNames = fakeLocalNames({ '999999': { name: '로컬종목', market: 'KOSDAQ' } });
      const service = new SymbolInfoService(
        { getStockInfo },
        { now: () => 0 },
        logger,
        localNames,
      );

      expect(await service.lookup(['999999'])).toEqual([
        {
          symbol: '999999',
          name: '로컬종목',
          englishName: null,
          market: 'KOSDAQ',
          status: '',
          sharesOutstanding: null,
        },
      ]);
    });

    it('증권사가 아는 이름이 로컬 폴백보다 우선한다', async () => {
      const getStockInfo = vi.fn(async () => [SAMSUNG]);
      const localNames = fakeLocalNames({ '005930': { name: '다른이름', market: 'KOSDAQ' } });
      const service = new SymbolInfoService(
        { getStockInfo },
        { now: () => 0 },
        logger,
        localNames,
      );

      expect(await service.lookup(['005930'])).toEqual([SAMSUNG]);
    });

    it('증권사 미설정 상태에서도 로컬 폴백은 그대로 동작한다', async () => {
      const getStockInfo = vi.fn(() => Promise.reject(new MarketDataSourceNotConfiguredError()));
      const localNames = fakeLocalNames({ '005930': { name: '로컬이름', market: 'KOSPI' } });
      const service = new SymbolInfoService(
        { getStockInfo },
        { now: () => 0 },
        logger,
        localNames,
      );

      expect(await service.lookup(['005930'])).toEqual([
        {
          symbol: '005930',
          name: '로컬이름',
          englishName: null,
          market: 'KOSPI',
          status: '',
          sharesOutstanding: null,
        },
      ]);
    });
  });
});
