import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { pino } from 'pino';
import { openDatabase, type DatabaseHandle } from '../../src/runtime/shared/db/database.js';
import { dailySelectionMetrics, dailySelectionMetricCoverage, krxDailyBars, providerInputIssues, symbols } from '../../src/runtime/shared/db/data-schema.js';
import { externalApiDailyUsage, krxRawApiSnapshots } from '../../src/server/shared/db/collection-schema.js';
import { SqliteExternalApiUsage } from '../../src/server/shared/db/external-api-usage.js';
import { SqliteProviderRequestPolicy } from '../../src/server/shared/provider-request-policy.js';
import { SqliteKrxRawSnapshotStore } from '../../src/server/modules/market-data/infrastructure/krx/sqlite-krx-raw-snapshot-store.js';
import { createKrxHistoricalUniverseSource } from '../../src/server/modules/market-data/infrastructure/krx/krx-historical-universe-source.js';
import { SymbolMasterService } from '../../src/runtime/modules/market-data/application/symbol-master-service.js';
import { SqliteFactCoverageStore } from '../../src/runtime/modules/facts/application/fact-coverage-store.js';
import { SqliteCorporateActionCoverageStore } from '../../src/runtime/modules/facts/application/corporate-action-coverage.js';
import { PreparationPreviewCache } from '../../src/runtime/modules/backtest/application/preparation-preview-cache.js';
import { baseInfoFixture, dailyFixture, krxEnvelope, startKrxFakeServer } from '../helpers/krx-fixtures.js';

const clock = { now: () => Date.parse('2026-08-04T00:00:00Z') };
const logger = pino({ enabled: false });

function services(database: DatabaseHandle, baseUrl: string, collectionVersion: string, configured: boolean) {
  const usage = new SqliteExternalApiUsage({ database, clock, currentDateKst: () => '2026-08-04' });
  const source = createKrxHistoricalUniverseSource(
    configured ? { baseUrl, apiKey: 'fixture-key', approvalExpiry: null } : null,
    clock, logger,
    { usage, rawNamespace: baseUrl, rawSnapshotStore: new SqliteKrxRawSnapshotStore(database.db), requestPolicy: new SqliteProviderRequestPolicy(database.sqlite, clock.now) },
  );
  return { source, usage, service: new SymbolMasterService({ db: database.db, source, clock, logger, collectionVersion }) };
}

