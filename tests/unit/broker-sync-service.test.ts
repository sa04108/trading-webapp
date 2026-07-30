import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  BrokerSyncService,
  SyncAlreadyRunningError,
  type BrokerSyncDeps,
  type FactsJobState,
} from '../../src/server/modules/market-data/application/broker-sync-service.js';
import { DatasetService } from '../../src/server/modules/market-data/application/dataset-service.js';
import {
  MarketDataSourceNotConfiguredError,
  type CandleRepository,
  type FetchCandleRequest,
  type FetchCandleResult,
  type MarketDataSource,
} from '../../src/server/modules/market-data/application/ports.js';
import type { Candle, Market, Timeframe } from '../../src/server/modules/market-data/domain/candle.js';
import { openDatabase } from '../../src/server/shared/db/database.js';
import { brokerSyncState, dataImportJobs, datasets } from '../../src/server/shared/db/schema.js';
import { createLogger } from '../../src/server/shared/logger.js';
import { loadConfig } from '../../src/server/bootstrap/config.js';
import type { AuditLogService } from '../../src/server/modules/audit/audit-service.js';

const logger = createLogger(loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'error' }));

/** 2026-07-06 월요일 09:00 KST */
const MON_0900_KST = Date.UTC(2026, 6, 6, 0, 0);
const MINUTE = 60_000;
const DAY = 86_400_000;

function minuteCandle(symbol: string, tsMs: number, volume = 10): Candle {
  return { symbol, market: 'KR', timeframe: '1m', tsMs, open: 100, high: 110, low: 90, close: 105, volume };
}

function dailyCandle(symbol: string, tsMs: number): Candle {
  return { symbol, market: 'KR', timeframe: '1d', tsMs, open: 100, high: 110, low: 90, close: 105, volume: 1000 };
}

/**
 * 어댑터 계약을 흉내내는 fake 소스: [from, to] 안에서 최신 pageSize 개를 오름차순으로
 * 반환하고, hasMore 는 범위 안에 더 과거 봉이 남아 있는지다 (from=0 이면 API 바닥).
 */
class FakeSource implements MarketDataSource {
  calls: FetchCandleRequest[] = [];
  constructor(
    public candles: Candle[],
    private readonly pageSize = 4,
  ) {}

  async fetchCandles(request: FetchCandleRequest): Promise<FetchCandleResult> {
    this.calls.push(request);
    const inRange = this.candles
      .filter(
        (c) =>
          c.symbol === request.symbol &&
          c.timeframe === request.timeframe &&
          c.tsMs >= request.fromTsMs &&
          c.tsMs <= request.toTsMs,
      )
      .sort((a, b) => a.tsMs - b.tsMs);
    const page = inRange.slice(-this.pageSize);
    return { candles: page, hasMore: inRange.length > page.length };
  }
}

class InMemoryCandleRepository implements CandleRepository {
  private store = new Map<string, Candle>();
  /** 저장 호출 횟수 추적 — 쓰기 증폭 회귀 감시용 */
  saveInvocations: Candle[][] = [];

  private key(datasetId: string, c: Candle): string {
    return `${datasetId}:${c.symbol}:${c.timeframe}:${c.tsMs}`;
  }

  async saveCandles(datasetId: string, candles: readonly Candle[]): Promise<void> {
    this.saveInvocations.push([...candles]);
    for (const c of candles) this.store.set(this.key(datasetId, c), c);
  }

  all(datasetId: string, timeframe: Timeframe): Candle[] {
    return [...this.store.entries()]
      .filter(([k, c]) => k.startsWith(`${datasetId}:`) && c.timeframe === timeframe)
      .map(([, c]) => c)
      .sort((a, b) => a.tsMs - b.tsMs);
  }

  async *getCandles(query: {
    datasetId: string;
    market: Market;
    timeframe: Timeframe;
    symbols: readonly string[];
    fromTsMs?: number;
    toTsMs?: number;
  }): AsyncIterable<Candle> {
    for (const c of this.all(query.datasetId, query.timeframe)) {
      if (!query.symbols.includes(c.symbol)) continue;
      if (query.fromTsMs !== undefined && c.tsMs < query.fromTsMs) continue;
      if (query.toTsMs !== undefined && c.tsMs > query.toTsMs) continue;
      yield c;
    }
  }

  async getTimestamps(
    datasetId: string,
    _market: Market,
    timeframe: Timeframe,
    symbol: string,
  ): Promise<number[]> {
    return this.all(datasetId, timeframe)
      .filter((c) => c.symbol === symbol)
      .map((c) => c.tsMs);
  }

  async deleteDataset(datasetId: string): Promise<void> {
    for (const key of [...this.store.keys()]) {
      if (key.startsWith(`${datasetId}:`)) this.store.delete(key);
    }
  }
}

const noopAudit: AuditLogService = { record: () => {} } as unknown as AuditLogService;

