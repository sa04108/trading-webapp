import { describe, expect, it } from 'vitest';
import { SqliteFactCoverageStore } from '../../src/server/modules/facts/application/fact-coverage-store.js';
import { openDatabase } from '../../src/server/shared/db/database.js';
import {
  dartFinancialFilingReceipts,
  facts,
  symbolFactsState,
  symbols as symbolsTable,
} from '../../src/server/shared/db/schema.js';

function setup() {
  const database = openDatabase(':memory:');
  database.db
    .insert(symbolsTable)
    .values([
      { code: '005930', market: 'KR', name: null, createdAtMs: 1 },
      { code: '000660', market: 'KR', name: null, createdAtMs: 1 },
    ])
    .run();
  return { database, store: new SqliteFactCoverageStore(database.db) };
}

describe('SqliteFactCoverageStore', () => {
  it('기록이 없으면 빈 Map 이다', () => {
    const { store, database } = setup();
    expect(store.getCoveredYears().size).toBe(0);
    database.close();
  });

  it('기록한 연도를 되돌려준다', () => {
    const { store, database } = setup();
    store.addCoveredYears('005930', [2021, 2020], 100);
    expect(store.getCoveredYears().get('005930')).toEqual([2020, 2021]);
    database.close();
  });

  it('여러 번 기록하면 합집합이 되고 중복은 접힌다', () => {
    const { store, database } = setup();
    store.addCoveredYears('005930', [2020, 2021], 100);
    store.addCoveredYears('005930', [2021, 2022], 200);
    expect(store.getCoveredYears().get('005930')).toEqual([2020, 2021, 2022]);
    database.close();
  });

  it('종목별로 따로 기록된다', () => {
    const { store, database } = setup();
    store.addCoveredYears('005930', [2020], 100);
    store.addCoveredYears('000660', [2021], 100);
    const covered = store.getCoveredYears();
    expect(covered.get('005930')).toEqual([2020]);
    expect(covered.get('000660')).toEqual([2021]);
    database.close();
  });

  it('마지막 기록 시각을 종목별로 돌려준다 — 공시 watermark 용', () => {
    const { store, database } = setup();
    store.addCoveredYears('005930', [2020], 100);
    store.addCoveredYears('005930', [2021], 250);
    store.addCoveredYears('000660', [2020], 300);
    const updated = store.getUpdatedAtMs(['005930', '000660', '999999']);
    expect(updated.get('005930')).toBe(250);
    expect(updated.get('000660')).toBe(300);
    // 기록이 없는 종목은 키 자체가 없다 — 0 을 돌려주면 "1970년 이후 전부" 로 오해된다
    expect(updated.has('999999')).toBe(false);
    database.close();
  });

  it('처리한 DART 접수번호를 영속적으로 조회하고 중복 기록은 접는다', () => {
    const { store, database } = setup();
    const filing = {
      receiptNo: '20260811000001',
      symbol: '005930',
      businessYear: 2025,
      receiptDate: '2026-08-11',
    };

    store.addProcessedFilings([filing, filing], 500);
    store.addProcessedFilings([filing], 600);

    expect(
      [...store.getProcessedFilingReceiptNos(['20260811000001', '20260811000002'])],
    ).toEqual(['20260811000001']);
    expect(database.db.select().from(dartFinancialFilingReceipts).all()).toEqual([
      {
        receiptNo: '20260811000001',
        code: '005930',
        businessYear: 2025,
        receiptDate: '2026-08-11',
        processedAtMs: 500,
      },
    ]);
    database.close();
  });

  it('빈 연도 목록은 기록하지 않는다', () => {
    const { store, database } = setup();
    store.addCoveredYears('005930', [], 100);
    expect(store.getCoveredYears().size).toBe(0);
    database.close();
  });

  it('자본변동만 수집해 생긴 행은 재무를 전혀 수집하지 않은 종목과 조회 결과가 같다', () => {
    const { store, database } = setup();
    // 자본변동 전용 수집(SqliteCorporateActionCoverageStore.addYears)이 먼저 행을
    // 만들면 이 컬럼은 빈 배열로 남는다. 000660 은 행 자체가 없다.
    // 두 경우 다 "재무를 수집했다" 로 읽히면 안 된다.
    database.db
      .insert(symbolsTable)
      .values({ code: '999999', market: 'KR', name: null, createdAtMs: 1 })
      .run();
    database.db
      .insert(symbolFactsState)
      .values({ code: '999999', coveredYearsJson: '[]', updatedAtMs: 1 })
      .run();

    const covered = store.getCoveredYears();
    expect(covered.get('999999') ?? []).toEqual(covered.get('000660') ?? []);
    expect(covered.get('999999')).toEqual([]);
    database.close();
  });

  it('깨진 JSON 은 빈 목록으로 읽어 수집을 멈추지 않는다', () => {
    const { store, database } = setup();
    database.sqlite
      .prepare(
        'INSERT INTO symbol_facts_state (code, covered_years_json, updated_at_ms) VALUES (?, ?, ?)',
      )
      .run('005930', '{not json', 1);
    expect(store.getCoveredYears().get('005930')).toEqual([]);
    database.close();
  });

  it('legacy covered 연도는 manifest가 없어 검증 완료로 신뢰하지 않는다', () => {
    const { store, database } = setup();
    database.db.insert(symbolFactsState).values({
      code: '005930',
      coveredYearsJson: '[2024,2025]',
      updatedAtMs: 1,
      financialUpdatedAtMs: 1,
    }).run();

    expect(store.getCoveredYears().get('005930')).toEqual([]);
    database.close();
  });

  it('기록 당시 재무 snapshot과 일치할 때만 연도를 검증 완료로 돌려준다', () => {
    const { store, database } = setup();
    database.db.insert(facts).values({
      scope: 'SYMBOL',
      key: '005930',
      field: 'NET_INCOME',
      periodKey: '2025Q1',
      asOfTsMs: 10,
      value: 100,
      unit: 'KRW',
    }).run();
    store.addCoverageResult('005930', [2025], [], 100);
    expect(store.getCoveredYears().get('005930')).toEqual([2025]);

    database.sqlite.prepare(
      "UPDATE facts SET value = 101 WHERE scope = 'SYMBOL' AND key = '005930' AND field = 'NET_INCOME'",
    ).run();
    expect(store.getCoveredYears().get('005930')).toEqual([]);
    database.close();
  });

  it('재무 행 추가·삭제도 manifest 훼손으로 감지하고 자본변동 변경은 제외한다', () => {
    const { store, database } = setup();
    database.db.insert(facts).values({
      scope: 'SYMBOL', key: '005930', field: 'NET_INCOME', periodKey: '2025Q1',
      asOfTsMs: 10, value: 100, unit: 'KRW',
    }).run();
    store.addCoverageResult('005930', [2025], [], 100);

    database.db.insert(facts).values({
      scope: 'SYMBOL', key: '005930', field: 'CURRENT_ASSETS', periodKey: '2025Q1',
      asOfTsMs: 10, value: 200, unit: 'KRW',
    }).run();
    expect(store.getCoveredYears().get('005930')).toEqual([]);

    store.addCoverageResult('005930', [2025], [], 200);
    database.sqlite.prepare(
      "DELETE FROM facts WHERE scope = 'SYMBOL' AND key = '005930' AND field = 'CURRENT_ASSETS'",
    ).run();
    expect(store.getCoveredYears().get('005930')).toEqual([]);

    store.addCoverageResult('005930', [2025], [], 300);
    database.db.insert(facts).values({
      scope: 'SYMBOL', key: '005930', field: 'SPLIT_RATIO',
      periodKey: '2025-03-14', asOfTsMs: 11, value: 2, unit: 'RATIO',
    }).run();
    expect(store.getCoveredYears().get('005930')).toEqual([2025]);
    database.close();
  });

  it('blocking gap은 검증 연도를 실행 불가로 표시하고 informational gap은 막지 않는다', () => {
    const { store, database } = setup();
    store.addCoverageResult('005930', [2024], [{
      symbol: '005930', periodKey: '2024Q1', reason: '금액 파싱 실패', severity: 'BLOCKING',
    }], 100);
    store.addCoverageResult('005930', [2025], [{
      symbol: '005930', periodKey: '2025Q1', reason: '매핑되지 않은 계정',
      severity: 'INFORMATIONAL',
    }], 200);

    expect(store.getCoverageState(['005930']).get('005930')).toEqual({
      verifiedYears: [2024, 2025],
      blockingGapYears: [2024],
      blockingGapDetails: [{ year: 2024, examples: ['2024Q1: 금액 파싱 실패'] }],
    });
    database.close();
  });

  it('다시 기록하면 현재 snapshot manifest를 만들고 해결된 gap을 지운다', () => {
    const { store, database } = setup();
    store.addCoverageResult('005930', [2025], [{
      symbol: '005930', periodKey: '-', reason: 'corp_code 없음', severity: 'BLOCKING',
    }], 100);
    expect(store.getCoverageState().get('005930')?.blockingGapYears).toEqual([2025]);

    store.addCoverageResult('005930', [2025], [], 200);
    expect(store.getCoverageState().get('005930')).toEqual({
      verifiedYears: [2025],
      blockingGapYears: [],
      blockingGapDetails: [],
    });
    database.close();
  });
});