describe('공급자 데이터 재사용 생명주기', () => {
  it('두 DB 이동·재시작·추가 스키마 변경과 실행 해시 변경 뒤 원문과 값을 HTTP 없이 재사용한다', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-reuse-'));
    const server = await startKrxFakeServer();
    let database: DatabaseHandle | undefined;
    try {
      server.setResponse('stk_bydd_trd', '20260803', { body: { ...krxEnvelope([dailyFixture({ ACC_TRDVAL: '1000000', FUTURE_FIELD: '보존' })]), extra: ['배열', '순서'] } });
      server.setResponse('stk_isu_base_info', '20260803', { body: krxEnvelope([baseInfoFixture()]) });
      const originalPath = path.join(dir, 'original.sqlite');
      database = openDatabase(originalPath);
      const first = services(database, server.baseUrl, 'a'.repeat(64), true);
      await first.service.ingestDate('2026-08-03');
      expect(server.requests).toHaveLength(4);
      const savedRows = database.db.select().from(krxDailyBars).all();
      expect(savedRows).toHaveLength(1);
      const savedRaw = database.db.select().from(krxRawApiSnapshots).all();
      expect(savedRaw).toHaveLength(4);
      expect(savedRaw.every((row) => row.fetchedAtMs === clock.now())).toBe(true);
      const savedUsage = database.db.select().from(externalApiDailyUsage).all();
      expect(savedUsage.reduce((sum, row) => sum + row.callsUsed, 0)).toBe(4);
      const coverage = first.service.coverageRanges();
      const parsed = await first.source.fetchDailyTrades('KOSPI', '2026-08-03');
      const originalDataPath = database.dataPath;
      database.close();
      database = undefined;
      const movedPath = path.join(dir, 'moved.sqlite');
      const movedDataPath = path.join(dir, 'moved-data.sqlite');
      fs.copyFileSync(originalPath, movedPath);
      fs.copyFileSync(originalDataPath, movedDataPath);
      database = openDatabase(movedPath, { dataPath: movedDataPath });
      database.sqlite.exec('ALTER TABLE data.krx_daily_bars ADD COLUMN local_annotation TEXT; CREATE INDEX data.provider_reuse_date_idx ON krx_daily_bars(date)');
      database.close();
      database = openDatabase(movedPath, { dataPath: movedDataPath });
      const restarted = services(database, server.baseUrl, 'b'.repeat(64), false);
      expect(await restarted.service.ingestDate('2026-08-03')).toEqual({ kind: 'ALREADY_COVERED' });
      await restarted.service.ensureSelectionMetrics(['2026-08-03']);
      await restarted.service.backfillNonTradingDays('2026-08-03', '2026-08-03');
      expect(await restarted.source.fetchDailyTrades('KOSPI', '2026-08-03')).toEqual(parsed);
      expect(await restarted.source.fetchDailyTrades('KOSDAQ', '2026-08-03')).toEqual([]);
      expect(restarted.service.coverageRanges()).toEqual(coverage);
      expect(database.db.select().from(krxDailyBars).all()).toEqual(savedRows);
      expect(database.db.select().from(krxRawApiSnapshots).all()).toEqual(savedRaw);
      expect(database.db.select().from(externalApiDailyUsage).all()).toEqual(savedUsage);
      expect(restarted.usage.maxCallsUsed('KRX')).toBe(1);
      expect(server.requests).toHaveLength(4);
      const metricCoverage = database.db.select().from(dailySelectionMetricCoverage).all();
      const metrics = database.db.select().from(dailySelectionMetrics).all();
      database.db.delete(krxDailyBars).run();
      database.db.delete(dailySelectionMetrics).run();
      await restarted.service.ingestDate('2026-08-03');
      expect(database.db.select().from(krxDailyBars).all()).toEqual(savedRows);
      expect(database.db.select().from(dailySelectionMetrics).all()).toEqual(metrics);
      database.db.delete(dailySelectionMetrics).run();
      await restarted.service.ensureSelectionMetrics(['2026-08-03']);
      expect(database.db.select().from(dailySelectionMetrics).all()).toEqual(metrics);
      expect(database.db.select().from(dailySelectionMetricCoverage).all()).toEqual(metricCoverage);
      expect(restarted.service.coverageRanges()).toEqual(coverage);
      expect(database.db.select().from(krxRawApiSnapshots).all()).toEqual(savedRaw);
      expect(database.db.select().from(externalApiDailyUsage).all()).toEqual(savedUsage);
      expect(server.requests).toHaveLength(4);
      database.db.delete(krxDailyBars).run();
      database.db.delete(krxRawApiSnapshots).run();
      await expect(restarted.service.ingestDate('2026-08-03')).rejects.toThrow('BLOCKED_SOURCE_REQUIREMENT');
      expect(server.requests).toHaveLength(4);
    } finally {
      database?.close();
      await server.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('확인된 입력 문제는 미리보기를 무효화하고 해당 종목·연도의 차단만 추가한다', () => {
    const database = openDatabase(':memory:');
    try {
      database.db.insert(symbols).values(['005930', '000660'].map((code) => ({ code, market: 'KR' as const, createdAtMs: 1 }))).run();
      const financial = new SqliteFactCoverageStore(database.db);
      const actions = new SqliteCorporateActionCoverageStore(database.db);
      for (const symbol of ['005930', '000660']) {
        financial.addCoveredYears(symbol, [2024, 2025], 1);
        actions.addCoveredYears(symbol, [2024, 2025], 1);
      }
      const cache = new PreparationPreviewCache(database);
      database.sqlite.prepare("INSERT INTO backtest_preparation_jobs (id, request_hash, request_json, status, phase, created_at_ms, updated_at_ms) VALUES ('preview', 'request', '{}', 'COMPLETED', 'MARKET_DATA', 1, 1)").run();
      const revision = cache.revision();
      cache.store('preview', revision, []);
      expect(cache.isFresh('preview')).toBe(true);
      database.db.insert(providerInputIssues).values({ id: 'receipt-one', symbol: '005930', businessYear: 2025, reportCode: '11011', reason: 'SOURCE_CHANGE_CONFIRMED', evidence: '정정공시 fixture' }).run();
      expect(cache.revision()).toBeGreaterThan(revision);
      expect(cache.isFresh('preview')).toBe(false);
      expect(financial.getCoverageState().get('005930')).toMatchObject({ verifiedYears: [2024, 2025], blockingGapYears: [2025] });
      expect(financial.getCoverageState().get('000660')).toMatchObject({ verifiedYears: [2024, 2025], blockingGapYears: [] });
      expect(actions.getGapYears().get('005930')).toEqual([2025]);
      expect(actions.getGapYears().get('000660') ?? []).toEqual([]);
      expect(actions.getCoveredYears().get('005930')).toEqual([2024, 2025]);
    } finally { database.close(); }
  });
});
