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

  /**
   * 목록 화면은 종목마다 묻지 않고 집합을 한 번 받는다 — 1,000종목에서 stat 1,000회를
   * 5초마다 반복하지 않기 위해서다. `hasFacts` 와 **같은 판정**을 내야 한다: 갈라지면
   * 배지(집합)와 제출 게이트(단건)가 서로 다른 답을 준다 (D-033).
   */
  describe('symbolsWithFacts', () => {
    it('수집 전에는 빈 집합이다 — 디렉터리가 아예 없어도 던지지 않는다', () => {
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

    it('파티션 디렉터리만 있고 파일이 없으면 세지 않는다 — 쓰기가 중간에 죽은 상태다', async () => {
      await repository.saveFacts([fact({ key: '005930' })]);
      fs.mkdirSync(path.join(dataRoot, 'facts', 'scope=SYMBOL', 'symbol=000660'), {
        recursive: true,
      });
      expect(repository.symbolsWithFacts()).toEqual(new Set(['005930']));
    });

    /**
     * 종목 코드 패턴(`[A-Za-z0-9._-]{1,20}`)을 어기는 디렉터리는 세지 않는다. 여기서
     * 고른 두 이름은 실제로 패턴을 벗어난다 — `@` 는 허용 문자가 아니고, 21자는 상한을
     * 넘는다. (`..escape` 같은 이름은 패턴상 **유효하다**: 점은 BRK.B 같은 티커에 쓰인다.)
     */
    it('종목 코드 패턴을 어기는 디렉터리 이름은 무시한다', async () => {
      await repository.saveFacts([fact({ key: '005930' })]);
      for (const name of ['symbol=b@d', `symbol=${'A'.repeat(21)}`, 'symbol=']) {
        const dir = path.join(dataRoot, 'facts', 'scope=SYMBOL', name);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'data.parquet'), 'not really parquet');
      }
      expect(repository.symbolsWithFacts()).toEqual(new Set(['005930']));
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

  /**
   * 종목끼리 격리된다 — 데이터셋 격리는 없어졌다 (설계 2026-07-31-symbol-as-first-class).
   * 데이터가 데이터셋 간에 공유되는 것이 이 변경의 목적이므로, 남은 격리 축은 종목이다.
   */
  it('종목끼리 격리된다 — 한 종목의 재작성이 다른 종목을 건드리지 않는다', async () => {
    await repository.saveFacts([fact({ key: '005930', value: 1 })]);
    await repository.saveFacts([fact({ key: '000660', value: 2 })]);

    expect((await repository.getFacts({ scope: 'SYMBOL', keys: ['005930'] })).map((r) => r.value)).toEqual([1]);
    expect((await repository.getFacts({ scope: 'SYMBOL', keys: ['000660'] })).map((r) => r.value)).toEqual([2]);
    // keys 없이 읽으면 두 파티션이 합쳐진다
    expect((await repository.getFacts({ scope: 'SYMBOL' })).map((r) => r.value).sort()).toEqual([1, 2]);
  });


  it('SYMBOL 과 MACRO 는 다른 파티션이다', async () => {
    await repository.saveFacts([
      fact(),
      { scope: 'MACRO', key: 'KR_BASE_RATE', field: 'RATE', periodKey: '2025-03-01', asOfTsMs: 1_000, value: 3.5, unit: 'PERCENT' },
    ]);
    expect(await repository.getFacts({ scope: 'MACRO' })).toHaveLength(1);
    expect(await repository.getFacts({ scope: 'SYMBOL' })).toHaveLength(1);
    expect(repository.hasFacts('MACRO', 'KOSPI')).toBe(true);
  });

  it('종목 파티션 아래에 저장한다 — 종목 단위 재작성과 삭제가 가능한 이유다', async () => {
    await repository.saveFacts([fact({ key: '005930' })]);
    const partition = path.join(dataRoot, 'facts', 'scope=SYMBOL', 'symbol=005930');
    expect(fs.existsSync(path.join(partition, 'data.parquet'))).toBe(true);

    fs.rmSync(partition, { recursive: true, force: true });
    expect(await repository.getFacts({ scope: 'SYMBOL' })).toEqual([]);
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

  it('같은 파티션에 동시에 저장해도 둘 다 남는다 (파티션 락)', async () => {
    // await 로 순서를 기다리지 않고 동시에 발사한다 — 락이 없으면 두 쓰기 모두
    // 저장 전 상태를 read 해서 나중에 rename 하는 쪽이 앞선 쓰기를 지운다.
    await Promise.all([
      repository.saveFacts([fact({ periodKey: '2025Q1', value: 1 })]),
      repository.saveFacts([fact({ periodKey: '2025Q2', value: 2 })]),
    ]);
    const rows = await repository.getFacts({ scope: 'SYMBOL' });
    expect(rows.map((row) => row.periodKey).sort()).toEqual(['2025Q1', '2025Q2']);
  });

  it('부적절한 datasetId 로 hasFacts 를 호출하면 false 를 반환한다', () => {
    expect(repository.hasFacts('SYMBOL', '../escape')).toBe(false);
  });
});
