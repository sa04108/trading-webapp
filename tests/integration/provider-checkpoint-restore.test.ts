import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { pino } from 'pino';
import { openDatabase, type DatabaseHandle } from '../../src/runtime/shared/db/database.js';
import { backupDatabase, restoreDatabase } from '../../src/server/shared/db/database-backup.js';
import { ProviderRequestBlockedError, SqliteProviderRequestPolicy, providerPlanFingerprint } from '../../src/server/shared/provider-request-policy.js';
import { DartFilingDiscovery } from '../../src/server/modules/facts/application/dart-filing-discovery.js';
import { SqliteDartPendingFilingStore } from '../../src/server/modules/facts/infrastructure/dart/dart-pending-filing-store.js';
import { SqliteDartRawSnapshotStore } from '../../src/server/modules/facts/infrastructure/dart/sqlite-dart-raw-snapshot-store.js';
import { SqliteKrxRawSnapshotStore } from '../../src/server/modules/market-data/infrastructure/krx/sqlite-krx-raw-snapshot-store.js';
import { createKrxHistoricalUniverseSource } from '../../src/server/modules/market-data/infrastructure/krx/krx-historical-universe-source.js';

const directories: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });
const now = () => Date.parse('2026-09-20T01:00:00Z');
const logger = pino({ level: 'silent' });
const krxKey = { namespace: 'https://fixture.test', endpoint: '/svc/apis/sto/stk_bydd_trd', basDd: '20260918' };
const dartKey = { symbol: '005930', endpoint: 'FINANCIAL_STATEMENT', businessYear: 2026, reportCode: '11012', fsDiv: 'CFS' } as const;
const requestKey = { provider: 'KRX', namespace: krxKey.namespace, endpoint: krxKey.endpoint, parameters: { basDd: krxKey.basDd } } as const;
const recovery = { kind: 'CORRUPT', evidence: 'snapshot:fixture' } as const;
const cancelledKey = { ...requestKey, parameters: { basDd: '20260917' } };

function capture(handle: DatabaseHandle) {
  const operations = ['provider_request_plans', 'dart_discovery_jobs', 'dart_discovery_pages', 'dart_discovered_filings',
    'dart_filing_endpoint_checkpoints', 'dart_raw_api_snapshots', 'dart_raw_api_snapshot_history', 'krx_raw_api_snapshots',
    'provider_execution_provenance', '__drizzle_migrations'];
  const data = ['symbols', 'symbol_facts_state', 'symbol_master_coverage', 'krx_daily_bars', 'provider_input_issues', 'dataset_state', '__drizzle_migrations'];
  return {
    operations: Object.fromEntries(operations.map((table) => [table, handle.sqlite.prepare(`SELECT * FROM main.${table} ORDER BY rowid`).all()])),
    data: Object.fromEntries(data.map((table) => [table, handle.sqlite.prepare(`SELECT * FROM data.${table} ORDER BY rowid`).all()])),
  };
}

function seed(handle: DatabaseHandle): void {
  const db = handle.sqlite;
  db.prepare("INSERT INTO symbols(code,market,name,created_at_ms) VALUES('005930','KR','삼성전자',1)").run();
  db.prepare("INSERT INTO symbol_facts_state(code,covered_years_json,action_covered_years_json,financial_updated_at_ms) VALUES('005930','[2026]','[2026]',?)").run(now());
  db.exec("INSERT INTO symbol_master_coverage(start_date,end_date,synced_at_ms,collection_version) VALUES('2026-09-18','2026-09-18',10,'legacy');");
  db.exec("INSERT INTO krx_daily_bars(short_code,date,market,open,high,low,close,volume) VALUES('005930','2026-09-18','KOSPI',100,110,90,105,7)");
  db.exec("INSERT INTO provider_input_issues(id,symbol,business_year,report_code,reason,evidence) VALUES('dart-filing:20260919000001','005930',2026,'11012','PENDING_FILING','20260919000001')");
  const raw = new SqliteDartRawSnapshotStore(handle.db);
  raw.put(dartKey, { status: '013', unused: '이전 원문' }, 10);
  raw.put(dartKey, { status: '013', unused: '현재 원문' }, 20);
  new SqliteKrxRawSnapshotStore(handle.db).put(krxKey, { OutBlock_1: [], unused: '보존' }, 30);
  db.prepare("INSERT INTO dart_discovery_jobs(day,from_date,to_date,page,status,completed_at_ms) VALUES('2026-09-20','2026-09-20','2026-09-19',1,'COMPLETED',?)").run(now());
  const filing = { rcept_no: '20260919000001', stock_code: '005930', corp_code: '00126380', report_nm: '반기보고서 (2026.06)' };
  const envelope = JSON.stringify({ status: '000', total_page: 1, list: [filing] });
  db.prepare("INSERT INTO dart_discovery_pages(day,from_date,page,payload_json,fetched_at_ms) VALUES('2026-09-20','2026-09-19',1,?,?)").run(envelope, now());
  db.prepare("INSERT INTO dart_discovered_filings(identity,receipt_no,symbol,business_year,report_code,payload_json,discovered_at_ms,status) VALUES('20260919000001','20260919000001','005930',2026,'11012',?,?,'PENDING')").run(JSON.stringify(filing), now());
  const pending = new SqliteDartPendingFilingStore(db);
  pending.markApplied(dartKey, filing.rcept_no);
  pending.markPendingPublication({ ...dartKey, endpoint: 'SHARE_STATUS', fsDiv: 'NONE' }, filing.rcept_no, now() + 86_400_000);
  db.prepare("INSERT INTO provider_execution_provenance(job_id,freshness_json) VALUES('completed-run',?)").run(JSON.stringify({ checkedThrough: '2026-09-19', lastCheckedAtMs: now(), warning: null }));
  const policy = new SqliteProviderRequestPolicy(db, now);
  expect(() => policy.authorize(requestKey, recovery)).toThrow(ProviderRequestBlockedError);
  policy.decide(providerPlanFingerprint(requestKey, recovery), true);
  policy.authorize(requestKey, recovery).beforeAttempt();
  expect(() => policy.authorize(cancelledKey, recovery)).toThrow(ProviderRequestBlockedError);
  policy.decide(providerPlanFingerprint(cancelledKey, recovery), false);
}

