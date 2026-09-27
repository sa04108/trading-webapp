import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clearAllBacktestWizardDrafts,
  saveBacktestWizardDraftStep,
  waitForPendingDraftSaves,
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

  it('pending autosave가 실제로 끝날 때까지 대기한다', async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetchMock = vi.fn(async (_input: unknown, init?: RequestInit) => {
      if (init?.method === 'PUT') await blocked;
      return new Response(JSON.stringify({ draft: {} }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const save = saveBacktestWizardDraftStep(null, 'strategy', {
      strategyId: 'range-breakout',
      parameters: { lookbackBars: '10' },
      currentStep: 'strategy',
    });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    let finished = false;
    const waiting = waitForPendingDraftSaves().then(() => {
      finished = true;
    });
    await Promise.resolve();
    expect(finished).toBe(false);

    release();
    await Promise.all([save, waiting]);
    expect(finished).toBe(true);
  });

  it('유니버스 미리보기 저장은 준비 작업 ID만 전송한다', async () => {
    const fetchMock = vi.fn(async (_input: unknown, _init?: RequestInit) =>
      new Response(JSON.stringify({ draft: {} }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await saveBacktestWizardDraftStep(null, 'universe', {
      universeRule: {
        markets: ['KOSPI'],
        stages: [{ criterion: 'MARKET_CAP', direction: 'HIGH', limit: 20 }],
        rebalanceInterval: { unit: 'MONTH', value: 1 },
      },
      lastPreview: {
        params: {
          universeRule: {
            markets: ['KOSPI'],
            stages: [{ criterion: 'MARKET_CAP', direction: 'HIGH', limit: 20 }],
            rebalanceInterval: { unit: 'MONTH', value: 1 },
          },
          period: { from: '2025-01-01', to: '2025-12-31' },
          strategyId: 'range-breakout',
          parameters: { lookbackBars: 10 },
        },
        result: {
          preparationJobId: 'prep-123',
          schedule: [],
          unionSymbols: ['005930'],
          scheduleHash: 'hash',
          uncoveredDates: [],
          periodCovered: true,
          missingCandleSymbols: [],
          warnings: [],
        },
      },
    });

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body.lastPreview).toEqual({ preparationJobId: 'prep-123' });
    expect(JSON.stringify(body)).not.toContain('005930');
    expect(JSON.stringify(body)).not.toContain('scheduleHash');
    expect(JSON.stringify(body)).not.toContain('lookbackBars');
  });

  it('준비 작업 ID가 없는 미리보기는 null로 저장한다', async () => {
    const fetchMock = vi.fn(async (_input: unknown, _init?: RequestInit) =>
      new Response(JSON.stringify({ draft: {} }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await saveBacktestWizardDraftStep(null, 'universe', {
      universeRule: {
        markets: ['KOSPI'],
        stages: [{ criterion: 'MARKET_CAP', direction: 'HIGH', limit: 20 }],
        rebalanceInterval: { unit: 'MONTH', value: 1 },
      },
      lastPreview: {
        params: {
          universeRule: {
            markets: ['KOSPI'],
            stages: [{ criterion: 'MARKET_CAP', direction: 'HIGH', limit: 20 }],
            rebalanceInterval: { unit: 'MONTH', value: 1 },
          },
          period: { from: '2025-01-01', to: '2025-12-31' },
          strategyId: 'range-breakout',
          parameters: {},
        },
        result: {
          schedule: [],
          unionSymbols: [],
          scheduleHash: 'hash',
          uncoveredDates: [],
          periodCovered: true,
          missingCandleSymbols: [],
          warnings: [],
        },
      },
    });

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body.lastPreview).toBeNull();
  });
});
