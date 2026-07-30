import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { Candle } from '../../src/server/modules/market-data/domain/candle.js';
import type {
  BrokerSyncService,
} from '../../src/server/modules/market-data/application/broker-sync-service.js';
import type {
  FetchCandleRequest,
  FetchCandleResult,
  MarketDataSource,
} from '../../src/server/modules/market-data/application/ports.js';
import { dataImportJobs } from '../../src/server/shared/db/schema.js';
import { createTestAdmin, createTestApp, type TestApp } from '../helpers/test-app.js';

const MONDAY_0900_KST_UTC = Date.UTC(2026, 6, 6, 0, 0);
const DAY = 86_400_000;

/**
 * 라우트 계약 테스트용 페이크 소스 — 요청된 timeframe 을 그대로 기록해 돌려주는
 * 최소 구현(설계 2026-07-30-dataset-symbol-group-design.md, Task 5). 실제 네트워크
 * 없이 "요청받은 slice 로 수집했는가" 를 라우트 경계까지 통째로 검증한다.
 */
class FakeSliceSource implements MarketDataSource {
  calls: FetchCandleRequest[] = [];
  constructor(private readonly candles: Candle[]) {}

  async fetchCandles(request: FetchCandleRequest): Promise<FetchCandleResult> {
    this.calls.push(request);
    const inRange = this.candles.filter(
      (c) =>
        c.symbol === request.symbol &&
        c.timeframe === request.timeframe &&
        c.tsMs >= request.fromTsMs &&
        c.tsMs <= request.toTsMs,
    );
    return { candles: inRange, hasMore: false };
  }
}

/** brokerSyncService 의 소스를 페이크로 바꿔치기 — DI 컨테이너는 실제 소스로 고정돼 있어 이 방법뿐이다 */
function injectFakeSource(brokerSyncService: BrokerSyncService, source: MarketDataSource): void {
  (brokerSyncService as unknown as { deps: { source: MarketDataSource } }).deps.source = source;
}

