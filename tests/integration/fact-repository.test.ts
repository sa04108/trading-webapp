import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Fact } from '../../src/server/modules/facts/domain/fact.js';
import { ParquetFactRepository } from '../../src/server/modules/facts/infrastructure/parquet-fact-repository.js';
import { DuckDbService } from '../../src/server/modules/market-data/infrastructure/duckdb-service.js';

let dataRoot: string;
let duckdb: DuckDbService;
let repository: ParquetFactRepository;

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
  dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'facts-'));
  duckdb = new DuckDbService({ threads: 1, memoryLimit: '256MB' });
  repository = new ParquetFactRepository(dataRoot, duckdb);
});

afterEach(() => {
  duckdb.close();
  fs.rmSync(dataRoot, { recursive: true, force: true });
});

describe('ParquetFactRepository', () => {
  it('저장한 팩트를 그대로 읽는다', async () => {
    await repository.saveFacts('ds-1', [fact()]);
    const rows = await repository.getFacts({ datasetId: 'ds-1', scope: 'SYMBOL' });
    expect(rows).toEqual([fact()]);
  });

  it('빈 배열 저장은 아무 일도 하지 않는다', async () => {
    await repository.saveFacts('ds-1', []);
    expect(repository.hasFacts('ds-1', 'SYMBOL')).toBe(false);
  });

  it('수집되지 않은 데이터셋 조회는 빈 배열', async () => {
    expect(await repository.getFacts({ datasetId: 'nope', scope: 'SYMBOL' })).toEqual([]);
    expect(repository.hasFacts('nope', 'SYMBOL')).toBe(false);
  });

  it('asOfMaxTsMs 로 미래 공시를 잘라낸다', async () => {
    await repository.saveFacts('ds-1', [
      fact({ periodKey: '2025Q1', asOfTsMs: 1_000, value: 10 }),
      fact({ periodKey: '2025Q2', asOfTsMs: 2_000, value: 20 }),
    ]);
    const rows = await repository.getFacts({
      datasetId: 'ds-1',
      scope: 'SYMBOL',
      asOfMaxTsMs: 1_500,
    });
    expect(rows.map((row) => row.periodKey)).toEqual(['2025Q1']);
  });

  it('keys·fields 로 걸러낸다', async () => {
    await repository.saveFacts('ds-1', [
      fact({ key: '005930', field: 'OPERATING_INCOME' }),
      fact({ key: '000660', field: 'OPERATING_INCOME' }),
      fact({ key: '005930', field: 'CURRENT_ASSETS' }),
    ]);
    const rows = await repository.getFacts({
      datasetId: 'ds-1',
      scope: 'SYMBOL',
      keys: ['005930'],
      fields: ['OPERATING_INCOME'],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.key).toBe('005930');
    expect(rows[0]?.field).toBe('OPERATING_INCOME');
  });

  it('같은 (key, field, periodKey, asOf) 재수집은 덮어쓴다 — idempotent', async () => {
    await repository.saveFacts('ds-1', [fact({ value: 100 })]);
    await repository.saveFacts('ds-1', [fact({ value: 200 })]);
    const rows = await repository.getFacts({ datasetId: 'ds-1', scope: 'SYMBOL' });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.value).toBe(200);
  });

  it('같은 분기의 다른 asOf(재집계)는 둘 다 남는다', async () => {
    await repository.saveFacts('ds-1', [
      fact({ asOfTsMs: 1_000, value: 100 }),
      fact({ asOfTsMs: 2_000, value: 90 }),
    ]);
    const rows = await repository.getFacts({ datasetId: 'ds-1', scope: 'SYMBOL' });
    expect(rows).toHaveLength(2);
  });

  it('두 번에 걸쳐 저장해도 앞서 저장한 것이 남는다 (병합 저장)', async () => {
    await repository.saveFacts('ds-1', [fact({ periodKey: '2025Q1' })]);
    await repository.saveFacts('ds-1', [fact({ periodKey: '2025Q2' })]);
    const rows = await repository.getFacts({ datasetId: 'ds-1', scope: 'SYMBOL' });
    expect(rows.map((row) => row.periodKey).sort()).toEqual(['2025Q1', '2025Q2']);
  });

  it('데이터셋끼리 격리된다', async () => {
    await repository.saveFacts('ds-1', [fact({ value: 1 })]);
    await repository.saveFacts('ds-2', [fact({ value: 2 })]);
    const first = await repository.getFacts({ datasetId: 'ds-1', scope: 'SYMBOL' });
    expect(first.map((row) => row.value)).toEqual([1]);
  });

  it('SYMBOL 과 MACRO 는 다른 파티션이다', async () => {
    await repository.saveFacts('ds-1', [
      fact(),
      { scope: 'MACRO', key: 'KR_BASE_RATE', field: 'RATE', periodKey: '2025-03-01', asOfTsMs: 1_000, value: 3.5, unit: 'PERCENT' },
    ]);
    expect(await repository.getFacts({ datasetId: 'ds-1', scope: 'MACRO' })).toHaveLength(1);
    expect(await repository.getFacts({ datasetId: 'ds-1', scope: 'SYMBOL' })).toHaveLength(1);
    expect(repository.hasFacts('ds-1', 'MACRO')).toBe(true);
  });

  it('데이터셋 삭제 경로에 놓인다 — dataset= 디렉터리 아래에 저장한다', async () => {
    await repository.saveFacts('ds-1', [fact()]);
    expect(fs.existsSync(path.join(dataRoot, 'dataset=ds-1'))).toBe(true);
    // ParquetCandleRepository.deleteDataset 이 dataset=<id> 를 재귀 삭제하므로
    // 팩트 정리 코드를 따로 만들지 않는다
    fs.rmSync(path.join(dataRoot, 'dataset=ds-1'), { recursive: true, force: true });
    expect(await repository.getFacts({ datasetId: 'ds-1', scope: 'SYMBOL' })).toEqual([]);
  });

  it('부적절한 datasetId 는 거부한다 (경로 조작 방지)', async () => {
    await expect(repository.saveFacts('../escape', [fact()])).rejects.toThrow(/datasetId/);
  });

  it('결과는 (key, field, periodKey, asOf) 순으로 결정적이다', async () => {
    await repository.saveFacts('ds-1', [
      fact({ key: '000660', periodKey: '2025Q2' }),
      fact({ key: '005930', periodKey: '2025Q1' }),
      fact({ key: '000660', periodKey: '2025Q1' }),
    ]);
    const rows = await repository.getFacts({ datasetId: 'ds-1', scope: 'SYMBOL' });
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
    await expect(repository.saveFacts('ds-1', [fact({ value: NaN })])).rejects.toThrow(
      /유한하지 않습니다/,
    );
    await expect(repository.saveFacts('ds-1', [fact({ value: Infinity })])).rejects.toThrow(
      /유한하지 않습니다/,
    );
  });

  it('asOfTsMs 가 유한하지 않으면 저장을 거부한다', async () => {
    await expect(
      repository.saveFacts('ds-1', [fact({ asOfTsMs: NaN })]),
    ).rejects.toThrow(/유한하지 않습니다/);
  });
});
