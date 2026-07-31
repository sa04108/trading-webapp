import fs from 'node:fs';
import path from 'node:path';
import { SYMBOL_PATTERN, normalizeCandles, type Candle, type Market, type Timeframe } from '../domain/candle.js';
import type { CandleQuery, CandleRepository } from '../application/ports.js';
import { DuckDbService, sqlString } from './duckdb-service.js';

/**
 * 임시 파일 이름의 유일성은 프로세스 단위로 보장한다 — 파티션 락은 인스턴스별이므로
 * 한 프로세스에 리포지터리가 둘 있으면 인스턴스 카운터로는 같은 tmp 경로가 나온다.
 */
let tmpCounter = 0;

/**
 * Parquet 기반 CandleRepository (스펙 §11 레이아웃):
 *   market=KR/timeframe=1h/symbol=005930/year=2026/data.parquet
 *   market=KR/timeframe=1m/symbol=005930/year=2026/month=07/data.parquet
 *
 * **최상위 `dataset=` 파티션이 없다** (설계 2026-07-31-symbol-as-first-class). 봉은
 * 종목에 종속되고 데이터셋은 참조만 갖는다 — 같은 종목을 열 개 데이터셋이 참조해도
 * 물리 사본은 하나다. 격리를 잃는 대신 재현성은 종목별 버전 스냅샷이 맡는다(§9.5).
 *
 * 컬럼: ts_ms BIGINT, open/high/low/close/volume DOUBLE. UTC epoch ms 저장.
 * 저장은 파티션 단위 재작성(기존 병합→임시 파일→교체)으로 idempotent 하다.
 */
export class ParquetCandleRepository implements CandleRepository {
  /** 파티션별 쓰기 직렬화 — 동시 import 의 read-merge-write 경합으로 행이 유실되지 않게 한다 */
  private readonly partitionLocks = new Map<string, Promise<unknown>>();

  constructor(
    private readonly dataRoot: string,
    private readonly duckdb: DuckDbService,
  ) {}

  private partitionDir(
    market: Market,
    timeframe: Timeframe,
    symbol: string,
    tsMs: number,
  ): string {
    const date = new Date(tsMs);
    const year = date.getUTCFullYear();
    const month = String(date.getUTCMonth() + 1).padStart(2, '0');
    const base = path.join(
      this.dataRoot,
      `market=${market}`,
      `timeframe=${timeframe}`,
      `symbol=${symbol}`,
      `year=${year}`,
    );
    return timeframe === '1m' ? path.join(base, `month=${month}`) : base;
  }

  private symbolGlob(
    market: Market,
    timeframe: Timeframe,
    symbol: string,
  ): string {
    return path
      .join(
        this.dataRoot,
        `market=${market}`,
        `timeframe=${timeframe}`,
        `symbol=${symbol}`,
        '**',
        '*.parquet',
      )
      .replaceAll('\\', '/');
  }

  private assertSymbol(symbol: string): void {
    if (!SYMBOL_PATTERN.test(symbol)) throw new Error(`invalid symbol: ${symbol}`);
  }

  async saveCandles(candles: readonly Candle[]): Promise<void> {
    if (candles.length === 0) return;

    // 파티션별 그룹화
    const groups = new Map<string, { dir: string; items: Candle[] }>();
    for (const candle of candles) {
      this.assertSymbol(candle.symbol);
      const dir = this.partitionDir(
        candle.market,
        candle.timeframe,
        candle.symbol,
        candle.tsMs,
      );
      const group = groups.get(dir) ?? { dir, items: [] };
      group.items.push(candle);
      groups.set(dir, group);
    }

    for (const { dir, items } of groups.values()) {
      await this.writePartitionLocked(dir, items);
    }
  }

  /**
   * 종목의 모든 봉을 지운다. 데이터셋 삭제는 이제 참조만 끊으므로 봉을 건드리지 않는다 —
   * 다른 데이터셋이 같은 종목을 참조하고 있을 수 있다.
   */
  async deleteSymbol(market: Market, symbol: string): Promise<void> {
    this.assertSymbol(symbol);
    for (const timeframe of ['1m', '1h', '1d'] as const) {
      fs.rmSync(
        path.join(this.dataRoot, `market=${market}`, `timeframe=${timeframe}`, `symbol=${symbol}`),
        { recursive: true, force: true },
      );
    }
  }