/** 잡이 QUEUED/RUNNING 이 아닐 때까지 폴링 — done 프라미스는 HTTP 경계 밖이라 접근할 수 없다 */
async function waitForJobSettled(
  app: TestApp['app'],
  jobId: string,
  cookie: string,
): Promise<{ status: string; error: string | null }> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/data-jobs/${jobId}`,
      cookies: { qp_session: cookie },
    });
    const job = res.json().job as { status: string; error: string | null };
    if (job.status !== 'QUEUED' && job.status !== 'RUNNING') return job;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`job ${jobId} 이 시간 내에 끝나지 않았습니다`);
}

/** 1일 간격 OHLCV CSV — 일봉 import 라우트 테스트용 */
function buildDailyCsv(rows: number, startTsMs = Date.UTC(2026, 0, 5)): string {
  const lines = ['timestamp,open,high,low,close,volume'];
  for (let i = 0; i < rows; i += 1) {
    lines.push(`${startTsMs + i * DAY},100,110,90,105,1000`);
  }
  return lines.join('\n');
}

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
      syncEstimate: {
        candles: { basis: string; ms?: number };
        facts: { basis: string; reason?: string };
      };
    };
    expect(body.coverage[0]!.symbol).toBe('005930');
    expect(body.coverage[0]!.barCount).toBe(7);
    expect(body.coverage[0]!.expectedBarCount).toBe(7);

    // 예상 소요시간이 coverage 응답에 함께 온다 (화면이 두 번 묻지 않게).
    // 백필 이력이 없으니 봉은 UNKNOWN, DART 키 미설정이니 재무는 UNSUPPORTED 다.
    expect(body.syncEstimate.candles).toEqual({ basis: 'UNKNOWN' });
    expect(body.syncEstimate.facts).toEqual({
      basis: 'UNSUPPORTED',
      reason: 'DART 인증키가 설정되지 않아 재무를 수집할 수 없습니다.',
    });

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
    expect((response.json() as { error: string }).error).toContain('거래 시간');
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

    // 종목명 조회: 소스 미설정이면 에러가 아니라 빈 목록 — 코드만으로 UI 가 동작한다
    const symbolInfo = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/symbols/info?symbols=005930',
      cookies: { qp_session: cookie },
    });
    expect(symbolInfo.statusCode).toBe(200);
    expect(symbolInfo.json().stocks).toEqual([]);
    const badSymbols = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/symbols/info?symbols=',
      cookies: { qp_session: cookie },
    });
    expect(badSymbols.statusCode).toBe(400);
  });

  /**
   * includeFacts 선검증. 재무 단계는 봉 뒤에 오므로 라우트에서 막지 않으면 45분짜리 봉
   * 수집을 끝낸 뒤에야 "DART 키가 없습니다" 로 실패한다 — 잡이 만들어지지 **않았다는
   * 것**까지 확인해야 선검증 테스트다 (상태 코드만 보면 startSync 뒤에서 막아도 통과한다).
   */
  it('rejects includeFacts before starting a job when facts are unsupported', async () => {
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
      payload: { name: 'KR-재무', market: 'KR', collect: '1d', symbols: ['005930'] },
    });
    const datasetId = (created.json().dataset as { id: string }).id;
    const jobCount = () =>
      ctx.container.database.db
        .select()
        .from(dataImportJobs)
        .where(eq(dataImportJobs.datasetId, datasetId))
        .all().length;
    expect(jobCount()).toBe(0);

    // DART 키 미설정 → 400 + 사유. 봉 수집은 시작조차 하지 않는다.
    const rejected = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/datasets/sync',
      cookies: { qp_session: cookie },
      payload: { datasetId, includeFacts: true },
    });
    expect(rejected.statusCode).toBe(400);
    expect(rejected.json().error).toBe('DART 인증키가 설정되지 않아 재무를 수집할 수 없습니다.');
    // 이것이 선검증의 증거다 — startSync 가 불렸다면 잡 행이 남는다
    expect(jobCount()).toBe(0);

    // includeFacts 없이는 종전대로 시작된다 — 선검증이 봉 수집을 막지 않는다
    const accepted = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/datasets/sync',
      cookies: { qp_session: cookie },
      payload: { datasetId },
    });
    expect(accepted.statusCode).toBe(202);
    expect(jobCount()).toBe(1);
    // 증권사 소스 미설정이라 잡은 곧 FAILED 로 끝난다 — 다음 테스트로 새지 않게 기다린다
    await new Promise((resolve) => setTimeout(resolve, 50));
  });

  /**
   * DART 키가 있으면 선검증이 통과해야 한다 — 봉이 아직 없는 상태는 UNSUPPORTED 가
   * 아니라 AFTER_CANDLES 이므로 막을 이유가 아니다. (시장이 KR 이 아닌 경우는 이
   * 경로로 시험할 수 없다: getSessionForMarket 이 KR 외 데이터셋 생성을 먼저 거부한다.
   * 그 분기는 tests/unit/facts-wiring.test.ts 가 직접 겨눈다.)
   */
  it('allows includeFacts when DART is configured and facts are merely pending candles', async () => {
    const dartCtx = await createTestApp({ DART_API_KEY: 'test-key' });
    try {
      const { username, password } = await createTestAdmin(dartCtx.container);
      const login = await dartCtx.app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { username, password },
      });
      const cookie = login.cookies.find((c) => c.name === 'qp_session')!.value;

      const created = await dartCtx.app.inject({
        method: 'POST',
        url: '/api/v1/datasets',
        cookies: { qp_session: cookie },
        payload: { name: 'KR-재무-가능', market: 'KR', collect: '1d', symbols: ['005930'] },
      });
      const datasetId = (created.json().dataset as { id: string }).id;

      const coverage = await dartCtx.app.inject({
        method: 'GET',
        url: `/api/v1/datasets/${datasetId}/coverage`,
        cookies: { qp_session: cookie },
      });
      expect(coverage.json().syncEstimate.facts).toEqual({ basis: 'AFTER_CANDLES' });

      const sync = await dartCtx.app.inject({
        method: 'POST',
        url: '/api/v1/datasets/sync',
        cookies: { qp_session: cookie },
        payload: { datasetId, includeFacts: true },
      });
      expect(sync.statusCode).toBe(202);
      expect(
        dartCtx.container.database.db
          .select()
          .from(dataImportJobs)
          .where(eq(dataImportJobs.datasetId, datasetId))
          .all(),
      ).toHaveLength(1);
      // 봉 수집이 소스 미설정으로 먼저 실패하므로 재무 단계(DART 호출)는 시작되지 않는다
      await new Promise((resolve) => setTimeout(resolve, 50));
    } finally {
      await dartCtx.close();
    }
  });

  it('serves candles for inspection with timeframe validation and a hard row cap', async () => {
    const { username, password } = await createTestAdmin(ctx.container);
    const login = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username, password },
    });
    const cookie = login.cookies.find((c) => c.name === 'qp_session')!.value;

    // 1m 390행(월요일 세션 하루) import → 1h 데이터셋 생성
    const { payload, contentType } = multipartBody(
      { datasetName: 'inspect-1h', market: 'KR', timeframe: '1m', symbol: '005930' },
      'candles.csv',
      buildCsv(390),
    );
    await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/datasets/import',
      cookies: { qp_session: cookie },
      headers: { 'content-type': contentType },
      payload,
    });
    const datasets = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/datasets',
      cookies: { qp_session: cookie },
    });
    const dataset = datasets.json().datasets.find((d: { name: string }) => d.name === 'inspect-1h');

    const from = MONDAY_0900_KST_UTC;
    const to = MONDAY_0900_KST_UTC + DAY;

    // 원본 1m 조회
    const minute = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/datasets/${dataset.id}/candles?symbol=005930&timeframe=1m&fromTsMs=${from}&toTsMs=${to}`,
      cookies: { qp_session: cookie },
    });
    expect(minute.statusCode).toBe(200);
    expect(minute.json().candles).toHaveLength(390);
    expect(minute.json().candles[0]).toMatchObject({ tsMs: from, open: 100, close: 105 });
    // 1m 뷰에는 coverage 음영을 싣지 않는다 (coverage 는 데이터셋 timeframe 기준)
    expect(minute.json().missingRanges).toEqual([]);

    // 집계 1h 조회 — 데이터셋 timeframe 이므로 missingRanges 동봉
    const hourly = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/datasets/${dataset.id}/candles?symbol=005930&timeframe=1h&fromTsMs=${from}&toTsMs=${to}`,
      cookies: { qp_session: cookie },
    });
    expect(hourly.statusCode).toBe(200);
    expect(hourly.json().candles.length).toBeGreaterThan(0);
    expect(Array.isArray(hourly.json().missingRanges)).toBe(true);

    // 1h 데이터셋에 1d 요청 → 400
    const wrongTf = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/datasets/${dataset.id}/candles?symbol=005930&timeframe=1d&fromTsMs=${from}&toTsMs=${to}`,
      cookies: { qp_session: cookie },
    });
    expect(wrongTf.statusCode).toBe(400);

    // 데이터셋 소속이 아닌 심볼 → 400
    const wrongSymbol = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/datasets/${dataset.id}/candles?symbol=000660&timeframe=1h&fromTsMs=${from}&toTsMs=${to}`,
      cookies: { qp_session: cookie },
    });
    expect(wrongSymbol.statusCode).toBe(400);

    // 상한 검증: 2,000봉 초과 구간은 정직하게 400 (다운샘플로 뭉개지 않는다)
    await ctx.container.candleRepository.saveCandles(
      dataset.id,
      Array.from({ length: 2100 }, (_, i) => minuteCandle(i)),
    );
    const tooWide = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/datasets/${dataset.id}/candles?symbol=005930&timeframe=1m&fromTsMs=${from}&toTsMs=${from + 3 * DAY}`,
      cookies: { qp_session: cookie },
    });
    expect(tooWide.statusCode).toBe(400);
    expect(tooWide.json().error).toContain('기간');

    // 캔들이 아예 없는 데이터셋 조회 — "이 데이터셋은  만 제공합니다" 같은 빈 목록
    // 메시지가 아니라 아직 수집된 캔들이 없다는 사실을 그대로 말해야 한다
    const empty = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/datasets',
      cookies: { qp_session: cookie },
      payload: { name: 'inspect-empty', market: 'KR', collect: '1d', symbols: ['000660'] },
    });
    const emptyDataset = empty.json().dataset as { id: string };
    const noCandles = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/datasets/${emptyDataset.id}/candles?symbol=000660&timeframe=1d&fromTsMs=${from}&toTsMs=${to}`,
      cookies: { qp_session: cookie },
    });
    expect(noCandles.statusCode).toBe(400);
    expect(noCandles.json().error).toBe(
      '이 데이터셋에는 아직 수집된 캔들이 없습니다 — 동기화 또는 CSV 가져오기 후 조회하세요.',
    );
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

  it('renames a dataset via PATCH, rejecting duplicates and keeping the version untouched', async () => {
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
      payload: { name: 'KR-이름변경', market: 'KR', collect: '1d', symbols: ['005930'] },
    });
    const dataset = created.json().dataset as { id: string; latestVersion: number };
    // 종목 구성은 위 데이터셋과 달라야 한다 — 같으면 이름이 아니라 종목 구성
    // 유일성 검사(DuplicateSymbolGroupError)에 걸려 이 데이터셋 자체가 생기지 않는다.
    await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/datasets',
      cookies: { qp_session: cookie },
      payload: { name: 'KR-점유된이름', market: 'KR', collect: '1d', symbols: ['000660'] },
    });

    // 이름만 변경 — 버전은 그대로 (이름은 §9.5 의 유효 데이터가 아니다)
    const renamed = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/datasets/${dataset.id}`,
      cookies: { qp_session: cookie },
      payload: { name: 'KR-새이름' },
    });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json().dataset.name).toBe('KR-새이름');
    expect(renamed.json().dataset.latestVersion).toBe(dataset.latestVersion);

    // 다른 데이터셋이 점유한 이름 → 400
    const duplicate = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/datasets/${dataset.id}`,
      cookies: { qp_session: cookie },
      payload: { name: 'KR-점유된이름' },
    });
    expect(duplicate.statusCode).toBe(400);
    expect(duplicate.json().error).toContain('이미');

    // 같은 이름으로의 재변경(no-op)은 성공한다
    const noop = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/datasets/${dataset.id}`,
      cookies: { qp_session: cookie },
      payload: { name: 'KR-새이름' },
    });
    expect(noop.statusCode).toBe(200);

    // 이름 + 심볼 변경 동시 적용
    const combined = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/datasets/${dataset.id}`,
      cookies: { qp_session: cookie },
      payload: { name: 'KR-최종이름', addSymbols: ['000660'] },
    });
    expect(combined.statusCode).toBe(200);
    expect(combined.json().dataset.name).toBe('KR-최종이름');
    expect(combined.json().dataset.symbols).toEqual(['000660', '005930']);

    // 빈 body 는 여전히 400
    const empty = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/datasets/${dataset.id}`,
      cookies: { qp_session: cookie },
      payload: {},
    });
    expect(empty.statusCode).toBe(400);
  });

  /**
   * 라우트 계약 — 슬라이스 (설계 2026-07-30-dataset-symbol-group-server, Task 5).
   */
  describe('라우트 계약 — 슬라이스', () => {
    it('GET /datasets/:datasetId/coverage 응답에 각 행의 slice 필드가 포함된다', async () => {
      const { username, password } = await createTestAdmin(ctx.container);
      const login = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { username, password },
      });
      const cookie = login.cookies.find((c) => c.name === 'qp_session')!.value;

      // 1d CSV import — slice: '1d'
      const { payload, contentType } = multipartBody(
        { datasetName: 'slice-test-1d', market: 'KR', timeframe: '1d', symbol: '005930' },
        'daily.csv',
        buildDailyCsv(10),
      );
      const imported = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/datasets/import',
        headers: { 'content-type': contentType },
        cookies: { qp_session: cookie },
        payload,
      });
      expect(imported.statusCode).toBe(201);
      const dataset = ctx.container.datasetService
        .listDatasets()
        .find((d) => d.name === 'slice-test-1d');
      expect(dataset).toBeDefined();

      // coverage 응답 확인
      const coverage = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/datasets/${dataset!.id}/coverage`,
        cookies: { qp_session: cookie },
      });
      expect(coverage.statusCode).toBe(200);
      const body = coverage.json() as {
        coverage: Array<{ symbol: string; slice: string }>;
      };
      expect(body.coverage).toHaveLength(1);
      expect(body.coverage[0]!.symbol).toBe('005930');
      expect(body.coverage[0]!.slice).toBe('1d');
    });

    it('POST /datasets 는 같은 종목 구성을 409 로 거부한다', async () => {
      const { username, password } = await createTestAdmin(ctx.container);
      const login = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { username, password },
      });
      const cookie = login.cookies.find((c) => c.name === 'qp_session')!.value;

      const first = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/datasets',
        cookies: { qp_session: cookie },
        payload: { name: '중복-원본', market: 'KR', collect: '1d', symbols: ['005930', '000660'] },
      });
      expect(first.statusCode).toBe(201);

      // 순서만 다른 같은 구성 — 종목 구성 유일성 위반 (DuplicateSymbolGroupError → 409)
      const duplicate = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/datasets',
        cookies: { qp_session: cookie },
        payload: { name: '중복-신규', market: 'KR', collect: '1m', symbols: ['000660', '005930'] },
      });
      expect(duplicate.statusCode).toBe(409);
      expect(duplicate.json().error).toContain('중복-원본');
    });

    it('PATCH /datasets/:id 로 종목을 편집해 다른 데이터셋과 구성이 같아지면 409', async () => {
      const { username, password } = await createTestAdmin(ctx.container);
      const login = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { username, password },
      });
      const cookie = login.cookies.find((c) => c.name === 'qp_session')!.value;

      await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/datasets',
        cookies: { qp_session: cookie },
        payload: { name: '편집-충돌대상', market: 'KR', collect: '1d', symbols: ['005930'] },
      });
      const created = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/datasets',
        cookies: { qp_session: cookie },
        payload: { name: '편집-대상', market: 'KR', collect: '1d', symbols: ['005930', '035420'] },
      });
      const dataset = created.json().dataset as { id: string };

      // '035420' 을 제거하면 '편집-충돌대상' 과 구성이 같아진다
      const patched = await ctx.app.inject({
        method: 'PATCH',
        url: `/api/v1/datasets/${dataset.id}`,
        cookies: { qp_session: cookie },
        payload: { removeSymbols: ['035420'] },
      });
      expect(patched.statusCode).toBe(409);
      expect(patched.json().error).toContain('편집-충돌대상');
    });

    it('POST /datasets/sync 에 slice:"1m" 을 주면 그 timeframe 으로 수집한다 (defaultTimeframe 은 1d)', async () => {
      const { username, password } = await createTestAdmin(ctx.container);
      const login = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { username, password },
      });
      const cookie = login.cookies.find((c) => c.name === 'qp_session')!.value;

      const fake = new FakeSliceSource([minuteCandle(0), minuteCandle(1), minuteCandle(2)]);
      injectFakeSource(ctx.container.brokerSyncService, fake);

      const created = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/datasets',
        cookies: { qp_session: cookie },
        payload: { name: '슬라이스-동기화', market: 'KR', collect: '1d', symbols: ['005930'] },
      });
      expect(created.statusCode).toBe(201);
      const dataset = created.json().dataset as { id: string; defaultTimeframe: string };
      expect(dataset.defaultTimeframe).toBe('1d');

      const sync = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/datasets/sync',
        cookies: { qp_session: cookie },
        payload: { datasetId: dataset.id, slice: '1m' },
      });
      expect(sync.statusCode).toBe(202);
      const jobId = sync.json().job.id as string;

      const finished = await waitForJobSettled(ctx.app, jobId, cookie);
      expect(finished.status).toBe('COMPLETED');

      // 데이터셋 기본은 1d 지만, slice:'1m' 을 줬으므로 페이크 소스는 '1m' 요청만 받아야 한다
      expect(fake.calls.length).toBeGreaterThan(0);
      for (const call of fake.calls) {
        expect(call.timeframe).toBe('1m');
      }
      const minuteStored = await ctx.container.candleRepository.getTimestamps(
        dataset.id,
        'KR',
        '1m',
        '005930',
      );
      expect(minuteStored.length).toBeGreaterThan(0);
    });

    it('POST /datasets/import 는 timeframe "1h" 를 400 으로 거부하고 "1d" 는 성공한다', async () => {
      const { username, password } = await createTestAdmin(ctx.container);
      const login = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { username, password },
      });
      const cookie = login.cookies.find((c) => c.name === 'qp_session')!.value;

      const rejected = multipartBody(
        { datasetName: 'csv-1h-거부', market: 'KR', timeframe: '1h', symbol: '005930' },
        'legacy.csv',
        buildCsv(10),
      );
      const rejectedResponse = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/datasets/import',
        headers: { 'content-type': rejected.contentType },
        cookies: { qp_session: cookie },
        payload: rejected.payload,
      });
      expect(rejectedResponse.statusCode).toBe(400);
      expect(ctx.container.datasetService.listDatasets()).toHaveLength(0);

      const accepted = multipartBody(
        { datasetName: 'csv-1d-허용', market: 'KR', timeframe: '1d', symbol: '005930' },
        'daily.csv',
        buildDailyCsv(10),
      );
      const acceptedResponse = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/datasets/import',
        headers: { 'content-type': accepted.contentType },
        cookies: { qp_session: cookie },
        payload: accepted.payload,
      });
      expect(acceptedResponse.statusCode).toBe(201);
      expect(acceptedResponse.json().job.status).toBe('COMPLETED');
      const dataset = ctx.container.datasetService
        .listDatasets()
        .find((d) => d.name === 'csv-1d-허용');
      expect(dataset?.defaultTimeframe).toBe('1d');
    });
  });
});
