import { expect, it, vi } from 'vitest';
import { openDatabase } from '../../src/runtime/shared/db/database.js';
import { SqliteDartPendingFilingStore } from '../../src/server/modules/facts/infrastructure/dart/dart-pending-filing-store.js';
import { SqliteDartRawSnapshotStore } from '../../src/server/modules/facts/infrastructure/dart/sqlite-dart-raw-snapshot-store.js';
const key={symbol:'005930',businessYear:2025,reportCode:'11011',endpoint:'FINANCIAL_STATEMENT',fsDiv:'CFS'} as const;

it('새 보고서의 작은 메타데이터만 비교하며 큰 과거 원문·법인코드 XML은 파싱하지 않는다',()=>{
  const db=openDatabase(':memory:');const sqlite=db.sqlite;
  try{
    sqlite.exec("INSERT INTO symbols(code,market,created_at_ms) VALUES('005930','KR',1)");
    sqlite.exec("INSERT INTO symbol_facts_state(code,covered_years_json) VALUES('005930','[2025]')");
    new SqliteDartRawSnapshotStore(db.db).put(key,{status:'000',list:[{rcept_no:'20260320000001'}]},1);
    sqlite.exec("UPDATE dart_raw_api_snapshots SET payload_json=hex(zeroblob(4000000)),content_hash='broken'");
    sqlite.exec("INSERT INTO dart_corp_code_snapshot(namespace,xml,content_hash,fetched_at_ms) VALUES('dart','invalid','broken',1)");
    sqlite.prepare(`INSERT INTO dart_discovered_filings(identity,receipt_no,symbol,business_year,report_code,payload_json,discovered_at_ms,status)
      VALUES('new','20260920000001','005930',2025,'11011','{}',1,'PENDING'),('other','20260920000002','000660',2025,'11011','{}',1,'PENDING')`).run();
    const queries:string[]=[];const prepare=sqlite.prepare.bind(sqlite);
    vi.spyOn(sqlite,'prepare').mockImplementation((sql:string)=>{queries.push(sql);return prepare(sql);});
    expect(new SqliteDartPendingFilingStore(sqlite).observeFilings(['new'])).toEqual([{symbol:'005930',year:2025}]);
    const rawReads=queries.filter(sql=>/SELECT[\s\S]*FROM dart_raw_api_snapshots/.test(sql));
    expect(rawReads).toHaveLength(1);expect(rawReads[0]).not.toMatch(/payload_json|content_hash|SELECT\s+\*/);
    expect(rawReads[0]).toContain('business_year = ? AND report_code = ?');
    expect(queries.some(sql=>sql.includes('dart_corp_code_snapshot'))).toBe(false);
    expect(sqlite.prepare('SELECT symbol,business_year FROM provider_input_issues').all()).toEqual([{symbol:'005930',business_year:2025}]);
    const revision=sqlite.prepare('SELECT revision FROM dataset_state').get();
    new SqliteDartPendingFilingStore(sqlite).observeFilings(['new']);
    expect(sqlite.prepare('SELECT revision FROM dataset_state').get()).toEqual(revision);
  }finally{vi.restoreAllMocks();db.close();}
});

it('반영 근거 없는 과거 자료는 원문을 채우지 않고 기존 DB와 완료 이력을 보존한다',()=>{
  const db=openDatabase(':memory:');const sqlite=db.sqlite;
  try{
    sqlite.exec("INSERT INTO symbols(code,market,created_at_ms) VALUES('005930','KR',1)");
    sqlite.exec("INSERT INTO symbol_facts_state(code,covered_years_json) VALUES('005930','[2025]')");
    sqlite.exec("INSERT INTO dart_discovered_filings(identity,receipt_no,symbol,business_year,report_code,payload_json,discovered_at_ms,status) VALUES('old','20250320000001','005930',2025,'11011','{}',1,'PENDING')");
    const before=sqlite.prepare('SELECT * FROM symbol_facts_state').all();
    expect(new SqliteDartPendingFilingStore(sqlite).observeFilings(['old'])).toEqual([]);
    expect(sqlite.prepare('SELECT * FROM provider_input_issues').all()).toEqual([]);
    expect(sqlite.prepare('SELECT status FROM dart_discovered_filings').get()).toEqual({status:'BASELINE_UNKNOWN'});
    expect(sqlite.prepare('SELECT * FROM symbol_facts_state').all()).toEqual(before);
  }finally{db.close();}
});

