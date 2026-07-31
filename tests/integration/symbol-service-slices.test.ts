import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { symbolCoverage } from '../../src/server/shared/db/schema.js';
import { createTestApp, type TestApp } from '../helpers/test-app.js';
import { registerSymbols } from '../helpers/seed.js';

const DAY = 86_400_000;

function buildDailyCsv(rows: number, startTsMs: number): string {
  const lines = ['timestamp,open,high,low,close,volume'];
  for (let i = 0; i < rows; i += 1) {
    lines.push(`${startTsMs + i * DAY},100,110,90,105,1000`);
  }
  return lines.join('\n');
}

/**
 * 봉 상태는 종목에 매달린다 (설계 2026-07-31-symbol-as-first-class).
 * 구 `dataset-service-slices.test.ts` 가 데이터셋 슬라이스로 검증했던 것을 종목 축으로 옮겼다.
 */
describe('SymbolService — 슬라이스와 참조', () => {
  let ctx: TestApp;

  beforeEach(async () => {
    ctx = await createTestApp();
  });
  afterEach(async () => {
    await ctx.close();
  });

  it('등록 직후 두 슬라이스 모두 hasData=false 다', () => {
    registerSymbols(ctx.container, 'KR', ['005930']);
    const symbol = ctx.container.symbolService.getSymbol('005930')!;
    expect(symbol.slices.map((slice) => ({ slice: slice.slice, hasData: slice.hasData }))).toEqual([
      { slice: '1d', hasData: false },
      { slice: '1m', hasData: false },
    ]);
  });

  it('1d CSV 는 일봉 슬라이스만 채우고 coverage 를 그 슬라이스에 기록한다', async () => {
    const job = await ctx.container.symbolService.importCsv({
      market: 'KR',
      timeframe: '1d',
      symbol: '005930',
      fileName: 'daily.csv',
      csvContent: buildDailyCsv(10, Date.UTC(2026, 0, 5)),
    });
    expect(job.status).toBe('COMPLETED');

    const rows = ctx.container.database.db
      .select()
      .from(symbolCoverage)
      .where(eq(symbolCoverage.code, '005930'))
      .all();
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.slice === '1d')).toBe(true);
    expect(rows.every((row) => row.barCount === 10)).toBe(true);

    const symbol = ctx.container.symbolService.getSymbol('005930')!;
    expect(symbol.slices.find((slice) => slice.slice === '1d')?.hasData).toBe(true);
    expect(symbol.slices.find((slice) => slice.slice === '1m')?.hasData).toBe(false);
  });

  it('CSV 는 등록되지 않은 종목도 함께 등록한다', async () => {
    expect(ctx.container.symbolService.exists('000660')).toBe(false);
    await ctx.container.symbolService.importCsv({
      market: 'KR',
      timeframe: '1d',
      symbol: '000660',
      fileName: 'daily.csv',
      csvContent: buildDailyCsv(5, Date.UTC(2026, 0, 5)),
    });
    expect(ctx.container.symbolService.exists('000660')).toBe(true);
  });

  it('데이터셋은 구성이 같아도 여러 개 만들 수 있다 — 데이터가 종목에 있어 중복 비용이 없다', () => {
    registerSymbols(ctx.container, 'KR', ['005930', '000660']);
    const a = ctx.container.datasetService.createDataset('a', ['005930', '000660']);
    const b = ctx.container.datasetService.createDataset('b', ['000660', '005930']);
    expect(a.symbols).toEqual(b.symbols);
  });

  it('등록되지 않은 종목을 참조하는 데이터셋 생성은 거부한다', () => {
    expect(() => ctx.container.datasetService.createDataset('x', ['999999'])).toThrow(
      /등록되지 않은/,
    );
  });
});
