import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { desc, eq } from 'drizzle-orm';
import type { Clock } from '../../../shared/clock.js';
import type { AppDatabase } from '../../../shared/db/database.js';
import {
  backtestJobs,
  backtestRuns,
  brokerSyncState,
  dataCoverage,
  dataImportJobs,
  datasetFactsState,
  datasetVersions,
  datasets,
} from '../../../shared/db/schema.js';
import { newId } from '../../../shared/ids.js';
import { symbolsKey, type DatasetSlice } from '../domain/dataset-slice.js';

/** pino Logger 가 구조적으로 만족하는 최소 폭 — 테스트가 기록용 가짜를 끼울 수 있다 */
export interface DatasetMergeLogger {
  info(obj: Record<string, unknown>, msg?: string): void;
  warn(obj: Record<string, unknown>, msg?: string): void;
}

export interface DatasetMergeMigrationDeps {
  db: AppDatabase;
  /** Parquet 최상위 — ParquetCandleRepository 가 받는 config.dataRoot 와 같은 값 */
  dataRoot: string;
  clock: Clock;
  logger: DatasetMergeLogger;
}

type DatasetRow = typeof datasets.$inferSelect;

interface PendingDataset {
  row: DatasetRow;
  key: string;
  /**
   * 레거시 종류 — '1d' = 일봉 데이터셋, '1m' = 분봉(구 1h/1m).
   * 0004 백필이 구 timeframe 컬럼을 같은 매핑으로 defaultTimeframe 에 복사했으므로
   * (마이그레이션이 부트 병합보다 항상 먼저 돈다) 그 값을 그대로 읽는다 —
   * 구 timeframe 컬럼은 제거됐다.
   */
  kind: DatasetSlice;
}

interface MergePlan {
  survivor: PendingDataset;
  loser: PendingDataset;
}

/** dataset=<id> 아래에서 이동할 (상대경로 src → 상대경로 dst) 한 건 */
interface DirMove {
  from: string;
  to: string;
}

const MERGE_MODULE = 'market-data';

/**
 * 부트 1회성 병합 마이그레이션 (설계 2026-07-30-dataset-symbol-group-design.md).
 *
 * 구모델에서는 같은 종목 구성이 일봉 데이터셋과 분봉 데이터셋으로 따로 존재했다.
 * 신모델의 데이터셋 = 종목 그룹이므로, 같은 (market, 종목 구성)에 일봉 종류와
 * 분봉 종류가 정확히 하나씩이면 먼저 만든 쪽으로 병합한다.
 *
 * 멱등성: `symbolsKey === ''` 인 행(0004 백필 직후의 레거시 행)만 처리한다 —
 * 처리된 행은 키가 채워지므로 두 번째 실행은 자연히 no-op 이다.
 *
 * 순서: Parquet 디렉터리 이동이 **먼저**, DB 변경은 그 뒤 단일 트랜잭션이다.
 * 이동이 중간에 실패하면 DB 는 그대로라 재실행이 이어받는다 (이미 옮겨진
 * 디렉터리는 loser 쪽에 없으므로 재실행 시 이동 목록에서 빠진다).
 */