it('완전 목록의 미관측 접수는 적용 범위에 따라 해제 또는 명시적으로 차단하고 재등장을 복원한다', () => {
  const db = openDatabase(':memory:');
  const sqlite = db.sqlite;
  const store = new SqliteDartPendingFilingStore(sqlite);
  const absent = '20260828001423';
  const partial = '20260828001529';
  try {
    sqlite.exec("INSERT INTO symbols(code,market,created_at_ms) VALUES('058970','KR',1),('309710','KR',1)");
    sqlite.exec("INSERT INTO symbol_facts_state(code,covered_years_json) VALUES('058970','[2026]'),('309710','[2026]')");
    sqlite.prepare(`INSERT INTO dart_discovered_filings
      (identity,receipt_no,symbol,business_year,report_code,payload_json,discovered_at_ms,status)
      VALUES ('absent',?,'058970',2026,'11012','{"corp_code":"00126380"}',1,'PENDING'),
        ('partial',?,'309710',2026,'11012','{}',1,'PENDING')`).run(absent, partial);
    for (const [identity, symbol, receipt] of [['absent', '058970', absent], ['partial', '309710', partial]] as const) {
      sqlite.prepare(`INSERT INTO provider_input_issues(id,symbol,business_year,report_code,reason,evidence)
        VALUES(?,?,2026,'11012','PENDING_FILING',?)`).run(`dart-filing:${identity}`, symbol, receipt);
    }
    sqlite.prepare(`INSERT INTO dart_filing_endpoint_checkpoints(receipt_no,endpoint,fs_div,status,retry_after_ms)
      VALUES(?,'FINANCIAL_STATEMENT','CFS','PENDING_PUBLICATION',99),
        (?,'FINANCIAL_STATEMENT','CFS','APPLIED',NULL),
        (?,'SHARE_STATUS','NONE','PENDING_PUBLICATION',99)`).run(absent, partial, partial);
    new SqliteDartRawSnapshotStore(db.db).put({ ...key, symbol: '309710', businessYear: 2026, reportCode: '11012' }, { status: '000', list: [] }, 1);

    expect(store.markUnlistedReceipts([absent, absent, 'invalid', partial])).toEqual([absent, partial]);
    expect(store.markUnlistedReceipts([absent])).toEqual([]);
    expect(sqlite.prepare("SELECT status FROM dart_discovered_filings WHERE identity='absent'").get()).toEqual({ status: 'UNLISTED' });
    expect(sqlite.prepare("SELECT * FROM dart_filing_endpoint_checkpoints WHERE receipt_no=?").all(absent)).toEqual([]);
    expect(sqlite.prepare("SELECT * FROM provider_input_issues WHERE id='dart-filing:absent'").get()).toBeUndefined();
    expect(store.get({ ...key, symbol: '058970', businessYear: 2026, reportCode: '11012' })).toBeNull();
    expect(store.getExpectedCorpCode('058970')).toBeNull();
    expect(sqlite.prepare("SELECT status FROM dart_discovered_filings WHERE identity='partial'").get()).toEqual({ status: 'UNLISTED_PARTIAL' });
    expect(sqlite.prepare("SELECT status FROM dart_filing_endpoint_checkpoints WHERE receipt_no=?").all(partial)).toEqual([{ status: 'APPLIED' }]);
    expect(sqlite.prepare("SELECT reason,evidence FROM provider_input_issues WHERE id='dart-filing:partial'").get())
      .toEqual({ reason: 'PENDING_FILING', evidence: `접수 ${partial}: 현재 목록 미관측, 일부 원문 반영` });
    expect(store.get({ ...key, symbol: '309710', businessYear: 2026, reportCode: '11012', endpoint: 'SHARE_STATUS', fsDiv: 'NONE' }))
      .toMatchObject({ receiptNo: partial, status: 'UNRESOLVED', retryAfterMs: null });
    expect(sqlite.prepare("SELECT receipt_no FROM dart_raw_api_snapshots WHERE code='309710'").get()).toBeDefined();

    expect(store.observeFilings(['absent'])).toEqual([{ symbol: '058970', year: 2026 }]);
    expect(sqlite.prepare("SELECT status FROM dart_discovered_filings WHERE identity='absent'").get()).toEqual({ status: 'PENDING' });
    expect(sqlite.prepare("SELECT reason,evidence FROM provider_input_issues WHERE id='dart-filing:absent'").get())
      .toEqual({ reason: 'PENDING_FILING', evidence: absent });
    expect(sqlite.prepare("SELECT * FROM dart_filing_endpoint_checkpoints WHERE receipt_no=?").all(absent)).toEqual([]);
    expect(store.observeFilings(['partial'])).toEqual([{ symbol: '309710', year: 2026 }]);
    expect(sqlite.prepare("SELECT status FROM dart_discovered_filings WHERE identity='partial'").get()).toEqual({ status: 'PENDING' });
    expect(sqlite.prepare("SELECT reason,evidence FROM provider_input_issues WHERE id='dart-filing:partial'").get())
      .toEqual({ reason: 'PENDING_FILING', evidence: partial });
  } finally { db.close(); }
});

it('게시 대기 저장은 기존 접수도 검증 예약하고 예약 실패에도 대기를 유지한다', () => {
  const db = openDatabase(':memory:');
  const sqlite = db.sqlite;
  const receipt = '20260828001423';
  const requestVerification = vi.fn()
    .mockImplementationOnce(() => undefined)
    .mockImplementationOnce(() => { throw new Error('예약 실패'); });
  const store = new SqliteDartPendingFilingStore(sqlite, requestVerification);
  try {
    store.markPendingPublication({ ...key, businessYear: 2026, reportCode: '11012' }, receipt, 100);
    store.markPendingPublication({ ...key, businessYear: 2026, reportCode: '11012' }, receipt, 200);
    expect(requestVerification).toHaveBeenCalledTimes(2);
    expect(requestVerification).toHaveBeenNthCalledWith(1, receipt);
    expect(requestVerification).toHaveBeenNthCalledWith(2, receipt);
    expect(sqlite.prepare("SELECT status,retry_after_ms FROM dart_filing_endpoint_checkpoints WHERE receipt_no=?").get(receipt))
      .toEqual({ status: 'PENDING_PUBLICATION', retry_after_ms: 200 });
  } finally { db.close(); }
});

