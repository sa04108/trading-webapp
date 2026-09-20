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
