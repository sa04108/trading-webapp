import { describe, expect, it, vi } from "vitest";
import { openDatabase } from "../../src/runtime/shared/db/database.js";
import { SqliteFactCoverageStore } from "../../src/runtime/modules/facts/application/fact-coverage-store.js";
import { SqliteCorporateActionCoverageStore } from "../../src/runtime/modules/facts/application/corporate-action-coverage.js";
import { facts, providerInputIssues, symbolFactsState, symbols } from "../../src/server/shared/db/schema.js";

describe("기존 수집 자료 재사용", () => {
  it("정상 legacy 재무 fact와 자본변동 coverage는 수집 버전 차이에도 재사용하고 PENDING_FILING 연도만 연다", () => {
    const database = openDatabase(":memory:");
    try {
      database.db.insert(symbols).values([{ code: "005930", market: "KR", createdAtMs: 1 }, { code: "000660", market: "KR", createdAtMs: 1 }]).run();
      database.db.insert(facts).values({ scope: "SYMBOL", key: "005930", field: "NET_INCOME", periodKey: "2025Q1", asOfTsMs: 1, value: 1, unit: "KRW" }).run();
      database.db.insert(symbolFactsState).values([
        { code: "005930", coveredYearsJson: "[2025]", actionCoveredYearsJson: "[2025]" },
        { code: "000660", coveredYearsJson: "[2025]", actionCoveredYearsJson: "[2025]" },
      ]).run();
      database.db.insert(providerInputIssues).values([{ id: "pending", symbol: "005930", businessYear: 2025, reportCode: "11011", reason: "PENDING_FILING", evidence: "receipt" }, { id: "unresolved", symbol: "000660", businessYear: null, reportCode: null, reason: "UNRESOLVED_FILING", evidence: "legacy" }]).run();
      const financial = new SqliteFactCoverageStore(database.db, { collectionVersion: "b".repeat(64) });
      const actions = new SqliteCorporateActionCoverageStore(database.db, { collectionVersion: "b".repeat(64) });
      expect(financial.getCoveredYears(["005930", "000660"])).toEqual(new Map([["005930", []], ["000660", []]]));
      expect(actions.getCoveredYears(["005930", "000660"])).toEqual(new Map([["005930", []], ["000660", [2025]]]));
      expect(actions.getGapYears(["000660"]).get("000660")).toEqual([]);
    } finally { database.close(); }
  });
});

it('이전 버전 manifest는 재사용하지만 실제 fact 변경과 삭제는 검출한다', () => {
  const database = openDatabase(':memory:');
  try {
    database.db.insert(symbols).values({code:'005930',market:'KR',createdAtMs:1}).run();
    database.db.insert(facts).values({scope:'SYMBOL',key:'005930',field:'NET_INCOME',periodKey:'2025Q1',asOfTsMs:1,value:10,unit:'KRW'}).run();
    const oldStore = new SqliteFactCoverageStore(database.db,{collectionVersion:'a'.repeat(64)});
    oldStore.addCoveredYears('005930',[2025],1);
    const row=database.sqlite.prepare('SELECT financial_coverage_protocol_json AS protocol FROM symbol_facts_state WHERE code=?').get('005930') as {protocol:string};
    const protocol=JSON.parse(row.protocol);protocol.version=100;
    database.sqlite.prepare('UPDATE symbol_facts_state SET financial_coverage_protocol_json=? WHERE code=?').run(JSON.stringify(protocol),'005930');
    const current=new SqliteFactCoverageStore(database.db,{collectionVersion:'b'.repeat(64)});
    expect(current.getCoveredYears(['005930']).get('005930')).toEqual([2025]);
    database.sqlite.prepare("UPDATE facts SET value=11 WHERE key='005930'").run();
    expect(current.getCoveredYears(['005930']).get('005930')).toEqual([]);
    database.sqlite.prepare("DELETE FROM facts WHERE key='005930'").run();
    expect(current.getCoveredYears(['005930']).get('005930')).toEqual([]);
  } finally {database.close();}
});

it('legacy 연도는 원문 없이 재사용하고 다른 연도를 수집해도 완료 근거를 보존한다', () => {
  const database = openDatabase(':memory:');
  try {
    database.db.insert(symbols).values({code:'005930',market:'KR',createdAtMs:1}).run();
    database.db.insert(facts).values({scope:'SYMBOL',key:'005930',field:'NET_INCOME',periodKey:'2024Q1',asOfTsMs:1,value:10,unit:'KRW'}).run();
    database.db.insert(symbolFactsState).values({code:'005930',coveredYearsJson:'[2024]',actionCoveredYearsJson:'[2024]',actionGapYearsJson:'[2024]'}).run();
    const current=new SqliteFactCoverageStore(database.db,{collectionVersion:'b'.repeat(64)});
    const actions=new SqliteCorporateActionCoverageStore(database.db);
    expect(current.getCoveredYears(['005930']).get('005930')).toEqual([2024]);
    expect(actions.getCoveredYears(['005930']).get('005930')).toEqual([2024]);
    expect(actions.getGapYears(['005930']).get('005930')).toEqual([2024]);
    current.addCoveredYears('005930',[2025],2);
    expect(current.getCoveredYears(['005930']).get('005930')).toEqual([2024,2025]);
    database.sqlite.prepare("UPDATE symbol_facts_state SET financial_coverage_protocol_json='broken',action_coverage_protocol_json='broken'").run();
    expect(current.getCoveredYears(['005930']).get('005930')).toEqual([]);
    expect(actions.getCoveredYears(['005930']).get('005930')).toEqual([]);
  } finally {database.close();}
});


it('coverage와 문제 이력은 요청 종목 조건을 SQL에 전달한다', () => {
  const database = openDatabase(':memory:');
  const queries: string[] = [];
  const prepare = database.sqlite.prepare.bind(database.sqlite);
  const spy = vi.spyOn(database.sqlite, 'prepare').mockImplementation((sql: string) => { queries.push(sql); return prepare(sql); });
  try {
    const financial = new SqliteFactCoverageStore(database.db);
    const actions = new SqliteCorporateActionCoverageStore(database.db);
    financial.getCoverageState(['005930']);financial.getCollectedYears(['005930']);financial.getUpdatedAtMs(['005930']);
    actions.getCoveredYears(['005930']);actions.getGapYears(['005930']);
    const reads = queries.filter(sql => /from "(?:symbol_facts_state|provider_input_issues)"/i.test(sql));
    expect(reads.length).toBeGreaterThan(5);
    for (const sql of reads) expect(sql).toMatch(/where.*(?:code|symbol).*in/i);
  } finally {spy.mockRestore();database.close();}
});