it('미관측 접수 50건은 전표를 한 번만 훑고 identity PK로 일괄 전이한다', () => {
  const db = openDatabase(':memory:');
  const sqlite = db.sqlite;
  const store = new SqliteDartPendingFilingStore(sqlite);
  const receipts = Array.from({ length: 50 }, (_, index) => `2026000000${String(index + 1).padStart(4, '0')}`);
  try {
    const insert = sqlite.prepare(`INSERT INTO dart_discovered_filings
      (identity,receipt_no,symbol,business_year,report_code,payload_json,discovered_at_ms,status)
      VALUES(?,?, '005930',2026,'11012','{}',1,'PENDING')`);
    for (const receipt of receipts) for (let copy = 0; copy < 20; copy += 1)
      insert.run(`${receipt}:${copy}`, receipt);
    const queries: string[] = [];
    const prepare = sqlite.prepare.bind(sqlite);
    vi.spyOn(sqlite, 'prepare').mockImplementation((sql: string) => {
      queries.push(sql);
      return prepare(sql);
    });
    expect(store.markUnlistedReceipts(receipts)).toEqual(receipts);
    expect(queries.filter((sql) => sql.includes('SELECT identity, receipt_no FROM dart_discovered_filings'))).toHaveLength(1);
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM dart_discovered_filings WHERE status = 'UNLISTED'").get()).toEqual({ n: 1000 });
  } finally { vi.restoreAllMocks(); db.close(); }
});

it('자본변동 두 원문과 정상화가 끝난 공시만 재무 미반영으로 좁히고 다시 발견해도 보존한다', () => {
  const db = openDatabase(':memory:');
  const sqlite = db.sqlite;
  const store = new SqliteDartPendingFilingStore(sqlite);
  const receipt = '20260828001423';
  const actionKey = { ...key, symbol: '058970', businessYear: 2026, reportCode: '11012', fsDiv: 'NONE' } as const;
  try {
    sqlite.exec("INSERT INTO symbols(code,market,created_at_ms) VALUES('058970','KR',1)");
    sqlite.exec("INSERT INTO symbol_facts_state(code,covered_years_json,action_covered_years_json) VALUES('058970','[2026]','[2026]')");
    for (const [id, symbol, year, status] of [
      [receipt, '058970', 2026, 'PENDING'], ['neighbor', '309710', 2026, 'PENDING'],
      ['outside', '058970', 2025, 'PENDING'], ['unresolved', '058970', 2026, 'UNRESOLVED'],
    ] as const) {
      sqlite.prepare(`INSERT INTO dart_discovered_filings
        (identity,receipt_no,symbol,business_year,report_code,payload_json,discovered_at_ms,status)
        VALUES(?,?,?,?,'11012','{}',1,?)`).run(id, id, symbol, year, status);
      sqlite.prepare(`INSERT INTO provider_input_issues(id,symbol,business_year,report_code,reason,evidence)
        VALUES(?,?,?,'11012','PENDING_FILING',?)`).run(`dart-filing:${id}`, symbol, year, id);
    }
    const reason = () => sqlite.prepare('SELECT reason FROM provider_input_issues WHERE id=?').get(`dart-filing:${receipt}`);
    store.markApplied({ ...actionKey, endpoint: 'SHARE_STATUS' }, receipt);
    store.markNormalized('058970', 2026, 'ACTION');
    expect(reason()).toEqual({ reason: 'PENDING_FILING' });
    store.markApplied({ ...actionKey, endpoint: 'ISSUANCE_STATUS' }, receipt);
    expect(reason()).toEqual({ reason: 'PENDING_FILING' });
    store.markNormalized('058970', 2026, 'ACTION');
    expect(reason()).toEqual({ reason: 'PENDING_FINANCIAL_FILING' });
    expect(store.observeFilings([receipt])).toEqual([{ symbol: '058970', year: 2026 }]);
    expect(reason()).toEqual({ reason: 'PENDING_FINANCIAL_FILING' });
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM provider_input_issues WHERE reason='PENDING_FILING'").get()).toEqual({ n: 3 });
    store.markApplied({ ...actionKey, endpoint: 'FINANCIAL_STATEMENT', fsDiv: 'CFS' }, receipt);
    expect(reason()).toEqual({ reason: 'PENDING_FINANCIAL_FILING' });
    store.markNormalized('058970', 2026);
    expect(reason()).toBeUndefined();
    expect(sqlite.prepare('SELECT status FROM dart_discovered_filings WHERE identity=?').get(receipt)).toEqual({ status: 'APPLIED' });
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM provider_input_issues').get()).toEqual({ n: 3 });
  } finally { db.close(); }
});
