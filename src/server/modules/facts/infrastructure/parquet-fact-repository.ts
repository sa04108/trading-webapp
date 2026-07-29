import fs from 'node:fs';
import path from 'node:path';
import { DuckDbService, sqlString } from '../../market-data/infrastructure/duckdb-service.js';
import type { Fact, FactScope } from '../domain/fact.js';
import type { FactQuery, FactRepository } from '../application/ports.js';

const DATASET_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const SCOPES: readonly FactScope[] = ['SYMBOL', 'MACRO'];

let tmpCounter = 0;

/**
 * Parquet 기반 FactRepository.
 *   dataset=<id>/facts/scope=SYMBOL/data.parquet
 *
 * 캔들과 같은 최상위 파티션(`dataset=`)을 쓰는 이유가 세 개다:
 *  1. 재현성이 공짜다 — 과거 공시를 나중에 backfill 해도 다른 데이터셋의 과거
 *     백테스트가 변하지 않는다.
 *  2. 정리 코드가 필요 없다 — ParquetCandleRepository.deleteDataset 이 dataset=<id>
 *     를 재귀 삭제한다.
 *  3. 작다 — 200종목 × 20분기 × 12필드 ≈ 5만 행. 단일 파일로 충분하다.
 *
 * 컬럼: key VARCHAR, field VARCHAR, period_key VARCHAR, as_of_ts_ms BIGINT,
 *       value DOUBLE, unit VARCHAR. scope 는 경로 파티션이라 파일에 넣지 않는다.
 */
export class ParquetFactRepository implements FactRepository {
  /** 파티션별 쓰기 직렬화 — read-merge-write 경합으로 행이 유실되지 않게 한다 */
  private readonly partitionLocks = new Map<string, Promise<unknown>>();

  constructor(
    private readonly dataRoot: string,
    private readonly duckdb: DuckDbService,
  ) {}

  private assertDatasetId(datasetId: string): void {
    if (!DATASET_ID_PATTERN.test(datasetId)) throw new Error(`invalid datasetId: ${datasetId}`);
  }

  private partitionDir(datasetId: string, scope: FactScope): string {
    return path.join(this.dataRoot, `dataset=${datasetId}`, 'facts', `scope=${scope}`);
  }

  private filePath(datasetId: string, scope: FactScope): string {
    return path.join(this.partitionDir(datasetId, scope), 'data.parquet');
  }

  hasFacts(datasetId: string, scope: FactScope): boolean {
    if (!DATASET_ID_PATTERN.test(datasetId)) return false;
    return fs.existsSync(this.filePath(datasetId, scope));
  }

  async saveFacts(datasetId: string, facts: readonly Fact[]): Promise<void> {
    this.assertDatasetId(datasetId);
    if (facts.length === 0) return;

    // PitFactView 의 정렬 비교자는 value 를 뺄셈으로 비교한다 — value 가 비유한(non-finite)
    // 값이면 비교 결과가 NaN 이 되고, Array.prototype.sort 는 NaN 을 동률로 취급해
    // 배열 순서로 결과가 갈린다(재현성 붕괴). 뷰에서 방어하지 않고 저장 경계에서 막는다.
    for (const fact of facts) {
      if (!Number.isFinite(fact.value)) {
        throw new Error(
          `팩트 값이 유한하지 않습니다: key=${fact.key}, field=${fact.field}, ` +
            `periodKey=${fact.periodKey}, value=${fact.value}`,
        );
      }
      if (!Number.isFinite(fact.asOfTsMs)) {
        throw new Error(
          `팩트 asOfTsMs 가 유한하지 않습니다: key=${fact.key}, field=${fact.field}, ` +
            `periodKey=${fact.periodKey}, asOfTsMs=${fact.asOfTsMs}`,
        );
      }
    }

    for (const scope of SCOPES) {
      const scoped = facts.filter((fact) => fact.scope === scope);
      if (scoped.length === 0) continue;
      await this.writePartitionLocked(datasetId, scope, scoped);
    }
  }

  private async writePartitionLocked(
    datasetId: string,
    scope: FactScope,
    incoming: readonly Fact[],
  ): Promise<void> {
    const dir = this.partitionDir(datasetId, scope);
    const previous = this.partitionLocks.get(dir) ?? Promise.resolve();
    const run = previous.then(
      () => this.writePartition(datasetId, scope, incoming),
      () => this.writePartition(datasetId, scope, incoming),
    );
    const guard = run.then(
      () => undefined,
      () => undefined,
    );
    this.partitionLocks.set(dir, guard);
    void guard.then(() => {
      if (this.partitionLocks.get(dir) === guard) this.partitionLocks.delete(dir);
    });
    await run;
  }