function buildHarness(
  source: MarketDataSource,
  options: {
    minFreeDiskBytes?: number;
    freeDiskBytes?: () => number;
    factsPhase?: BrokerSyncDeps['factsPhase'];
  } = {},
) {
  const handle = openDatabase(':memory:');
  const repo = new InMemoryCandleRepository();
  const clock = { now: () => Date.UTC(2026, 6, 8, 12, 0) }; // 2026-07-08 수요일 21:00 KST
  const datasetService = new DatasetService(handle.db, repo, clock, logger, noopAudit);
  const sync = new BrokerSyncService({
    db: handle.db,
    source,
    candleRepository: repo,
    datasetService,
    clock,
    logger,
    audit: noopAudit,
    minFreeDiskBytes: options.minFreeDiskBytes ?? 0,
    freeDiskBytes: options.freeDiskBytes ?? (() => Number.MAX_SAFE_INTEGER),
    factsPhase: options.factsPhase,
  });
  return { db: handle.db, repo, datasetService, sync, clock };
}

type Harness = ReturnType<typeof buildHarness>;

function jobRow(harness: Harness, jobId: string) {
  return harness.db.select().from(dataImportJobs).where(eq(dataImportJobs.id, jobId)).get();
}

/** factsJson 파싱. 비어 있으면 즉시 실패시킨다 — 뒤 단정이 undefined 로 조용히 묻히지 않게 */
function requireFacts(row: { factsJson: string | null } | undefined): FactsJobState {
  const json = row?.factsJson;
  if (json == null) throw new Error('factsJson 이 비어 있습니다');
  return JSON.parse(json) as FactsJobState;
}

function emptyFactResult() {
  return { savedFacts: 0, gapCount: 0, stopReason: null, failureMessage: null };
}

/** 월요일 09:00 부터 count 개의 1분봉 */
function minutes(symbol: string, count: number, startTsMs = MON_0900_KST): Candle[] {
  return Array.from({ length: count }, (_, i) => minuteCandle(symbol, startTsMs + i * MINUTE));
}

