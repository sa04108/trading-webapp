import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Candle } from '../../src/server/modules/market-data/domain/candle.js';
import { createTestAdmin, createTestApp, type TestApp } from '../helpers/test-app.js';

const MONDAY_0900_KST_UTC = Date.UTC(2026, 6, 6, 0, 0);

function minuteCandle(offsetMinutes: number): Candle {
  return {
    symbol: '005930',
    market: 'KR',
    timeframe: '1m',
    tsMs: MONDAY_0900_KST_UTC + offsetMinutes * 60_000,
    open: 100,
    high: 110,
    low: 90,
    close: 105,
    volume: 10,
  };
}

function buildCsv(rows: number): string {
  const lines = ['timestamp,open,high,low,close,volume'];
  for (let i = 0; i < rows; i += 1) {
    lines.push(`${MONDAY_0900_KST_UTC + i * 60_000},100,110,90,105,10`);
  }
  return lines.join('\n');
}

function multipartBody(fields: Record<string, string>, fileName: string, fileContent: string) {
  const boundary = '----vitestboundary';
  const parts: string[] = [];
  for (const [name, value] of Object.entries(fields)) {
    parts.push(`--${boundary}`, `Content-Disposition: form-data; name="${name}"`, '', value);
  }
  parts.push(
    `--${boundary}`,
    `Content-Disposition: form-data; name="file"; filename="${fileName}"`,
    'Content-Type: text/csv',
    '',
    fileContent,
    `--${boundary}--`,
    '',
  );
  return {
    payload: parts.join('\r\n'),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

describe('market data (스펙 §11, §13)', () => {
  let ctx: TestApp;

  beforeEach(async () => {
    ctx = await createTestApp();
  });

  afterEach(async () => {
    await ctx.close();
  });

  it('roundtrips candles through parquet and is idempotent on re-import', async () => {
    const repo = ctx.container.candleRepository;
    const candles = Array.from({ length: 120 }, (_, i) => minuteCandle(i));

    await repo.saveCandles(candles);
    await repo.saveCandles(candles); // 중복 수집 — idempotent (스펙 §11)

    const timestamps = await repo.getTimestamps('KR', '1m', '005930');
    expect(timestamps).toHaveLength(120);
    expect(timestamps[0]).toBe(MONDAY_0900_KST_UTC);

    const loaded: Candle[] = [];
    for await (const candle of repo.getCandles({
      market: 'KR',
      timeframe: '1m',
      symbols: ['005930'],
      fromTsMs: MONDAY_0900_KST_UTC + 60_000,
      toTsMs: MONDAY_0900_KST_UTC + 5 * 60_000,
    })) {
      loaded.push(candle);
    }
    expect(loaded).toHaveLength(5);
    expect(loaded[0]!.tsMs).toBe(MONDAY_0900_KST_UTC + 60_000);
    expect(loaded[0]!.close).toBe(105);
  });

  it('imports CSV via API, aggregates to hourly, and reports coverage', async () => {
    const { username, password } = await createTestAdmin(ctx.container);
    const login = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username, password },
    });
    const cookie = login.cookies.find((c) => c.name === 'qp_session')!.value;

    const { payload, contentType } = multipartBody(
      { datasetName: 'kr-hourly-v1', market: 'KR', timeframe: '1m', symbol: '005930' },
      'candles.csv',
      buildCsv(390), // 하루 전체 세션
    );

    const imported = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/datasets/import',
      headers: { 'content-type': contentType },
      cookies: { qp_session: cookie },
      payload,
    });
    expect(imported.statusCode).toBe(201);
    const job = imported.json().job as { id: string; status: string; rowsImported: number };
    expect(job.status).toBe('COMPLETED');
    expect(job.rowsImported).toBe(390);

    // 데이터셋 목록
    const list = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/datasets',
      cookies: { qp_session: cookie },
    });
    const datasets = list.json().datasets as Array<{ id: string; name: string; timeframe: string }>;
    expect(datasets).toHaveLength(1);
    expect(datasets[0]!.name).toBe('kr-hourly-v1');
    expect(datasets[0]!.timeframe).toBe('1h');

    // 1h 사전 집계 확인 (스펙 §11: 백테스트는 1시간봉 우선)
    const hourlyTs = await ctx.container.candleRepository.getTimestamps('KR', '1h', '005930');
    expect(hourlyTs).toHaveLength(7);

    // coverage
    const coverage = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/datasets/${datasets[0]!.id}/coverage`,
      cookies: { qp_session: cookie },
    });
    const body = coverage.json() as {
      coverage: Array<{ symbol: string; barCount: number; expectedBarCount: number }>;
    };
    expect(body.coverage[0]!.symbol).toBe('005930');
    expect(body.coverage[0]!.barCount).toBe(7);
    expect(body.coverage[0]!.expectedBarCount).toBe(7);

    // data job 조회
    const jobLookup = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/data-jobs/${job.id}`,
      cookies: { qp_session: cookie },
    });
    expect(jobLookup.statusCode).toBe(200);
  });

  it('rejects US imports until a US session is defined (Codex 리뷰)', async () => {
    const { username, password } = await createTestAdmin(ctx.container);
    const login = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username, password },
    });
    const cookie = login.cookies.find((c) => c.name === 'qp_session')!.value;

    const { payload, contentType } = multipartBody(
      { datasetName: 'us-set', market: 'US', timeframe: '1m', symbol: 'AAPL' },
      'us.csv',
      buildCsv(60),
    );
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/datasets/import',
      headers: { 'content-type': contentType },
      cookies: { qp_session: cookie },
      payload,
    });
    // 빈 1h 집계로 조용히 COMPLETED 되면 안 된다 — 명시적 거부
    expect(response.statusCode).toBe(400);
    expect((response.json() as { error: string }).error).toContain('세션');
  });

  it('chains dataset version hashes so identical last uploads differ (재현성 §9.5)', async () => {
    const service = ctx.container.datasetService;
    const csv = buildCsv(390);

    const first = await service.importCsv({
      datasetName: 'hash-chain',
      market: 'KR',
      timeframe: '1m',
      symbol: '005930',
      fileName: 'a.csv',
      csvContent: csv,
    });
    expect(first.status).toBe('COMPLETED');
    const v1 = service.getLatestVersion(first.datasetId)!;

    // 같은 파일을 다시 import — 마지막 업로드가 동일해도 해시는 이력에 따라 달라야 한다
    const second = await service.importCsv({
      datasetName: 'hash-chain',
      market: 'KR',
      timeframe: '1m',
      symbol: '005930',
      fileName: 'a.csv',
      csvContent: csv,
    });
    expect(second.status).toBe('COMPLETED');
    const v2 = service.getLatestVersion(second.datasetId)!;

    expect(v2.version).toBe(v1.version + 1);
    expect(v2.contentHash).not.toBe(v1.contentHash);
  });

  it('rejects invalid CSV headers', async () => {
    const { username, password } = await createTestAdmin(ctx.container);
    const login = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username, password },
    });
    const cookie = login.cookies.find((c) => c.name === 'qp_session')!.value;

    const { payload, contentType } = multipartBody(
      { datasetName: 'bad', market: 'KR', timeframe: '1m', symbol: '005930' },
      'bad.csv',
      'foo,bar\n1,2',
    );
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/datasets/import',
      headers: { 'content-type': contentType },
      cookies: { qp_session: cookie },
      payload,
    });
    expect(response.statusCode).toBe(400);
  });
});
