import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { openDatabase, type DatabaseHandle } from '../../src/server/shared/db/database.js';
import { krxDailyBars } from '../../src/server/shared/db/schema.js';
import { CompositeCandleRepository } from '../../src/server/modules/market-data/infrastructure/composite-candle-repository.js';
import type { Candle, Market, Timeframe } from '../../src/server/modules/market-data/domain/candle.js';
import type { CandleQuery, CandleRepository } from '../../src/server/modules/market-data/application/ports.js';

/** 위임 대상 스텁 — 호출 여부·인자를 그대로 기록해 "위임했는지"를 검증한다 */
class StubCandleRepository implements CandleRepository {
  readonly getCandlesCalls: CandleQuery[] = [];
  readonly getTimestampsCalls: Array<{ market: Market; timeframe: Timeframe; symbol: string }> = [];
  readonly saveCandlesCalls: Array<readonly Candle[]> = [];
  readonly deleteSymbolCalls: Array<{ market: Market; symbol: string }> = [];

  constructor(
    private readonly candles: readonly Candle[] = [],
    private readonly timestamps: readonly number[] = [],
  ) {}

  async *getCandles(query: CandleQuery): AsyncIterable<Candle> {
    this.getCandlesCalls.push(query);
    for (const candle of this.candles) yield candle;
  }

  async getTimestamps(market: Market, timeframe: Timeframe, symbol: string): Promise<number[]> {
    this.getTimestampsCalls.push({ market, timeframe, symbol });
    return [...this.timestamps];
  }

  async saveCandles(candles: readonly Candle[]): Promise<void> {
    this.saveCandlesCalls.push([...candles]);
  }

  async deleteSymbol(market: Market, symbol: string): Promise<void> {
    this.deleteSymbolCalls.push({ market, symbol });
  }
}

async function collect(iterable: AsyncIterable<Candle>): Promise<Candle[]> {
  const out: Candle[] = [];
  for await (const candle of iterable) out.push(candle);
  return out;
}

function insertBar(
  handle: DatabaseHandle,
  overrides: Partial<typeof krxDailyBars.$inferInsert> = {},
): void {
  handle.db
    .insert(krxDailyBars)
    .values({
      shortCode: '005930',
      date: '2026-07-06',
      market: 'KOSPI',
      open: 100,
      high: 110,
      low: 90,
      close: 105,
      volume: 1000,
      ...overrides,
    })
    .run();
}

/** 2026-07-06 의 UTC 자정 — krxDailyBars.date → tsMs 변환의 기대값 (규약 3) */
const DAY1_TS_MS = Date.UTC(2026, 6, 6);
const DAY2_TS_MS = Date.UTC(2026, 6, 7);

const FALLBACK_CANDLE: Candle = {
  symbol: '005930',
  market: 'KR',
  timeframe: '1d',
  tsMs: 999,
  open: 1,
  high: 1,
  low: 1,
  close: 1,
  volume: 1,
};

