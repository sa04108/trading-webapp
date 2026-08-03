import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { symbolCoverage } from '../../src/server/shared/db/schema.js';
import { createTestAdmin, createTestApp, type TestApp } from '../helpers/test-app.js';
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

/**
 * 참조 편집 — 데이터 화면의 「종목 편집」 다이얼로그가 쓰는 경로 (`PATCH /datasets/:id`).
 * 추가와 제거를 한 번에 보내는 이유를 여기서 지킨다: 두 번으로 나누면 중간 상태가
 * 검증에 걸려 앞의 절반만 적용된다.
 */
describe('PATCH /datasets/:datasetId — 참조 종목 편집', () => {
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
    registerSymbols(ctx.container, 'KR', ['005930', '000660', '035420']);
    datasetId = ctx.container.datasetService.createDataset('kr-core', ['005930']).id;
  });
  afterEach(async () => {
    await ctx.close();
  });

  const patch = (payload: Record<string, unknown>) =>
    ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/datasets/${datasetId}`,
      cookies: { qp_session: cookie },
      payload,
    });

  it('추가와 제거를 한 요청으로 함께 적용한다 — 교체가 중간에 0종목을 거치지 않는다', async () => {
    const res = await patch({ addSymbols: ['000660'], removeSymbols: ['005930'] });

    expect(res.statusCode).toBe(200);
    expect(res.json().dataset.symbols).toEqual(['000660']);
  });

  it('참조를 끊어도 그 종목과 봉은 남는다 — 데이터는 종목 소관이다', async () => {
    await ctx.container.symbolService.importCsv({
      market: 'KR',
      timeframe: '1d',
      symbol: '005930',
      fileName: 'daily.csv',
      csvContent: buildDailyCsv(10, Date.UTC(2026, 0, 5)),
    });
    await patch({ addSymbols: ['000660'], removeSymbols: ['005930'] });

    const symbol = ctx.container.symbolService.getSymbol('005930');
    expect(symbol).not.toBeNull();
    expect(symbol!.slices.find((slice) => slice.slice === '1d')?.hasData).toBe(true);
    // 참조만 끊겼으므로 「데이터셋 N곳」 은 줄어든다
    expect(symbol!.datasetCount).toBe(0);
  });

  it('종목을 0개로 만드는 편집은 400 — 다이얼로그가 저장을 잠그는 근거다', async () => {
    const res = await patch({ removeSymbols: ['005930'] });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/최소 1개/);
  });

  it('등록되지 않은 종목 참조는 400 — 데이터셋이 종목을 만들어내지 않는다', async () => {
    const res = await patch({ addSymbols: ['999999'] });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/등록되지 않은/);
  });

  it('이름과 참조를 한 번에 바꾼다 — 다이얼로그와 이름 편집이 같은 라우트를 쓴다', async () => {
    const res = await patch({ name: 'kr-tech', addSymbols: ['035420'] });
    expect(res.statusCode).toBe(200);
    expect(res.json().dataset.name).toBe('kr-tech');
    expect(res.json().dataset.symbols).toEqual(['005930', '035420']);
  });

  it('바꿀 내용이 없는 요청은 400 — 빈 PATCH 를 성공으로 위장하지 않는다', async () => {
    expect((await patch({})).statusCode).toBe(400);
  });
});
