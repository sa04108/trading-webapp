import { EventEmitter } from 'node:events';
import type { ChildProcess, fork } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  BacktestResultCompletionInput,
  BacktestResultCompletionOutput,
} from '../../src/runtime/modules/backtest/application/backtest-result-artifact.js';
import { ForkedBacktestResultCompleter } from '../../src/server/modules/backtest/infrastructure/forked-backtest-result-completer.js';

const input: BacktestResultCompletionInput = {
  jobId: 'job-one',
  attempt: 1,
  leaseTokenHash: 'hash',
  artifactPath: '/tmp/result.sqlite',
  checksum: 'checksum',
  expectedRunnerVersion: 'runner',
};

const output: BacktestResultCompletionOutput = {
  status: 'ACCEPTED',
  schemaVersion: 2,
  rowCount: 10,
  processedBars: 20,
  completedAtMs: 30,
};

class FakeChild extends EventEmitter {
  readonly stderr = new EventEmitter();
  readonly kill = vi.fn(() => true);
}

function harness(options: {
  onProgress?: (
    input: BacktestResultCompletionInput,
    activity: 'VALIDATING_RESULT' | 'IMPORTING_RESULT',
  ) => void;
  onProgressError?: (
    error: unknown,
    input: BacktestResultCompletionInput,
    activity: 'VALIDATING_RESULT' | 'IMPORTING_RESULT',
  ) => void;
  gracefulStopMs?: number;
  termStopMs?: number;
  killStopMs?: number;
} = {}) {
  const children: FakeChild[] = [];
  const forkProcess = vi.fn(() => {
    const child = new FakeChild();
    children.push(child);
    return child as unknown as ChildProcess;
  });
  const completer = new ForkedBacktestResultCompleter(
    '/tmp/app.sqlite',
    options.onProgress,
    {
      forkProcess: forkProcess as unknown as typeof fork,
      onProgressError: options.onProgressError,
      gracefulStopMs: options.gracefulStopMs,
      termStopMs: options.termStopMs,
      killStopMs: options.killStopMs,
    },
  );
  return { completer, forkProcess, children };
}

async function started(harnessResult: ReturnType<typeof harness>): Promise<FakeChild> {
  await vi.waitFor(() => expect(harnessResult.children).toHaveLength(1));
  return harnessResult.children[0]!;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('ForkedBacktestResultCompleter lifecycle', () => {
  it('exit가 아니라 IPC와 stdio가 닫히는 close까지 기다린다', async () => {
    const ctx = harness();
    const completion = ctx.completer.complete(input);
    const child = await started(ctx);
    let settled = false;
    void completion.finally(() => { settled = true; });

    child.emit('message', { type: 'completed', output });
    child.emit('exit', 0, null);
    await Promise.resolve();
    expect(settled).toBe(false);

    child.emit('close', 0, null);
    await expect(completion).resolves.toEqual(output);
    await expect(ctx.completer.stop()).resolves.toBeUndefined();
  });

  it('child error가 발생해도 실제 close까지 기다린 뒤 한 번만 실패한다', async () => {
    const ctx = harness();
    const completion = ctx.completer.complete(input);
    const child = await started(ctx);
    const childError = new Error('spawn failed');
    let settled = false;
    void completion.catch(() => { settled = true; });

    child.emit('error', childError);
    await Promise.resolve();
    expect(settled).toBe(false);

    child.emit('close', null, null);
    await expect(completion).rejects.toBe(childError);
    await expect(ctx.completer.stop()).resolves.toBeUndefined();
  });

  it('종료 시작 뒤 늦은 progress를 전달하지 않고 진행 중 child close를 기다린다', async () => {
    const onProgress = vi.fn();
    const ctx = harness({ onProgress, gracefulStopMs: 1_000 });
    const completion = ctx.completer.complete(input);
    const child = await started(ctx);
    const stopping = ctx.completer.stop();

    child.emit('message', { type: 'progress', activity: 'VALIDATING_RESULT' });
    expect(onProgress).not.toHaveBeenCalled();
    child.emit('message', { type: 'completed', output });
    child.emit('close', 0, null);

    await expect(completion).resolves.toEqual(output);
    await expect(stopping).resolves.toBeUndefined();
    expect(child.kill).not.toHaveBeenCalled();
  });

  it('종료 전에 대기열에 들어간 다음 import를 fork하지 않는다', async () => {
    const ctx = harness({ gracefulStopMs: 1_000 });
    const first = ctx.completer.complete(input);
    const child = await started(ctx);
    const second = ctx.completer.complete({ ...input, jobId: 'job-two' });
    const secondRejection = expect(second).rejects.toThrow('서버가 종료 중');
    const stopping = ctx.completer.stop();

    child.emit('message', { type: 'completed', output });
    child.emit('close', 0, null);

    await expect(first).resolves.toEqual(output);
    await secondRejection;
    await expect(stopping).resolves.toBeUndefined();
    expect(ctx.forkProcess).toHaveBeenCalledTimes(1);
  });

  it('progress 저장 오류를 별도 callback으로 보고하고 artifact 완료는 유지한다', async () => {
    const progressError = new Error('progress persistence failed');
    const onProgress = vi.fn(() => { throw progressError; });
    const onProgressError = vi.fn();
    const ctx = harness({ onProgress, onProgressError });
    const completion = ctx.completer.complete(input);
    const child = await started(ctx);

    child.emit('message', { type: 'progress', activity: 'IMPORTING_RESULT' });
    child.emit('message', { type: 'completed', output });
    child.emit('close', 0, null);

    await expect(completion).resolves.toEqual(output);
    expect(onProgressError).toHaveBeenCalledWith(
      progressError,
      input,
      'IMPORTING_RESULT',
    );
  });

  it('유예시간 뒤 SIGTERM과 SIGKILL을 보내고 실제 close까지 기다린다', async () => {
    vi.useFakeTimers();
    const ctx = harness({ gracefulStopMs: 10, termStopMs: 10, killStopMs: 10 });
    const completion = ctx.completer.complete(input);
    await vi.advanceTimersByTimeAsync(0);
    const child = ctx.children[0]!;
    const rejection = expect(completion).rejects.toThrow('SIGKILL');
    const stopping = ctx.completer.stop();

    await vi.advanceTimersByTimeAsync(10);
    expect(child.kill).toHaveBeenNthCalledWith(1, 'SIGTERM');
    await vi.advanceTimersByTimeAsync(10);
    expect(child.kill).toHaveBeenNthCalledWith(2, 'SIGKILL');
    child.emit('close', null, 'SIGKILL');

    await rejection;
    await expect(stopping).resolves.toBeUndefined();
  });
});
