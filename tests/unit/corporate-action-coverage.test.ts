import { afterEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../helpers/test-app.js';
import { SqliteCorporateActionCoverageStore } from '../../src/server/modules/facts/application/corporate-action-coverage.js';
import { SqliteFactCoverageStore } from '../../src/server/modules/facts/application/fact-coverage-store.js';
import { symbolFactsState, symbols as symbolsTable } from '../../src/server/shared/db/schema.js';

let t: TestApp;

afterEach(async () => {
  await t.close();
});

async function setup() {
  t = await createTestApp();
  const db = t.container.database.db;
  db.insert(symbolsTable)
    .values([
      { code: '005930', market: 'KR', name: null, createdAtMs: 1 },
      { code: '000660', market: 'KR', name: null, createdAtMs: 1 },
    ])
    .run();
  return { db, store: new SqliteCorporateActionCoverageStore(db) };
}

describe('SqliteCorporateActionCoverageStore', () => {
  it('수집 연도를 합집합으로 더한다', async () => {
    const { store } = await setup();
    store.addCoveredYears('005930', [2025], 100);
    store.addCoveredYears('005930', [2026], 200);
    expect(store.getCoveredYears().get('005930')).toEqual([2025, 2026]);
  });

  it('gap 연도를 따로 관리한다', async () => {
    const { store } = await setup();
    store.addCoveredYears('005930', [2025], 100);
    store.addGapYears('005930', [2026], 100);
    expect(store.getCoveredYears().get('005930')).toEqual([2025]);
    expect(store.getGapYears().get('005930')).toEqual([2026]);
  });

  it('다른 연도의 coverage와 gap은 보존한다', async () => {
    const { store } = await setup();
    store.addCoverageResult('005930', [2025], [2025], 100);
    store.addCoverageResult('005930', [2026], [], 200);

    expect(store.getCoveredYears().get('005930')).toEqual([2025, 2026]);
    expect(store.getGapYears().get('005930')).toEqual([2025]);
    expect(store.getUpdatedAtMs(['005930']).get('005930')).toBe(200);
  });

  it('같은 연도를 재수집하면 옛 gap 상세를 최신 결과로 교체한다', async () => {
    const { store } = await setup();
    store.addCoverageResult('005930', [2025], [2025], 100, [{
      year: 2025,
      periodKey: '2025-05-01',
      reason: '분류할 수 없는 발행형태: -',
      severity: 'BLOCKING',
    }]);

    expect(store.getGapDetails(['005930']).get('005930')).toEqual([{
      year: 2025,
      periodKey: '2025-05-01',
      reason: '분류할 수 없는 발행형태: -',
      severity: 'BLOCKING',
    }]);

    store.addCoverageResult('005930', [2025], [], 200);

    expect(store.getGapYears(['005930']).get('005930')).toEqual([]);
    expect(store.getGapDetails(['005930']).get('005930')).toEqual([]);
  });

  it('구버전 coverage는 신뢰하지 않고 필요한 연도를 현재 프로토콜로 재수집하게 연다', async () => {
    const { db, store } = await setup();
    db.insert(symbolFactsState).values({
      code: '005930',
      coveredYearsJson: '[]',
      actionCoveredYearsJson: '[2025]',
      actionGapYearsJson: null,
      actionCoverageProtocolJson: '{"version":7,"years":[2025]}',
      updatedAtMs: 100,
      actionUpdatedAtMs: 100,
    }).run();

    expect(store.getCoveredYears(['005930']).get('005930')).toEqual([]);
    expect(store.getCollectedYears(['005930']).get('005930')).toEqual([2025]);

    store.addCoverageResult('005930', [2025], [], 200);
    expect(store.getCoveredYears(['005930']).get('005930')).toEqual([2025]);
  });

  it('재무 커버리지를 건드리지 않는다', async () => {
    const { db, store } = await setup();
    db.insert(symbolFactsState)
      .values({ code: '005930', coveredYearsJson: JSON.stringify([2019]), updatedAtMs: 1 })
      .run();

    store.addCoveredYears('005930', [2025], 100);

    const row = db
      .select()
      .from(symbolFactsState)
      .all()
      .find((r) => r.code === '005930');
    expect(row?.coveredYearsJson).toBe(JSON.stringify([2019]));
    expect(store.getCoveredYears().get('005930')).toEqual([2025]);
  });

  it('없는 종목은 조회되지 않는다', async () => {
    const { store } = await setup();
    expect(store.getCoveredYears().get('999999')).toBeUndefined();
    expect(store.getGapYears().get('999999')).toBeUndefined();
  });

  it('요청한 종목만 coverage·gap·watermark에서 반환하고 빈 입력은 전체 조회가 아니다', async () => {
    const { store } = await setup();
    store.addCoverageResult('005930', [2025], [2025], 100);
    store.addCoverageResult('000660', [2026], [], 200);

    expect([...store.getCoveredYears(['005930']).keys()]).toEqual(['005930']);
    expect([...store.getGapYears(['005930']).keys()]).toEqual(['005930']);
    expect([...store.getUpdatedAtMs(['005930']).keys()]).toEqual(['005930']);
    expect(store.getCoveredYears([]).size).toBe(0);
    expect(store.getGapYears([]).size).toBe(0);
    expect(store.getUpdatedAtMs([]).size).toBe(0);
  });

  it('연도를 오름차순으로 돌려준다', async () => {
    const { store } = await setup();
    store.addCoveredYears('005930', [2026, 2020, 2023], 100);
    expect(store.getCoveredYears().get('005930')).toEqual([2020, 2023, 2026]);
  });

  it('재무와 자본변동 watermark를 서로 덮어쓰지 않는다', async () => {
    const { db, store: actionStore } = await setup();
    const financialStore = new SqliteFactCoverageStore(db);

    financialStore.addCoveredYears('005930', [2024], 100);
    actionStore.addCoveredYears('005930', [2024], 200);

    expect(financialStore.getUpdatedAtMs(['005930']).get('005930')).toBe(100);
    expect(actionStore.getUpdatedAtMs(['005930']).get('005930')).toBe(200);

    financialStore.addCoveredYears('005930', [2025], 300);
    expect(financialStore.getUpdatedAtMs(['005930']).get('005930')).toBe(300);
    expect(actionStore.getUpdatedAtMs(['005930']).get('005930')).toBe(200);

    actionStore.addGapYears('005930', [2025], 400);
    expect(financialStore.getUpdatedAtMs(['005930']).get('005930')).toBe(300);
    expect(actionStore.getUpdatedAtMs(['005930']).get('005930')).toBe(400);
  });
});