  private async writePartition(
    datasetId: string,
    scope: FactScope,
    incoming: readonly Fact[],
  ): Promise<void> {
    const dir = this.partitionDir(datasetId, scope);
    fs.mkdirSync(dir, { recursive: true });
    const target = this.filePath(datasetId, scope);
    tmpCounter += 1;
    const tmpPath = path.join(dir, `data.parquet.tmp-${process.pid}-${tmpCounter}`);

    const existing = fs.existsSync(target)
      ? await this.getFacts({ datasetId, scope })
      : [];

    // (key, field, periodKey, asOf) 가 같으면 뒤에 온 것이 이긴다 — idempotent 재수집.
    // asOf 가 다르면 둘 다 남는다: 재집계는 새 행이어야 과거 시점 조회가 변하지 않는다.
    // key·field 는 domain 상 자유 문자열이라 구분자 없이 이어붙이면 경계가 다른
    // 두 조합이 같은 문자열로 충돌할 수 있다(예: 'AB'+'CD' === 'ABC'+'D') —
    // JSON.stringify 로 각 구성요소를 이스케이프해 경계를 명확히 한다.
    const merged = new Map<string, Fact>();
    for (const fact of [...existing, ...incoming]) {
      const mergeKey = JSON.stringify([fact.key, fact.field, fact.periodKey, fact.asOfTsMs]);
      merged.set(mergeKey, fact);
    }

    const values = [...merged.values()]
      .map(
        (fact) =>
          `(${sqlString(fact.key)}, ${sqlString(fact.field)}, ${sqlString(fact.periodKey)}, ` +
          `${fact.asOfTsMs}, ${fact.value}, ${sqlString(fact.unit)})`,
      )
      .join(',\n');

    // DuckDB 의 VALUES 타입 추론(DECIMAL/BIGINT)을 피하려고 명시적으로 CAST 한다.
    //
    // 실패하면 임시 파일을 지우고 다시 던진다. rename 자체는 같은 디렉터리 원자적 교체이고
    // 독자는 명시적 파일명(data.parquet)만 읽으므로 남은 tmp 는 손상이 아니라 찌꺼기다 —
    // 다만 팩트 저장이 종목 단위로 쪼개진 뒤 백필 한 번에 쓰기 시도가 200회 가까이
    // 일어나므로 그 찌꺼기가 쌓인다.
    try {
      await this.duckdb.run(
        `COPY (
           SELECT
             CAST(key AS VARCHAR) AS key,
             CAST(field AS VARCHAR) AS field,
             CAST(period_key AS VARCHAR) AS period_key,
             CAST(as_of_ts_ms AS BIGINT) AS as_of_ts_ms,
             CAST(value AS DOUBLE) AS value,
             CAST(unit AS VARCHAR) AS unit
           FROM (VALUES ${values}) AS t(key, field, period_key, as_of_ts_ms, value, unit)
           ORDER BY key, field, period_key, as_of_ts_ms
         ) TO ${sqlString(tmpPath.replaceAll('\\', '/'))} (FORMAT PARQUET, COMPRESSION ZSTD)`,
      );

      fs.renameSync(tmpPath, target);
    } catch (error) {
      // 청소 실패가 원인 오류를 가리면 안 된다 — force 는 없는 파일에 던지지 않는다
      try {
        fs.rmSync(tmpPath, { force: true });
      } catch {
        /* 원인 오류를 그대로 올린다 */
      }
      throw error;
    }
  }

  async getFacts(query: FactQuery): Promise<Fact[]> {
    this.assertDatasetId(query.datasetId);
    const target = this.filePath(query.datasetId, query.scope);
    if (!fs.existsSync(target)) return [];

    const conditions: string[] = [];
    if (query.asOfMaxTsMs !== undefined) conditions.push(`as_of_ts_ms <= ${query.asOfMaxTsMs}`);
    if (query.keys && query.keys.length > 0) {
      conditions.push(`key IN (${query.keys.map((key) => sqlString(key)).join(', ')})`);
    }
    if (query.fields && query.fields.length > 0) {
      conditions.push(`field IN (${query.fields.map((field) => sqlString(field)).join(', ')})`);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const rows = await this.duckdb.query<{
      key: string;
      field: string;
      period_key: string;
      as_of_ts_ms: bigint | number;
      value: number;
      unit: string;
    }>(
      `SELECT CAST(key AS VARCHAR) AS key,
              CAST(field AS VARCHAR) AS field,
              CAST(period_key AS VARCHAR) AS period_key,
              CAST(as_of_ts_ms AS BIGINT) AS as_of_ts_ms,
              CAST(value AS DOUBLE) AS value,
              CAST(unit AS VARCHAR) AS unit
       FROM read_parquet(${sqlString(target.replaceAll('\\', '/'))})
       ${where}
       ORDER BY key, field, period_key, as_of_ts_ms`,
    );

    return rows.map((row) => ({
      scope: query.scope,
      key: row.key,
      field: row.field,
      periodKey: row.period_key,
      asOfTsMs: Number(row.as_of_ts_ms),
      value: row.value,
      unit: row.unit,
    }));
  }
}
