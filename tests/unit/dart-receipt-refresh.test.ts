import { expect, it, vi } from 'vitest';
import { openDatabase } from '../../src/runtime/shared/db/database.js';
import { createDartFactSource } from '../../src/server/modules/facts/infrastructure/dart/dart-fact-source.js';
import { SqliteDartPendingFilingStore } from '../../src/server/modules/facts/infrastructure/dart/dart-pending-filing-store.js';
import { SqliteDartRawSnapshotStore } from '../../src/server/modules/facts/infrastructure/dart/sqlite-dart-raw-snapshot-store.js';
import { SqliteProviderRequestPolicy } from '../../src/server/shared/provider-request-policy.js';
import type { DartRawSnapshotKey } from '../../src/server/modules/facts/infrastructure/dart/dart-raw-snapshot-store.js';

const oldReceipt = '20260814003090';
const newReceipt = '20260820000112';
const now = Date.parse('2026-09-24T01:00:00+09:00');
const endpoints = ['FINANCIAL_STATEMENT', 'SHARE_STATUS', 'ISSUANCE_STATUS'] as const;
const logger = { info() {}, warn() {}, error() {}, debug() {} } as never;

function payload(receipts: string[], amount = '1000') {
  return { status: '000', list: receipts.map((rcept_no) => ({
    rcept_no, corp_code: '01021949', bsns_year: '2026', reprt_code: '11012',
    sj_div: 'BS', account_id: 'ifrs-full_CurrentAssets', account_nm: '유동자산', thstrm_amount: amount,
    se: '보통주', istc_totqy: amount, stlm_dt: '2026.06.30',
    isu_dcrs_de: '2026-04-01', isu_dcrs_stle: '무상증자', isu_dcrs_stock_knd: '보통주', isu_dcrs_qy: amount,
  })) };
}

function fixture(endpoint: typeof endpoints[number], listed: string, saved: unknown, live: unknown) {
  const database = openDatabase(':memory:');
  const raw = new SqliteDartRawSnapshotStore(database.db);
  const pending = new SqliteDartPendingFilingStore(database.sqlite);
  const key: DartRawSnapshotKey = { symbol: '206560', businessYear: 2026, reportCode: '11012',
    endpoint, fsDiv: endpoint === 'FINANCIAL_STATEMENT' ? 'CFS' : 'NONE' };
  database.sqlite.exec("INSERT INTO symbols(code,market,created_at_ms) VALUES('206560','KR',1)");
  database.sqlite.prepare(`INSERT INTO dart_discovered_filings
    (identity,receipt_no,symbol,business_year,report_code,payload_json,discovered_at_ms,status)
    VALUES(?,?,'206560',2026,'11012','{"corp_code":"01021949"}',?,'PENDING')`).run(listed, listed, now);
  for (const ep of endpoints) for (const reportCode of ['11013', '11012'] as const) {
    const k: DartRawSnapshotKey = { ...key, endpoint: ep, reportCode, fsDiv: ep === 'FINANCIAL_STATEMENT' ? 'CFS' : 'NONE' };
    raw.put(k, ep === endpoint && reportCode === key.reportCode ? saved : { status: '013' }, 1);
    if (ep !== endpoint && reportCode === key.reportCode)
      pending.markChecked(k, pending.get(k)!);
  }
  // 운영 자료처럼 접수번호 메타데이터가 비어 있어도 저장 원문의 식별자를 비교해야 한다.
  database.sqlite.exec('UPDATE dart_raw_api_snapshots SET receipt_no = NULL');
  database.sqlite.prepare(`INSERT INTO dart_filing_endpoint_checkpoints
    (receipt_no,endpoint,fs_div,status,retry_after_ms) VALUES(?,?,?,'PENDING_PUBLICATION',?)`)
    .run(listed, endpoint, key.fsDiv, now + 86_400_000);
  const put = vi.spyOn(raw, 'put');
  const fetch = vi.fn(async () => Response.json(live));
  const source = createDartFactSource({ baseUrl: 'https://dart.test', apiKey: 'fixture' }, logger, {
    clock: { now: () => now }, sleep: async () => {}, fetchImpl: fetch,
    rawSnapshots: raw, pendingFilings: pending,
    corpCodeResolver: { resolve: async () => '01021949' },
    requestPolicy: new SqliteProviderRequestPolicy(database.sqlite, () => now),
  });
  const request = { symbols: ['206560'], years: [2026], shareYears: [2026], consolidated: true };
  const run = () => endpoint === 'FINANCIAL_STATEMENT'
    ? source.fetchFinancials({ ...request }) : source.fetchCorporateActions({ ...request });
  return { database, raw, pending, key, put, fetch, run };
}