describe('BrokerSyncService (설계 2026-07-28-broker-sync-design.md)', () => {
  it('backfills a 1h dataset to the API bottom, aggregating full 1h buckets', async () => {
    const source = new FakeSource(minutes('005930', 90)); // 09:00~10:29 → 1h 버킷 2개
    const { repo, datasetService, sync } = buildHarness(source);
    const dataset = datasetService.createBrokerDataset('KR-유니버스', 'KR', '1m', ['005930']);

    const { job, done } = sync.startSync(dataset.id);
    await done;

    const finished = datasetService.getImportJob(job.id);
    expect(finished?.status).toBe('COMPLETED');
    expect(finished?.rowsImported).toBe(90);
    expect(finished?.sourceType).toBe('BROKER');

    expect(repo.all(dataset.id, '1m')).toHaveLength(90);
    // 페이지 크기 4로 시간 버킷이 쪼개져도 재집계는 저장소 전체 기준 — 반쪽 시간봉 없음
    const hourly = repo.all(dataset.id, '1h');
    expect(hourly.map((c) => c.tsMs)).toEqual([MON_0900_KST, MON_0900_KST + 60 * MINUTE]);
    expect(hourly[0]?.volume).toBe(60 * 10);
    expect(hourly[1]?.volume).toBe(30 * 10);
  });

  it('marks backfill done and records the synced watermark', async () => {
    const source = new FakeSource(minutes('005930', 10));
    const { db, datasetService, sync } = buildHarness(source);
    const dataset = datasetService.createBrokerDataset('KR-유니버스', 'KR', '1m', ['005930']);

    await sync.startSync(dataset.id).done;

    const state = db.select().from(brokerSyncState).where(eq(brokerSyncState.datasetId, dataset.id)).get();
    expect(state?.backfillDoneAtMs).not.toBeNull();
    expect(state?.syncedFirstTsMs).toBe(MON_0900_KST);
    expect(state?.syncedLastTsMs).toBe(MON_0900_KST + 9 * MINUTE);
  });

  it('bumps the dataset version and refreshes coverage on completion', async () => {
    const source = new FakeSource(minutes('005930', 10));
    const { datasetService, sync } = buildHarness(source);
    const dataset = datasetService.createBrokerDataset('KR-유니버스', 'KR', '1m', ['005930']);

    await sync.startSync(dataset.id).done;

    expect(datasetService.getLatestVersion(dataset.id)?.version).toBe(1);
    expect(datasetService.getCoverage(dataset.id).length).toBeGreaterThan(0);
  });

  it('second sync fetches only newer candles (incremental, no bottom re-scan)', async () => {
    const source = new FakeSource(minutes('005930', 10));
    const { repo, datasetService, sync } = buildHarness(source);
    const dataset = datasetService.createBrokerDataset('KR-유니버스', 'KR', '1m', ['005930']);
    await sync.startSync(dataset.id).done;

    // 다음 날 봉 5개 추가
    source.candles.push(...minutes('005930', 5, MON_0900_KST + DAY));
    source.calls = [];
    await sync.startSync(dataset.id).done;

    expect(repo.all(dataset.id, '1m')).toHaveLength(15);
    // 백필 완료 상태이므로 모든 호출의 fromTsMs 는 기존 워터마크 이후여야 한다
    expect(source.calls.length).toBeGreaterThan(0);
    for (const call of source.calls) {
      expect(call.fromTsMs).toBe(MON_0900_KST + 9 * MINUTE + 1);
    }
  });

  it('resumes an interrupted backfill from the oldest synced candle', async () => {
    const all = minutes('005930', 12);
    const source = new FakeSource(all);
    // 2페이지째에서 죽는 소스
    let calls = 0;
    const flaky: MarketDataSource = {
      fetchCandles(request) {
        calls += 1;
        if (calls === 2) return Promise.reject(new Error('network down'));
        return source.fetchCandles(request);
      },
    };
    const { db, repo, datasetService, sync } = buildHarness(flaky);
    const dataset = datasetService.createBrokerDataset('KR-유니버스', 'KR', '1m', ['005930']);

    const first = sync.startSync(dataset.id);
    await first.done;
    expect(datasetService.getImportJob(first.job.id)?.status).toBe('FAILED');
    const saved = repo.all(dataset.id, '1m').length;
    expect(saved).toBe(4); // 첫 페이지는 저장됨 — 진행이 유실되지 않는다

    const second = sync.startSync(dataset.id);
    await second.done;
    expect(datasetService.getImportJob(second.job.id)?.status).toBe('COMPLETED');
    expect(repo.all(dataset.id, '1m')).toHaveLength(12);
    const state = db.select().from(brokerSyncState).where(eq(brokerSyncState.datasetId, dataset.id)).get();
    expect(state?.backfillDoneAtMs).not.toBeNull();
  });

  it('syncs a 1d dataset without hourly aggregation', async () => {
    const source = new FakeSource([
      dailyCandle('005930', MON_0900_KST),
      dailyCandle('005930', MON_0900_KST + DAY),
    ]);
    const { repo, datasetService, sync } = buildHarness(source);
    const dataset = datasetService.createBrokerDataset('KR-일봉', 'KR', '1d', ['005930']);

    const { job, done } = sync.startSync(dataset.id);
    await done;

    expect(datasetService.getImportJob(job.id)?.status).toBe('COMPLETED');
    expect(repo.all(dataset.id, '1d')).toHaveLength(2);
    expect(repo.all(dataset.id, '1h')).toHaveLength(0);
  });

  it('records a FAILED job with CSV guidance when the source is not configured', async () => {
    const notConfigured: MarketDataSource = {
      fetchCandles: () => Promise.reject(new MarketDataSourceNotConfiguredError()),
    };
    const { datasetService, sync } = buildHarness(notConfigured);
    const dataset = datasetService.createBrokerDataset('KR-유니버스', 'KR', '1m', ['005930']);

    const { job, done } = sync.startSync(dataset.id);
    await done;

    const finished = datasetService.getImportJob(job.id);
    expect(finished?.status).toBe('FAILED');
    expect(finished?.error).toContain('CSV');
  });

  it('rejects concurrent sync on the same dataset', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const slow: MarketDataSource = {
      fetchCandles: async () => {
        await gate;
        return { candles: [], hasMore: false };
      },
    };
    const { datasetService, sync } = buildHarness(slow);
    const dataset = datasetService.createBrokerDataset('KR-유니버스', 'KR', '1m', ['005930']);

    const first = sync.startSync(dataset.id);
    expect(() => sync.startSync(dataset.id)).toThrow(SyncAlreadyRunningError);
    release();
    await first.done;
  });

  /**
   * 슬라이스 모델 전환 전에는 datasets.timeframe 원본 값이 '1h'|'1d' 가 아니면
   * (예: 레거시 오염 데이터의 '1m') collectTimeframe 이 SyncUnsupportedDatasetError 로
   * 막았다. 전환 후에는 defaultTimeframe('1d'|'1m') 이 유일한 근거이고
   * legacyConsumeDefault 가 그 두 값을 전부 '1h'|'1d' 로 총사상하므로, 이 경로로는
   * 더 이상 도달 불가능한 방어다 — defaultTimeframe 컬럼을 지정하지 않은(레거시) 행도
   * DB 기본값 '1d' 로 채워져 정상적으로 수집된다. 방어 코드 자체는 유지하되(Task 4 가
   * 슬라이스별 동기화를 재정비할 때 재평가), 이 테스트는 현재 실제 동작(우아한 성공)으로
   * 갱신한다.
   */
  it('legacy 행(defaultTimeframe 미지정)도 DB 기본값 1d 로 정상 동기화된다', async () => {
    const { db, datasetService, sync, clock } = buildHarness(
      new FakeSource([dailyCandle('005930', MON_0900_KST)]),
    );
    db.insert(
      // 직접 삽입 — createBrokerDataset 은 1m/1d 만 허용하므로 우회해서 레거시 행을 재현한다
      (await import('../../src/server/shared/db/schema.js')).datasets,
    )
      .values({
        id: 'ds_raw1m',
        name: 'raw',
        market: 'KR',
        // defaultTimeframe 미지정 → 컬럼 기본값 '1d' 가 채워진다
        symbolsJson: '["005930"]',
        createdAtMs: clock.now(),
        updatedAtMs: clock.now(),
      })
      .run();

    let result: { job: { id: string }; done: Promise<void> } | undefined;
    expect(() => {
      result = sync.startSync('ds_raw1m');
    }).not.toThrow();
    await result?.done;

    // done 은 실패해도 reject 하지 않는다(실패는 job 레코드에 기록된다) — 상태를 직접 확인해야
    // "예외를 안 던졌다"는 것과 "실제로 완료됐다"를 혼동하지 않는다
    const finished = datasetService.getImportJob(result!.job.id);
    expect(finished?.status).toBe('COMPLETED');

    const state = db
      .select()
      .from(brokerSyncState)
      .where(eq(brokerSyncState.datasetId, 'ds_raw1m'))
      .get();
    expect(state?.slice).toBe('1d');
    expect(state?.backfillDoneAtMs).not.toBeNull();
  });

  it('fails the job before fetching when free disk is below the threshold', async () => {
    const source = new FakeSource(minutes('005930', 10));
    const { repo, datasetService, sync } = buildHarness(source, {
      minFreeDiskBytes: 2 * 1024 ** 3,
      freeDiskBytes: () => 1024 ** 3,
    });
    const dataset = datasetService.createBrokerDataset('KR-유니버스', 'KR', '1m', ['005930']);

    const { job, done } = sync.startSync(dataset.id);
    await done;

    const finished = datasetService.getImportJob(job.id);
    expect(finished?.status).toBe('FAILED');
    expect(finished?.error).toContain('디스크');
    expect(source.calls).toHaveLength(0);
    expect(repo.all(dataset.id, '1m')).toHaveLength(0);
  });

  it('terminates on an empty page with hasMore=true instead of looping forever', async () => {
    const broken: MarketDataSource = {
      fetchCandles: async () => ({ candles: [], hasMore: true }),
    };
    const { datasetService, sync } = buildHarness(broken);
    const dataset = datasetService.createBrokerDataset('KR-유니버스', 'KR', '1m', ['005930']);

    const { job, done } = sync.startSync(dataset.id);
    await done;
    // 진행 없는 응답은 중단하되 실패로 기록한다 — 조용히 완료로 위장하지 않는다
    expect(datasetService.getImportJob(job.id)?.status).toBe('FAILED');
  });

  it('batches page saves instead of rewriting the partition per page (쓰기 증폭 방지)', async () => {
    // 90봉 · 페이지 4봉 = 23페이지. 페이지마다 저장하면 파티션 재작성 23회 —
    // 운영 장애(메모리 고갈)의 근본 원인이었다. 배칭 후엔 1m 저장이 소수여야 한다.
    const source = new FakeSource(minutes('005930', 90));
    const { repo, datasetService, sync } = buildHarness(source);
    const dataset = datasetService.createBrokerDataset('KR-유니버스', 'KR', '1m', ['005930']);

    await sync.startSync(dataset.id).done;

    const minuteSaves = repo.saveInvocations.filter((batch) => batch[0]?.timeframe === '1m');
    expect(minuteSaves.length).toBeLessThanOrEqual(2);
    expect(repo.all(dataset.id, '1m')).toHaveLength(90);
  });

  it('cancels a running sync at a page boundary and resumes on the next run', async () => {
    const inner = new FakeSource(minutes('005930', 12));
    let fetches = 0;
    const ref: { sync: BrokerSyncService | null; jobId: string } = { sync: null, jobId: '' };
    const source: MarketDataSource = {
      async fetchCandles(request) {
        await Promise.resolve(); // startSync 반환 이후에 몸체가 돌도록 양보
        fetches += 1;
        if (fetches === 2) ref.sync?.cancelSync(ref.jobId);
        return inner.fetchCandles(request);
      },
    };
    const { repo, datasetService, sync } = buildHarness(source);
    ref.sync = sync;
    const dataset = datasetService.createBrokerDataset('KR-유니버스', 'KR', '1m', ['005930']);

    const started = sync.startSync(dataset.id);
    ref.jobId = started.job.id;
    await started.done;

    const cancelled = datasetService.getImportJob(started.job.id);
    expect(cancelled?.status).toBe('CANCELLED');
    // 취소 시점(2페이지째 요청 중)까지 저장된 봉은 남는다 — 페이지 경계 취소
    expect(repo.all(dataset.id, '1m')).toHaveLength(8);

    // 재실행이 이어받아 끝까지 간다
    const resumed = sync.startSync(dataset.id);
    await resumed.done;
    expect(datasetService.getImportJob(resumed.job.id)?.status).toBe('COMPLETED');
    expect(repo.all(dataset.id, '1m')).toHaveLength(12);
  });

  it('reports NOT_RUNNING when cancelling an unknown or finished job', async () => {
    const { datasetService, sync } = buildHarness(new FakeSource(minutes('005930', 4)));
    const dataset = datasetService.createBrokerDataset('KR-유니버스', 'KR', '1m', ['005930']);
    expect(sync.cancelSync('imp_unknown')).toBe('NOT_RUNNING');

    const started = sync.startSync(dataset.id);
    await started.done;
    expect(sync.cancelSync(started.job.id)).toBe('NOT_RUNNING');
  });

  it('recovers orphaned RUNNING jobs on boot', async () => {
    const { db, datasetService, sync, clock } = buildHarness(new FakeSource([]));
    const dataset = datasetService.createBrokerDataset('KR-유니버스', 'KR', '1m', ['005930']);
    db.insert(dataImportJobs)
      .values({
        id: 'imp_orphan',
        datasetId: dataset.id,
        status: 'RUNNING',
        sourceType: 'BROKER',
        createdAtMs: clock.now(),
      })
      .run();

    const recovered = sync.recoverInterrupted();

    expect(recovered).toBe(1);
    const job = datasetService.getImportJob('imp_orphan');
    expect(job?.status).toBe('FAILED');
    expect(job?.error).toContain('중단');
  });
});

