import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { SqliteDartPendingFilingStore } from '../../src/server/modules/facts/infrastructure/dart/dart-pending-filing-store.js';

it('기존 소비자만 차단하고 endpoint 세 개와 정상화를 모두 마친 뒤 재발견하지 않는다', () => {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE dart_discovered_filings(identity TEXT, receipt_no TEXT, symbol TEXT, business_year INTEGER, report_code TEXT, status TEXT, discovered_at_ms INTEGER, payload_json TEXT);
    CREATE TABLE dart_filing_endpoint_checkpoints(receipt_no TEXT, endpoint TEXT, fs_div TEXT, status TEXT, retry_after_ms INTEGER, PRIMARY KEY(receipt_no,endpoint,fs_div));
    CREATE TABLE provider_input_issues(id TEXT PRIMARY KEY,symbol TEXT,business_year INTEGER,report_code TEXT,reason TEXT,evidence TEXT);
    CREATE TABLE symbol_facts_state(code TEXT,covered_years_json TEXT,action_covered_years_json TEXT, financial_updated_at_ms INTEGER, action_updated_at_ms INTEGER);
    CREATE TABLE dart_raw_api_snapshots(code TEXT,business_year INTEGER,report_code TEXT,payload_json TEXT,content_hash TEXT,endpoint TEXT);
    INSERT INTO symbol_facts_state VALUES('005930','[2025]','[2025]',1747137600000,1747137600000);
    INSERT INTO dart_discovered_filings VALUES('event','20250515000001','005930',2025,'11013','PENDING',10,NULL);
    INSERT INTO dart_discovered_filings VALUES('unused','20250515000002','000660',2025,'11013','PENDING',10,NULL);`);
  try {
    const store = new SqliteDartPendingFilingStore(db);
    const key = {symbol:'005930',businessYear:2025,reportCode:'11013',endpoint:'FINANCIAL_STATEMENT',fsDiv:'CFS'} as const;
    expect(store.reconcileDiscoveredFilings()).toEqual([{symbol:'005930',year:2025}]);
    expect(store.isCollected(key)).toBe(true);
    store.markPendingPublication(key,'20250515000001',100);
    expect(store.get(key)?.retryAfterMs).toBe(100);
    store.markApplied(key,'20250515000001');
    store.markNormalized('005930',2025);
    expect(db.prepare('SELECT * FROM provider_input_issues').all()).toHaveLength(1);
    store.markApplied({...key,endpoint:'SHARE_STATUS',fsDiv:'NONE'},'20250515000001');
    store.markApplied({...key,endpoint:'ISSUANCE_STATUS',fsDiv:'NONE'},'20250515000001');
    store.markNormalized('005930',2025);
    expect(db.prepare('SELECT * FROM provider_input_issues').all()).toHaveLength(0);
    expect(store.reconcileDiscoveredFilings()).toEqual([]);
    db.exec("INSERT INTO dart_discovered_filings VALUES('baseline','20240515000001','005930',2025,'11012','PENDING',10,NULL)");
    expect(store.reconcileDiscoveredFilings()).toEqual([]);
    expect(db.prepare("SELECT status FROM dart_discovered_filings WHERE identity = 'baseline'").get()).toEqual({status:'BASELINE_UNKNOWN'});
    expect(store.get({...key,reportCode:'11012'})).toBeNull();
    db.exec('CREATE TABLE dart_corp_code_snapshot(namespace TEXT,xml TEXT,content_hash TEXT)');
    const xml = '<result><list><stock_code>005930</stock_code><corp_code>00126380</corp_code></list></result>';
    db.prepare('INSERT INTO dart_corp_code_snapshot VALUES(?,?,?)').run('dart.test',xml,createHash('sha256').update(xml).digest('hex'));
    db.prepare("UPDATE dart_discovered_filings SET payload_json = ? WHERE identity = 'baseline'").run(JSON.stringify({corp_code:'99999999'}));
    expect(new SqliteDartPendingFilingStore(db,'dart.test').reconcileDiscoveredFilings()).toEqual([]);
    expect(db.prepare("SELECT id,reason FROM provider_input_issues").all()).toEqual([{id:'dart-identity:005930',reason:'IDENTITY_CHANGED'}]);
  } finally { db.close(); }
});

it('원문 접수번호가 새로워도 해시가 손상되면 최신 반영으로 간주하지 않는다', () => {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE dart_discovered_filings(identity TEXT, receipt_no TEXT, symbol TEXT, business_year INTEGER, report_code TEXT, status TEXT, discovered_at_ms INTEGER, payload_json TEXT);
    CREATE TABLE provider_input_issues(id TEXT PRIMARY KEY,symbol TEXT,business_year INTEGER,report_code TEXT,reason TEXT,evidence TEXT);
    CREATE TABLE symbol_facts_state(code TEXT,covered_years_json TEXT,action_covered_years_json TEXT, financial_updated_at_ms INTEGER, action_updated_at_ms INTEGER);
    CREATE TABLE dart_raw_api_snapshots(code TEXT,business_year INTEGER,report_code TEXT,payload_json TEXT,content_hash TEXT,endpoint TEXT);
    INSERT INTO symbol_facts_state VALUES('005930','[2025]',NULL,NULL,NULL);
    INSERT INTO dart_discovered_filings VALUES('event','20250515000001','005930',2025,'11013','PENDING',10,NULL);`);
  try {
    const payload = JSON.stringify({list:[{rcept_no:'20260515000001'}]});
    db.prepare('INSERT INTO dart_raw_api_snapshots(code,business_year,report_code,payload_json,content_hash) VALUES(?,?,?,?,?)').run('005930',2025,'11013',payload,createHash('sha256').update('other').digest('hex'));
    expect(new SqliteDartPendingFilingStore(db).reconcileDiscoveredFilings()).toEqual([{symbol:'005930',year:2025}]);
  } finally { db.close(); }
});


