import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import type { BacktestExecutionTelemetry } from '../../src/server/modules/backtest/application/backtest-execution-telemetry.js';

const tempDirectories: string[] = [];

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('backtest:telemetry-report CLI', () => {
  it('reads the live database in read-only mode and emits machine-readable JSON', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'qp-telemetry-cli-'));
    tempDirectories.push(directory);
    const databasePath = path.join(directory, 'app.sqlite');
    const sqlite = new Database(databasePath);
    sqlite.exec(`
      CREATE TABLE audit_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        actor TEXT NOT NULL,
        event TEXT NOT NULL,
        detail_json TEXT,
        created_at_ms INTEGER NOT NULL
      )
    `);
    const sample: BacktestExecutionTelemetry = {
      schemaVersion: 1,
      outcome: 'COMPLETED',
      failedStage: null,
      durationsMs: { load: 10, run: 20, persist: 30, total: 60 },
      peakRssBytes: 64 * 1024 ** 2,
      input: { candleCount: 100, factCount: 10, symbolCount: 1 },
      output: {
        rowCount: 20,
        estimatedPayloadBytes: 2_000,
        equityPointCount: 5,
        drawdownPointCount: 5,
        tradeCount: 5,
        monthlyReturnCount: 3,
        openPositionCount: 0,
      },
    };
    sqlite.prepare(
      `INSERT INTO audit_logs (actor, event, detail_json, created_at_ms)
       VALUES ('system', 'backtest.finished', ?, ?)`,
    ).run(JSON.stringify({ jobId: 'bt_cli', executionTelemetry: sample }), Date.now());
    sqlite.close();

    const result = spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        'src/server/cli.ts',
        'backtest:telemetry-report',
        '--since-days',
        '1',
        '--format',
        'json',
      ],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        env: { ...process.env, NODE_ENV: 'test', DATABASE_PATH: databasePath },
      },
    );

    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      events: { available: 1, scanned: 1, withoutTelemetry: 0, invalidTelemetry: 0 },
      samples: { valid: 1, completed: 1 },
      readiness: { readyForSizing: false },
      sizing: { localLightsailConcurrency: 1, memoryConcurrencyCap: null },
    });
  });
});