describe('BrokerSyncService 재무 단계', () => {
  it('includeFacts 없이는 factsPhase 를 부르지 않고 factsJson 이 null 이다', async () => {
    let called = false;
    const harness = buildHarness(new FakeSource(minutes('005930', 10)), {
      factsPhase: async () => {
        called = true;
        return emptyFactResult();
      },
    });
    const dataset = harness.datasetService.createBrokerDataset('KR-유니버스', 'KR', '1m', ['005930']);

    const { job, done } = harness.sync.startSync(dataset.id);
    await done;

    expect(called).toBe(false);
    const row = jobRow(harness, job.id);
    expect(row?.factsJson).toBeNull();
    expect(row?.candlesMs).not.toBeNull();
    expect(row?.phase).toBeNull();
    expect(row?.status).toBe('COMPLETED');
  });

  it('includeFacts 면 봉 뒤에 재무를 돌리고 결과를 factsJson 에 남긴다', async () => {
    const seen: Array<{ fromYear: number; toYear: number; candlesSaved: number; phase: string | null }> = [];
    const ref = { jobId: '' };
    const harness: Harness = buildHarness(new FakeSource(minutes('005930', 10)), {
      factsPhase: async ({ datasetId, fromYear, toYear, onProgress }) => {
        // 봉이 이미 저장된 뒤에, 잡 단계가 FACTS 로 바뀐 상태에서 불려야 한다 —
        // 폴링 중인 UI 가 "재무 중" 을 볼 수 있는지가 이 단계의 계약이다
        const inflight = jobRow(harness, ref.jobId);
        seen.push({
          fromYear,
          toYear,
          candlesSaved: harness.repo.all(datasetId, '1m').length,
          phase: inflight?.phase ?? null,
        });
        onProgress({ symbolsDone: 1, symbolTotal: 1, savedFacts: 12, gapCount: 3 });
        return { savedFacts: 12, gapCount: 3, stopReason: null, failureMessage: null };
      },
    });
    const dataset = harness.datasetService.createBrokerDataset('KR-유니버스', 'KR', '1m', ['005930']);

    const { job, done } = harness.sync.startSync(dataset.id, { includeFacts: true });
    ref.jobId = job.id;
    await done;

    // 봉은 2026-07-06 (KST) 뿐 — 연도 범위도 그 해로 좁혀진다
    expect(seen).toEqual([{ fromYear: 2026, toYear: 2026, candlesSaved: 10, phase: 'FACTS' }]);
    const row = jobRow(harness, job.id);
    const facts = requireFacts(row);
    expect(facts.savedFacts).toBe(12);
    expect(facts.gapCount).toBe(3);
    expect(facts.symbolsDone).toBe(1);
    expect(facts.fromYear).toBe(2026);
    expect(facts.skipReason).toBeNull();
    expect(row?.status).toBe('COMPLETED');
    expect(row?.rowsImported).toBe(10);
    expect(row?.phase).toBeNull();
  });

  it('onProgress 마다 진행을 factsJson 에 적는다 (조용한 45분과 멈춤을 구분한다)', async () => {
    const persisted: Array<Pick<FactsJobState, 'symbolsDone' | 'symbolTotal' | 'savedFacts' | 'gapCount'>> = [];
    const ref = { jobId: '' };
    const harness: Harness = buildHarness(new FakeSource(minutes('005930', 10)), {
      factsPhase: async ({ onProgress }) => {
        // 넘긴 인자가 아니라 **저장된** 행을 읽는다 — 폴링하는 화면이 보는 것이 그것이다.
        // symbolTotal 을 데이터셋 종목 수(1)와 다른 2 로 주어 초기 상태가 아니라
        // onProgress 가 쓴 값이 남는 것까지 확인한다.
        const snapshot = () => {
          const facts = requireFacts(jobRow(harness, ref.jobId));
          return {
            symbolsDone: facts.symbolsDone,
            symbolTotal: facts.symbolTotal,
            savedFacts: facts.savedFacts,
            gapCount: facts.gapCount,
          };
        };
        onProgress({ symbolsDone: 1, symbolTotal: 2, savedFacts: 7, gapCount: 1 });
        persisted.push(snapshot());
        onProgress({ symbolsDone: 2, symbolTotal: 2, savedFacts: 19, gapCount: 4 });
        persisted.push(snapshot());
        return { savedFacts: 19, gapCount: 4, stopReason: null, failureMessage: null };
      },
    });
    const dataset = harness.datasetService.createBrokerDataset('KR-유니버스', 'KR', '1m', ['005930']);

    const started = harness.sync.startSync(dataset.id, { includeFacts: true });
    ref.jobId = started.job.id;
    await started.done;

    expect(persisted).toEqual([
      { symbolsDone: 1, symbolTotal: 2, savedFacts: 7, gapCount: 1 },
      { symbolsDone: 2, symbolTotal: 2, savedFacts: 19, gapCount: 4 },
    ]);
    expect(jobRow(harness, started.job.id)?.status).toBe('COMPLETED');
  });

  it('봉이 하나도 없으면 재무를 건너뛰고 사유를 남긴다', async () => {
    let called = false;
    const harness = buildHarness(new FakeSource([]), {
      factsPhase: async () => {
        called = true;
        return emptyFactResult();
      },
    });
    const dataset = harness.datasetService.createBrokerDataset('KR-유니버스', 'KR', '1m', ['005930']);

    const { job, done } = harness.sync.startSync(dataset.id, { includeFacts: true });
    await done;

    expect(called).toBe(false);
    const row = jobRow(harness, job.id);
    expect(requireFacts(row).skipReason).toContain('봉이 수집되지 않아');
    // 건너뛴 것은 실패가 아니다 — 봉 단계는 성공했다
    expect(row?.status).toBe('COMPLETED');
  });

  it('재무 단계가 실패해도 봉 결과(rowsImported)는 남는다', async () => {
    const harness = buildHarness(new FakeSource(minutes('005930', 10)), {
      factsPhase: async () => ({
        savedFacts: 5,
        gapCount: 0,
        stopReason: 'ERROR' as const,
        failureMessage: 'DART 응답 오류 020: 사용 한도 초과',
      }),
    });
    const dataset = harness.datasetService.createBrokerDataset('KR-유니버스', 'KR', '1m', ['005930']);

    const { job, done } = harness.sync.startSync(dataset.id, { includeFacts: true });
    await done;

    const row = jobRow(harness, job.id);
    expect(row?.status).toBe('FAILED');
    expect(row?.rowsImported).toBe(10);
    expect(row?.error).toContain('한도 초과');
    const facts = requireFacts(row);
    expect(facts.savedFacts).toBe(5);
    expect(facts.failureMessage).toContain('한도 초과');
  });

  it('재무 단계 취소는 CANCELLED 로 기록된다', async () => {
    const harness = buildHarness(new FakeSource(minutes('005930', 10)), {
      factsPhase: async () => ({
        savedFacts: 2,
        gapCount: 0,
        stopReason: 'CANCELLED' as const,
        failureMessage: '수집이 사용자 요청으로 취소됐습니다',
      }),
    });
    const dataset = harness.datasetService.createBrokerDataset('KR-유니버스', 'KR', '1m', ['005930']);

    const { job, done } = harness.sync.startSync(dataset.id, { includeFacts: true });
    await done;

    const row = jobRow(harness, job.id);
    expect(row?.status).toBe('CANCELLED');
    expect(row?.rowsImported).toBe(10);
    expect(requireFacts(row).savedFacts).toBe(2);
  });

  it('한 번의 취소가 두 단계에 모두 전달된다 (shouldStop 이 같은 집합을 읽는다)', async () => {
    const observed: boolean[] = [];
    const ref = { jobId: '' };
    const harness: Harness = buildHarness(new FakeSource(minutes('005930', 10)), {
      factsPhase: async ({ shouldStop }) => {
        observed.push(shouldStop());
        harness.sync.cancelSync(ref.jobId);
        observed.push(shouldStop());
        return { savedFacts: 0, gapCount: 0, stopReason: 'CANCELLED' as const, failureMessage: '취소됨' };
      },
    });
    const dataset = harness.datasetService.createBrokerDataset('KR-유니버스', 'KR', '1m', ['005930']);

    const started = harness.sync.startSync(dataset.id, { includeFacts: true });
    ref.jobId = started.job.id;
    await started.done;

    expect(observed).toEqual([false, true]);
    expect(jobRow(harness, started.job.id)?.status).toBe('CANCELLED');
  });

  it('factsPhase 가 주입되지 않았으면 includeFacts 를 건너뛴다', async () => {
    const harness = buildHarness(new FakeSource(minutes('005930', 10)));
    const dataset = harness.datasetService.createBrokerDataset('KR-유니버스', 'KR', '1m', ['005930']);

    const { job, done } = harness.sync.startSync(dataset.id, { includeFacts: true });
    await done;

    const row = jobRow(harness, job.id);
    expect(requireFacts(row).skipReason).toContain('DART');
    expect(row?.status).toBe('COMPLETED');
  });

  /**
   * DART 는 국내 공시 기관이다 — 비KR 데이터셋은 재무 단계에 들어가기 전에 걸러야 한다.
   * `deriveFactYearRange` 가 `getSessionForMarket` 을 부르므로 가드가 없으면 예외가
   * `factsPhase` 를 감싼 try **밖**에서 올라가 봉 결과까지 실패로 덮는다 (스펙 §2).
   */
  it('비KR 데이터셋은 재무를 건너뛰고 봉 결과를 남긴다', async () => {
    let called = false;
    const harness = buildHarness(new FakeSource([dailyCandle('AAPL', MON_0900_KST)]), {
      factsPhase: async () => {
        called = true;
        return emptyFactResult();
      },
    });
    // US 는 생성 경로가 막으므로(D-006) 행을 직접 넣는다. 세션이 정의되는 날 봉 단계가
    // 통과하면서 이 경로가 살아나고, 그때 재무로 흘러가면 국내 공시를 외국 종목에 붙인다.
    harness.db
      .insert(datasets)
      .values({
        id: 'ds-us',
        name: 'US-유니버스',
        market: 'US',
        symbolsJson: JSON.stringify(['AAPL']),
        description: null,
        createdAtMs: 1,
        updatedAtMs: 1,
      })
      .run();
    // 봉 단계의 refreshCoverage 도 세션을 부른다 — 여기서 보려는 것은 재무 가드뿐이므로 무력화
    harness.datasetService.refreshCoverage = async () => {};

    const { job, done } = harness.sync.startSync('ds-us', { includeFacts: true });
    await done;

    expect(called).toBe(false);
    const row = jobRow(harness, job.id);
    expect(requireFacts(row).skipReason).toContain('국내');
    // 건너뛴 것은 실패가 아니다 — 봉 단계는 성공했다
    expect(row?.status).toBe('COMPLETED');
    expect(row?.rowsImported).toBe(1);
  });

  it('factsPhase 가 예외를 던져도 봉 결과를 덮지 않고 재무 실패로 기록한다', async () => {
    const harness = buildHarness(new FakeSource(minutes('005930', 10)), {
      factsPhase: () => Promise.reject(new Error('DART 서버 연결 실패')),
    });
    const dataset = harness.datasetService.createBrokerDataset('KR-유니버스', 'KR', '1m', ['005930']);

    const { job, done } = harness.sync.startSync(dataset.id, { includeFacts: true });
    await done;

    const row = jobRow(harness, job.id);
    expect(row?.status).toBe('FAILED');
    expect(row?.rowsImported).toBe(10);
    expect(row?.candlesMs).not.toBeNull();
    expect(requireFacts(row).failureMessage).toContain('DART 서버 연결 실패');
  });
});