describe('CompositeCandleRepository', () => {
  describe('getCandles', () => {
    it('1d 이고 범위 안에 KRX 행이 있으면 KRX 값을 쓴다', async () => {
      const handle = openDatabase(':memory:');
      insertBar(handle);
      const delegate = new StubCandleRepository([FALLBACK_CANDLE]);
      const repo = new CompositeCandleRepository(handle.db, delegate);

      const candles = await collect(
        repo.getCandles({ market: 'KR', timeframe: '1d', symbols: ['005930'] }),
      );

      expect(candles).toEqual([
        {
          symbol: '005930',
          market: 'KR',
          timeframe: '1d',
          tsMs: DAY1_TS_MS,
          open: 100,
          high: 110,
          low: 90,
          close: 105,
          volume: 1000,
        },
      ]);
      expect(delegate.getCandlesCalls).toHaveLength(0); // 섞지 않는다 — delegate 는 아예 안 불린다
      handle.close();
    });

    it('1d 이지만 KRX 행이 범위 밖이면 위임한다(섞지 않는다)', async () => {
      const handle = openDatabase(':memory:');
      insertBar(handle, { date: '2020-01-01' }); // 조회 범위 밖
      const delegate = new StubCandleRepository([FALLBACK_CANDLE]);
      const repo = new CompositeCandleRepository(handle.db, delegate);

      const candles = await collect(
        repo.getCandles({
          market: 'KR',
          timeframe: '1d',
          symbols: ['005930'],
          fromTsMs: Date.UTC(2026, 6, 1),
          toTsMs: Date.UTC(2026, 6, 31),
        }),
      );

      expect(candles).toEqual([FALLBACK_CANDLE]);
      expect(delegate.getCandlesCalls).toHaveLength(1);
      expect(delegate.getCandlesCalls[0]?.symbols).toEqual(['005930']);
      handle.close();
    });

    it('1d 이고 KRX 에 그 종목 행이 아예 없으면 위임한다', async () => {
      const handle = openDatabase(':memory:');
      const delegate = new StubCandleRepository([FALLBACK_CANDLE]);
      const repo = new CompositeCandleRepository(handle.db, delegate);

      const candles = await collect(
        repo.getCandles({ market: 'KR', timeframe: '1d', symbols: ['005930'] }),
      );

      expect(candles).toEqual([FALLBACK_CANDLE]);
      handle.close();
    });

    it('timeframe !== 1d 이면 KRX 행이 있어도 무조건 위임한다', async () => {
      const handle = openDatabase(':memory:');
      insertBar(handle);
      const delegate = new StubCandleRepository([FALLBACK_CANDLE]);
      const repo = new CompositeCandleRepository(handle.db, delegate);

      const candles = await collect(
        repo.getCandles({ market: 'KR', timeframe: '1m', symbols: ['005930'] }),
      );

      expect(candles).toEqual([FALLBACK_CANDLE]);
      expect(delegate.getCandlesCalls).toHaveLength(1);
      handle.close();
    });

    it('market 이 KR 이 아니면 1d 여도 위임한다 — KRX 테이블은 국내 종목만 갖는다', async () => {
      const handle = openDatabase(':memory:');
      insertBar(handle); // shortCode 가 우연히 같아도
      const delegate = new StubCandleRepository([FALLBACK_CANDLE]);
      const repo = new CompositeCandleRepository(handle.db, delegate);

      const candles = await collect(
        repo.getCandles({ market: 'US', timeframe: '1d', symbols: ['005930'] }),
      );

      expect(candles).toEqual([FALLBACK_CANDLE]);
      expect(delegate.getCandlesCalls).toHaveLength(1);
      handle.close();
    });

    it('여러 종목 중 KRX 가 있는 종목·없는 종목이 섞이면 각각 KRX·위임으로 갈린다', async () => {
      const handle = openDatabase(':memory:');
      insertBar(handle, { shortCode: '005930' });
      const otherFallback: Candle = { ...FALLBACK_CANDLE, symbol: '000660' };
      const delegate = new StubCandleRepository([otherFallback]);
      const repo = new CompositeCandleRepository(handle.db, delegate);

      const candles = await collect(
        repo.getCandles({ market: 'KR', timeframe: '1d', symbols: ['005930', '000660'] }),
      );

      expect(candles).toEqual([
        {
          symbol: '005930',
          market: 'KR',
          timeframe: '1d',
          tsMs: DAY1_TS_MS,
          open: 100,
          high: 110,
          low: 90,
          close: 105,
          volume: 1000,
        },
        otherFallback,
      ]);
      expect(delegate.getCandlesCalls).toHaveLength(1);
      expect(delegate.getCandlesCalls[0]?.symbols).toEqual(['000660']);
      handle.close();
    });
  });

  describe('getTimestamps', () => {
    it('1d 이고 KRX 행이 있으면 KRX 기준 tsMs 를 오름차순으로 준다', async () => {
      const handle = openDatabase(':memory:');
      insertBar(handle, { date: '2026-07-07' });
      insertBar(handle, { date: '2026-07-06' }); // 역순으로 넣어도 결과는 오름차순
      const delegate = new StubCandleRepository([], [123]);
      const repo = new CompositeCandleRepository(handle.db, delegate);

      const timestamps = await repo.getTimestamps('KR', '1d', '005930');

      expect(timestamps).toEqual([DAY1_TS_MS, DAY2_TS_MS]);
      expect(delegate.getTimestampsCalls).toHaveLength(0);
      handle.close();
    });

    it('1d 이고 KRX 행이 없으면 위임한다', async () => {
      const handle = openDatabase(':memory:');
      const delegate = new StubCandleRepository([], [111, 222]);
      const repo = new CompositeCandleRepository(handle.db, delegate);

      const timestamps = await repo.getTimestamps('KR', '1d', '005930');

      expect(timestamps).toEqual([111, 222]);
      expect(delegate.getTimestampsCalls).toEqual([
        { market: 'KR', timeframe: '1d', symbol: '005930' },
      ]);
      handle.close();
    });

    it('timeframe !== 1d 이면 KRX 행이 있어도 위임한다', async () => {
      const handle = openDatabase(':memory:');
      insertBar(handle);
      const delegate = new StubCandleRepository([], [42]);
      const repo = new CompositeCandleRepository(handle.db, delegate);

      const timestamps = await repo.getTimestamps('KR', '1m', '005930');

      expect(timestamps).toEqual([42]);
      handle.close();
    });

    it('market 이 KR 이 아니면 위임한다', async () => {
      const handle = openDatabase(':memory:');
      insertBar(handle);
      const delegate = new StubCandleRepository([], [42]);
      const repo = new CompositeCandleRepository(handle.db, delegate);

      const timestamps = await repo.getTimestamps('US', '1d', '005930');

      expect(timestamps).toEqual([42]);
      handle.close();
    });
  });

  it('saveCandles 는 항상 위임한다', async () => {
    const handle = openDatabase(':memory:');
    const delegate = new StubCandleRepository();
    const repo = new CompositeCandleRepository(handle.db, delegate);

    await repo.saveCandles([FALLBACK_CANDLE]);

    expect(delegate.saveCandlesCalls).toEqual([[FALLBACK_CANDLE]]);
    handle.close();
  });

  it('deleteSymbol 은 위임하고, KRX 일봉 행은 지우지 않는다', async () => {
    const handle = openDatabase(':memory:');
    insertBar(handle);
    const delegate = new StubCandleRepository();
    const repo = new CompositeCandleRepository(handle.db, delegate);

    await repo.deleteSymbol('KR', '005930');

    expect(delegate.deleteSymbolCalls).toEqual([{ market: 'KR', symbol: '005930' }]);
    const rows = handle.db.select().from(krxDailyBars).where(eq(krxDailyBars.shortCode, '005930')).all();
    expect(rows).toHaveLength(1); // 시장 공용 자산이라 종목 삭제로 지워지지 않는다
    handle.close();
  });
});
