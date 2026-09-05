import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BacktestPreparationJobDto } from '../../src/server/modules/backtest/application/backtest-preparation-orchestrator.js';
import { waitForPreparationFixture } from '../helpers/test-app.js';

const activeJob = (overrides: Partial<BacktestPreparationJobDto> = {}): BacktestPreparationJobDto => ({
  id: 'prep_active',
  requestHash: 'hash',
  status: 'RUNNING',
  phase: 'RESOLVING_STAGES',
  doneSymbols: 7,
  totalSymbols: 12,
  savedFacts: 3,
  gapCount: 1,
  nextResumeAtMs: null,
  error: null,
  ...overrides,
});

describe('test app preparation fixture', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

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
