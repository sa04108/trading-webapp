import { describe, expect, it } from 'vitest';
import { DatasetService } from '../../src/server/modules/market-data/application/dataset-service.js';
import type { CandleRepository } from '../../src/server/modules/market-data/application/ports.js';
import type { Candle } from '../../src/server/modules/market-data/domain/candle.js';
import { loadConfig } from '../../src/server/bootstrap/config.js';
import { openDatabase } from '../../src/server/shared/db/database.js';
import { brokerSyncState, dataImportJobs, datasets } from '../../src/server/shared/db/schema.js';
import { createLogger } from '../../src/server/shared/logger.js';
import type { AuditLogService } from '../../src/server/modules/audit/audit-service.js';

const logger = createLogger(loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'error' }));
const noopAudit: AuditLogService = { record: () => {} } as unknown as AuditLogService;

/** getCandleSyncEstimate 는 캔들 저장소를 건드리지 않으므로 최소 스텁으로 충분하다 */
const stubRepository: CandleRepository = {
  // eslint-disable-next-line require-yield
  getCandles: async function* (): AsyncIterable<Candle> {
    throw new Error('사용되지 않아야 한다');
  },
  getTimestamps: async () => [],
  saveCandles: async () => {},
  deleteDataset: async () => {},
};

function setup() {
  const database = openDatabase(':memory:');
  database.db
    .insert(datasets)
    .values({
      id: 'ds-1',
      name: 'test',
      market: 'KR',
      timeframe: '1d',
      symbolsJson: JSON.stringify(['005930', '000660']),
      description: null,
      createdAtMs: 1,
      // datasets.updated_at_ms 는 NOT NULL 이다 — 빠뜨리면 insert 가 제약 위반으로 죽는다
      updatedAtMs: 1,
    })
    .run();
  return database;
}

function makeDatasetService(database: ReturnType<typeof setup>) {
  const clock = { now: () => Date.UTC(2026, 6, 8, 12, 0) };
  return new DatasetService(database.db, stubRepository, clock, logger, noopAudit);
}

function insertJob(
  database: ReturnType<typeof setup>,
  args: { id: string; createdAtMs: number; candlesMs: number | null; status?: string },
) {
  database.db
    .insert(dataImportJobs)
    .values({
      id: args.id,
      datasetId: 'ds-1',
      status: args.status ?? 'COMPLETED',
      sourceType: 'BROKER',
      createdAtMs: args.createdAtMs,
      completedAtMs: args.createdAtMs + (args.candlesMs ?? 0),
      candlesMs: args.candlesMs,
    })
    .run();
}

function markBackfillDone(database: ReturnType<typeof setup>, symbol: string, atMs: number) {
  database.db
    .insert(brokerSyncState)
    .values({ datasetId: 'ds-1', symbol, backfillDoneAtMs: atMs })
    .run();
}

describe('getCandleSyncEstimate', () => {
  it('백필이 끝나지 않은 종목이 있으면 UNKNOWN 이다', () => {
    const database = setup();
    markBackfillDone(database, '005930', 1_000);
    insertJob(database, { id: 'imp-1', createdAtMs: 2_000, candlesMs: 60_000 });
    const service = makeDatasetService(database);
    expect(service.getCandleSyncEstimate('ds-1', ['005930', '000660'])).toEqual({
      basis: 'UNKNOWN',
    });
    database.close();
  });

  it('백필 완료 이전에 시작된 잡은 쓰지 않는다', () => {
    const database = setup();
    markBackfillDone(database, '005930', 5_000);
    markBackfillDone(database, '000660', 5_000);
    // 백필을 포함한 실행 — 증분 예상치로 쓰면 과대 추정이 된다
    insertJob(database, { id: 'imp-1', createdAtMs: 1_000, candlesMs: 3_600_000 });
    const service = makeDatasetService(database);
    expect(service.getCandleSyncEstimate('ds-1', ['005930', '000660'])).toEqual({
      basis: 'UNKNOWN',
    });
    database.close();
  });

  it('백필 완료 이후의 최신 COMPLETED 잡 실측치를 쓴다', () => {
    const database = setup();
    markBackfillDone(database, '005930', 5_000);
    markBackfillDone(database, '000660', 5_000);
    insertJob(database, { id: 'imp-1', createdAtMs: 6_000, candlesMs: 60_000 });
    insertJob(database, { id: 'imp-2', createdAtMs: 7_000, candlesMs: 30_000 });
    const service = makeDatasetService(database);
    expect(service.getCandleSyncEstimate('ds-1', ['005930', '000660'])).toEqual({
      basis: 'LAST_RUN',
      ms: 30_000,
    });
    database.close();
  });

  it('candlesMs 가 없는 옛 잡은 건너뛴다', () => {
    const database = setup();
    markBackfillDone(database, '005930', 5_000);
    markBackfillDone(database, '000660', 5_000);
    insertJob(database, { id: 'imp-1', createdAtMs: 6_000, candlesMs: 60_000 });
    insertJob(database, { id: 'imp-2', createdAtMs: 7_000, candlesMs: null });
    const service = makeDatasetService(database);
    expect(service.getCandleSyncEstimate('ds-1', ['005930', '000660'])).toEqual({
      basis: 'LAST_RUN',
      ms: 60_000,
    });
    database.close();
  });

  it('candlesMs 가 0 인 잡도 측정값으로 쓴다 — 0 은 falsy 지만 측정 없음이 아니다', () => {
    const database = setup();
    markBackfillDone(database, '005930', 5_000);
    markBackfillDone(database, '000660', 5_000);
    insertJob(database, { id: 'imp-1', createdAtMs: 6_000, candlesMs: 0 });
    const service = makeDatasetService(database);
    expect(service.getCandleSyncEstimate('ds-1', ['005930', '000660'])).toEqual({
      basis: 'LAST_RUN',
      ms: 0,
    });
    database.close();
  });

  it('실패한 잡은 쓰지 않는다', () => {
    const database = setup();
    markBackfillDone(database, '005930', 5_000);
    markBackfillDone(database, '000660', 5_000);
    insertJob(database, { id: 'imp-1', createdAtMs: 6_000, candlesMs: 60_000, status: 'FAILED' });
    const service = makeDatasetService(database);
    expect(service.getCandleSyncEstimate('ds-1', ['005930', '000660'])).toEqual({
      basis: 'UNKNOWN',
    });
    database.close();
  });
});