describe('슬라이스별 동기화', () => {
  it('slice 를 주면 그 봉을 수집한다 — 일봉 기본 데이터셋에서 분봉 동기화', async () => {
    const source = new FakeSource(minutes('005930', 10));
    const { db, datasetService, sync } = buildHarness(source);
    const dataset = datasetService.createBrokerDataset('KR-일봉', 'KR', '1d', ['005930']);
    expect(dataset.defaultTimeframe).toBe('1d');

    const { done } = sync.startSync(dataset.id, { slice: '1m' });
    await done;

    expect(source.calls.length).toBeGreaterThan(0);
    for (const call of source.calls) {
      expect(call.timeframe).toBe('1m');
    }

    const rows = db
      .select()
      .from(brokerSyncState)
      .where(eq(brokerSyncState.datasetId, dataset.id))
      .all();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.slice).toBe('1m');
    expect(rows.some((r) => r.slice === '1d')).toBe(false);
  });

  it('slice 생략 시 defaultTimeframe 을 따른다', async () => {
    const source = new FakeSource([dailyCandle('005930', MON_0900_KST)]);
    const { datasetService, sync } = buildHarness(source);
    const dataset = datasetService.createBrokerDataset('KR-일봉', 'KR', '1d', ['005930']);
    expect(dataset.defaultTimeframe).toBe('1d');

    const { done } = sync.startSync(dataset.id, {});
    await done;

    expect(source.calls.length).toBeGreaterThan(0);
    for (const call of source.calls) {
      expect(call.timeframe).toBe('1d');
    }
  });

  it('같은 (dataset, symbol) 의 1d·1m 워터마크가 서로를 침범하지 않는다', async () => {
    const source = new FakeSource([
      dailyCandle('005930', MON_0900_KST),
      ...minutes('005930', 10),
    ]);
    const { db, datasetService, sync } = buildHarness(source);
    const dataset = datasetService.createBrokerDataset('KR-일봉', 'KR', '1d', ['005930']);

    await sync.startSync(dataset.id, { slice: '1d' }).done;
    await sync.startSync(dataset.id, { slice: '1m' }).done;

    const rows = db
      .select()
      .from(brokerSyncState)
      .where(eq(brokerSyncState.datasetId, dataset.id))
      .all();
    expect(rows).toHaveLength(2);
    const dailyRow = rows.find((r) => r.slice === '1d');
    const minuteRow = rows.find((r) => r.slice === '1m');
    expect(dailyRow?.syncedLastTsMs).toBe(MON_0900_KST);
    expect(minuteRow?.syncedLastTsMs).toBe(MON_0900_KST + 9 * MINUTE);
    expect(dailyRow?.backfillDoneAtMs).not.toBeNull();
    expect(minuteRow?.backfillDoneAtMs).not.toBeNull();
  });
});

