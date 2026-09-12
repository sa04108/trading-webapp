import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fork } from 'node:child_process';
import Database from 'better-sqlite3';
import { expect, it } from 'vitest';

interface MemoryResult {
  readonly incomplete: number;
  readonly hash: string;
  readonly maxFactBatch: number;
  readonly maxRssMiB: number;
}

function runChild(databasePath: string, legacy: boolean): Promise<MemoryResult> {
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  const child = fork(new URL('../fixtures/financial-readiness-memory-child.ts', import.meta.url), [
    databasePath, legacy ? 'legacy' : 'bounded',
  ], {
    env,
    execArgv: ['--import', 'tsx', `--max-old-space-size=${legacy ? 256 : 128}`, '--max-semi-space-size=1'],
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  return new Promise((resolve, reject) => {
    let result: MemoryResult | undefined;
    let stderr = '';
    const timeout = setTimeout(() => child.kill('SIGKILL'), 45_000);
    child.stderr?.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-4000); });
    child.on('message', (message: MemoryResult) => { result = message; });
    child.on('error', reject);
    child.on('close', (code, signal) => {
      clearTimeout(timeout);
      if (code === 0 && signal === null && result !== undefined) resolve(result);
      else reject(new Error(`재무 검증 child 종료: code=${code}, signal=${signal}\n${stderr}`));
    });
  });
}

/** 운영 원본 대신 초기 선정의 종목 수·날짜 행 수·facts 행 수만 맞춘 결정적 합성 입력. */
function seed(databasePath: string): void {
  const db = new Database(databasePath);
  try {
    db.exec(`
      CREATE TABLE krx_daily_bars (short_code TEXT, date TEXT, market TEXT,
        open INTEGER, high INTEGER, low INTEGER, close INTEGER, volume INTEGER,
        PRIMARY KEY(short_code, date));
      CREATE TABLE facts (scope TEXT, key TEXT, field TEXT, period_key TEXT, as_of_ts_ms INTEGER,
        value REAL, unit TEXT, corporate_action_before_shares INTEGER, corporate_action_after_shares INTEGER,
        PRIMARY KEY(scope, key, field, period_key, as_of_ts_ms));
    `);
    const dates: string[] = [];
    for (let ts = Date.parse('2016-08-01'); ts <= Date.parse('2026-09-12'); ts += 86_400_000) {
      const date = new Date(ts);
      if (date.getUTCDay() !== 0 && date.getUTCDay() !== 6) dates.push(date.toISOString().slice(0, 10));
    }
    const fields = [
      'BONDS', 'CASH_AND_EQUIVALENTS', 'CURRENT_ASSETS', 'CURRENT_LIABILITIES',
      'CURRENT_LONG_TERM_DEBT', 'LONG_TERM_BORROWINGS', 'NET_INCOME', 'OPERATING_INCOME',
      'SHARES_OUTSTANDING', 'SHORT_TERM_BORROWINGS', 'SHORT_TERM_INVESTMENTS', 'TANGIBLE_ASSETS',
      'TOTAL_EQUITY',
    ];
    const insertBar = db.prepare("INSERT INTO krx_daily_bars VALUES (?, ?, 'KOSPI', 100, 110, 90, 100, 1000)");
    const insertFact = db.prepare("INSERT INTO facts VALUES ('SYMBOL', ?, ?, ?, ?, 1000000, 'KRW', NULL, NULL)");
    db.transaction(() => {
      for (let index = 0; index < 275; index += 1) {
        const code = String(index).padStart(6, '0');
        const dateCount = Math.floor(607309 / 275) + (index < 607309 % 275 ? 1 : 0);
        for (const date of dates.slice(-dateCount)) insertBar.run(code, date);
        const factCount = Math.floor(93313 / 275) + (index < 93313 % 275 ? 1 : 0);
        for (let row = 0; row < factCount; row += 1) {
          const ordinal = Math.floor(row / fields.length);
          const year = 2016 + Math.floor(ordinal / 4);
          const quarter = ordinal % 4 + 1;
          insertFact.run(code, fields[row % fields.length], `${year}Q${quarter}`, Date.UTC(year, quarter * 3 - 1, 28));
        }
      }
    })();
  } finally {
    db.close();
  }
}

it('10년 재무 검증은 128 MiB child에서 완료하고 기존 256 MiB 판정과 일치한다', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qp-financial-memory-'));
  try {
    const databasePath = path.join(dir, 'synthetic.sqlite');
    seed(databasePath);
    const current = await runChild(databasePath, false);
    const legacy = await runChild(databasePath, true);
    expect(current.incomplete).toBe(54);
    expect(current.hash).toBe('26d3e0b2acc437027da5534275128995908226b5dae65aa9a4c7cb22f53891fe');
    expect(current.hash).toBe(legacy.hash);
    expect(current.maxFactBatch).toBeLessThanOrEqual(32);
    expect(current.maxRssMiB).toBeLessThan(320);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}, 90_000);