it.each(endpoints)('%s는 목록 번호와 무관하게 본문 번호가 다를 때만 원문을 교체한다', async (endpoint) => {
  for (const [listed, stored, returned] of [
    [newReceipt, oldReceipt, oldReceipt],
    [newReceipt, newReceipt, oldReceipt],
    [oldReceipt, oldReceipt, newReceipt],
    [oldReceipt, newReceipt, newReceipt],
  ]) {
    const saved = payload([stored!]);
    const live = payload([returned!], '2000');
    const f = fixture(endpoint, listed!, saved, live);
    try {
      const result = await f.run();
      const changed = stored !== returned;
      expect(f.fetch).toHaveBeenCalledTimes(1);
      expect(f.put).toHaveBeenCalledTimes(changed ? 1 : 0);
      expect(f.raw.get(f.key)).toEqual({ payload: changed ? live : saved, fetchedAtMs: changed ? now : 1 });
      expect(f.pending.get(f.key)).toBeNull();
      expect(f.database.sqlite.prepare('SELECT COUNT(*) AS n FROM dart_raw_api_snapshot_history').get()).toEqual({ n: changed ? 1 : 0 });
      expect(f.database.sqlite.prepare('SELECT status FROM provider_request_plans').all()).toEqual([{ status: 'COMPLETED' }]);
      if (endpoint === 'FINANCIAL_STATEMENT')
        expect(result.facts.find((fact) => fact.field === 'CURRENT_ASSETS')?.value).toBe(changed ? 2000 : 1000);
      await f.run();
      expect(f.fetch).toHaveBeenCalledTimes(1);
    } finally { f.database.close(); }
  }
});

it('여러 접수번호는 최대값이 아닌 전체 집합을 비교하고 순서·중복만 다른 경우 유지한다', async () => {
  for (const [receipts, changed] of [
    [[newReceipt, oldReceipt, oldReceipt], false],
    [['20260815000001', newReceipt], true],
  ] as const) {
    const saved = payload([oldReceipt, newReceipt]);
    const live = payload([...receipts]);
    const f = fixture('FINANCIAL_STATEMENT', newReceipt, saved, live);
    try {
      await f.run();
      expect(f.put).toHaveBeenCalledTimes(changed ? 1 : 0);
      expect(f.raw.get(f.key)?.payload).toEqual(changed ? live : saved);
    } finally { f.database.close(); }
  }
});

it('013은 빈 결과로 반영하고 기존에도 빈 결과였으면 원문과 수집 시각을 유지한다', async () => {
  for (const saved of [payload([newReceipt]), { status: '013' }]) {
    const f = fixture('FINANCIAL_STATEMENT', newReceipt, saved, { status: '013' });
    try {
      const result = await f.run();
      expect(result.facts).toEqual([]);
      expect(f.raw.get(f.key)?.payload).toEqual({ status: '013' });
      expect(f.put).toHaveBeenCalledTimes(saved.status === '013' ? 0 : 1);
      expect(f.pending.get(f.key)).toBeNull();
    } finally { f.database.close(); }
  }
});

it.each([
  { corp_code: '99999999' }, { bsns_year: '2025' }, { reprt_code: '11013' },
])('접수번호가 같아도 회사·연도·보고서가 다른 응답은 거부한다: %j', async (mismatch) => {
  const saved = payload([oldReceipt]);
  const live = { ...saved, list: saved.list.map((row) => ({ ...row, ...mismatch })) };
  const f = fixture('FINANCIAL_STATEMENT', newReceipt, saved, live);
  try {
    await expect(f.run()).rejects.toMatchObject({ reason: 'IDENTITY_MISMATCH' });
    expect(f.put).not.toHaveBeenCalled();
    expect(f.raw.get(f.key)?.payload).toEqual(saved);
    expect(f.pending.get(f.key)).not.toBeNull();
  } finally { f.database.close(); }
});
