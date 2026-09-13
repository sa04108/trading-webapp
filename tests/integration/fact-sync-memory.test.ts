import { fork } from 'node:child_process';
import { expect, it } from 'vitest';

interface MemoryResult {
  stopReason: string | null;
  gapCount: number;
  examples: number;
  persistedGaps: number;
  persistedBlockingGaps: number;
  maxHeapMiB: number;
  maxRssMiB: number;
}

function runChild(kind: string): Promise<MemoryResult> {
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  const child = fork(new URL('../fixtures/fact-sync-memory-child.ts', import.meta.url), [kind], {
    env, execArgv: ['--import', 'tsx', '--max-old-space-size=128'],
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  return new Promise((resolve, reject) => {
    let result: MemoryResult | undefined;
    let stderr = '';
    const timeout = setTimeout(() => child.kill('SIGKILL'), 30_000);
    child.stderr?.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-3000); });
    child.on('message', (message: MemoryResult) => { result = message; });
    child.on('error', reject);
    child.on('close', (code, signal) => {
      clearTimeout(timeout);
      if (code === 0 && signal === null && result !== undefined) resolve(result);
      else reject(new Error(`수집 child 종료: code=${code}, signal=${signal}\n${stderr}`));
    });
  });
}

it.each(['financial', 'actions'])('%s 수집의 결손 676,280건은 128 MiB에서 완료되고 판정용 결손은 모두 저장된다', async (kind) => {
  const result = await runChild(kind);
  expect(result.stopReason).toBeNull();
  expect(result.gapCount).toBe(676_280);
  expect(result.examples).toBe(100);
  expect(result.persistedGaps).toBe(result.gapCount);
  expect(result.persistedBlockingGaps).toBe(212 * 11);
  expect(result.maxHeapMiB).toBeLessThan(128);
  expect(result.maxRssMiB).toBeLessThan(320);
}, 40_000);