export function runDatasetMergeMigration(deps: DatasetMergeMigrationDeps): void {
  const { db, dataRoot, clock, logger } = deps;

  const allRows = db.select().from(datasets).all();
  const pending = allRows.filter((row) => row.symbolsKey === '');
  if (pending.length === 0) return;

  // (market, symbolsKey) 로 레거시 행을 묶는다
  const groups = new Map<string, PendingDataset[]>();
  for (const row of pending) {
    let key: string;
    try {
      key = symbolsKey(JSON.parse(row.symbolsJson) as string[]);
    } catch (error) {
      logger.warn(
        {
          module: MERGE_MODULE,
          event: 'dataset.merge.symbols-json-corrupt',
          datasetId: row.id,
          error: error instanceof Error ? error.message : String(error),
        },
        '데이터셋 symbolsJson 파싱 실패 — 이 데이터셋은 건너뜁니다 (symbolsKey 는 다음 부팅에 다시 시도합니다)',
      );
      continue;
    }
    const groupKey = `${row.market}|${key}`;
    const list = groups.get(groupKey) ?? [];
    list.push({ row, key, kind: row.defaultTimeframe as DatasetSlice });
    groups.set(groupKey, list);
  }

  const keyFills: PendingDataset[] = [];
  const candidates: MergePlan[] = [];
  for (const group of groups.values()) {
    const daily = group.filter((entry) => entry.kind === '1d');
    const minute = group.filter((entry) => entry.kind === '1m');
    if (group.length === 2 && daily.length === 1 && minute.length === 1) {
      // 생존자 = 먼저 만든 쪽 (동시 생성이면 id 순으로 결정적이게)
      const [survivor, loser] = [...group].sort(
        (a, b) => a.row.createdAtMs - b.row.createdAtMs || a.row.id.localeCompare(b.row.id),
      ) as [PendingDataset, PendingDataset];
      candidates.push({ survivor, loser });
      continue;
    }
    keyFills.push(...group);
    if (group.length > 1) {
      logger.warn(
        {
          module: MERGE_MODULE,
          event: 'dataset.merge.duplicate-kind',
          market: group[0]?.row.market,
          symbolsKey: group[0]?.key,
          datasetIds: group.map((entry) => entry.row.id),
        },
        '같은 종목 구성의 데이터셋이 병합 불가 조합입니다 — 둘 다 유지합니다',
      );
    }
  }

  // 파일 이동 단계 (DB 트랜잭션보다 앞): 충돌을 전부 확인한 뒤에만 옮긴다 — 반쪽 이동 금지
  const merges: MergePlan[] = [];
  for (const plan of candidates) {
    const { survivor, loser } = plan;
    const moves = planParquetMoves(dataRoot, loser.row.id, survivor.row.id);
    const collisions = moves.filter((move) => fs.existsSync(move.to));
    if (collisions.length > 0) {
      logger.warn(
        {
          module: MERGE_MODULE,
          event: 'dataset.merge.dir-collision',
          survivorId: survivor.row.id,
          loserId: loser.row.id,
          targets: collisions.map((move) => path.relative(dataRoot, move.to)),
        },
        '병합 대상 Parquet 디렉터리가 이미 있습니다 — 이 쌍은 병합하지 않습니다',
      );
      keyFills.push(survivor, loser);
      continue;
    }
    for (const move of moves) {
      fs.mkdirSync(path.dirname(move.to), { recursive: true });
      fs.renameSync(move.from, move.to);
    }
    removeEmptyDatasetDir(dataRoot, loser.row.id);
    merges.push(plan);
  }

  // DB 변경은 단일 트랜잭션 — 동시 조회가 반쯤 병합된 메타데이터를 보지 않는다
  const nowMs = clock.now();
  db.transaction((tx) => {
    for (const entry of keyFills) {
      tx.update(datasets)
        .set({ symbolsKey: entry.key })
        .where(eq(datasets.id, entry.row.id))
        .run();
    }
    for (const { survivor, loser } of merges) {
      const survivorLatest = latestVersion(tx, survivor.row.id);
      const loserLatest = latestVersion(tx, loser.row.id);

      // 참조 재매핑 — datasetId 를 가진 모든 테이블 (schema.ts 전수).
      // 정상 데이터에선 슬라이스가 서로소라 (symbol, slice) 충돌이 없지만, 비정상
      // 상태로 unique 인덱스에 걸려 부트 전체가 죽으면 안 된다. 충돌 시:
      // - coverage: survivor 행 유지 — refreshCoverage 가 다음 갱신에서 스스로 고친다.
      // - sync_state·facts_state: **둘 다 삭제** — survivor 행은 방금 옮겨온 Parquet
      //   을 모른 채 워터마크·수집 연도를 주장할 수 있다 (낡은 커서는 구간을 건너뛰고,
      //   낡은 facts_state 는 재수집을 막는다). 비우면 다음 실행이 정직하게 다시 쌓는다.
      remapCoverage(tx, loser.row.id, survivor.row.id, logger);
      remapSyncState(tx, loser.row.id, survivor.row.id, logger);
      remapFactsState(tx, loser.row.id, survivor.row.id, logger);
      tx.update(dataImportJobs)
        .set({ datasetId: survivor.row.id })
        .where(eq(dataImportJobs.datasetId, loser.row.id))
        .run();
      tx.update(datasetVersions)
        .set({ datasetId: survivor.row.id })
        .where(eq(datasetVersions.datasetId, loser.row.id))
        .run();
      remapBacktestJobs(tx, loser.row.id, survivor.row.id, logger);
      tx.update(backtestRuns)
        .set({ datasetId: survivor.row.id })
        .where(eq(backtestRuns.datasetId, loser.row.id))
        .run();

      // 참조를 전부 옮겼으므로 cascade 는 datasets 행만 지운다
      tx.delete(datasets).where(eq(datasets.id, loser.row.id)).run();
      // defaultTimeframe 은 생존자 것 유지 — 0004 가 이미 구 종류에서 백필했다
      tx.update(datasets)
        .set({ symbolsKey: survivor.key, updatedAtMs: nowMs })
        .where(eq(datasets.id, survivor.row.id))
        .run();

      // 병합은 백테스트가 보는 유효 데이터가 바뀌는 변경 — 버전 체인에 반영 (§9.5).
      // 버전 = max(두 최신 버전) + 1, 해시는 생존자 체인에 merge 시드를 연결한다
      // (DatasetService.bumpVersion 과 같은 체인 규칙: sha256(prevHash + ':' + seed)).
      const version = Math.max(survivorLatest?.version ?? 0, loserLatest?.version ?? 0) + 1;
      const contentHash = createHash('sha256')
        .update(`${survivorLatest?.contentHash ?? ''}:merge:${loser.row.id}`)
        .digest('hex');
      tx.insert(datasetVersions)
        .values({
          id: newId('dsv'),
          datasetId: survivor.row.id,
          version,
          contentHash,
          note: `merge:${loser.row.id}`,
          createdAtMs: nowMs,
        })
        .run();

      logger.info(
        {
          module: MERGE_MODULE,
          event: 'dataset.merged',
          survivorId: survivor.row.id,
          loserId: loser.row.id,
          symbolsKey: survivor.key,
          version,
        },
        `데이터셋 병합: ${loser.row.name} → ${survivor.row.name}`,
      );
    }
  });
}

