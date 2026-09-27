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

it.each([
  ['FINANCIAL_STATEMENT', 'CFS'],
  ['SHARE_STATUS', 'NONE'],
  ['ISSUANCE_STATUS', 'NONE'],
] as const)('%s의 013 조회와 같은 날짜 공시는 재조회하고 조회일 전 공시는 그대로 둔다', (endpoint, fsDiv) => {
  const db = openDatabase(':memory:');
  const sqlite = db.sqlite;
  const raw = new SqliteDartRawSnapshotStore(db.db);
  const store = new SqliteDartPendingFilingStore(sqlite);
  const timestamp = Date.parse('2026-09-27T03:00:00.000Z');
  try {
    sqlite.exec("INSERT INTO symbols(code,market,created_at_ms) VALUES('005930','KR',1)");
    sqlite.exec("INSERT INTO symbol_facts_state(code,covered_years_json,financial_updated_at_ms,action_updated_at_ms) VALUES('005930','[2026]',0,0)");
    const key = { ...({symbol:'005930',businessYear:2026,reportCode:'11013'} as const), endpoint, fsDiv };
    raw.put(key, { status: '013' }, timestamp);
    const insert = sqlite.prepare(`INSERT INTO dart_discovered_filings
      (identity,receipt_no,symbol,business_year,report_code,payload_json,discovered_at_ms,status)
      VALUES(?,?,'005930',2026,'11013','{}',1,'PENDING')`);
    insert.run('same-day', '20260927000001');
    expect(store.observeFilings(['same-day'])).toEqual([{ symbol: '005930', year: 2026 }]);
    expect(sqlite.prepare("SELECT reason FROM provider_input_issues WHERE id='dart-filing:same-day'").get())
      .toEqual({ reason: 'PENDING_FILING' });

    insert.run('prior-day', '20260926000001');
    expect(store.observeFilings(['prior-day'])).toEqual([]);
    expect(sqlite.prepare("SELECT status FROM dart_discovered_filings WHERE identity='prior-day'").get())
      .toEqual({ status: 'BASELINE_UNKNOWN' });
  } finally { db.close(); }
});

it('현재 보고서 원문이 없더라도 같은 연도의 다른 보고서 원문이 있으면 신규 분기를 다시 수집한다', () => {
  const db = openDatabase(':memory:');
  const sqlite = db.sqlite;
  const store = new SqliteDartPendingFilingStore(sqlite);
  try {
    sqlite.exec("INSERT INTO symbols(code,market,created_at_ms) VALUES('005930','KR',1)");
    sqlite.exec("INSERT INTO symbol_facts_state(code,covered_years_json,financial_updated_at_ms) VALUES('005930','[2026]',0)");
    new SqliteDartRawSnapshotStore(db.db).put(
      { symbol:'005930', endpoint:'FINANCIAL_STATEMENT', businessYear:2026, reportCode:'11012', fsDiv:'CFS' },
      { status:'000', list:[{ rcept_no:'20260814000001' }] }, 1,
    );
    sqlite.exec(`INSERT INTO dart_discovered_filings
      (identity,receipt_no,symbol,business_year,report_code,payload_json,discovered_at_ms,status)
      VALUES('new-q3','20260927000001','005930',2026,'11013','{}',1,'PENDING')`);
    expect(store.observeFilings(['new-q3'])).toEqual([{ symbol:'005930', year:2026 }]);
    expect(sqlite.prepare("SELECT reason FROM provider_input_issues WHERE id='dart-filing:new-q3'").get())
      .toEqual({ reason:'PENDING_FILING' });
    expect(sqlite.prepare("SELECT financial_updated_at_ms FROM symbol_facts_state WHERE code='005930'").get())
      .toEqual({ financial_updated_at_ms:0 });
  } finally { db.close(); }
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
    store.markChecked({ ...actionKey, endpoint: 'SHARE_STATUS' }, store.get({ ...actionKey, endpoint: 'SHARE_STATUS' })!);
    store.markNormalized('058970', 2026, 'ACTION');
    expect(reason()).toEqual({ reason: 'PENDING_FILING' });
    store.markChecked({ ...actionKey, endpoint: 'ISSUANCE_STATUS' }, store.get({ ...actionKey, endpoint: 'ISSUANCE_STATUS' })!);
    expect(reason()).toEqual({ reason: 'PENDING_FILING' });
    store.markNormalized('058970', 2026, 'ACTION');
    expect(reason()).toEqual({ reason: 'PENDING_FINANCIAL_FILING' });
    expect(store.observeFilings([receipt])).toEqual([{ symbol: '058970', year: 2026 }]);
    expect(reason()).toEqual({ reason: 'PENDING_FINANCIAL_FILING' });
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM provider_input_issues WHERE reason='PENDING_FILING'").get()).toEqual({ n: 3 });
    store.markChecked({ ...actionKey, endpoint: 'FINANCIAL_STATEMENT', fsDiv: 'CFS' }, store.get({ ...actionKey, endpoint: 'FINANCIAL_STATEMENT', fsDiv: 'CFS' })!);
    expect(reason()).toEqual({ reason: 'PENDING_FINANCIAL_FILING' });
    store.markNormalized('058970', 2026);
    expect(reason()).toBeUndefined();
    expect(sqlite.prepare('SELECT status FROM dart_discovered_filings WHERE identity=?').get(receipt)).toEqual({ status: 'APPLIED' });
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM provider_input_issues').get()).toEqual({ n: 3 });
  } finally { db.close(); }
});

it('목록에 더 작은 접수가 새로 관측되어도 재조회하고 조회 중 발견된 공시까지 완료 처리하지 않는다', () => {
  const db = openDatabase(':memory:');
  const store = new SqliteDartPendingFilingStore(db.sqlite);
  const older = '20260814003090';
  const newer = '20260820000112';
  try {
    db.sqlite.exec("INSERT INTO symbols(code,market,created_at_ms) VALUES('005930','KR',1)");
    db.sqlite.exec("INSERT INTO symbol_facts_state(code,covered_years_json) VALUES('005930','[2025]')");
    new SqliteDartRawSnapshotStore(db.db).put(key, { status: '000', list: [{ rcept_no: newer }] }, 1);
    const insert = db.sqlite.prepare(`INSERT INTO dart_discovered_filings
      (identity,receipt_no,symbol,business_year,report_code,payload_json,discovered_at_ms,status)
      VALUES(?,?,'005930',2025,'11011','{}',?,'PENDING')`);
    insert.run(older, older, 10);
    expect(store.observeFilings([older])).toEqual([{ symbol: '005930', year: 2025 }]);
    const filing = store.get(key)!;
    insert.run(newer, newer, 10);
    store.markChecked(key, filing);
    expect(store.get(key)?.receiptNo).toBe(newer);
    expect(db.sqlite.prepare('SELECT receipt_no FROM dart_filing_endpoint_checkpoints').all()).toEqual([{ receipt_no: older }]);
  } finally { db.close(); }
});
