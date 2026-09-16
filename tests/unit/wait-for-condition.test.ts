import { describe, expect, it, vi } from 'vitest';
import { waitForCondition } from '../helpers/wait-for-condition.js';

describe('waitForCondition', () => {
  it('이미 취소된 signal이면 상태를 읽지 않는다', async () => {
    const abort = new AbortController();
    abort.abort(new Error('cancelled'));
    const read = vi.fn(() => 'RUNNING');

    await expect(waitForCondition(read, () => false, {
      signal: abort.signal,
      timeoutMs: 100,
      label: 'job',
    })).rejects.toThrow('cancelled');
    expect(read).not.toHaveBeenCalled();
  });

  it('대기 중 취소 뒤 상태를 다시 읽지 않는다', async () => {
    const abort = new AbortController();
    const read = vi.fn(() => 'RUNNING');
    const waiting = waitForCondition(read, () => false, {
      signal: abort.signal,
      timeoutMs: 1_000,
      intervalMs: 100,
      label: 'job',
    });
    await vi.waitFor(() => expect(read).toHaveBeenCalledOnce());
    abort.abort(new Error('cancelled while waiting'));

    await expect(waiting).rejects.toThrow();
    const readsAfterAbort = read.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(read).toHaveBeenCalledTimes(readsAfterAbort);
  });

  it('제한시간 오류에 마지막 상태와 label을 포함한다', async () => {
    await expect(waitForCondition(
      () => ({ status: 'RUNNING', progress: 3 }),
      () => false,
      {
        signal: new AbortController().signal,
        timeoutMs: 5,
        intervalMs: 1,
        label: 'preparation prep-one',
      },
    )).rejects.toThrow(/preparation prep-one timeout.*RUNNING/);
  });
});
