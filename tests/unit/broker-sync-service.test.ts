import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  BrokerSyncService,
  SyncAlreadyRunningError,
  SyncUnsupportedDatasetError,
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
import { brokerSyncState, dataImportJobs } from '../../src/server/shared/db/schema.js';
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

  private key(datasetId: string, c: Candle): string {
    return `${datasetId}:${c.symbol}:${c.timeframe}:${c.tsMs}`;
  }

  async saveCandles(datasetId: string, candles: readonly Candle[]): Promise<void> {
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

function buildHarness(source: MarketDataSource, options: { minFreeDiskBytes?: number; freeDiskBytes?: () => number } = {}) {
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
  });
  return { db: handle.db, repo, datasetService, sync, clock };
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

  it('rejects datasets whose timeframe has no collectable source timeframe', async () => {
    const { db, sync, clock } = buildHarness(new FakeSource([]));
    db.insert(
      // 직접 삽입 — createBrokerDataset 은 1m/1d 만 허용하므로 우회해서 방어를 검증한다
      (await import('../../src/server/shared/db/schema.js')).datasets,
    )
      .values({
        id: 'ds_raw1m',
        name: 'raw',
        market: 'KR',
        timeframe: '1m',
        symbolsJson: '["005930"]',
        createdAtMs: clock.now(),
        updatedAtMs: clock.now(),
      })
      .run();

    expect(() => sync.startSync('ds_raw1m')).toThrow(SyncUnsupportedDatasetError);
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

describe('DatasetService.createBrokerDataset', () => {
  it('creates a 1h dataset for 1m collection (CSV 관례와 동일 — 백테스트 소비 기준)', () => {
    const { datasetService } = buildHarness(new FakeSource([]));
    const dataset = datasetService.createBrokerDataset('KR-유니버스', 'KR', '1m', ['005930', '000660']);
    expect(dataset.timeframe).toBe('1h');
    expect(dataset.symbols).toEqual(['000660', '005930']);
  });

  it('creates a 1d dataset for daily collection and rejects invalid symbols', () => {
    const { datasetService } = buildHarness(new FakeSource([]));
    expect(datasetService.createBrokerDataset('KR-일봉', 'KR', '1d', ['005930']).timeframe).toBe('1d');
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
