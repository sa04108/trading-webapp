import fs from 'node:fs';
import path from 'node:path';
import { SYMBOL_PATTERN, normalizeCandles, type Candle, type Market, type Timeframe } from '../domain/candle.js';
import type { CandleQuery, CandleRepository } from '../application/ports.js';
import { DuckDbService, sqlString } from './duckdb-service.js';

/**
 * Parquet 기반 CandleRepository (스펙 §11 레이아웃):
 *   market=KR/timeframe=1h/symbol=005930/year=2026/data.parquet
 *   market=KR/timeframe=1m/symbol=005930/year=2026/month=07/data.parquet
 * 컬럼: ts_ms BIGINT, open/high/low/close/volume DOUBLE. UTC epoch ms 저장.
 * 저장은 파티션 단위 재작성(기존 병합→임시 파일→교체)으로 idempotent 하다.
 */
export class ParquetCandleRepository implements CandleRepository {
  constructor(
    private readonly dataRoot: string,
    private readonly duckdb: DuckDbService,
  ) {}

  private partitionDir(market: Market, timeframe: Timeframe, symbol: string, tsMs: number): string {
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

  private symbolGlob(market: Market, timeframe: Timeframe, symbol: string): string {
    return path
      .join(this.dataRoot, `market=${market}`, `timeframe=${timeframe}`, `symbol=${symbol}`, '**', '*.parquet')
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
      const dir = this.partitionDir(candle.market, candle.timeframe, candle.symbol, candle.tsMs);
      const group = groups.get(dir) ?? { dir, items: [] };
      group.items.push(candle);
      groups.set(dir, group);
    }

    for (const { dir, items } of groups.values()) {
      await this.writePartition(dir, items);
    }
  }

  private async writePartition(dir: string, incoming: Candle[]): Promise<void> {
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, 'data.parquet');
    const tmpPath = path.join(dir, `data.parquet.tmp-${process.pid}`);
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

    await this.duckdb.run(
      `COPY (
         SELECT * FROM (VALUES ${values}) AS t(ts_ms, open, high, low, close, volume)
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
    }>(`SELECT ts_ms, open, high, low, close, volume FROM read_parquet(${sqlString(filePath.replaceAll('\\', '/'))})`);
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
        `SELECT ts_ms, open, high, low, close, volume
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
