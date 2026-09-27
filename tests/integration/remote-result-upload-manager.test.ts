import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RemoteResultUploadManager } from '../../src/server/modules/backtest/infrastructure/remote-result-upload-manager.js';

let directory: string;

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'qp-result-upload-'));
});

afterEach(() => {
  fs.rmSync(directory, { recursive: true, force: true });
});

describe('RemoteResultUploadManager lifecycle', () => {
  it('종료 signal이 전송 stream과 생성 중인 임시 artifact를 정리한다', async () => {
    const manager = new RemoteResultUploadManager(directory);
    const source = new PassThrough();
    const abort = new AbortController();
    source.write(Buffer.from('partial-result'));
    const receiving = manager.receive(
      source,
      'job-one',
      1,
      undefined,
      abort.signal,
    );

    abort.abort();

    await expect(receiving).rejects.toMatchObject({ name: 'AbortError' });
    expect(
      fs.existsSync(path.join(directory, 'remote-backtests', 'uploads')),
    ).toBe(true);
    expect(
      fs.readdirSync(path.join(directory, 'remote-backtests', 'uploads')),
    ).toEqual([]);
  });
});
