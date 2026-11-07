import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fork } from 'node:child_process';
import Database from 'better-sqlite3';
import { seedUniverseMemoryDatabase } from '../fixtures/universe-preparation-memory-seed.js';
import { expect, it } from 'vitest';

interface MemoryResult {
  kind: string; hash: string; dates: number; members: number; actionSymbols: string[];
  maxFactBatch: number; maxRssMiB: number;
}

function runChild(databasePath: string, mode: string, exclusions = false): Promise<MemoryResult> {
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  const child = fork(new URL('../fixtures/universe-preparation-memory-child.ts', import.meta.url), [databasePath, mode, exclusions ? 'excluded' : 'none'], {
    env, execArgv: ['--import', 'tsx', '--max-old-space-size=128', '--max-semi-space-size=4'], stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  return new Promise((resolve, reject) => {
    let result: MemoryResult | undefined;
    let stderr = '';
    const timeout = setTimeout(() => child.kill('SIGKILL'), 240_000);
    child.stderr?.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-4000); });
    child.on('message', (message: MemoryResult) => { result = message; });
    child.on('error', reject);
    child.on('close', (code, signal) => {
      clearTimeout(timeout);
      if (code === 0 && signal === null && result !== undefined) resolve(result);
      else reject(new Error(`유니버스 child 종료: code=${code}, signal=${signal}\n${stderr}`));
    });
  });
}


it('10년 월별 시총 및 급상승 선정은 제한된 메모리에서 결정적 결과를 낸다', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qp-universe-memory-'));
  try {
    const databasePath = path.join(dir, 'synthetic.sqlite');
    seedUniverseMemoryDatabase(databasePath);
    const ready = await runChild(databasePath, 'serial');
    expect(ready.kind).toBe('READY');
    expect(ready.dates).toBe(120);
    expect(ready.members).toBe(6000);
    expect(ready.maxFactBatch).toBeLessThanOrEqual(32);
    expect(ready.maxRssMiB).toBeLessThan(320);
    const parallel = await runChild(databasePath, 'parallel');
    expect(parallel.kind).toBe('READY');
    expect(parallel.hash).toBe(ready.hash);
    expect(parallel.maxRssMiB).toBeLessThan(700);
    const serialExcluded = await runChild(databasePath, 'serial', true);
    const parallelExcluded = await runChild(databasePath, 'parallel', true);
    expect(serialExcluded.kind).toBe('READY');
    expect(serialExcluded.hash).not.toBe(ready.hash);
    expect(parallelExcluded.hash).toBe(serialExcluded.hash);
    expect(serialExcluded.maxRssMiB).toBeLessThan(320);
    expect(parallelExcluded.maxRssMiB).toBeLessThan(700);
    const db = new Database(databasePath);
    db.prepare("UPDATE symbol_facts_state SET action_covered_years_json = '[]', action_coverage_protocol_json = NULL WHERE code = '000000'").run();
    db.close();
    const missing = await runChild(databasePath, 'serial');
    const parallelMissing = await runChild(databasePath, 'parallel');
    expect(missing.kind).toBe('NEEDS_DATA');
    expect(missing.actionSymbols).toEqual(['000000']);
    expect(parallelMissing.kind).toBe('NEEDS_DATA');
    expect(parallelMissing.hash).toBe(missing.hash);
    expect(missing.maxRssMiB).toBeLessThan(320);
    expect(parallelMissing.maxRssMiB).toBeLessThan(700);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}, 780_000);
