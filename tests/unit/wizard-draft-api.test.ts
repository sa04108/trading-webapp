import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clearAllBacktestWizardDrafts,
  saveBacktestWizardDraftStep,
} from '../../src/web/features/backtests/wizard-draft-api.js';

describe('backtest wizard draft API', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('같은 문맥·단계의 저장을 순서대로 보낸 뒤 삭제한다', async () => {
    let releaseFirst!: () => void;
    const firstFinished = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const calls: Array<{ method: string; value: string | null }> = [];
    const fetchMock = vi.fn(async (_input: unknown, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      const body = init?.body === undefined
        ? null
        : (JSON.parse(String(init.body)) as { parameters?: { lookbackBars?: string } })
          .parameters?.lookbackBars ?? null;
      calls.push({ method, value: body });
      if (method === 'PUT' && calls.length === 1) await firstFinished;
      if (method === 'DELETE') return new Response(null, { status: 204 });
      return new Response(JSON.stringify({ draft: {} }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const firstSave = saveBacktestWizardDraftStep(null, 'strategy', {
      strategyId: 'range-breakout',
      parameters: { lookbackBars: '10' },
      currentStep: 'strategy',
    });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    const latestSave = saveBacktestWizardDraftStep(null, 'strategy', {
      strategyId: 'range-breakout',
      parameters: { lookbackBars: '17' },
      currentStep: 'period',
    });
    const clear = clearAllBacktestWizardDrafts();
    await Promise.resolve();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    releaseFirst();
    await Promise.all([firstSave, latestSave, clear]);

    expect(calls).toEqual([
      { method: 'PUT', value: '10' },
      { method: 'PUT', value: '17' },
      { method: 'DELETE', value: null },
    ]);
  });
});
