import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runDatasetMergeMigration } from '../../src/server/modules/market-data/application/dataset-merge-migration.js';
import {
  openDatabase,
  type AppDatabase,
  type DatabaseHandle,
} from '../../src/server/shared/db/database.js';
import {
  backtestJobs,
  backtestRuns,
  brokerSyncState,
  dataCoverage,
  dataImportJobs,
  datasetFactsState,
  datasetVersions,
  datasets,
} from '../../src/server/shared/db/schema.js';

const NOW_MS = 5_000;
const clock = { now: () => NOW_MS };

interface LogEntry {
  obj: Record<string, unknown>;
  msg: string | undefined;
}

function recordingLogger(): {
  warns: LogEntry[];
  logger: { info: (obj: Record<string, unknown>, msg?: string) => void; warn: (obj: Record<string, unknown>, msg?: string) => void };
} {
  const warns: LogEntry[] = [];
  return {
    warns,
    logger: {
      info: () => undefined,
      warn: (obj, msg) => warns.push({ obj, msg }),
    },
  };
}

let dir: string;
let dataRoot: string;
let handle: DatabaseHandle;
let db: AppDatabase;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'merge-migration-'));
  dataRoot = join(dir, 'market-data');
  mkdirSync(dataRoot, { recursive: true });
  handle = openDatabase(join(dir, 'test.sqlite'));
  db = handle.db;
});
afterEach(() => {
  handle.close();
  rmSync(dir, { recursive: true, force: true });
});

/** 0004 백필 직후의 레거시 데이터셋 행 — symbolsKey 는 아직 '' 이다 */
function insertLegacyDataset(
  id: string,
  legacyTimeframe: '1h' | '1m' | '1d',
  createdAtMs: number,
  symbols: string[] = ['005930', '000660'],
): void {
  db.insert(datasets)
    .values({
      id,
      name: id,
      market: 'KR',
      timeframe: legacyTimeframe,
      defaultTimeframe: legacyTimeframe === '1d' ? '1d' : '1m',
      symbolsJson: JSON.stringify(symbols),
      createdAtMs,
      updatedAtMs: createdAtMs,
    })
    .run();
}

function insertVersion(datasetId: string, version: number, contentHash: string): void {
  db.insert(datasetVersions)
    .values({ id: `dsv_${datasetId}_${version}`, datasetId, version, contentHash, createdAtMs: 1 })
    .run();
}

function seedCandleDir(datasetId: string, timeframe: string, symbol = '005930'): string {
  const partition = join(
    dataRoot,
    `dataset=${datasetId}`,
    'market=KR',
    `timeframe=${timeframe}`,
    `symbol=${symbol}`,
    'year=2026',
  );
  mkdirSync(partition, { recursive: true });
  const file = join(partition, 'data.parquet');
  writeFileSync(file, `fake:${datasetId}:${timeframe}`);
  return file;
}

function seedFactsDir(datasetId: string): void {
  const partition = join(dataRoot, `dataset=${datasetId}`, 'facts', 'scope=SYMBOL');
  mkdirSync(partition, { recursive: true });
  writeFileSync(join(partition, 'data.parquet'), `facts:${datasetId}`);
}

function run(logger = recordingLogger().logger): void {
  runDatasetMergeMigration({ db, dataRoot, clock, logger });
}

