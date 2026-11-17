import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  loadBacktestWizardDraft,
  saveBacktestWizardDraftStep,
  waitForPendingDraftSaves,
} from '../../src/web/features/backtests/wizard-draft-api.js';

describe('backtest wizard draft API', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('같은 위저드·단계의 저장을 순서대로 보낸 뒤 대기한다', async () => {
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

    const firstSave = saveBacktestWizardDraftStep('wizard-1', 'strategy', {
      strategyId: 'range-breakout',
      parameters: { lookbackBars: '10' },
      currentStep: 'strategy',
    });
    let latestSave: Promise<void> | undefined;
    let clear: Promise<void> | undefined;
    try {
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
      latestSave = saveBacktestWizardDraftStep('wizard-1', 'strategy', {
        strategyId: 'range-breakout',
        parameters: { lookbackBars: '17' },
        currentStep: 'period',
      });
      clear = waitForPendingDraftSaves('wizard-1');
      await Promise.resolve();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      releaseFirst();
      await Promise.all([firstSave, latestSave, clear]);
      expect(calls).toEqual([
        { method: 'PUT', value: '10' },
        { method: 'PUT', value: '17' },
      ]);
    } finally {
      releaseFirst();
      await Promise.allSettled([firstSave, latestSave, clear]);
    }
  });

  it('재개 시 pending autosave가 끝난 뒤 최신 초안을 읽는다', async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
      if (init?.method === 'PUT') await blocked;
      const strategy = String(input).includes('/strategy?');
      return new Response(JSON.stringify({ draft: strategy && init?.method !== 'PUT' ? { payload: { strategyId: 'saved', parameters: {}, currentStep: 'strategy' } } : null }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const save = saveBacktestWizardDraftStep('wizard-1', 'strategy', {
      strategyId: 'range-breakout',
      parameters: { lookbackBars: '10' },
      currentStep: 'strategy',
    });
    let waiting: ReturnType<typeof loadBacktestWizardDraft> | undefined;
    try {
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
      let finished = false;
      waiting = loadBacktestWizardDraft('wizard-1').then((draft) => {
        finished = true;
        return draft;
      });
      await Promise.resolve();
      expect(finished).toBe(false);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      release();
      const [, draft] = await Promise.all([save, waiting]);
      expect(finished).toBe(true);
      expect(draft).toEqual({ strategy: { strategyId: 'saved', parameters: {}, currentStep: 'strategy' } });
      expect(fetchMock.mock.calls.filter(([, init]) => init?.method !== 'PUT').map(([url]) => url).sort()).toEqual([
        '/api/v1/backtests/wizard-draft/capital?wizardId=wizard-1',
        '/api/v1/backtests/wizard-draft/period?wizardId=wizard-1',
        '/api/v1/backtests/wizard-draft/strategy?wizardId=wizard-1',
        '/api/v1/backtests/wizard-draft/universe?wizardId=wizard-1',
      ]);
    } finally {
      release();
      await Promise.allSettled([save, waiting]);
    }
  });

  it('이전 저장이 실패해도 다음 저장은 전송한다', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response('failed', { status: 500 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ draft: {} }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const payload = { strategyId: 'range-breakout', parameters: {}, currentStep: 'strategy' as const };
    const first = saveBacktestWizardDraftStep('retry-wizard', 'strategy', payload);
    const second = saveBacktestWizardDraftStep('retry-wizard', 'strategy', payload);
    await expect(first).rejects.toMatchObject({ status: 500 });
    await expect(second).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('다른 위저드의 저장은 기다리지 않는다', async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const fetchMock = vi.fn(async () => {
      await blocked;
      return new Response(JSON.stringify({ draft: {} }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    const save = saveBacktestWizardDraftStep('wizard-blocked', 'strategy', {
      strategyId: null, parameters: {}, currentStep: 'strategy',
    });
    try {
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
      await waitForPendingDraftSaves('wizard-other');
    } finally {
      release();
      await Promise.allSettled([save]);
    }
  });

  it('유니버스 미리보기 저장은 준비 작업 ID만 전송한다', async () => {
    const fetchMock = vi.fn(async (_input: unknown, _init?: RequestInit) =>
      new Response(JSON.stringify({ draft: {} }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await saveBacktestWizardDraftStep('wizard-1', 'universe', {
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

    await saveBacktestWizardDraftStep('wizard-1', 'universe', {
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