it.each(['MAPPING', 'RAW'] as const)('미수집 새 연도의 법인 변경도 기존 %s 정체성으로 과거 입력 전체를 차단한다', (knownIdentity) => {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE dart_discovered_filings(identity TEXT, receipt_no TEXT, symbol TEXT, business_year INTEGER, report_code TEXT, status TEXT, discovered_at_ms INTEGER, payload_json TEXT);
    CREATE TABLE provider_input_issues(id TEXT PRIMARY KEY,symbol TEXT,business_year INTEGER,report_code TEXT,reason TEXT,evidence TEXT);
    CREATE TABLE symbol_facts_state(code TEXT,covered_years_json TEXT,action_covered_years_json TEXT,financial_updated_at_ms INTEGER,action_updated_at_ms INTEGER);
    CREATE TABLE dart_raw_api_snapshots(code TEXT,business_year INTEGER,report_code TEXT,payload_json TEXT,content_hash TEXT,endpoint TEXT);
    CREATE TABLE dart_corp_code_snapshot(namespace TEXT,xml TEXT,content_hash TEXT);
    INSERT INTO symbol_facts_state VALUES('005930','[2025]',NULL,NULL,NULL);`);
  try {
    db.prepare('INSERT INTO dart_discovered_filings VALUES(?,?,?,?,?,?,?,?)').run('new-company','20260515000001','005930',2026,'11013','PENDING',10,JSON.stringify({corp_code:'99999999'}));
    if (knownIdentity === 'MAPPING') {
      const xml = '<result><list><stock_code>005930</stock_code><corp_code>00126380</corp_code></list></result>';
      db.prepare('INSERT INTO dart_corp_code_snapshot VALUES(?,?,?)').run('dart.test',xml,createHash('sha256').update(xml).digest('hex'));
    } else {
      const payload = JSON.stringify({status:'000',list:[{corp_code:'00126380'}]});
      db.prepare('INSERT INTO dart_raw_api_snapshots VALUES(?,?,?,?,?,?)').run('005930',2025,'11011',payload,createHash('sha256').update(payload).digest('hex'),'FINANCIAL_STATEMENT');
    }
    const store = new SqliteDartPendingFilingStore(db, knownIdentity === 'MAPPING' ? 'dart.test' : undefined);
    expect(store.reconcileDiscoveredFilings()).toEqual([]);
    expect(db.prepare('SELECT id,business_year,reason FROM provider_input_issues').all()).toEqual([
      {id:'dart-identity:005930',business_year:null,reason:'IDENTITY_CHANGED'},
    ]);
  } finally { db.close(); }
});