  private async writePartitionLocked(dir: string, items: Candle[]): Promise<void> {
    const prev = this.partitionLocks.get(dir) ?? Promise.resolve();
    const run = prev.then(
      () => this.writePartition(dir, items),
      () => this.writePartition(dir, items), // 앞선 쓰기 실패는 이번 쓰기를 막지 않는다
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

  private async writePartition(dir: string, incoming: Candle[]): Promise<void> {
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, 'data.parquet');
    tmpCounter += 1;
    const tmpPath = path.join(dir, `data.parquet.tmp-${process.pid}-${tmpCounter}`);
    const fileExists = fs.existsSync(filePath);

    let merged = incoming;
    if (fileExists) {
      const existing = await this.readFile(filePath, incoming[0] as Candle);
      merged = [...existing, ...incoming];
    }
    // 뒤에 온(신규) 봉이 이기도록 normalize (idempotent 재수집)
    const normalized = normalizeCandles(merged);

    const values = normalized
      .map(
        (candle) =>
          `(${candle.tsMs}, ${candle.open}, ${candle.high}, ${candle.low}, ${candle.close}, ${candle.volume})`,
      )
      .join(',\n');

    // DuckDB 의 VALUES 타입 추론(DECIMAL/BIGINT)을 피하려고 명시적으로 CAST 한다
    await this.duckdb.run(
      `COPY (
         SELECT
           CAST(ts_ms AS BIGINT) AS ts_ms,
           CAST(open AS DOUBLE) AS open,
           CAST(high AS DOUBLE) AS high,
           CAST(low AS DOUBLE) AS low,
           CAST(close AS DOUBLE) AS close,
           CAST(volume AS DOUBLE) AS volume
         FROM (VALUES ${values}) AS t(ts_ms, open, high, low, close, volume)
         ORDER BY ts_ms
       ) TO ${sqlString(tmpPath.replaceAll('\\', '/'))} (FORMAT PARQUET, COMPRESSION ZSTD)`,
    );

    fs.renameSync(tmpPath, filePath);
  }

  private async readFile(filePath: string, template: Candle): Promise<Candle[]> {
    const rows = await this.duckdb.query<{
      ts_ms: bigint | number;
      open: number;
      high: number;
      low: number;
      close: number;
      volume: number;
    }>(
      `SELECT CAST(ts_ms AS BIGINT) AS ts_ms,
              CAST(open AS DOUBLE) AS open, CAST(high AS DOUBLE) AS high,
              CAST(low AS DOUBLE) AS low, CAST(close AS DOUBLE) AS close,
              CAST(volume AS DOUBLE) AS volume
       FROM read_parquet(${sqlString(filePath.replaceAll('\\', '/'))})`,
    );
    return rows.map((row) => ({
      symbol: template.symbol,
      market: template.market,
      timeframe: template.timeframe,
      tsMs: Number(row.ts_ms),
      open: row.open,
      high: row.high,
      low: row.low,
      close: row.close,
      volume: row.volume,
    }));
  }

  async *getCandles(query: CandleQuery): AsyncIterable<Candle> {
    for (const symbol of query.symbols) {
      this.assertSymbol(symbol);
      const glob = this.symbolGlob(query.market, query.timeframe, symbol);
      if (!this.hasAnyFile(query.market, query.timeframe, symbol)) continue;

      const conditions: string[] = [];
      if (query.fromTsMs !== undefined) conditions.push(`ts_ms >= ${query.fromTsMs}`);
      if (query.toTsMs !== undefined) conditions.push(`ts_ms <= ${query.toTsMs}`);
      const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

      const rows = await this.duckdb.query<{
        ts_ms: bigint | number;
        open: number;
        high: number;
        low: number;
        close: number;
        volume: number;
      }>(
        `SELECT CAST(ts_ms AS BIGINT) AS ts_ms,
                CAST(open AS DOUBLE) AS open, CAST(high AS DOUBLE) AS high,
                CAST(low AS DOUBLE) AS low, CAST(close AS DOUBLE) AS close,
                CAST(volume AS DOUBLE) AS volume
         FROM read_parquet(${sqlString(glob)})
         ${where}
         ORDER BY ts_ms`,
      );

      for (const row of rows) {
        yield {
          symbol,
          market: query.market,
          timeframe: query.timeframe,
          tsMs: Number(row.ts_ms),
          open: row.open,
          high: row.high,
          low: row.low,
          close: row.close,
          volume: row.volume,
        };
      }
    }
  }

  async getTimestamps(market: Market, timeframe: Timeframe, symbol: string): Promise<number[]> {
    this.assertSymbol(symbol);
    if (!this.hasAnyFile(market, timeframe, symbol)) return [];
    const glob = this.symbolGlob(market, timeframe, symbol);
    const rows = await this.duckdb.query<{ ts_ms: bigint | number }>(
      `SELECT ts_ms FROM read_parquet(${sqlString(glob)}) ORDER BY ts_ms`,
    );
    return rows.map((row) => Number(row.ts_ms));
  }

  private hasAnyFile(market: Market, timeframe: Timeframe, symbol: string): boolean {
    const dir = path.join(
      this.dataRoot,
      `market=${market}`,
      `timeframe=${timeframe}`,
      `symbol=${symbol}`,
    );
    return fs.existsSync(dir);
  }
}