describe('공급자 원문·승인·공시 checkpoint의 두 DB 복원', () => {
  it.each([false, true])('복원 중단=%s 후 재실행·migration·로컬 재생에 원천 HTTP가 필요하지 않다', async (interrupt) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-checkpoint-'));
    directories.push(directory);
    const file = path.join(directory, 'app.sqlite');
    const backup = path.join(directory, 'backup.sqlite');
    let handle: DatabaseHandle | null = openDatabase(file);
    try {
      seed(handle);
      const before = capture(handle);
      handle.close(); handle = null;
      await backupDatabase(file, backup);
      handle = openDatabase(file);
      handle.sqlite.exec("UPDATE provider_request_plans SET status = 'COMPLETED'; DELETE FROM dart_filing_endpoint_checkpoints; DELETE FROM dart_discovery_pages; DELETE FROM krx_raw_api_snapshots; DELETE FROM dart_raw_api_snapshots; DELETE FROM dart_raw_api_snapshot_history; DELETE FROM provider_input_issues; UPDATE krx_daily_bars SET close=999");
      handle.close(); handle = null;
      if (interrupt) {
        const rename = fs.renameSync;
        const spy = vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
          if (String(to) === file) throw new Error('운영 DB 교체 직전 중단');
          rename(from, to);
        });
        await expect(restoreDatabase(file, backup)).rejects.toThrow('운영 DB 교체 직전 중단');
        expect(() => openDatabase(file)).toThrow('DB 복원이 완료되지');
        spy.mockRestore();
      }
      await restoreDatabase(file, backup);
      handle = openDatabase(file);
      expect(capture(handle)).toEqual(before);
      handle.close(); handle = openDatabase(file);
      expect(capture(handle)).toEqual(before);
      const http = vi.fn(async () => { throw new Error('외부 HTTP 금지'); });
      const source = createKrxHistoricalUniverseSource(null, { now }, logger, {
        rawNamespace: krxKey.namespace, rawSnapshotStore: new SqliteKrxRawSnapshotStore(handle.db), fetchImpl: http,
      });
      await expect(source.fetchDailyTrades('KOSPI', '2026-09-18')).resolves.toEqual([]);
      expect(new SqliteDartRawSnapshotStore(handle.db).get(dartKey)).toEqual({ payload: { status: '013', unused: '현재 원문' }, fetchedAtMs: 20 });
      const discovery = new DartFilingDiscovery({ sqlite: handle.sqlite, fetchPage: http, logger, now });
      expect(discovery.freshness().lastCheckedAtMs).toBe(now());
      expect(http).not.toHaveBeenCalled();
      expect(capture(handle)).toEqual(before);
      const policy = new SqliteProviderRequestPolicy(handle.sqlite, now);
      expect(policy.authorize(requestKey, recovery).fingerprint).toBe(providerPlanFingerprint(requestKey, recovery));
      expect(() => policy.authorize(cancelledKey, recovery)).toThrow(ProviderRequestBlockedError);
    } finally { handle?.close(); }
  });
});