/**
 * loser 의 Parquet 파티션 이동 계획.
 * 캔들은 timeframe 단위로 옮긴다 — 슬라이스별 timeframe 파티션이 서로소라
 * survivor 의 같은 market 아래로 나란히 들어간다. facts 는 디렉터리째 옮긴다.
 */
function planParquetMoves(dataRoot: string, loserId: string, survivorId: string): DirMove[] {
  const loserDir = path.join(dataRoot, `dataset=${loserId}`);
  const survivorDir = path.join(dataRoot, `dataset=${survivorId}`);
  if (!fs.existsSync(loserDir)) return [];

  const moves: DirMove[] = [];
  for (const entry of fs.readdirSync(loserDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name === 'facts') {
      moves.push({ from: path.join(loserDir, 'facts'), to: path.join(survivorDir, 'facts') });
      continue;
    }
    if (!entry.name.startsWith('market=')) continue;
    const marketDir = path.join(loserDir, entry.name);
    for (const timeframeEntry of fs.readdirSync(marketDir, { withFileTypes: true })) {
      if (!timeframeEntry.isDirectory() || !timeframeEntry.name.startsWith('timeframe=')) continue;
      moves.push({
        from: path.join(marketDir, timeframeEntry.name),
        to: path.join(survivorDir, entry.name, timeframeEntry.name),
      });
    }
  }
  return moves;
}