/** 병합 대상 표준 시나리오: 분봉 종류(먼저 생성) + 일봉 종류(나중 생성) */
function seedMergePair(): void {
  insertLegacyDataset('ds_min', '1h', 1_000);
  insertLegacyDataset('ds_day', '1d', 2_000, ['000660', '005930']);
  insertVersion('ds_min', 1, 'a1');
  insertVersion('ds_min', 2, 'a2');
  insertVersion('ds_day', 5, 'b5');
  seedCandleDir('ds_min', '1m');
  seedCandleDir('ds_min', '1h');
  seedCandleDir('ds_day', '1d');

  // loser(ds_day)를 참조하는 행 — 병합 후 전부 survivor 로 재매핑되어야 한다
  db.insert(dataCoverage)
    .values({ datasetId: 'ds_day', symbol: '005930', slice: '1d', barCount: 10, computedAtMs: 1 })
    .run();
  db.insert(brokerSyncState).values({ datasetId: 'ds_day', symbol: '005930', slice: '1d' }).run();
  db.insert(dataImportJobs)
    .values({ id: 'imp_1', datasetId: 'ds_day', status: 'COMPLETED', sourceType: 'CSV', createdAtMs: 1 })
    .run();
  db.insert(datasetFactsState)
    .values({ datasetId: 'ds_day', symbol: '005930', coveredYearsJson: '[2025]', updatedAtMs: 1 })
    .run();
  db.insert(backtestJobs)
    .values({ id: 'bt_1', status: 'COMPLETED', requestJson: '{}', strategyId: 's', datasetId: 'ds_day', createdAtMs: 1 })
    .run();
  db.insert(backtestRuns)
    .values({
      id: 'run_1',
      jobId: 'bt_1',
      strategyId: 's',
      strategyVersion: '1',
      strategySourceHash: 'h',
      parameterJson: '{}',
      datasetId: 'ds_day',
      datasetVersion: 5,
      datasetHash: 'b5',
      engineVersion: '1',
      feeModelVersion: '1',
      slippageModelVersion: '1',
      randomSeed: 1,
      gitCommitSha: 'sha',
      startedAtMs: 1,
    })
    .run();

  // survivor 자기 행 — 병합이 건드리지 않아야 한다
  db.insert(dataCoverage)
    .values({ datasetId: 'ds_min', symbol: '005930', slice: '1m', barCount: 20, computedAtMs: 1 })
    .run();
}

describe('runDatasetMergeMigration — 병합', () => {
  it('일봉·분봉 한 쌍을 먼저 만든 쪽으로 병합한다 (행·파일·참조·버전)', () => {
    seedMergePair();
    run();

    // 데이터셋 행: 생존자 ds_min 하나만 남고 symbolsKey 가 채워진다
    const rows = db.select().from(datasets).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe('ds_min');
    expect(rows[0]?.symbolsKey).toBe('000660,005930');
    // defaultTimeframe 은 생존자 것 유지
    expect(rows[0]?.defaultTimeframe).toBe('1m');

    // Parquet: loser 의 timeframe=1d 가 survivor 아래로 이동, loser 디렉터리는 사라진다
    expect(
      existsSync(
        join(dataRoot, 'dataset=ds_min', 'market=KR', 'timeframe=1d', 'symbol=005930', 'year=2026', 'data.parquet'),
      ),
    ).toBe(true);
    expect(existsSync(join(dataRoot, 'dataset=ds_min', 'market=KR', 'timeframe=1m'))).toBe(true);
    expect(existsSync(join(dataRoot, 'dataset=ds_day'))).toBe(false);

    // 참조 재매핑: loser 를 가리키던 행이 전부 survivor 를 가리킨다
    expect(db.select().from(dataCoverage).all().map((r) => r.datasetId)).toEqual(['ds_min', 'ds_min']);
    expect(db.select().from(brokerSyncState).all()[0]?.datasetId).toBe('ds_min');
    expect(db.select().from(dataImportJobs).all()[0]?.datasetId).toBe('ds_min');
    expect(db.select().from(datasetFactsState).all()[0]?.datasetId).toBe('ds_min');
    expect(db.select().from(backtestJobs).all()[0]?.datasetId).toBe('ds_min');
    expect(db.select().from(backtestRuns).all()[0]?.datasetId).toBe('ds_min');

    // 버전: loser 의 버전 행도 survivor 로 옮겨지고, 새 버전 = max(2, 5) + 1 = 6
    const versions = db.select().from(datasetVersions).all();
    expect(versions.every((v) => v.datasetId === 'ds_min')).toBe(true);
    expect(versions).toHaveLength(4);
    const latest = versions.reduce((a, b) => (a.version > b.version ? a : b));
    expect(latest.version).toBe(6);
    expect(latest.createdAtMs).toBe(NOW_MS);
    // 체인 해시: 생존자 최신 해시에 merge 시드를 연결한다
    expect(latest.contentHash).toBe(
      createHash('sha256').update('a2:merge:ds_day').digest('hex'),
    );
  });

  it('loser 만 facts 파티션을 가지면 함께 이동한다', () => {
    seedMergePair();
    seedFactsDir('ds_day');
    run();

    expect(existsSync(join(dataRoot, 'dataset=ds_min', 'facts', 'scope=SYMBOL', 'data.parquet'))).toBe(true);
    expect(existsSync(join(dataRoot, 'dataset=ds_day'))).toBe(false);
  });

  it('두 번 실행해도 결과가 같다 (멱등)', () => {
    seedMergePair();
    run();

    const snapshot = {
      datasets: db.select().from(datasets).all(),
      versions: db.select().from(datasetVersions).all(),
      coverage: db.select().from(dataCoverage).all(),
    };
    run();

    expect(db.select().from(datasets).all()).toEqual(snapshot.datasets);
    expect(db.select().from(datasetVersions).all()).toEqual(snapshot.versions);
    expect(db.select().from(dataCoverage).all()).toEqual(snapshot.coverage);
  });
});