describe('DatasetService.createBrokerDataset', () => {
  it('creates a 1h dataset for 1m collection (CSV 관례와 동일 — 백테스트 소비 기준)', () => {
    const { datasetService } = buildHarness(new FakeSource([]));
    const dataset = datasetService.createBrokerDataset('KR-유니버스', 'KR', '1m', ['005930', '000660']);
    expect(dataset.defaultTimeframe).toBe('1m');
    expect(dataset.symbols).toEqual(['000660', '005930']);
  });

  /**
   * 중복은 여기서 접는다 — updateSymbols·importCsv 가 이미 Set 으로 접는 관례이고,
   * 중복이 남으면 재무 쪽 symbolTotal 이 부풀고 봉 쪽도 같은 종목을 두 번 긁는다
   * (스펙 §3). 400 으로 거부하지 않는 이유: 무해한 입력이고 결과가 모호하지 않다.
   */
  it('중복 심볼은 한 번만 저장한다', () => {
    const { datasetService } = buildHarness(new FakeSource([]));
    const dataset = datasetService.createBrokerDataset('KR-중복', 'KR', '1d', [
      '005930',
      '005930',
      '000660',
    ]);
    expect(dataset.symbols).toEqual(['000660', '005930']);
  });

  it('creates a 1d dataset for daily collection and rejects invalid symbols', () => {
    const { datasetService } = buildHarness(new FakeSource([]));
    expect(
      datasetService.createBrokerDataset('KR-일봉', 'KR', '1d', ['005930']).defaultTimeframe,
    ).toBe('1d');
    expect(() => datasetService.createBrokerDataset('x', 'KR', '1d', ['bad symbol!'])).toThrow();
    expect(() => datasetService.createBrokerDataset('y', 'KR', '1d', [])).toThrow();
  });
});

