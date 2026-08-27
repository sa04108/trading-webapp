import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { createTestApp } from '../helpers/test-app.js';
import { krxDailyBars } from '../../src/server/shared/db/schema.js';
import type { AppDatabase } from '../../src/server/shared/db/database.js';
import {
  KrxDailyCandleRepository,
  ceilToDate,
  floorToDate,
} from '../../src/server/modules/market-data/infrastructure/krx-daily-candle-repository.js';

const DAY = 86_400_000;
const midnight = (date: string): number => Date.parse(`${date}T00:00:00Z`);

describe('날짜 경계 변환', () => {
  it('하한이 정확히 자정이면 그 날을 포함한다', () => {
    expect(ceilToDate(midnight('2026-08-07'))).toBe('2026-08-07');
  });

  it('하한이 자정이 아니면 다음 날로 올린다', () => {
    expect(ceilToDate(midnight('2026-08-07') + 1)).toBe('2026-08-08');
    expect(ceilToDate(Date.parse('2026-08-07T05:00:00Z'))).toBe('2026-08-08');
  });

  it('상한은 그 시각이 속한 날로 내린다', () => {
    expect(floorToDate(Date.parse('2026-08-07T23:59:59.999Z'))).toBe('2026-08-07');
    expect(floorToDate(midnight('2026-08-07'))).toBe('2026-08-07');
  });
});

