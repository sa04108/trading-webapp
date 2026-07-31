import fs from 'node:fs';
import path from 'node:path';
import { DuckDbService, sqlString } from '../../market-data/infrastructure/duckdb-service.js';
import { SYMBOL_PATTERN } from '../../market-data/domain/candle.js';
import type { Fact, FactScope } from '../domain/fact.js';
import type { FactQuery, FactRepository } from '../application/ports.js';

const SCOPES: readonly FactScope[] = ['SYMBOL', 'MACRO'];

let tmpCounter = 0;

/**
 * Parquet 기반 FactRepository (설계 2026-07-31-symbol-as-first-class):
 *   facts/scope=SYMBOL/symbol=005930/data.parquet
 *   facts/scope=MACRO/data.parquet
 *
 * **데이터셋 파티션을 버리고 종목 파티션으로 갔다.** 종전 `dataset=<id>/facts/` 는 같은
 * 종목을 N개 데이터셋에 N번 복제했고, 진짜 비용은 디스크가 아니라 DART 일일 호출
 * 한도였다(종목·연도당 9회, 한도 40,000/일 — 200종목 50년이면 데이터셋 하나로 이미
 * 225%). 종목 파티션이 그 중복을 없앤다.
 *
 * 종목 단위 파일은 **쓰기 증폭**도 함께 없앤다. `writePartition` 은 read-merge-write 라
 * 파티션 전체를 다시 쓰는데, 데이터셋 단일 파일이던 시절엔 48만 행(200종목 50년)을 매
 * 수집마다 재작성했다 — SQL VALUES 문자열만 ~38MB 로 640MB cgroup 을 위협했다. 이제
 * 해당 종목 몫(~2,400행)만 다시 쓴다.
 *
 * MACRO 는 종목 축이 없어 스코프당 단일 파일로 남는다 — 중복 문제도 없었다.
 *
 * 컬럼: key VARCHAR, field VARCHAR, period_key VARCHAR, as_of_ts_ms BIGINT,
 *       value DOUBLE, unit VARCHAR. scope·symbol 은 경로 파티션이라 파일에 넣지 않는다.
 */
export class ParquetFactRepository implements FactRepository {
  /** 파티션별 쓰기 직렬화 — read-merge-write 경합으로 행이 유실되지 않게 한다 */
  private readonly partitionLocks = new Map<string, Promise<unknown>>();

  constructor(
    private readonly dataRoot: string,
    private readonly duckdb: DuckDbService,
  ) {}

  /**
   * SYMBOL 스코프만 종목 파티션을 갖는다 — MACRO 의 key 는 종목이 아니라 지표 계열명이라
   * 경로 안전성을 보장할 수 없고, 애초에 중복될 대상도 아니다.
   */
  private partitionDir(scope: FactScope, key: string | null): string {
    const base = path.join(this.dataRoot, 'facts', `scope=${scope}`);
    if (scope !== 'SYMBOL' || key === null) return base;
    if (!SYMBOL_PATTERN.test(key)) throw new Error(`invalid symbol key: ${key}`);
    return path.join(base, `symbol=${key}`);
  }

  private filePath(scope: FactScope, key: string | null): string {
    return path.join(this.partitionDir(scope, key), 'data.parquet');
  }

  /** 스코프 아래 실제로 존재하는 파티션 파일 — 「전 종목」 조회용 */
  private existingFiles(scope: FactScope): string[] {
    const base = path.join(this.dataRoot, 'facts', `scope=${scope}`);
    if (!fs.existsSync(base)) return [];
    if (scope !== 'SYMBOL') {
      const single = path.join(base, 'data.parquet');
      return fs.existsSync(single) ? [single] : [];
    }
    return fs
      .readdirSync(base, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith('symbol='))
      .map((entry) => path.join(base, entry.name, 'data.parquet'))
      .filter((file) => fs.existsSync(file));
  }

  /** 종목 하나의 재무 보유 여부 — 파일 존재만 본다 (D-033: 충족도는 묻지 않는다) */
  hasFacts(scope: FactScope, key: string): boolean {
    if (scope === 'SYMBOL' && !SYMBOL_PATTERN.test(key)) return false;
    return fs.existsSync(this.filePath(scope, scope === 'SYMBOL' ? key : null));
  }

  async saveFacts(facts: readonly Fact[]): Promise<void> {
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
      if (scope !== 'SYMBOL') {
        await this.writePartitionLocked(scope, null, scoped);
        continue;
      }
      // 종목별로 쪼개 쓴다 — 한 종목의 재작성이 다른 종목 몫을 건드리지 않는다
      const byKey = new Map<string, Fact[]>();
      for (const fact of scoped) {
        const list = byKey.get(fact.key) ?? [];
        list.push(fact);
        byKey.set(fact.key, list);
      }
      for (const [key, group] of byKey) {
        await this.writePartitionLocked(scope, key, group);
      }
    }
  }

  private async writePartitionLocked(
    scope: FactScope,
    key: string | null,
    incoming: readonly Fact[],
  ): Promise<void> {
    const dir = this.partitionDir(scope, key);
    const previous = this.partitionLocks.get(dir) ?? Promise.resolve();
    const run = previous.then(
      () => this.writePartition(scope, key, incoming),
      () => this.writePartition(scope, key, incoming),
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
    scope: FactScope,
    key: string | null,
    incoming: readonly Fact[],
  ): Promise<void> {
    const dir = this.partitionDir(scope, key);
    fs.mkdirSync(dir, { recursive: true });
    const target = this.filePath(scope, key);
    tmpCounter += 1;
    const tmpPath = path.join(dir, `data.parquet.tmp-${process.pid}-${tmpCounter}`);

    const existing = fs.existsSync(target)
      ? await this.getFacts({ scope, keys: key === null ? undefined : [key] })
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
    // 읽기 대상 결정: keys 가 있으면 그 종목 파일만, 없으면 스코프 전체를 glob 한다.
    // 종목 파티션으로 쪼갠 뒤 "전 종목" 조회가 여러 파일을 걸치므로 read_parquet 에
    // 목록을 넘긴다 — 없는 파일을 섞으면 DuckDB 가 던지므로 존재하는 것만 고른다.
    const targets =
      query.scope === 'SYMBOL' && query.keys && query.keys.length > 0
        ? query.keys
            .filter((key) => SYMBOL_PATTERN.test(key))
            .map((key) => this.filePath(query.scope, key))
            .filter((file) => fs.existsSync(file))
        : this.existingFiles(query.scope);
    if (targets.length === 0) return [];
    const source =
      targets.length === 1
        ? sqlString(targets[0]!.replaceAll('\\', '/'))
        : `[${targets.map((file) => sqlString(file.replaceAll('\\', '/'))).join(', ')}]`;

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
       FROM read_parquet(${source})
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
