import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import type {
  BacktestResultArtifact,
  BacktestResultWriteContext,
  BacktestResultWriter,
} from '../application/backtest-result-artifact.js';

export const BACKTEST_RESULT_ARTIFACT_SCHEMA_VERSION = 1;

/** Worker가 서버 DB 대신 독립 SQLite artifact에 결과를 순차 기록하는 adapter. */
export class SqliteBacktestResultArtifactWriter implements BacktestResultWriter {
  constructor(private readonly artifactPath: string) {}

  write(context: BacktestResultWriteContext, artifact: BacktestResultArtifact): void {
    if (fs.existsSync(this.artifactPath)) {
      throw new Error(`결과 artifact 대상이 이미 존재합니다: ${this.artifactPath}`);
    }
    fs.mkdirSync(path.dirname(this.artifactPath), { recursive: true, mode: 0o700 });
    const sqlite = new Database(this.artifactPath);
    try {
      sqlite.pragma('journal_mode = DELETE');
      sqlite.pragma('synchronous = FULL');
      sqlite.pragma(`user_version = ${BACKTEST_RESULT_ARTIFACT_SCHEMA_VERSION}`);
      sqlite.exec(`
        CREATE TABLE artifact_manifest (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          schema_version INTEGER NOT NULL,
          context_json TEXT NOT NULL,
          summary_json TEXT NOT NULL
        ) STRICT;
        CREATE TABLE equity_points (
          sequence INTEGER PRIMARY KEY,
          ts_ms INTEGER NOT NULL,
          equity REAL NOT NULL
        ) STRICT;
        CREATE TABLE drawdown_points (
          sequence INTEGER PRIMARY KEY,
          ts_ms INTEGER NOT NULL,
          drawdown REAL NOT NULL
        ) STRICT;
        CREATE TABLE trades (
          sequence INTEGER PRIMARY KEY,
          symbol TEXT NOT NULL,
          quantity REAL NOT NULL,
          entry_ts_ms INTEGER NOT NULL,
          exit_ts_ms INTEGER NOT NULL,
          entry_price REAL NOT NULL,
          exit_price REAL NOT NULL,
          gross_pnl REAL NOT NULL,
          costs REAL NOT NULL,
          net_pnl REAL NOT NULL,
          return_pct REAL NOT NULL,
          holding_time_ms INTEGER NOT NULL,
          exit_reason TEXT
        ) STRICT;
        CREATE TABLE monthly_returns (
          sequence INTEGER PRIMARY KEY,
          year INTEGER NOT NULL,
          month INTEGER NOT NULL,
          return_pct REAL NOT NULL
        ) STRICT;
      `);

      const write = sqlite.transaction(() => {
        sqlite.prepare(
          `INSERT INTO artifact_manifest
           (singleton, schema_version, context_json, summary_json)
           VALUES (1, ?, ?, ?)`,
        ).run(
          BACKTEST_RESULT_ARTIFACT_SCHEMA_VERSION,
          JSON.stringify(context),
          JSON.stringify({
            metrics: artifact.metrics,
            openPositions: artifact.openPositions,
            warnings: artifact.warnings,
            processedBars: artifact.processedBars,
          }),
        );

        const equity = sqlite.prepare(
          'INSERT INTO equity_points (sequence, ts_ms, equity) VALUES (?, ?, ?)',
        );
        for (let index = 0; index < artifact.equityPoints.length; index += 1) {
          const point = artifact.equityPoints[index]!;
          equity.run(index, point.tsMs, point.equity);
        }

        const drawdown = sqlite.prepare(
          'INSERT INTO drawdown_points (sequence, ts_ms, drawdown) VALUES (?, ?, ?)',
        );
        for (let index = 0; index < artifact.drawdownPoints.length; index += 1) {
          const point = artifact.drawdownPoints[index]!;
          drawdown.run(index, point.tsMs, point.drawdown);
        }

        const trade = sqlite.prepare(
          `INSERT INTO trades (
             sequence, symbol, quantity, entry_ts_ms, exit_ts_ms, entry_price, exit_price,
             gross_pnl, costs, net_pnl, return_pct, holding_time_ms, exit_reason
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        );
        for (let index = 0; index < artifact.trades.length; index += 1) {
          const value = artifact.trades[index]!;
          trade.run(
            index,
            value.symbol,
            value.quantity,
            value.entryTsMs,
            value.exitTsMs,
            value.entryPrice,
            value.exitPrice,
            value.grossPnl,
            value.costs,
            value.netPnl,
            value.returnPct,
            value.holdingTimeMs,
            value.exitReason ?? null,
          );
        }

        const monthly = sqlite.prepare(
          'INSERT INTO monthly_returns (sequence, year, month, return_pct) VALUES (?, ?, ?, ?)',
        );
        for (let index = 0; index < artifact.monthlyReturns.length; index += 1) {
          const value = artifact.monthlyReturns[index]!;
          monthly.run(index, value.year, value.month, value.returnPct);
        }
      });
      write.immediate();
      fs.chmodSync(this.artifactPath, 0o600);
    } catch (error) {
      sqlite.close();
      fs.rmSync(this.artifactPath, { force: true });
      throw error;
    }
    sqlite.close();
  }
}
