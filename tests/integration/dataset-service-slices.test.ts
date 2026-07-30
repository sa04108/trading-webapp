import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { dataCoverage } from '../../src/server/shared/db/schema.js';
import { createTestApp, type TestApp } from '../helpers/test-app.js';

const DAY = 86_400_000;

/**
 * 일봉 CSV 문자열 빌더 — market-data.test.ts 의 buildCsv 관례(헤더 + OHLCV 행)를
 * 1일 간격 타임스탬프로 옮긴 것.
 */
function buildDailyCsv(rows: number, startTsMs: number): string {
  const lines = ['timestamp,open,high,low,close,volume'];
  for (let i = 0; i < rows; i += 1) {
    lines.push(`${startTsMs + i * DAY},100,110,90,105,1000`);
  }
  return lines.join('\n');
}

describe('DatasetService — 슬라이스와 종목 구성 유일성 (설계 2026-07-30-dataset-symbol-group)', () => {
  let ctx: TestApp;

  beforeEach(async () => {
    ctx = await createTestApp();
  });

  afterEach(async () => {
    await ctx.close();
  });

  describe('종목 구성 유일성', () => {
    it('같은 구성(순서 무관)의 데이터셋 생성을 거부한다', () => {
      const service = ctx.container.datasetService;
      service.createBrokerDataset('a', 'KR', '1d', ['005930', '000660']);

      expect(() =>
        service.createBrokerDataset('b', 'KR', '1m', ['000660', '005930']),
      ).toThrow('같은 종목 구성의 데이터셋이 이미 있습니다: a');
    });

    it('종목 편집으로 다른 데이터셋과 구성이 같아지면 거부한다', () => {
      const service = ctx.container.datasetService;
      service.createBrokerDataset('c', 'KR', '1d', ['005930']);
      const d = service.createBrokerDataset('d', 'KR', '1d', ['005930', '035420']);

      expect(() => service.updateSymbols(d.id, { remove: ['035420'] })).toThrow(
        '같은 종목 구성의 데이터셋이 이미 있습니다: c',
      );
    });
  });

  describe('슬라이스 요약', () => {
    it('생성 직후 두 슬라이스 모두 hasData=false, defaultTimeframe 은 수집 봉이다', () => {
      const service = ctx.container.datasetService;
      const ds = service.createBrokerDataset('e', 'KR', '1m', ['005930']);

      expect(ds.defaultTimeframe).toBe('1m');
      expect(ds.slices).toEqual([
        { slice: '1d', hasData: false },
        { slice: '1m', hasData: false },
      ]);
    });
  });

  describe('CSV 가져오기 슬라이스', () => {
    it('1d CSV 는 일봉 슬라이스를 채우고 coverage 도 1d 슬라이스에 기록된다', async () => {
      const service = ctx.container.datasetService;
      const start = Date.UTC(2026, 0, 5); // 2026-01-05 (월)

      const job = await service.importCsv({
        datasetName: 'daily-slice',
        market: 'KR',
        timeframe: '1d',
        symbol: '005930',
        fileName: 'daily.csv',
        csvContent: buildDailyCsv(10, start),
      });
      expect(job.status).toBe('COMPLETED');

      const dataset = service.listDatasets().find((d) => d.name === 'daily-slice')!;
      expect(dataset.defaultTimeframe).toBe('1d');

      // coverage 행 slice === '1d'
      const coverageRows = ctx.container.database.db
        .select()
        .from(dataCoverage)
        .where(eq(dataCoverage.datasetId, dataset.id))
        .all();
      expect(coverageRows.length).toBeGreaterThan(0);
      expect(coverageRows.every((row) => row.slice === '1d')).toBe(true);
      expect(coverageRows.every((row) => row.barCount === 10)).toBe(true);

      // summary.slices 의 1d.hasData === true
      expect(dataset.slices).toEqual([
        { slice: '1d', hasData: true },
        { slice: '1m', hasData: false },
      ]);
    });
  });
});