describe('DatasetService.updateSymbols (유니버스 밸브)', () => {
  it('adds and removes symbols, bumps the version, keeps stored candles of removed symbols', async () => {
    const source = new FakeSource(minutes('005930', 10));
    const { repo, datasetService, sync } = buildHarness(source);
    const dataset = datasetService.createBrokerDataset('KR-유니버스', 'KR', '1m', ['005930']);
    await sync.startSync(dataset.id).done;
    const versionAfterSync = datasetService.getLatestVersion(dataset.id)?.version;

    const updated = datasetService.updateSymbols(dataset.id, {
      add: ['000660'],
      remove: ['005930'],
    });

    expect(updated.symbols).toEqual(['000660']);
    expect(datasetService.getLatestVersion(dataset.id)?.version).toBe((versionAfterSync ?? 0) + 1);
    // 제거는 수집 중단 밸브 — 이미 쌓인 봉은 지우지 않는다 (재추가 시 이어받기)
    expect(repo.all(dataset.id, '1m').length).toBeGreaterThan(0);
  });

  it('rejects updates that would leave no symbols and invalid symbols', () => {
    const { datasetService } = buildHarness(new FakeSource([]));
    const dataset = datasetService.createBrokerDataset('KR-유니버스', 'KR', '1m', ['005930']);
    expect(() => datasetService.updateSymbols(dataset.id, { remove: ['005930'] })).toThrow(/최소 1개/);
    expect(() => datasetService.updateSymbols(dataset.id, { add: ['bad symbol!'] })).toThrow();
    expect(() => datasetService.updateSymbols('ds_missing', { add: ['000660'] })).toThrow(/찾을 수 없/);
  });
});

