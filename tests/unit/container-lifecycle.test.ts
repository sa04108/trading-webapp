import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/server/bootstrap/config.js';
import { createContainer } from '../../src/server/bootstrap/container.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('Container lifecycle', () => {
  it('preparation stop이 symbol 경계에서 끝난 뒤에만 SQLite를 닫는다', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qp-container-close-'));
    const config = loadConfig({
      NODE_ENV: 'test',
      DATABASE_PATH: path.join(dir, 'app.sqlite'),
      DATA_ROOT: path.join(dir, 'market-data'),
      IMPORT_ROOT: path.join(dir, 'imports'),
      EXPORT_ROOT: path.join(dir, 'exports'),
      TEMP_ROOT: path.join(dir, 'temp'),
      SESSION_SECRET: 's'.repeat(48),
      LOG_LEVEL: 'error',
    });
    const container = createContainer(config);
    const stopGate = deferred();
    container.backtestPreparationOrchestrator.stop = (() => stopGate.promise) as never;
    const originalDatabaseClose = container.database.close.bind(container.database);
    const events: string[] = [];
    container.database.close = (() => {
      events.push('sqlite-closed');
      originalDatabaseClose();
    }) as never;

    const closing = Promise.resolve(container.close());
    await Promise.resolve();
    const beforeStopBoundary = [...events];
    stopGate.resolve();
    await closing;

    expect(beforeStopBoundary).toEqual([]);
    expect(events).toEqual(['sqlite-closed']);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