describe('KrxDailyCandleRepository', () => {
  let t: Awaited<ReturnType<typeof createTestApp>>;
  let db: AppDatabase;
  let repository: KrxDailyCandleRepository;

  beforeEach(async () => {
    t = await createTestApp();
    db = t.container.database.db;
    db.insert(krxDailyBars)
      .values([
        { shortCode: '005930', date: '2026-08-05', market: 'KOSPI', open: 100, high: 110, low: 90, close: 105, volume: 1000 },
        { shortCode: '005930', date: '2026-08-06', market: 'KOSPI', open: 105, high: 115, low: 95, close: 110, volume: 2000 },
        { shortCode: '005930', date: '2026-08-07', market: 'KOSPI', open: 110, high: 120, low: 100, close: 115, volume: 3000 },
        { shortCode: '000660', date: '2026-08-06', market: 'KOSPI', open: 200, high: 210, low: 190, close: 205, volume: 500 },
        { shortCode: 'INVALID', date: '2026-08-06', market: 'UNKNOWN', open: 100, high: 110, low: 90, close: 105, volume: 100 },
      ])
      .run();
    repository = new KrxDailyCandleRepository(db);
  });

  // 임시 디렉터리와 sqlite 핸들이 테스트마다 누적되지 않도록 앱을 닫는다.
  afterEach(async () => {
    await t.close();
  });

  const collect = async (query: Parameters<KrxDailyCandleRepository['getCandles']>[0]) => {
    const out = [];
    for await (const candle of repository.getCandles(query)) out.push(candle);
    return out;
  };

  it('요청 범위 안의 봉만 낸다', async () => {
    const candles = await collect({
      market: 'KR',
      timeframe: '1d',
      symbols: ['005930'],
      fromTsMs: midnight('2026-08-06'),
      toTsMs: Date.parse('2026-08-06T23:59:59.999Z'),
    });
    expect(candles).toHaveLength(1);
    expect(candles[0]?.tsMs).toBe(midnight('2026-08-06'));
    expect(candles[0]?.close).toBe(110);
    expect(candles[0]?.venue).toBe('KOSPI');
  });

  it('경계가 자정이 아니면 그 날을 제외한다', async () => {
    const candles = await collect({
      market: 'KR',
      timeframe: '1d',
      symbols: ['005930'],
      fromTsMs: midnight('2026-08-05') + 1,
      toTsMs: midnight('2026-08-07') + DAY,
    });
    expect(candles.map((candle) => candle.tsMs)).toEqual([
      midnight('2026-08-06'),
      midnight('2026-08-07'),
    ]);
  });

  it('경계를 주지 않으면 종목의 모든 봉을 낸다', async () => {
    const candles = await collect({ market: 'KR', timeframe: '1d', symbols: ['005930'] });
    expect(candles).toHaveLength(3);
  });

  it('여러 종목을 요청하면 종목별로 날짜 오름차순으로 낸다', async () => {
    const candles = await collect({
      market: 'KR',
      timeframe: '1d',
      symbols: ['005930', '000660'],
    });
    expect(candles).toHaveLength(4);
    expect(candles.map((candle) => candle.symbol)).toEqual([
      '005930', '005930', '005930', '000660',
    ]);
    const bySymbol = candles.filter((candle) => candle.symbol === '005930');
    expect(bySymbol.map((candle) => candle.tsMs)).toEqual([
      midnight('2026-08-05'),
      midnight('2026-08-06'),
      midnight('2026-08-07'),
    ]);
  });

  it('bulk 조회도 streaming과 같은 순서·날짜 경계·검증 결과를 낸다', async () => {
    const query = {
      market: 'KR' as const,
      timeframe: '1d' as const,
      symbols: ['005930', '000660'],
      fromTsMs: midnight('2026-08-06'),
      toTsMs: Date.parse('2026-08-07T23:59:59.999Z'),
    };

    const streamed = await collect(query);
    const bulk = await repository.getCandlesArray(query);

    expect(bulk).toEqual(streamed);
    expect(bulk.map((candle) => candle.symbol)).toEqual(['005930', '005930', '000660']);
  });

  it('다종목 조회는 SQLite bind 한도 단위로 배치한다', async () => {
    let selectCalls = 0;
    const fakeDb = {
      select: () => ({
        from: () => ({
          where: () => ({
            orderBy: () => ({
              all: () => {
                selectCalls += 1;
                return [];
              },
            }),
          }),
        }),
      }),
    };
    const batchRepository = new KrxDailyCandleRepository(fakeDb as never);
    const symbols = Array.from({ length: 501 }, (_, index) => String(index).padStart(6, '0'));
    for await (const _candle of batchRepository.getCandles({
      market: 'KR', timeframe: '1d', symbols,
    })) { /* 빈 fake 결과를 끝까지 소비해 조회를 실행한다. */ }

    expect(selectCalls).toBe(3);
  });

  it('첫 batch를 소비하는 동안 뒤 batch 결과를 미리 메모리에 올리지 않는다', async () => {
    let selectCalls = 0;
    const fakeDb = {
      select: () => ({
        from: () => ({
          where: () => ({
            orderBy: () => ({
              all: () => {
                selectCalls += 1;
                return selectCalls === 1 ? [{
                  shortCode: '000000',
                  date: '2026-08-06',
                  market: 'KOSPI',
                  open: 100,
                  high: 110,
                  low: 90,
                  close: 105,
                  volume: 1_000,
                }] : [];
              },
            }),
          }),
        }),
      }),
    };
    const batchRepository = new KrxDailyCandleRepository(fakeDb as never);
    const symbols = Array.from({ length: 501 }, (_, index) => String(index).padStart(6, '0'));
    const iterator = batchRepository.getCandles({
      market: 'KR', timeframe: '1d', symbols,
    })[Symbol.asyncIterator]();

    const first = await iterator.next();

    expect(first.value?.symbol).toBe('000000');
    expect(selectCalls).toBe(1);
  });

  it('KR 이 아닌 시장은 빈 결과를 낸다', async () => {
    const candles = await collect({ market: 'US', timeframe: '1d', symbols: ['005930'] });
    expect(candles).toHaveLength(0);
  });

  it('알 수 없는 실제 거래시장의 봉은 내보내지 않는다', async () => {
    const candles = await collect({ market: 'KR', timeframe: '1d', symbols: ['INVALID'] });
    expect(candles).toHaveLength(0);
  });

  it('getTimestamps 는 저장된 봉의 시각을 오름차순으로 준다', async () => {
    const timestamps = await repository.getTimestamps('KR', '1d', '005930');
    expect(timestamps).toEqual([
      midnight('2026-08-05'),
      midnight('2026-08-06'),
      midnight('2026-08-07'),
    ]);
  });

  it('거래불가 형태로 잘못 남은 행은 봉과 시각에서 모두 제외한다', async () => {
    db.insert(krxDailyBars)
      .values({
        shortCode: '005930',
        date: '2026-08-08',
        market: 'KOSPI',
        open: 0,
        high: 0,
        low: 0,
        close: 115,
        volume: 0,
      })
      .run();

    const candles = await collect({ market: 'KR', timeframe: '1d', symbols: ['005930'] });
    const timestamps = await repository.getTimestamps('KR', '1d', '005930');

    expect(candles.map((candle) => candle.tsMs)).toEqual([
      midnight('2026-08-05'),
      midnight('2026-08-06'),
      midnight('2026-08-07'),
    ]);
    expect(timestamps).toEqual([
      midnight('2026-08-05'),
      midnight('2026-08-06'),
      midnight('2026-08-07'),
    ]);
  });
});