describe('runDatasetMergeMigration — 병합하지 않는 경우', () => {
  it('짝이 없는 데이터셋은 symbolsKey 만 채우고 버전은 올리지 않는다', () => {
    insertLegacyDataset('ds_solo', '1d', 1_000, ['005930', '005930', '000660']);
    insertVersion('ds_solo', 3, 'c3');
    run();

    const row = db.select().from(datasets).all()[0];
    expect(row?.symbolsKey).toBe('000660,005930'); // 정렬·중복 제거
    const versions = db.select().from(datasetVersions).all();
    expect(versions).toHaveLength(1);
    expect(versions[0]?.version).toBe(3);
  });

  it('같은 종류 중복(일봉 둘)은 경고만 남기고 둘 다 유지한다', () => {
    insertLegacyDataset('ds_a', '1d', 1_000);
    insertLegacyDataset('ds_b', '1d', 2_000, ['000660', '005930']);
    const { warns, logger } = recordingLogger();
    run(logger);

    const rows = db.select().from(datasets).all();
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.symbolsKey === '000660,005930')).toBe(true);
    expect(db.select().from(datasetVersions).all()).toHaveLength(0);
    expect(warns.length).toBeGreaterThan(0);
  });

  it('이동 대상 디렉터리가 이미 있으면 그 쌍은 건너뛰고 경고한다 (반쪽 이동 금지)', () => {
    insertLegacyDataset('ds_min', '1h', 1_000);
    insertLegacyDataset('ds_day', '1d', 2_000);
    seedCandleDir('ds_min', '1h');
    seedCandleDir('ds_min', '1d'); // survivor 가 이미 1d 파티션을 가진 비정상 상태
    const loserFile = seedCandleDir('ds_day', '1d');
    const { warns, logger } = recordingLogger();
    run(logger);

    // 병합하지 않는다: 두 행 모두 남고 loser 파일은 제자리
    const rows = db.select().from(datasets).all();
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.symbolsKey === '000660,005930')).toBe(true);
    expect(existsSync(loserFile)).toBe(true);
    expect(db.select().from(datasetVersions).all()).toHaveLength(0);
    expect(warns.length).toBeGreaterThan(0);
  });

  it('symbolsKey 가 이미 채워진 데이터셋은 건드리지 않는다 (재실행 무시)', () => {
    db.insert(datasets)
      .values({
        id: 'ds_new',
        name: 'ds_new',
        market: 'KR',
        timeframe: '1d',
        defaultTimeframe: '1d',
        symbolsKey: '005930',
        symbolsJson: '["005930"]',
        createdAtMs: 1,
        updatedAtMs: 1,
      })
      .run();
    run();

    const row = db.select().from(datasets).all()[0];
    expect(row?.updatedAtMs).toBe(1);
  });
});
