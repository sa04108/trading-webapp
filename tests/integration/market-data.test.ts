import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Candle } from '../../src/server/modules/market-data/domain/candle.js';
import { createTestAdmin, createTestApp, type TestApp } from '../helpers/test-app.js';

const MONDAY_0900_KST_UTC = Date.UTC(2026, 6, 6, 0, 0);
const DAY = 86_400_000;

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

function buildCsv(rows: number, startTsMs = MONDAY_0900_KST_UTC): string {
  const lines = ['timestamp,open,high,low,close,volume'];
  for (let i = 0; i < rows; i += 1) {
    lines.push(`${startTsMs + i * 60_000},100,110,90,105,10`);
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

    await repo.saveCandles('ds_test', candles);
    await repo.saveCandles('ds_test', candles); // 중복 수집 — idempotent (스펙 §11)

    const timestamps = await repo.getTimestamps('ds_test', 'KR', '1m', '005930');
    expect(timestamps).toHaveLength(120);
    expect(timestamps[0]).toBe(MONDAY_0900_KST_UTC);

    const loaded: Candle[] = [];
    for await (const candle of repo.getCandles({
      datasetId: 'ds_test',
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
    const hourlyTs = await ctx.container.candleRepository.getTimestamps(
      datasets[0]!.id,
      'KR',
      '1h',
      '005930',
    );
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

  it('serializes concurrent writes to the same partition (행 유실 방지)', async () => {
    const repo = ctx.container.candleRepository;
    const first = Array.from({ length: 30 }, (_, i) => minuteCandle(i));
    const second = Array.from({ length: 30 }, (_, i) => minuteCandle(i + 30));

    await Promise.all([
      repo.saveCandles('ds_conc', first),
      repo.saveCandles('ds_conc', second),
    ]);

    const timestamps = await repo.getTimestamps('ds_conc', 'KR', '1m', '005930');
    expect(timestamps).toHaveLength(60); // 어느 쪽도 상대의 쓰기를 덮어쓰지 않는다
  });

  it('isolates candle storage per dataset — same symbol never merges (Codex 리뷰)', async () => {
    const service = ctx.container.datasetService;
    const repo = ctx.container.candleRepository;

    // 데이터셋 A: 월요일 하루치
    const importA = await service.importCsv({
      datasetName: 'set-a',
      market: 'KR',
      timeframe: '1m',
      symbol: '005930',
      fileName: 'a.csv',
      csvContent: buildCsv(390),
    });
    expect(importA.status).toBe('COMPLETED');
    const dsA = service.listDatasets().find((d) => d.name === 'set-a')!;
    const versionBefore = service.getLatestVersion(dsA.id)!;
    const hourlyBefore = await repo.getTimestamps(dsA.id, 'KR', '1h', '005930');
    expect(hourlyBefore).toHaveLength(7);

    // 같은 심볼을 '다른' 데이터셋 B 로 화요일 하루치 import
    const importB = await service.importCsv({
      datasetName: 'set-b',
      market: 'KR',
      timeframe: '1m',
      symbol: '005930',
      fileName: 'b.csv',
      csvContent: buildCsv(390, MONDAY_0900_KST_UTC + DAY),
    });
    expect(importB.status).toBe('COMPLETED');
    const dsB = service.listDatasets().find((d) => d.name === 'set-b')!;

    // A 의 데이터·버전은 B 의 import 에 영향받지 않아야 한다
    const hourlyAfter = await repo.getTimestamps(dsA.id, 'KR', '1h', '005930');
    expect(hourlyAfter).toEqual(hourlyBefore);
    expect(service.getLatestVersion(dsA.id)).toEqual(versionBefore);

    // B 는 자기 데이터만 갖는다 (화요일 7봉)
    const hourlyB = await repo.getTimestamps(dsB.id, 'KR', '1h', '005930');
    expect(hourlyB).toHaveLength(7);
    expect(hourlyB[0]).toBe(MONDAY_0900_KST_UTC + DAY);
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
    // 파싱은 메타데이터 변경 전에 일어난다 — 명시적 400, 빈 데이터셋이 생기지 않는다
    expect(response.statusCode).toBe(400);
    expect(ctx.container.datasetService.listDatasets()).toHaveLength(0);
  });

  it('does not add a symbol to dataset metadata when its CSV fails to parse', async () => {
    const service = ctx.container.datasetService;
    const good = await service.importCsv({
      datasetName: 'meta-guard',
      market: 'KR',
      timeframe: '1m',
      symbol: '005930',
      fileName: 'good.csv',
      csvContent: buildCsv(60),
    });
    expect(good.status).toBe('COMPLETED');

    // 새 심볼의 전량 불량 업로드 — symbolsJson 에 유령 심볼이 남으면 안 된다
    await expect(
      service.importCsv({
        datasetName: 'meta-guard',
        market: 'KR',
        timeframe: '1m',
        symbol: '000660',
        fileName: 'bad.csv',
        csvContent: 'timestamp,open,high,low,close,volume\nnot-a-number,x,x,x,x,x',
      }),
    ).rejects.toThrow();

    const dataset = service.listDatasets().find((d) => d.name === 'meta-guard')!;
    expect(dataset.symbols).toEqual(['005930']);
  });

  it('does not add a symbol whose bars all fall outside the trading session', async () => {
    const service = ctx.container.datasetService;
    await service.importCsv({
      datasetName: 'session-guard',
      market: 'KR',
      timeframe: '1m',
      symbol: '005930',
      fileName: 'good.csv',
      csvContent: buildCsv(60),
    });

    // 구문은 멀쩡하지만 전 봉이 03:00 KST — 1h 집계 결과가 비어 있다.
    // 파싱만 앞세우면 이 업로드가 ensureDataset 을 통과해 유령 심볼을 남긴다.
    const outsideSession = Date.UTC(2026, 6, 5, 18, 0);
    await expect(
      service.importCsv({
        datasetName: 'session-guard',
        market: 'KR',
        timeframe: '1m',
        symbol: '000660',
        fileName: 'off-hours.csv',
        csvContent: buildCsv(60, outsideSession),
      }),
    ).rejects.toThrow(/세션 밖/);

    const dataset = service.listDatasets().find((d) => d.name === 'session-guard')!;
    expect(dataset.symbols).toEqual(['005930']);
    // 유령 심볼의 원본 봉도 저장되지 않아야 한다
    const timestamps = await ctx.container.candleRepository.getTimestamps(
      dataset.id,
      'KR',
      '1m',
      '000660',
    );
    expect(timestamps).toHaveLength(0);
  });

  it('creates a broker dataset and syncs it — unconfigured source fails the job with CSV guidance', async () => {
    const { username, password } = await createTestAdmin(ctx.container);
    const login = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username, password },
    });
    const cookie = login.cookies.find((c) => c.name === 'qp_session')!.value;

    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/datasets',
      cookies: { qp_session: cookie },
      payload: { name: 'KR-일봉', market: 'KR', collect: '1d', symbols: ['005930'] },
    });
    expect(created.statusCode).toBe(201);
    const dataset = created.json().dataset as { id: string; timeframe: string };
    expect(dataset.timeframe).toBe('1d');

    const sync = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/datasets/sync',
      cookies: { qp_session: cookie },
      payload: { datasetId: dataset.id },
    });
    expect(sync.statusCode).toBe(202);
    const jobId = sync.json().job.id as string;

    // 자격 증명 미설정 → 잡은 FAILED 로 끝나되 CSV 안내를 담는다
    await new Promise((resolve) => setTimeout(resolve, 50));
    const job = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/data-jobs/${jobId}`,
      cookies: { qp_session: cookie },
    });
    expect(job.json().job.status).toBe('FAILED');
    expect(job.json().job.error).toContain('CSV');

    // 존재하지 않는 데이터셋은 404
    const missing = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/datasets/sync',
      cookies: { qp_session: cookie },
      payload: { datasetId: 'ds_missing' },
    });
    expect(missing.statusCode).toBe(404);

    // 취소: 이미 종료된 잡은 409, 모르는 잡은 404
    const cancelDone = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/data-jobs/${jobId}/cancel`,
      cookies: { qp_session: cookie },
    });
    expect(cancelDone.statusCode).toBe(409);
    const cancelMissing = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/data-jobs/imp_missing/cancel',
      cookies: { qp_session: cookie },
    });
    expect(cancelMissing.statusCode).toBe(404);
  });

  it('updates symbols and deletes a dataset via API, blocking delete while backtests are active', async () => {
    const { username, password } = await createTestAdmin(ctx.container);
    const login = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username, password },
    });
    const cookie = login.cookies.find((c) => c.name === 'qp_session')!.value;

    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/datasets',
      cookies: { qp_session: cookie },
      payload: { name: 'KR-편집', market: 'KR', collect: '1m', symbols: ['005930'] },
    });
    const dataset = created.json().dataset as { id: string };

    // U: 심볼 추가·제거
    const patched = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/datasets/${dataset.id}`,
      cookies: { qp_session: cookie },
      payload: { addSymbols: ['000660'] },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().dataset.symbols).toEqual(['000660', '005930']);

    // D 가드: 활성 백테스트가 참조 중이면 409
    const btJob = ctx.container.jobQueue.enqueue({
      strategyId: 'noop',
      datasetId: dataset.id,
    } as never);
    const blocked = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/v1/datasets/${dataset.id}`,
      cookies: { qp_session: cookie },
    });
    expect(blocked.statusCode).toBe(409);

    // 백테스트 잡 정리 후 삭제 성공
    ctx.container.jobQueue.setStatus(btJob.id, 'CANCELLED');
    const deleted = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/v1/datasets/${dataset.id}`,
      cookies: { qp_session: cookie },
    });
    expect(deleted.statusCode).toBe(204);

    const gone = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/datasets/${dataset.id}`,
      cookies: { qp_session: cookie },
    });
    expect(gone.statusCode).toBe(404);
  });
});