/** 이동 후 비게 된 loser 디렉터리 정리 — 빈 디렉터리만 지운다 (알 수 없는 파일은 남긴다) */
function removeEmptyDatasetDir(dataRoot: string, loserId: string): void {
  const loserDir = path.join(dataRoot, `dataset=${loserId}`);
  if (!fs.existsSync(loserDir)) return;
  for (const entry of fs.readdirSync(loserDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const child = path.join(loserDir, entry.name);
    if (fs.readdirSync(child).length === 0) fs.rmdirSync(child);
  }
  if (fs.readdirSync(loserDir).length === 0) fs.rmdirSync(loserDir);
}

type Tx = Parameters<Parameters<AppDatabase['transaction']>[0]>[0];

function latestVersion(tx: Tx, datasetId: string): { version: number; contentHash: string } | null {
  const latest = tx
    .select()
    .from(datasetVersions)
    .where(eq(datasetVersions.datasetId, datasetId))
    .orderBy(desc(datasetVersions.version))
    .limit(1)
    .get();
  return latest ? { version: latest.version, contentHash: latest.contentHash } : null;
}

/** coverage 충돌: survivor 행 유지, loser 행 삭제 — refreshCoverage 가 자가 복구한다 */
function remapCoverage(
  tx: Tx,
  loserId: string,
  survivorId: string,
  logger: DatasetMergeLogger,
): void {
  const survivorRows = tx
    .select({ symbol: dataCoverage.symbol, slice: dataCoverage.slice })
    .from(dataCoverage)
    .where(eq(dataCoverage.datasetId, survivorId))
    .all();
  const taken = new Set(survivorRows.map((row) => `${row.symbol}|${row.slice}`));
  const loserRows = tx.select().from(dataCoverage).where(eq(dataCoverage.datasetId, loserId)).all();
  for (const row of loserRows) {
    if (taken.has(`${row.symbol}|${row.slice}`)) {
      tx.delete(dataCoverage).where(eq(dataCoverage.id, row.id)).run();
      logger.warn(
        {
          module: MERGE_MODULE,
          event: 'dataset.merge.coverage-conflict',
          survivorId,
          loserId,
          symbol: row.symbol,
          slice: row.slice,
        },
        '병합 중 coverage 가 겹쳐 피병합 쪽 행을 버립니다 — 다음 갱신이 다시 계산합니다',
      );
    } else {
      tx.update(dataCoverage).set({ datasetId: survivorId }).where(eq(dataCoverage.id, row.id)).run();
    }
  }
}

/** sync_state 충돌: 둘 다 삭제 — 낡은 워터마크가 이동해 온 봉 구간을 건너뛰게 하지 않는다 */
function remapSyncState(
  tx: Tx,
  loserId: string,
  survivorId: string,
  logger: DatasetMergeLogger,
): void {
  const survivorRows = tx
    .select({ id: brokerSyncState.id, symbol: brokerSyncState.symbol, slice: brokerSyncState.slice })
    .from(brokerSyncState)
    .where(eq(brokerSyncState.datasetId, survivorId))
    .all();
  const survivorByKey = new Map(survivorRows.map((row) => [`${row.symbol}|${row.slice}`, row.id]));
  const loserRows = tx
    .select()
    .from(brokerSyncState)
    .where(eq(brokerSyncState.datasetId, loserId))
    .all();
  for (const row of loserRows) {
    const survivorRowId = survivorByKey.get(`${row.symbol}|${row.slice}`);
    if (survivorRowId !== undefined) {
      tx.delete(brokerSyncState).where(eq(brokerSyncState.id, row.id)).run();
      tx.delete(brokerSyncState).where(eq(brokerSyncState.id, survivorRowId)).run();
      logger.warn(
        {
          module: MERGE_MODULE,
          event: 'dataset.merge.sync-state-conflict',
          survivorId,
          loserId,
          symbol: row.symbol,
          slice: row.slice,
        },
        '병합 중 sync_state 가 겹쳐 양쪽 행을 비웁니다 — 다음 수집이 워터마크를 다시 쌓습니다',
      );
    } else {
      tx.update(brokerSyncState)
        .set({ datasetId: survivorId })
        .where(eq(brokerSyncState.id, row.id))
        .run();
    }
  }
}

/**
 * backtest_jobs.dataset_id 재매핑 + request_json 안에 박혀 있는 datasetId 도 함께 고친다.
 * 워커(backtest-child.ts)·복제·복제초안이 모두 dataset_id 컬럼이 아니라 request_json 을
 * 파싱해 얻은 datasetId 로 데이터셋을 찾으므로, 컬럼만 옮기면 과거 job 의 재실행/복제가
 * 사라진 loser id 를 참조하게 된다. request_json 이 손상돼 있으면 컬럼 재매핑은 그대로
 * 두고 경고만 남긴다 — 부팅을 막을 이유는 아니다.
 */
function remapBacktestJobs(
  tx: Tx,
  loserId: string,
  survivorId: string,
  logger: DatasetMergeLogger,
): void {
  const rows = tx
    .select({ id: backtestJobs.id, requestJson: backtestJobs.requestJson })
    .from(backtestJobs)
    .where(eq(backtestJobs.datasetId, loserId))
    .all();
  for (const row of rows) {
    let requestJson = row.requestJson;
    try {
      const parsed = JSON.parse(requestJson) as Record<string, unknown>;
      parsed['datasetId'] = survivorId;
      requestJson = JSON.stringify(parsed);
    } catch (error) {
      logger.warn(
        {
          module: MERGE_MODULE,
          event: 'dataset.merge.request-json-skip',
          jobId: row.id,
          loserId,
          survivorId,
          error: error instanceof Error ? error.message : String(error),
        },
        'backtest_jobs.request_json 파싱 실패 — dataset_id 컬럼만 재매핑하고 JSON 은 그대로 둡니다',
      );
    }
    tx.update(backtestJobs)
      .set({ datasetId: survivorId, requestJson })
      .where(eq(backtestJobs.id, row.id))
      .run();
  }
}

/** facts_state 충돌: 둘 다 삭제 — 낡은 수집 연도 주장이 재수집을 막지 않게 한다 */
function remapFactsState(
  tx: Tx,
  loserId: string,
  survivorId: string,
  logger: DatasetMergeLogger,
): void {
  const survivorRows = tx
    .select({ id: datasetFactsState.id, symbol: datasetFactsState.symbol })
    .from(datasetFactsState)
    .where(eq(datasetFactsState.datasetId, survivorId))
    .all();
  const survivorBySymbol = new Map(survivorRows.map((row) => [row.symbol, row.id]));
  const loserRows = tx
    .select()
    .from(datasetFactsState)
    .where(eq(datasetFactsState.datasetId, loserId))
    .all();
  for (const row of loserRows) {
    const survivorRowId = survivorBySymbol.get(row.symbol);
    if (survivorRowId !== undefined) {
      tx.delete(datasetFactsState).where(eq(datasetFactsState.id, row.id)).run();
      tx.delete(datasetFactsState).where(eq(datasetFactsState.id, survivorRowId)).run();
      logger.warn(
        {
          module: MERGE_MODULE,
          event: 'dataset.merge.facts-state-conflict',
          survivorId,
          loserId,
          symbol: row.symbol,
        },
        '병합 중 facts_state 가 겹쳐 양쪽 행을 비웁니다 — 다음 재무 수집이 다시 쌓습니다',
      );
    } else {
      tx.update(datasetFactsState)
        .set({ datasetId: survivorId })
        .where(eq(datasetFactsState.id, row.id))
        .run();
    }
  }
}
