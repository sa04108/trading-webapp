import { describe, expect, it } from 'vitest';
import { SymbolService } from '../../src/server/modules/market-data/application/symbol-service.js';
import type { CandleRepository } from '../../src/server/modules/market-data/application/ports.js';
import type { Candle } from '../../src/server/modules/market-data/domain/candle.js';
import { loadConfig } from '../../src/server/bootstrap/config.js';
import { openDatabase } from '../../src/server/shared/db/database.js';
import {
  symbolSlices,
  dataSyncJobs,
  symbols as symbolsTable,
} from '../../src/server/shared/db/schema.js';
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
  deleteSymbol: async () => {},
};

function setup() {
  const database = openDatabase(':memory:');
  database.db
    .insert(symbolsTable)
    .values([
      { code: '005930', market: 'KR', name: null, createdAtMs: 1 },
      { code: '000660', market: 'KR', name: null, createdAtMs: 1 },
    ])
    .run();
  return database;
}

function makeSymbolService(database: ReturnType<typeof setup>) {
  const clock = { now: () => Date.UTC(2026, 6, 8, 12, 0) };
  return new SymbolService(database.db, stubRepository, clock, logger, noopAudit);
}

function insertJob(
  database: ReturnType<typeof setup>,
  args: { id: string; createdAtMs: number; candlesMs: number | null; status?: string },
) {
  database.db
    .insert(dataSyncJobs)
    .values({
      id: args.id,
      symbolsJson: JSON.stringify(['005930', '000660']),
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
    .insert(symbolSlices)
    .values({ code: symbol, slice: '1d', backfillDoneAtMs: atMs })
    .run();
}

describe('getCandleSyncEstimate', () => {
  it('백필이 끝나지 않은 종목이 있으면 UNKNOWN 이다', () => {
    const database = setup();
    markBackfillDone(database, '005930', 1_000);
    insertJob(database, { id: 'imp-1', createdAtMs: 2_000, candlesMs: 60_000 });
    const service = makeSymbolService(database);
    expect(service.getCandleSyncEstimate(['005930', '000660'], '1d')).toEqual({
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
    const service = makeSymbolService(database);
    expect(service.getCandleSyncEstimate(['005930', '000660'], '1d')).toEqual({
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
    const service = makeSymbolService(database);
    expect(service.getCandleSyncEstimate(['005930', '000660'], '1d')).toEqual({
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
    const service = makeSymbolService(database);
    expect(service.getCandleSyncEstimate(['005930', '000660'], '1d')).toEqual({
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
    const service = makeSymbolService(database);
    expect(service.getCandleSyncEstimate(['005930', '000660'], '1d')).toEqual({
      basis: 'LAST_RUN',
      ms: 0,
    });
    database.close();
  });

  // 재무 단계에서 멈춘 잡은 FAILED/CANCELLED 로 적히지만 봉 단계는 이미 끝나 candlesMs 가
  // 측정돼 있다 — 상태로 거르면 DART 오류 하나가 멀쩡한 봉 실측치를 버린다 (스펙 §6)
  it('재무 단계에서 실패한 잡의 봉 실측치도 쓴다', () => {
    const database = setup();
    markBackfillDone(database, '005930', 5_000);
    markBackfillDone(database, '000660', 5_000);
    insertJob(database, { id: 'imp-1', createdAtMs: 6_000, candlesMs: 60_000, status: 'FAILED' });
    const service = makeSymbolService(database);
    expect(service.getCandleSyncEstimate(['005930', '000660'], '1d')).toEqual({
      basis: 'LAST_RUN',
      ms: 60_000,
    });
    database.close();
  });

  it('취소된 잡의 봉 실측치도 쓴다', () => {
    const database = setup();
    markBackfillDone(database, '005930', 5_000);
    markBackfillDone(database, '000660', 5_000);
    insertJob(database, {
      id: 'imp-1',
      createdAtMs: 6_000,
      candlesMs: 45_000,
      status: 'CANCELLED',
    });
    const service = makeSymbolService(database);
    expect(service.getCandleSyncEstimate(['005930', '000660'], '1d')).toEqual({
      basis: 'LAST_RUN',
      ms: 45_000,
    });
    database.close();
  });

  // 봉 도중에 죽은 잡은 candlesMs 를 남기지 않는다(refreshCoverage 직후에만 채워진다) —
  // 상태 필터를 걷어도 반쪽 측정이 새지 않는 근거다
  it('봉 단계에서 죽어 candlesMs 가 없는 실패 잡은 여전히 건너뛴다', () => {
    const database = setup();
    markBackfillDone(database, '005930', 5_000);
    markBackfillDone(database, '000660', 5_000);
    insertJob(database, { id: 'imp-1', createdAtMs: 6_000, candlesMs: null, status: 'FAILED' });
    const service = makeSymbolService(database);
    expect(service.getCandleSyncEstimate(['005930', '000660'], '1d')).toEqual({
      basis: 'UNKNOWN',
    });
    database.close();
  });
});
