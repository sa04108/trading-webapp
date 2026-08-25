import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Fact } from '../../src/server/modules/facts/domain/fact.js';
import { SqliteFactRepository } from '../../src/server/modules/facts/infrastructure/sqlite-fact-repository.js';
import { openDatabase, type DatabaseHandle } from '../../src/server/shared/db/database.js';
import { symbolFactsState, symbols } from '../../src/server/shared/db/schema.js';

let root: string;
let database: DatabaseHandle;
let repository: SqliteFactRepository;

function fact(overrides: Partial<Fact> = {}): Fact {
  return {
    scope: 'SYMBOL',
    key: '005930',
    field: 'OPERATING_INCOME',
    periodKey: '2025Q1',
    asOfTsMs: 1_700_000_000_000,
    value: 123_456,
    unit: 'KRW',
    ...overrides,
  };
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'facts-'));
  database = openDatabase(path.join(root, 'app.sqlite'));
  repository = new SqliteFactRepository(database.db);
});

afterEach(() => {
  database.close();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('SqliteFactRepository', () => {
  it('저장한 팩트를 그대로 읽는다', async () => {
    await repository.saveFacts([fact()]);
    const rows = await repository.getFacts({ scope: 'SYMBOL' });
    expect(rows).toEqual([fact()]);
  });

  it('빈 배열 저장은 아무 일도 하지 않는다', async () => {
    await repository.saveFacts([]);
    expect(repository.hasFacts('SYMBOL', '005930')).toBe(false);
  });

  it('수집되지 않은 데이터셋 조회는 빈 배열', async () => {
    expect(await repository.getFacts({ scope: 'SYMBOL' })).toEqual([]);
    expect(repository.hasFacts('SYMBOL', 'nope!')).toBe(false);
  });

  it('팩트가 0건이어도 수집 coverage가 있으면 수집된 종목으로 센다', () => {
    database.db.insert(symbols).values({
      code: '005930',
      market: 'KR',
      createdAtMs: 1,
    }).run();
    database.db.insert(symbolFactsState).values({
      code: '005930',
      coveredYearsJson: '[2025]',
      actionCoveredYearsJson: '[]',
      actionGapYearsJson: '[]',
      updatedAtMs: 1,
    }).run();

    expect(repository.hasFacts('SYMBOL', '005930')).toBe(true);
    expect(repository.symbolsWithFacts()).toEqual(new Set(['005930']));
  });

  /** 목록 화면은 종목마다 묻지 않고 집합을 한 번 받는다. */
  describe('symbolsWithFacts', () => {
    it('수집 전에는 빈 집합이다', () => {
      expect(repository.symbolsWithFacts()).toEqual(new Set());
    });

    it('저장한 종목만 담고 hasFacts 와 답이 같다', async () => {
      await repository.saveFacts([fact({ key: '005930' }), fact({ key: '000660' })]);
      const codes = repository.symbolsWithFacts();
      expect(codes).toEqual(new Set(['005930', '000660']));
      for (const code of ['005930', '000660', '035720']) {
        expect(codes.has(code)).toBe(repository.hasFacts('SYMBOL', code));
      }
    });

    it('MACRO 팩트는 종목 집합에 섞이지 않는다 — key 가 종목이 아니라 지표 계열명이다', async () => {
      await repository.saveFacts([fact({ scope: 'MACRO', key: 'KOSPI' })]);
      expect(repository.symbolsWithFacts()).toEqual(new Set());
    });
  });

  it('asOfMaxTsMs 로 미래 공시를 잘라낸다', async () => {
    await repository.saveFacts([
      fact({ periodKey: '2025Q1', asOfTsMs: 1_000, value: 10 }),
      fact({ periodKey: '2025Q2', asOfTsMs: 2_000, value: 20 }),
    ]);
    const rows = await repository.getFacts({
      scope: 'SYMBOL',
      asOfMaxTsMs: 1_500,
    });
    expect(rows.map((row) => row.periodKey)).toEqual(['2025Q1']);
  });

  it('keys·fields 로 걸러낸다', async () => {
    await repository.saveFacts([
      fact({ key: '005930', field: 'OPERATING_INCOME' }),
      fact({ key: '000660', field: 'OPERATING_INCOME' }),
      fact({ key: '005930', field: 'CURRENT_ASSETS' }),
    ]);
    const rows = await repository.getFacts({
      scope: 'SYMBOL',
      keys: ['005930'],
      fields: ['OPERATING_INCOME'],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.key).toBe('005930');
    expect(rows[0]?.field).toBe('OPERATING_INCOME');
  });

  it('같은 (key, field, periodKey, asOf) 재수집은 덮어쓴다 — idempotent', async () => {
    await repository.saveFacts([fact({ value: 100 })]);
    await repository.saveFacts([fact({ value: 200 })]);
    const rows = await repository.getFacts({ scope: 'SYMBOL' });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.value).toBe(200);
  });

  it('같은 분기의 다른 asOf(재집계)는 둘 다 남는다', async () => {
    await repository.saveFacts([
      fact({ asOfTsMs: 1_000, value: 100 }),
      fact({ asOfTsMs: 2_000, value: 90 }),
    ]);
    const rows = await repository.getFacts({ scope: 'SYMBOL' });
    expect(rows).toHaveLength(2);
  });

  it('두 번에 걸쳐 저장해도 앞서 저장한 것이 남는다 (병합 저장)', async () => {
    await repository.saveFacts([fact({ periodKey: '2025Q1' })]);
    await repository.saveFacts([fact({ periodKey: '2025Q2' })]);
    const rows = await repository.getFacts({ scope: 'SYMBOL' });
    expect(rows.map((row) => row.periodKey).sort()).toEqual(['2025Q1', '2025Q2']);
  });

  it('종목·연도 재무 snapshot 교체는 stale 행을 지우고 다른 연도·자본변동은 보존한다', async () => {
    await repository.saveFacts([
      fact({ field: 'NET_INCOME', periodKey: '2025Q1', value: 1 }),
      fact({ field: 'CURRENT_ASSETS', periodKey: '2025Q2', value: 2 }),
      fact({ field: 'NET_INCOME', periodKey: '2024Q4', value: 3 }),
      fact({ field: 'SPLIT_RATIO', periodKey: '2025-03-14', value: 2, unit: 'RATIO' }),
    ]);

    await repository.replaceSymbolFinancialFactsForYear('005930', 2025, [
      fact({ field: 'NET_INCOME', periodKey: '2025Q1', value: 10 }),
    ]);

    const rows = await repository.getFacts({ scope: 'SYMBOL', keys: ['005930'] });
    expect(rows.map((row) => `${row.field}:${row.periodKey}:${row.value}`).sort()).toEqual([
      'NET_INCOME:2024Q4:3',
      'NET_INCOME:2025Q1:10',
      'SPLIT_RATIO:2025-03-14:2',
    ]);
  });

  it('빈 재무 snapshot도 해당 연도의 stale 재무만 제거한다', async () => {
    await repository.saveFacts([
      fact({ periodKey: '2025Q1' }),
      fact({ periodKey: '2024Q4' }),
      fact({ field: 'SPLIT_RATIO', periodKey: '2025-03-14', value: 2, unit: 'RATIO' }),
    ]);

    await repository.replaceSymbolFinancialFactsForYear('005930', 2025, []);

    expect((await repository.getFacts({ scope: 'SYMBOL' })).map(
      (row) => `${row.field}:${row.periodKey}`,
    ).sort()).toEqual(['OPERATING_INCOME:2024Q4', 'SPLIT_RATIO:2025-03-14']);
  });

  it('재무 snapshot 범위를 벗어난 팩트는 삭제 전에 거부한다', async () => {
    await repository.saveFacts([fact({ periodKey: '2025Q1', value: 1 })]);

    await expect(repository.replaceSymbolFinancialFactsForYear('005930', 2025, [
      fact({ key: '000660', periodKey: '2025Q1' }),
    ])).rejects.toThrow(/범위를 벗어난/);
    await expect(repository.replaceSymbolFinancialFactsForYear('005930', 2025, [
      fact({ periodKey: '2024Q4' }),
    ])).rejects.toThrow(/범위를 벗어난/);
    await expect(repository.replaceSymbolFinancialFactsForYear('005930', 2025, [
      fact({ field: 'SPLIT_RATIO', periodKey: '2025-03-14', unit: 'RATIO' }),
    ])).rejects.toThrow(/범위를 벗어난/);

    expect(await repository.getFacts({ scope: 'SYMBOL', keys: ['005930'] })).toEqual([
      fact({ periodKey: '2025Q1', value: 1 }),
    ]);
  });

  it('종목끼리 격리된다', async () => {
    await repository.saveFacts([fact({ key: '005930', value: 1 })]);
    await repository.saveFacts([fact({ key: '000660', value: 2 })]);

    expect((await repository.getFacts({ scope: 'SYMBOL', keys: ['005930'] })).map((r) => r.value)).toEqual([1]);
    expect((await repository.getFacts({ scope: 'SYMBOL', keys: ['000660'] })).map((r) => r.value)).toEqual([2]);
    // keys 없이 읽으면 두 종목이 합쳐진다.
    expect((await repository.getFacts({ scope: 'SYMBOL' })).map((r) => r.value).sort()).toEqual([1, 2]);
  });
  it('SYMBOL과 MACRO는 다른 스코프다', async () => {
    await repository.saveFacts([
      fact(),
      { scope: 'MACRO', key: 'KR_BASE_RATE', field: 'RATE', periodKey: '2025-03-01', asOfTsMs: 1_000, value: 3.5, unit: 'PERCENT' },
    ]);
    expect(await repository.getFacts({ scope: 'MACRO' })).toHaveLength(1);
    expect(await repository.getFacts({ scope: 'SYMBOL' })).toHaveLength(1);
    expect(repository.hasFacts('MACRO', 'KR_BASE_RATE')).toBe(true);
  });

  it('부적절한 종목 키는 거부한다 (경로 조작 방지)', async () => {
    await expect(repository.saveFacts([fact({ key: '../escape' })])).rejects.toThrow(/symbol key/);
  });

  it('결과는 (key, field, periodKey, asOf) 순으로 결정적이다', async () => {
    await repository.saveFacts([
      fact({ key: '000660', periodKey: '2025Q2' }),
      fact({ key: '005930', periodKey: '2025Q1' }),
      fact({ key: '000660', periodKey: '2025Q1' }),
    ]);
    const rows = await repository.getFacts({ scope: 'SYMBOL' });
    expect(rows.map((row) => `${row.key}:${row.periodKey}`)).toEqual([
      '000660:2025Q1',
      '000660:2025Q2',
      '005930:2025Q1',
    ]);
  });

  // 이하 두 건은 브리프 이후 추가: PitFactView 의 정렬 비교자가 value 를 뺄셈으로
  // 비교하기 때문에 non-finite value 가 들어오면 비교 결과가 NaN 이 되고,
  // Array.prototype.sort 는 NaN 을 동률로 취급해 배열 순서로 조용히 결과가 갈린다
  // (재현성 붕괴). 뷰에서 방어하지 않고 저장 경계에서 막는다.
  it('value 가 유한하지 않으면 저장을 거부한다', async () => {
    await expect(repository.saveFacts([fact({ value: NaN })])).rejects.toThrow(
      /유한하지 않습니다/,
    );
    await expect(repository.saveFacts([fact({ value: Infinity })])).rejects.toThrow(
      /유한하지 않습니다/,
    );
  });

  it('asOfTsMs 가 유한하지 않으면 저장을 거부한다', async () => {
    await expect(
      repository.saveFacts([fact({ asOfTsMs: NaN })]),
    ).rejects.toThrow(/유한하지 않습니다/);
  });

  it('구분자 없이 이어붙이면 충돌하는 (key, field) 경계쌍도 둘 다 남는다', async () => {
    // 'AB'+'CD' 와 'ABC'+'D' 는 구분자 없이 이어붙이면 같은 문자열이 된다 —
    // key·field 는 domain 상 자유 문자열(FundamentalField 도 리터럴 유니온일 뿐
    // 실제 타입은 string)이라 이 경계쌍은 이론이 아니라 실제로 도달 가능하다.
    await repository.saveFacts([
      fact({ key: 'AB', field: 'CD', periodKey: '2025Q1', asOfTsMs: 1_000, value: 1 }),
      fact({ key: 'ABC', field: 'D', periodKey: '2025Q1', asOfTsMs: 1_000, value: 2 }),
    ]);
    const rows = await repository.getFacts({ scope: 'SYMBOL' });
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => `${row.key}/${row.field}`).sort()).toEqual(['AB/CD', 'ABC/D']);
  });

  it('동시에 저장해도 둘 다 남는다', async () => {
    await Promise.all([
      repository.saveFacts([fact({ periodKey: '2025Q1', value: 1 })]),
      repository.saveFacts([fact({ periodKey: '2025Q2', value: 2 })]),
    ]);
    const rows = await repository.getFacts({ scope: 'SYMBOL' });
    expect(rows.map((row) => row.periodKey).sort()).toEqual(['2025Q1', '2025Q2']);
  });

  it('부적절한 key 로 hasFacts 를 호출하면 false 를 반환한다', () => {
    expect(repository.hasFacts('SYMBOL', '../escape')).toBe(false);
  });
});
