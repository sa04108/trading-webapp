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
import { KR_SESSION } from '../../src/server/modules/market-data/domain/exchange-session.js';
import {
  MINUTE_BACKFILL_MAX_MONTHS,
  estimateMinuteBackfillBars,
  minuteBackfillFloorTsMs,
  recommendedMinuteMonths,
} from '../../src/server/modules/market-data/domain/minute-backfill.js';
import { dataSyncJobs } from '../../src/server/shared/db/schema.js';
import { createTestAdmin, createTestApp, type TestApp } from '../helpers/test-app.js';
import { registerSymbols } from '../helpers/seed.js';

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

/**
 * 아래에서 사라진 테스트들 (설계 2026-07-31-symbol-as-first-class):
 * - "isolates candle storage per dataset" — 데이터셋별 격리를 **의도적으로** 없앴다.
 *   같은 종목을 여러 데이터셋이 공유하는 것이 이 변경의 목적이다.
 * - "chains dataset version hashes" — 버전 체인이 종목·슬라이스로 옮겼다
 *   (tests/unit/broker-sync-service.test.ts, job-queue.test.ts 의 universeJson 검증).
 * - "does not add a symbol to dataset metadata …" — 데이터셋에 symbolsJson 이 없다.
 * - 종목 구성 중복 409 두 건 — 데이터가 종목에 있어 구성이 같은 데이터셋이 비용을 더
 *   쓰지 않으므로 규칙 자체를 폐기했다.
 */
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
      { market: 'KR', timeframe: '1m', symbol: '005930' },
      'candles.csv',
      buildCsv(390), // 하루 전체 세션
    );

    const imported = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/symbols/import',
      headers: { 'content-type': contentType },
      cookies: { qp_session: cookie },
      payload,
    });
    expect(imported.statusCode).toBe(201);
    const job = imported.json().job as { id: string; status: string; rowsImported: number };
    expect(job.status).toBe('COMPLETED');
    expect(job.rowsImported).toBe(390);

    // CSV 는 종목을 등록한다 — 데이터셋 개념은 더 이상 없다
    const symbolList = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/symbols',
      cookies: { qp_session: cookie },
    });
    const symbols = symbolList.json().symbols as Array<{ code: string; market: string }>;
    expect(symbols).toHaveLength(1);
    expect(symbols[0]!.code).toBe('005930');

    // 1h 사전 집계 확인 (스펙 §11: 백테스트는 1시간봉 우선)
    const hourlyTs = await ctx.container.candleRepository.getTimestamps('KR',
      '1h',
      '005930',
    );
    expect(hourlyTs).toHaveLength(7);

    // 커버리지는 종목 목록에 실려 온다 — 화면이 두 번 묻지 않게 한다
    const covered = symbols[0] as unknown as {
      slices: Array<{ slice: string; barCount: number; hasData: boolean }>;
    };
    const minuteSlice = covered.slices.find((entry) => entry.slice === '1m')!;
    expect(minuteSlice.barCount).toBe(7);
    expect(minuteSlice.hasData).toBe(true);

    // 예상 소요시간은 선택 집합 기준으로 따로 묻는다.
    // 백필 이력이 없으니 봉은 UNKNOWN, DART 키 미설정이니 재무는 UNSUPPORTED 다.
    const beforeCoverageMs = Date.now();
    const estimateRes = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/symbols/sync-estimate?codes=005930&slice=1m',
      cookies: { qp_session: cookie },
    });
    const afterCoverageMs = Date.now();
    const body = estimateRes.json() as {
      candles: { basis: string; ms?: number };
      facts: { basis: string; reason?: string };
      minutePlan: {
        capMonths: number;
        recommendedMonths: number;
        fromTsMs: number;
        expectedBars: number;
        exceedsBacktestLimit: boolean;
      } | null;
    };
    expect(body.candles).toEqual({ basis: 'UNKNOWN' });
    expect(body.facts).toEqual({
      basis: 'UNSUPPORTED',
      reason: 'DART 인증키가 설정되지 않아 재무를 수집할 수 없습니다.',
    });

    // 분봉 사전 계획 — KR 은 세션이 정의돼 있으므로 null 이 아니다. 종목 1개이므로
    // 권장 기간은 상한(24개월)에 그대로 걸린다.
    expect(body.minutePlan).not.toBeNull();
    const minutePlan = body.minutePlan!;
    const krSessionMinutesPerDay = KR_SESSION.closeMinutes - KR_SESSION.openMinutes;
    expect(minutePlan.capMonths).toBe(MINUTE_BACKFILL_MAX_MONTHS);
    expect(minutePlan.recommendedMonths).toBe(recommendedMinuteMonths(1));
    expect(minutePlan.expectedBars).toBe(
      estimateMinuteBackfillBars(1, krSessionMinutesPerDay, MINUTE_BACKFILL_MAX_MONTHS),
    );
    expect(minutePlan.exceedsBacktestLimit).toBe(false);
    // 실제 시각(clock.now())은 요청 처리 중 흐르므로 요청 전후로 감싸 판정한다
    expect(minutePlan.fromTsMs).toBeGreaterThanOrEqual(minuteBackfillFloorTsMs(beforeCoverageMs));
    expect(minutePlan.fromTsMs).toBeLessThanOrEqual(minuteBackfillFloorTsMs(afterCoverageMs));

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
      repo.saveCandles(first),
      repo.saveCandles(second),
    ]);

    const timestamps = await repo.getTimestamps('KR', '1m', '005930');
    expect(timestamps).toHaveLength(60); // 어느 쪽도 상대의 쓰기를 덮어쓰지 않는다
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
      { market: 'US', timeframe: '1m', symbol: 'AAPL' },
      'us.csv',
      buildCsv(60),
    );
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/symbols/import',
      headers: { 'content-type': contentType },
      cookies: { qp_session: cookie },
      payload,
    });
    // 빈 1h 집계로 조용히 COMPLETED 되면 안 된다 — 명시적 거부
    expect(response.statusCode).toBe(400);
    expect((response.json() as { error: string }).error).toContain('거래 시간');
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
      { market: 'KR', timeframe: '1m', symbol: '005930' },
      'bad.csv',
      'foo,bar\n1,2',
    );
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/symbols/import',
      headers: { 'content-type': contentType },
      cookies: { qp_session: cookie },
      payload,
    });
    // 파싱은 메타데이터 변경 전에 일어난다 — 명시적 400, 종목이 등록되지 않는다
    expect(response.statusCode).toBe(400);
    expect(ctx.container.symbolService.listSymbols()).toHaveLength(0);
  });


  it('does not add a symbol whose bars all fall outside the trading session', async () => {
    const service = ctx.container.symbolService;
    await service.importCsv({
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
        market: 'KR',
        timeframe: '1m',
        symbol: '000660',
        fileName: 'off-hours.csv',
        csvContent: buildCsv(60, outsideSession),
      }),
    ).rejects.toThrow(/세션 밖/);

    // 세션 밖 업로드는 종목을 등록하지도 않는다 — 화면이 유령 종목을 광고하면
    // 위저드가 그것을 고를 수 있고 제출 검증도 통과시킨다
    expect(ctx.container.symbolService.exists('005930')).toBe(true);
    expect(ctx.container.symbolService.exists('000660')).toBe(false);
    // 유령 종목의 원본 봉도 저장되지 않아야 한다
    const timestamps = await ctx.container.candleRepository.getTimestamps('KR',
      '1m',
      '000660',
    );
    expect(timestamps).toHaveLength(0);
  });

  it('syncs registered symbols — unconfigured source fails the job with CSV guidance', async () => {
    const { username, password } = await createTestAdmin(ctx.container);
    const login = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username, password },
    });
    const cookie = login.cookies.find((c) => c.name === 'qp_session')!.value;

    // 동기화 대상은 종목이다 — 먼저 등록한다
    registerSymbols(ctx.container, 'KR', ['005930']);

    const sync = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/symbols/sync',
      cookies: { qp_session: cookie },
      payload: { codes: ['005930'] },
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

    // 등록되지 않은 종목은 400 이다
    const missing = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/symbols/sync',
      cookies: { qp_session: cookie },
      payload: { codes: ['999999'] },
    });
    expect(missing.statusCode).toBe(400);

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

    // 동기화 대상은 종목이다 — 먼저 등록한다
    registerSymbols(ctx.container, 'KR', ['005930']);

    const jobCount = () =>
      ctx.container.database.db
        .select()
        .from(dataSyncJobs)
        .where(eq(dataSyncJobs.sourceType, 'BROKER'))
        .all().length;
    expect(jobCount()).toBe(0);

    // DART 키 미설정 → 400 + 사유. 봉 수집은 시작조차 하지 않는다.
    const rejected = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/symbols/sync',
      cookies: { qp_session: cookie },
      payload: { codes: ['005930'], includeFacts: true },
    });
    expect(rejected.statusCode).toBe(400);
    expect(rejected.json().error).toBe('DART 인증키가 설정되지 않아 재무를 수집할 수 없습니다.');
    // 이것이 선검증의 증거다 — startSync 가 불렸다면 잡 행이 남는다
    expect(jobCount()).toBe(0);

    // includeFacts 없이는 종전대로 시작된다 — 선검증이 봉 수집을 막지 않는다
    const accepted = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/symbols/sync',
      cookies: { qp_session: cookie },
      payload: { codes: ['005930'] },
    });
    expect(accepted.statusCode).toBe(202);
    expect(jobCount()).toBe(1);
    // 증권사 소스 미설정이라 잡은 곧 FAILED 로 끝난다 — 다음 테스트로 새지 않게 기다린다
    await new Promise((resolve) => setTimeout(resolve, 50));
  });

  /**
   * DART 키가 있으면 선검증이 통과해야 한다 — 봉이 아직 없는 상태는 UNSUPPORTED 가
   * 아니라 AFTER_CANDLES 이므로 막을 이유가 아니다. (시장이 KR 이 아닌 경우는 이
   * 경로로 시험할 수 없다: getSessionForMarket 이 KR 외 종목 등록을 먼저 거부한다.
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

      registerSymbols(dartCtx.container, 'KR', ['005930']);

      // 봉이 아직 없는 상태는 UNSUPPORTED 가 아니라 AFTER_CANDLES 다 — 막을 이유가 아니다
      const estimate = await dartCtx.app.inject({
        method: 'GET',
        url: '/api/v1/symbols/sync-estimate?codes=005930&slice=1d',
        cookies: { qp_session: cookie },
      });
      expect(estimate.json().facts).toEqual({ basis: 'AFTER_CANDLES' });

      const sync = await dartCtx.app.inject({
        method: 'POST',
        url: '/api/v1/symbols/sync',
        cookies: { qp_session: cookie },
        payload: { codes: ['005930'], includeFacts: true },
      });
      expect(sync.statusCode).toBe(202);
      expect(
        dartCtx.container.database.db
          .select()
          .from(dataSyncJobs)
          .where(eq(dataSyncJobs.sourceType, 'BROKER'))
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
      { market: 'KR', timeframe: '1m', symbol: '005930' },
      'candles.csv',
      buildCsv(390),
    );
    await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/symbols/import',
      cookies: { qp_session: cookie },
      headers: { 'content-type': contentType },
      payload,
    });
    const from = MONDAY_0900_KST_UTC;
    const to = MONDAY_0900_KST_UTC + DAY;

    // 원본 1m 조회
    const minute = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/symbols/005930/candles?timeframe=1m&fromTsMs=${from}&toTsMs=${to}`,
      cookies: { qp_session: cookie },
    });
    expect(minute.statusCode).toBe(200);
    expect(minute.json().candles).toHaveLength(390);
    expect(minute.json().candles[0]).toMatchObject({ tsMs: from, open: 100, close: 105 });
    // 1m 뷰에는 coverage 음영을 싣지 않는다 (coverage 는 슬라이스 기준 timeframe 인 1h)
    expect(minute.json().missingRanges).toEqual([]);

    // 집계 1h 조회 — 1m 슬라이스의 coverage 기준 timeframe 이므로 missingRanges 동봉
    const hourly = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/symbols/005930/candles?timeframe=1h&fromTsMs=${from}&toTsMs=${to}`,
      cookies: { qp_session: cookie },
    });
    expect(hourly.statusCode).toBe(200);
    expect(hourly.json().candles.length).toBeGreaterThan(0);
    expect(Array.isArray(hourly.json().missingRanges)).toBe(true);

    // 일봉을 갖지 않은 종목에 1d 요청 → 400
    const wrongTf = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/symbols/005930/candles?timeframe=1d&fromTsMs=${from}&toTsMs=${to}`,
      cookies: { qp_session: cookie },
    });
    expect(wrongTf.statusCode).toBe(400);

    // 등록되지 않은 종목 → 404 (구 "데이터셋 소속이 아닌 심볼 → 400" 자리).
    // 종목이 1급 객체가 된 뒤 "소속" 개념이 없어졌고, 없는 종목은 404 가 맞다.
    const unknownSymbol = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/symbols/999999/candles?timeframe=1h&fromTsMs=${from}&toTsMs=${to}`,
      cookies: { qp_session: cookie },
    });
    expect(unknownSymbol.statusCode).toBe(404);

    // 상한 검증: 2,000봉 초과 구간은 정직하게 400 (다운샘플로 뭉개지 않는다)
    await ctx.container.candleRepository.saveCandles(Array.from({ length: 2100 }, (_, i) => minuteCandle(i)),
    );
    const tooWide = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/symbols/005930/candles?timeframe=1m&fromTsMs=${from}&toTsMs=${from + 3 * DAY}`,
      cookies: { qp_session: cookie },
    });
    expect(tooWide.statusCode).toBe(400);
    expect(tooWide.json().error).toContain('기간');

    // 등록만 되고 캔들이 없는 종목 — "이 종목은  만 제공합니다" 같은 빈 목록 메시지가
    // 아니라 아직 수집된 캔들이 없다는 사실을 그대로 말해야 한다
    registerSymbols(ctx.container, 'KR', ['000660']);
    const noCandles = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/symbols/000660/candles?timeframe=1d&fromTsMs=${from}&toTsMs=${to}`,
      cookies: { qp_session: cookie },
    });
    expect(noCandles.statusCode).toBe(400);
    expect(noCandles.json().error).toBe(
      '이 종목에는 아직 수집된 캔들이 없습니다 — 동기화 또는 CSV 가져오기 후 조회하세요.',
    );
  });

  /**
   * 라우트 계약 — 슬라이스 (설계 2026-07-30-dataset-symbol-group-server, Task 5).
   */
  // GET /symbols 슬라이스 커버리지(barCount 포함)는 symbol-card.test.ts 가 덮는다
  describe('라우트 계약 — 슬라이스', () => {


    it('POST /symbols/sync 에 slice:"1m" 을 주면 그 timeframe 으로 수집한다', async () => {
      const { username, password } = await createTestAdmin(ctx.container);
      const login = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { username, password },
      });
      const cookie = login.cookies.find((c) => c.name === 'qp_session')!.value;

      const fake = new FakeSliceSource([minuteCandle(0), minuteCandle(1), minuteCandle(2)]);
      injectFakeSource(ctx.container.brokerSyncService, fake);

      // 동기화 대상은 종목이다 — 먼저 등록한다
      registerSymbols(ctx.container, 'KR', ['005930']);

      const sync = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/symbols/sync',
        cookies: { qp_session: cookie },
        payload: { codes: ['005930'], slice: '1m' },
      });
      expect(sync.statusCode).toBe(202);
      const jobId = sync.json().job.id as string;

      const finished = await waitForJobSettled(ctx.app, jobId, cookie);
      expect(finished.status).toBe('COMPLETED');

      // 기본 슬라이스는 1d 지만, slice:'1m' 을 줬으므로 페이크 소스는 '1m' 요청만 받아야 한다
      expect(fake.calls.length).toBeGreaterThan(0);
      for (const call of fake.calls) {
        expect(call.timeframe).toBe('1m');
      }
      const minuteStored = await ctx.container.candleRepository.getTimestamps('KR',
        '1m',
        '005930',
      );
      expect(minuteStored.length).toBeGreaterThan(0);
    });

    it('POST /symbols/import 는 timeframe "1h" 를 400 으로 거부하고 "1d" 는 성공한다', async () => {
      const { username, password } = await createTestAdmin(ctx.container);
      const login = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { username, password },
      });
      const cookie = login.cookies.find((c) => c.name === 'qp_session')!.value;

      const rejected = multipartBody(
        { market: 'KR', timeframe: '1h', symbol: '005930' },
        'legacy.csv',
        buildCsv(10),
      );
      const rejectedResponse = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/symbols/import',
        headers: { 'content-type': rejected.contentType },
        cookies: { qp_session: cookie },
        payload: rejected.payload,
      });
      expect(rejectedResponse.statusCode).toBe(400);
      // 거부된 업로드는 종목도 등록하지 않는다
      expect(ctx.container.symbolService.listSymbols()).toHaveLength(0);

      const accepted = multipartBody(
        { market: 'KR', timeframe: '1d', symbol: '005930' },
        'daily.csv',
        buildDailyCsv(10),
      );
      const acceptedResponse = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/symbols/import',
        headers: { 'content-type': accepted.contentType },
        cookies: { qp_session: cookie },
        payload: accepted.payload,
      });
      expect(acceptedResponse.statusCode).toBe(201);
      expect(acceptedResponse.json().job.status).toBe('COMPLETED');
      // 일봉 CSV 는 종목을 등록한다 — 슬라이스 상태는 symbol-service-slices.test.ts 가 덮는다
      expect(ctx.container.symbolService.exists('005930')).toBe(true);
    });
  });
});
