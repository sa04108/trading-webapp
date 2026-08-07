import { describe, expect, it, afterEach, beforeEach } from 'vitest';
import { createTestApp } from '../helpers/test-app.js';
import { krxDailyBars } from '../../src/server/shared/db/schema.js';
import { CandleCoverageService } from '../../src/server/modules/market-data/application/candle-coverage-service.js';

const midnight = (date: string): number => Date.parse(`${date}T00:00:00Z`);

describe('CandleCoverageService', () => {
  let app: Awaited<ReturnType<typeof createTestApp>>;
  let service: CandleCoverageService;

  // createTestApp 은 임시 디렉터리와 sqlite 핸들을 잡는다 — 닫지 않으면 테스트마다 샌다
  afterEach(async () => {
    await app.close();
  });

  beforeEach(async () => {
    app = await createTestApp();
    const db = app.container.database.db;
    db.insert(krxDailyBars)
      .values([
        { shortCode: '005930', date: '2026-08-05', market: 'KOSPI', open: 100, high: 110, low: 90, close: 105, volume: 1000 },
        { shortCode: '005930', date: '2026-08-07', market: 'KOSPI', open: 110, high: 120, low: 100, close: 115, volume: 3000 },
      ])
      .run();
    service = new CandleCoverageService(db);
  });

  it('보유 구간과 봉 수를 준다', () => {
    expect(service.getCoverage(['005930'])).toEqual([
      {
        code: '005930',
        firstTsMs: midnight('2026-08-05'),
        lastTsMs: midnight('2026-08-07'),
        barCount: 2,
      },
    ]);
  });

  it('봉이 없는 종목은 barCount 0 으로 준다 — 목록에서 빠지지 않는다', () => {
    expect(service.getCoverage(['000660'])).toEqual([
      { code: '000660', firstTsMs: null, lastTsMs: null, barCount: 0 },
    ]);
  });

  it('빈 코드 목록에는 빈 배열을 준다', () => {
    expect(service.getCoverage([])).toEqual([]);
  });
});
