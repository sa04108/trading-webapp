import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Fact } from '../../src/server/modules/facts/domain/fact.js';
import { datasetSymbols } from '../../src/server/shared/db/schema.js';
import { createTestAdmin, createTestApp, type TestApp } from '../helpers/test-app.js';
import { registerSymbols, seedDataset } from '../helpers/seed.js';

const DAY = 86_400_000;

function buildDailyCsv(rows: number, startTsMs: number): string {
  const lines = ['timestamp,open,high,low,close,volume'];
  for (let i = 0; i < rows; i += 1) {
    lines.push(`${startTsMs + i * DAY},100,110,90,105,1000`);
  }
  return lines.join('\n');
}

function factFor(code: string, asOfTsMs: number): Fact {
  return {
    scope: 'SYMBOL',
    key: code,
    field: 'EBIT',
    periodKey: '2025Q1',
    value: 1_000,
    asOfTsMs,
    unit: 'KRW',
    source: 'DART',
  } as Fact;
}

/**
 * 종목 화면이 읽는 계약 (설계 2026-07-31-symbol-as-first-class).
 * 슬라이스별 봉 보유·슬라이스별 마지막 수집·재무 보유·참조 데이터셋 수가 한 응답에 있어야
 * 200종목에서 행마다 조회를 내지 않는다.
 */
describe('GET /symbols 가 종목 화면에 필요한 것을 한 번에 준다', () => {
  let ctx: TestApp;

  beforeEach(async () => {
    ctx = await createTestApp();
  });
  afterEach(async () => {
    await ctx.close();
  });

  async function loginCookie(): Promise<string> {
    const { username, password } = await createTestAdmin(ctx.container);
    const login = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username, password },
    });
    return login.cookies.find((c) => c.name === 'qp_session')!.value;
  }

  async function listSymbols(cookie: string) {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/symbols',
      cookies: { qp_session: cookie },
    });
    return res.json().symbols as Array<{
      code: string;
      market: string;
      name: string | null;
      hasFacts: boolean;
      datasetCount: number;
      slices: Array<{
        slice: string;
        hasData: boolean;
        barCount: number;
        lastSyncedAtMs: number | null;
      }>;
    }>;
  }

  it('수집 전에는 두 슬라이스 모두 비어 있고 수집 시각도 없다', async () => {
    const cookie = await loginCookie();
    registerSymbols(ctx.container, 'KR', ['005930']);

    const [symbol] = await listSymbols(cookie);
    expect(symbol?.code).toBe('005930');
    expect(symbol?.slices.map((s) => s.hasData)).toEqual([false, false]);
    expect(symbol?.slices.every((s) => s.lastSyncedAtMs === null)).toBe(true);
    expect(symbol?.hasFacts).toBe(false);
  });

  it('CSV 가져오기가 그 슬라이스만 채우고 수집 시각을 남긴다 — 다른 슬라이스는 비어 있다', async () => {
    const cookie = await loginCookie();
    const job = await ctx.container.symbolService.importCsv({
      market: 'KR',
      timeframe: '1d',
      symbol: '005930',
      fileName: 'daily.csv',
      csvContent: buildDailyCsv(10, Date.UTC(2026, 0, 5)),
    });
    expect(job.status).toBe('COMPLETED');

    const [symbol] = await listSymbols(cookie);
    const daily = symbol!.slices.find((s) => s.slice === '1d')!;
    const minute = symbol!.slices.find((s) => s.slice === '1m')!;
    expect(daily.hasData).toBe(true);
    expect(daily.barCount).toBe(10); // 커버리지 봉 수도 목록 응답에 실린다 (별도 조회 없음)
    expect(daily.lastSyncedAtMs).not.toBeNull();
    // 「봉 있음」 하나로 접으면 이 사실이 숨는다 — 슬라이스별로 답해야 한다
    expect(minute.hasData).toBe(false);
    expect(minute.lastSyncedAtMs).toBeNull();
  });

  it('재무는 있고 없음만 답한다 — 저장하면 true 로 바뀐다', async () => {
    const cookie = await loginCookie();
    registerSymbols(ctx.container, 'KR', ['005930']);
    expect((await listSymbols(cookie))[0]?.hasFacts).toBe(false);

    await ctx.container.factRepository.saveFacts([factFor('005930', Date.UTC(2025, 4, 15))]);

    expect((await listSymbols(cookie))[0]?.hasFacts).toBe(true);
  });

  it('재무 보유는 종목별이다 — 한 종목만 받아도 다른 종목은 false 다', async () => {
    const cookie = await loginCookie();
    registerSymbols(ctx.container, 'KR', ['005930', '000660']);
    await ctx.container.factRepository.saveFacts([factFor('005930', Date.UTC(2025, 4, 15))]);

    const symbols = await listSymbols(cookie);
    expect(symbols.find((s) => s.code === '005930')?.hasFacts).toBe(true);
    expect(symbols.find((s) => s.code === '000660')?.hasFacts).toBe(false);
  });

  it('참조 데이터셋 수를 센다 — 제거를 안전하게 만드는 값이다', async () => {
    const cookie = await loginCookie();
    seedDataset(ctx.container, 'a', 'KR', ['005930']);
    seedDataset(ctx.container, 'b', 'KR', ['005930', '000660']);

    const symbols = await listSymbols(cookie);
    expect(symbols.find((s) => s.code === '005930')?.datasetCount).toBe(2);
    expect(symbols.find((s) => s.code === '000660')?.datasetCount).toBe(1);
  });
});

describe('종목 제거 영향 판정', () => {
  let ctx: TestApp;
  beforeEach(async () => {
    ctx = await createTestApp();
  });
  afterEach(async () => {
    await ctx.close();
  });

  it('데이터셋을 비게 만드는 제거는 거부한다', async () => {
    seedDataset(ctx.container, 'solo', 'KR', ['005930']);
    await expect(ctx.container.symbolService.removeSymbols(['005930'])).rejects.toThrow(/비게/);
  });

  it('선택 집합 전체를 함께 본다 — 2종목을 둘 다 고르면 "각각 1개 남는다" 로 통과시키지 않는다', () => {
    seedDataset(ctx.container, 'pair', 'KR', ['005930', '000660']);
    const impacts = ctx.container.symbolService.removalImpact(['005930', '000660']);
    expect(impacts.every((impact) => impact.wouldEmpty.length === 1)).toBe(true);
  });

  it('남는 종목이 있으면 제거하고 참조만 끊는다', async () => {
    seedDataset(ctx.container, 'pair', 'KR', ['005930', '000660']);
    await ctx.container.symbolService.removeSymbols(['000660']);
    expect(ctx.container.symbolService.getSymbol('000660')).toBeNull();
    const remaining = ctx.container.database.db
      .select({ code: datasetSymbols.code })
      .from(datasetSymbols)
      .all()
      .map((row) => row.code);
    expect(remaining).toEqual(['005930']);
  });
});