describe('DatasetService.deleteDataset', () => {
  it('deletes DB rows and physical candles', async () => {
    const source = new FakeSource(minutes('005930', 10));
    const { db, repo, datasetService, sync } = buildHarness(source);
    const dataset = datasetService.createBrokerDataset('KR-유니버스', 'KR', '1m', ['005930']);
    await sync.startSync(dataset.id).done;
    expect(repo.all(dataset.id, '1m').length).toBeGreaterThan(0);

    await datasetService.deleteDataset(dataset.id);

    expect(datasetService.getDataset(dataset.id)).toBeNull();
    expect(repo.all(dataset.id, '1m')).toHaveLength(0);
    // cascade: sync 상태도 함께 사라진다
    const state = db.select().from(brokerSyncState).where(eq(brokerSyncState.datasetId, dataset.id)).all();
    expect(state).toHaveLength(0);
  });

  it('refuses to delete while a sync job is running', async () => {
    const { db, datasetService, clock } = buildHarness(new FakeSource([]));
    const dataset = datasetService.createBrokerDataset('KR-유니버스', 'KR', '1m', ['005930']);
    db.insert(dataImportJobs)
      .values({
        id: 'imp_busy',
        datasetId: dataset.id,
        status: 'RUNNING',
        sourceType: 'BROKER',
        createdAtMs: clock.now(),
      })
      .run();

    await expect(datasetService.deleteDataset(dataset.id)).rejects.toThrow(/실행 중/);
    expect(datasetService.getDataset(dataset.id)).not.toBeNull();
  });
});
