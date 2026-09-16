import { describe, expect, test, vi } from 'vitest';
import type { PreparationInput } from '../../src/runtime/modules/backtest/application/backtest-preparation-orchestrator.js';
import type { TestApp } from '../helpers/test-app.js';
import { prepareSubmission } from '../helpers/backtest-preparation.js';

const input = {
  universeRule: {
    markets: ['KOSPI'],
    stages: [{ criterion: 'MARKET_CAP', direction: 'HIGH', limit: 10 }],
    rebalanceInterval: { unit: 'DAY', value: 1 },
  },
  period: { from: '2026-01-05', to: '2026-01-05' },
  strategyId: 'range-breakout',
  parameters: {},
} as const satisfies PreparationInput;

const preview = {
  preparationJobId: 'prep-1',
  schedule: [],
  diagnostics: [],
  stages: input.universeRule.stages,
  unionSymbols: [],
  scheduleHash: 'hash',
  uncoveredDates: [],
  periodCovered: true,
  missingCandleSymbols: [],
  warnings: [],
};

function response(statusCode: number, body: unknown) {
  return {
    statusCode,
    body: JSON.stringify(body),
    json: <T>() => body as T,
  };
}

describe('명시적 backtest preparation helper', () => {
  test('202 작업 완료 뒤 같은 preview를 다시 조회한다', async () => {
    const inject = vi.fn()
      .mockResolvedValueOnce(response(202, { job: { id: 'prep-1' } }))
      .mockResolvedValueOnce(response(200, preview));
    const ctx = {
      app: { inject },
      container: {
        backtestPreparationOrchestrator: {
          get: vi.fn(() => ({
            id: 'prep-1', requestHash: 'hash', status: 'COMPLETED', phase: 'FINALIZING',
            overallProgress: 1, doneSymbols: 1, totalSymbols: 1, savedFacts: 0,
            gapCount: 0, nextResumeAtMs: null, error: null,
          })),
        },
      },
    } as unknown as TestApp;

    await expect(prepareSubmission(ctx, 'cookie', input, {
      signal: new AbortController().signal,
    })).resolves.toEqual({ preparationJobId: 'prep-1', preview });
    expect(inject).toHaveBeenCalledTimes(2);
  });

  test.each(['FAILED', 'CANCELLED'] as const)('%s 작업을 성공으로 복구하지 않는다', async (status) => {
    const inject = vi.fn().mockResolvedValue(response(202, { job: { id: 'prep-1' } }));
    const ctx = {
      app: { inject },
      container: {
        backtestPreparationOrchestrator: {
          get: vi.fn(() => ({
            id: 'prep-1', requestHash: 'hash', status, phase: 'FINALIZING',
            overallProgress: 0.5, doneSymbols: 1, totalSymbols: 2, savedFacts: 0,
            gapCount: 0, nextResumeAtMs: null, error: 'fixture failure',
          })),
        },
      },
    } as unknown as TestApp;

    await expect(prepareSubmission(ctx, 'cookie', input, {
      signal: new AbortController().signal,
    })).rejects.toThrow(`preparation 실패`);
    expect(inject).toHaveBeenCalledTimes(1);
  });

  test('예상하지 않은 시작 응답을 본문과 함께 보고한다', async () => {
    const ctx = {
      app: { inject: vi.fn().mockResolvedValue(response(503, { error: 'DART_REQUIRED' })) },
    } as unknown as TestApp;

    await expect(prepareSubmission(ctx, 'cookie', input, {
      signal: new AbortController().signal,
    })).rejects.toThrow('503');
  });
});
