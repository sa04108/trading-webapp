import fs from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BacktestPreparationJobDto } from '../../src/runtime/modules/backtest/application/backtest-preparation-orchestrator.js';
import { createTestApp, waitForPreparationFixture } from '../helpers/test-app.js';

const activeJob = (overrides: Partial<BacktestPreparationJobDto> = {}): BacktestPreparationJobDto => ({
  id: 'prep_active',
  requestHash: 'hash',
  status: 'RUNNING',
  phase: 'RESOLVING_STAGES',
  overallProgress: 5,
  doneSymbols: 7,
  totalSymbols: 12,
  savedFacts: 3,
  gapCount: 1,
  nextResumeAtMs: null,
  error: null,
  ...overrides,
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('test app preparation fixture', () => {
  it('uses the default bounded timeout and reports the last progress', async () => {
    vi.useFakeTimers();
    const startedAtMs = Date.parse('2026-09-05T00:00:00Z');
    vi.setSystemTime(startedAtMs);
    const waiting = waitForPreparationFixture(() => activeJob(), 'prep_active');
    const rejection = expect(waiting).rejects.toThrow(
      'preparation fixture timeout: {"jobId":"prep_active","elapsedMs":5000,"status":"RUNNING","phase":"RESOLVING_STAGES","progress":{"doneSymbols":7,"totalSymbols":12,"savedFacts":3,"gapCount":1},"error":null}',
    );

    vi.setSystemTime(startedAtMs + 4_995);
    await vi.advanceTimersByTimeAsync(5);

    await rejection;
  });

  it('keeps a configured 15 second wait pending beyond the default timeout', async () => {
    vi.useFakeTimers();
    const startedAtMs = Date.parse('2026-09-05T00:00:00Z');
    vi.setSystemTime(startedAtMs);
    const waiting = waitForPreparationFixture(() => activeJob(), 'prep_active', 15_000);
    let settled = false;
    void waiting.then(
      () => { settled = true; },
      () => { settled = true; },
    );
    const rejection = expect(waiting).rejects.toThrow(
      'preparation fixture timeout: {"jobId":"prep_active","elapsedMs":15000,"status":"RUNNING","phase":"RESOLVING_STAGES","progress":{"doneSymbols":7,"totalSymbols":12,"savedFacts":3,"gapCount":1},"error":null}',
    );

    vi.setSystemTime(startedAtMs + 5_995);
    await vi.advanceTimersByTimeAsync(5);
    expect(settled).toBe(false);

    vi.setSystemTime(startedAtMs + 14_995);
    await vi.advanceTimersByTimeAsync(5);
    await rejection;
  });

  it.each([
    ['COMPLETED', true],
    ['FAILED', false],
    ['CANCELLED', false],
  ] as const)('maps terminal %s jobs to %s', async (status, expected) => {
    await expect(waitForPreparationFixture(
      () => activeJob({ status }),
      'prep_terminal',
      15,
    )).resolves.toBe(expected);
  });
});

describe('test app lifecycle', () => {
  it('두 앱이 서로 다른 DB와 디렉터리를 소유하고 독립적으로 종료된다', async () => {
    const first = await createTestApp();
    const second = await createTestApp();
    try {
      expect(first.dir).not.toBe(second.dir);
      expect(first.container.database.dataPath).not.toBe(
        second.container.database.dataPath,
      );

      await first.close();
      expect(fs.existsSync(first.dir)).toBe(false);
      expect(fs.existsSync(second.dir)).toBe(true);
      expect(() => second.container.jobQueue.getJob('missing-job')).not.toThrow();
    } finally {
      await Promise.allSettled([first.close(), second.close()]);
    }
  });

  it('close 중복 호출이 같은 정리 작업을 기다린다', async () => {
    const ctx = await createTestApp();
    const first = ctx.close();
    const second = ctx.close();

    expect(second).toBe(first);
    await first;
    expect(fs.existsSync(ctx.dir)).toBe(false);
  });

  it('ready 이전 설정 실패도 생성한 container와 임시 디렉터리를 정리한다', async () => {
    const removed: string[] = [];
    const actualRemove = fs.rmSync.bind(fs);
    const trackedRemove = vi.spyOn(fs, 'rmSync').mockImplementation((target, options) => {
      removed.push(String(target));
      return actualRemove(target, options);
    });

    await expect(createTestApp({}, () => {
      throw new Error('configure failed');
    })).rejects.toThrow('configure failed');

    expect(removed.some((target) => target.includes('qp-test-'))).toBe(true);
    trackedRemove.mockRestore();
  });
});
