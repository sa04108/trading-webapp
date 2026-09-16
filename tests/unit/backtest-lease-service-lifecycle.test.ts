import { describe, expect, it, vi } from 'vitest';
import type {
  BacktestResultCompleter,
  BacktestResultCompletionOutput,
} from '../../src/runtime/modules/backtest/application/backtest-result-artifact.js';
import { BacktestLeaseService } from '../../src/server/modules/backtest/application/backtest-lease-service.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

const accepted: BacktestResultCompletionOutput = {
  status: 'ACCEPTED',
  schemaVersion: 2,
  rowCount: 1,
  processedBars: 2,
  completedAtMs: 3,
};

function harness() {
  const completion = deferred<BacktestResultCompletionOutput>();
  const completer: BacktestResultCompleter = {
    complete: vi.fn(() => completion.promise),
    stop: vi.fn(async () => undefined),
  };
  const queue = {
    getJob: vi.fn(() => ({
      id: 'job-one',
      status: 'RUNNING',
      attempt: 1,
      agentId: 'agent-one',
      startedAtMs: 1,
      createdAtMs: 1,
    })),
  };
  const audit = { record: vi.fn() };
  const logger = { warn: vi.fn() };
  const service = new BacktestLeaseService(
    queue as never,
    'runner',
    { now: () => 10 },
    audit as never,
    logger as never,
    completer,
    () => 'token',
  );
  const input = {
    jobId: 'job-one',
    attempt: 1,
    leaseToken: 'lease-token',
    artifactPath: '/tmp/result.sqlite',
    checksum: 'checksum',
  };
  return { service, completion, completer, audit, input };
}

describe('BacktestLeaseService lifecycle', () => {
  it('result child 뒤의 감사 기록과 이벤트까지 완료한 다음 stop을 반환한다', async () => {
    const ctx = harness();
    const events = vi.fn();
    ctx.service.events.on('job', events);
    const completing = ctx.service.complete(ctx.input);
    let stopped = false;
    const stopping = ctx.service.stop().then(() => { stopped = true; });

    await Promise.resolve();
    expect(stopped).toBe(false);
    ctx.completion.resolve(accepted);

    await expect(completing).resolves.toBe('ACCEPTED');
    await stopping;
    expect(ctx.audit.record).toHaveBeenCalledWith(
      'system',
      'backtest.finished',
      expect.objectContaining({ jobId: 'job-one', status: 'COMPLETED' }),
    );
    expect(events).toHaveBeenCalledWith({ jobId: 'job-one', kind: 'status' });
  });

  it('stop은 중복 호출에 안전하고 종료 뒤 새 completion을 거부한다', async () => {
    const ctx = harness();
    const first = ctx.service.stop();
    const second = ctx.service.stop();

    expect(second).toBe(first);
    await first;
    expect(ctx.completer.stop).toHaveBeenCalledTimes(1);
    await expect(ctx.service.complete(ctx.input)).rejects.toThrow('서버가 종료 중');
    expect(ctx.completer.complete).not.toHaveBeenCalled();
  });
});
