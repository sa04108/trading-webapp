import { describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/server/shared/db/database.js';
import { backtestPreparationJobs } from '../../src/server/shared/db/schema.js';
import {
  BacktestPreparationOrchestrator,
  type PreparationInput,
} from '../../src/server/modules/backtest/application/backtest-preparation-orchestrator.js';

const LOGGER = { debug() {}, info() {}, warn() {}, error() {} } as never;

const INPUT: PreparationInput = {
  universeRule: {
    markets: ['KOSPI'],
    stages: [{ criterion: 'MARKET_CAP', limit: 1 }],
    rebalanceInterval: { unit: 'MONTH', value: 1 },
  },
  period: { from: '2026-01-05', to: '2026-01-05' },
  strategyId: 'test-strategy',
  parameters: {},
};

const ENTRY = {
  standardCode: 'KR7005930003',
  shortCode: '005930',
  name: '삼성전자',
  market: 'KOSPI',
  sharesOutstanding: '1',
  instrumentType: 'COMMON_STOCK',
  listedDate: null,
} as const;

function ready(symbols: readonly string[] = ['005930']) {
  return {
    kind: 'READY' as const,
    schedule: [{
      rebalanceDate: '2026-01-05',
      effectiveDate: '2026-01-05',
      fromTsMs: Date.parse('2026-01-05T00:00:00Z'),
      members: symbols.map((symbol) => ({
        symbol,
        standardCode: ENTRY.standardCode,
        marketCapKrw: '100',
        volume: 10,
        tradingValueKrw: '1000',
      })),
    }],
    diagnostics: [{ rebalanceDate: '2026-01-05', effectiveDate: '2026-01-05', stages: [] }],
    unionEntries: new Map(symbols.map((symbol) => [symbol, { ...ENTRY, shortCode: symbol }])),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('waitFor timeout');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function makeDeps(overrides: Record<string, unknown> = {}) {
  const handle = openDatabase(':memory:');
  let nowMs = Date.parse('2026-01-05T00:00:00Z');
  const deps = {
    database: handle,
    clock: { now: () => nowMs },
    logger: LOGGER,
    resolver: {
      resolveOrDescribeNeeds: async () => ready(),
      isPeriodCovered: () => true,
    },
    strategies: {
      get: (id: string) => id === INPUT.strategyId ? {
        id,
        version: '1.0.0',
        name: id,
        description: id,
        parameterSchema: { safeParse: (value: unknown) => ({ success: true, data: value }) },
        initialize: () => ({}),
        onBars: () => ({ orders: [] }),
      } : null,
    },
    symbolMaster: {
      ensureTradingDay: async () => ({ effectiveTradingDate: '2026-01-05', ingestedDates: [] }),
      ensureSelectionMetrics: async () => undefined,
      ingestDate: async () => ({ kind: 'ALREADY_COVERED' }),
    },
    symbolService: {
      exists: () => true,
      addSymbol: () => undefined,
    },
    factSync: {
      sync: async () => ({ savedFacts: 0, gaps: [], stoppedAtSymbol: null, stopReason: null, failureMessage: null }),
      syncCorporateActions: async () => ({ savedFacts: 0, gaps: [], stoppedAtSymbol: null, stopReason: null, failureMessage: null }),
    },
    dartDailyCallLimit: 40_000,
    ...overrides,
  };
  return {
    handle,
    deps,
    setNow(value: number) { nowMs = value; },
  };
}

describe('BacktestPreparationOrchestrator single-flight와 직렬 실행', () => {
  it('같은 hash는 같은 active id를 돌려주고 다른 hash는 한 runner 뒤 QUEUED로 남긴다', async () => {
    const firstResolve = deferred<ReturnType<typeof ready>>();
    let calls = 0;
    const ctx = makeDeps({
      resolver: {
        resolveOrDescribeNeeds: async () => {
          calls += 1;
          if (calls === 1) return firstResolve.promise;
          return ready();
        },
        isPeriodCovered: () => true,
      },
    });
    const orchestrator = new BacktestPreparationOrchestrator(ctx.deps as never);

    const first = orchestrator.start(INPUT);
    const duplicate = orchestrator.start(INPUT);
    const second = orchestrator.start({ ...INPUT, parameters: { variant: 2 } });

    expect(duplicate.id).toBe(first.id);
    await waitFor(() => orchestrator.get(first.id)?.status === 'RUNNING');
    expect(orchestrator.get(second.id)?.status).toBe('QUEUED');

    firstResolve.resolve(ready());
    await waitFor(() => orchestrator.get(first.id)?.status === 'COMPLETED');
    await waitFor(() => orchestrator.get(second.id)?.status === 'COMPLETED');
    orchestrator.stop();
    ctx.handle.close();
  });

  it('구독 snapshot의 모든 status 변경은 허용된 transition만 따른다', async () => {
    const gate = deferred<ReturnType<typeof ready>>();
    const ctx = makeDeps({ resolver: { resolveOrDescribeNeeds: () => gate.promise, isPeriodCovered: () => true } });
    const orchestrator = new BacktestPreparationOrchestrator(ctx.deps as never);
    const job = orchestrator.start(INPUT);
    const statuses: string[] = [];
    const unsubscribe = orchestrator.subscribe(job.id, (snapshot) => statuses.push(snapshot.status));

    await waitFor(() => orchestrator.get(job.id)?.status === 'RUNNING');
    gate.resolve(ready());
    await waitFor(() => orchestrator.get(job.id)?.status === 'COMPLETED');

    expect(statuses.filter((status, index) => status !== statuses[index - 1])).toEqual([
      'QUEUED', 'RUNNING', 'COMPLETED',
    ]);
    unsubscribe();
    orchestrator.stop();
    ctx.handle.close();
  });
});

describe('BacktestPreparationOrchestrator recovery와 취소', () => {
  it('RUNNING은 QUEUED로 회수하고 미래 quota wait는 그대로 두며 만기 wait만 QUEUED로 회수한다', () => {
    const ctx = makeDeps();
    const now = ctx.deps.clock.now();
    const base = {
      requestHash: 'hash', requestJson: JSON.stringify(INPUT), phase: 'MARKET_DATA',
      doneSymbols: 0, totalSymbols: 0, savedFacts: 0, gapCount: 0,
      dartCallsUsed: 0, cancelRequested: false, createdAtMs: 1, updatedAtMs: 1,
    };
    ctx.handle.db.insert(backtestPreparationJobs).values([
      { ...base, id: 'prep_running', requestHash: 'running', status: 'RUNNING' },
      { ...base, id: 'prep_due', requestHash: 'due', status: 'WAITING_DAILY_QUOTA', nextResumeAtMs: now },
      { ...base, id: 'prep_future', requestHash: 'future', status: 'WAITING_DAILY_QUOTA', nextResumeAtMs: now + 60_000 },
    ]).run();
    const orchestrator = new BacktestPreparationOrchestrator(ctx.deps as never);

    orchestrator.recoverOrphaned();

    expect(orchestrator.get('prep_running')?.status).toBe('QUEUED');
    expect(orchestrator.get('prep_due')?.status).toBe('QUEUED');
    expect(orchestrator.get('prep_future')?.status).toBe('WAITING_DAILY_QUOTA');
    orchestrator.stop();
    ctx.handle.close();
  });

  it('취소는 현재 symbol 저장 완료 뒤 CANCELLED가 되고 반복 취소도 성공한다', async () => {
    const savedOne = deferred<void>();
    const continueAfterCancel = deferred<void>();
    const ctx = makeDeps({
      resolver: {
        resolveOrDescribeNeeds: async () => ({
          kind: 'NEEDS_DATA',
          needs: { factSymbols: ['005930', '000660'], actionSymbols: [], priceSymbols: [], selectionMetricDates: [], priceRange: null },
        }),
        isPeriodCovered: () => true,
      },
      factSync: {
        sync: async (_request: unknown, hooks: { onSymbolDone?: (p: unknown) => void; shouldStop?: () => boolean }) => {
          hooks.onSymbolDone?.({ symbol: '005930', index: 1, total: 2, savedFacts: 1, gapCount: 0 });
          savedOne.resolve();
          await continueAfterCancel.promise;
          return {
            savedFacts: 1,
            gaps: [],
            stoppedAtSymbol: hooks.shouldStop?.() ? '000660' : null,
            stopReason: hooks.shouldStop?.() ? 'CANCELLED' : null,
            failureMessage: hooks.shouldStop?.() ? '사용자가 취소했습니다.' : null,
          };
        },
        syncCorporateActions: async () => ({ savedFacts: 0, gaps: [], stoppedAtSymbol: null, stopReason: null, failureMessage: null }),
      },
    });
    const orchestrator = new BacktestPreparationOrchestrator(ctx.deps as never);
    const job = orchestrator.start(INPUT);
    await savedOne.promise;

    expect(orchestrator.cancel(job.id)).toBe(true);
    expect(orchestrator.get(job.id)?.status).toBe('RUNNING');
    continueAfterCancel.resolve();
    await waitFor(() => orchestrator.get(job.id)?.status === 'CANCELLED');
    expect(orchestrator.get(job.id)?.doneSymbols).toBe(1);
    expect(orchestrator.cancel(job.id)).toBe(true);
    orchestrator.stop();
    ctx.handle.close();
  });
});

describe('BacktestPreparationOrchestrator quota resume와 terminal 결과', () => {
  it('KST 다음 자정까지 기다렸다가 INCREMENTAL로 완료된 현재연도 symbol-year를 반복하지 않는다', async () => {
    const completedSymbols = new Set<string>();
    const requestedSymbols: string[] = [];
    const modes: string[] = [];
    const ctx = makeDeps({
      dartDailyCallLimit: 1,
      resolver: {
        resolveOrDescribeNeeds: async () => completedSymbols.size === 2 ? ready() : ({
          kind: 'NEEDS_DATA',
          needs: { factSymbols: ['005930', '000660'], actionSymbols: [], priceSymbols: [], selectionMetricDates: [], priceRange: null },
        }),
        isPeriodCovered: () => true,
      },
      factSync: {
        sync: async (
          request: { symbols: readonly string[]; mode: string; refreshCurrentYear?: boolean },
          hooks: {
            beforeWorkUnit?: (work: unknown) => string;
            onSymbolDone?: (progress: { index: number; total: number }) => void;
          },
        ) => {
          modes.push(request.mode);
          for (const [index, symbol] of request.symbols.entries()) {
            if (completedSymbols.has(symbol) && request.refreshCurrentYear === false) {
              hooks.onSymbolDone?.({ index: index + 1, total: request.symbols.length });
              continue;
            }
            const decision = hooks.beforeWorkUnit?.({ symbol, year: 2026, shareYears: [2025, 2026], estimatedDartCalls: 1 });
            if (decision === 'PAUSE_DAILY_QUOTA') {
              return { savedFacts: 0, gaps: [], stoppedAtSymbol: symbol, stopReason: 'DAILY_QUOTA', failureMessage: 'quota' };
            }
            requestedSymbols.push(symbol);
            completedSymbols.add(symbol);
            hooks.onSymbolDone?.({ index: index + 1, total: request.symbols.length });
          }
          return { savedFacts: 0, gaps: [], stoppedAtSymbol: null, stopReason: null, failureMessage: null };
        },
        syncCorporateActions: async () => ({ savedFacts: 0, gaps: [], stoppedAtSymbol: null, stopReason: null, failureMessage: null }),
      },
    });
    const orchestrator = new BacktestPreparationOrchestrator(ctx.deps as never);
    const job = orchestrator.start(INPUT);

    await waitFor(() => orchestrator.get(job.id)?.status === 'WAITING_DAILY_QUOTA');
    expect(orchestrator.get(job.id)?.nextResumeAtMs).toBe(Date.parse('2026-01-05T15:00:00.000Z'));
    expect(requestedSymbols).toEqual(['000660']);

    ctx.setNow(Date.parse('2026-01-05T15:00:00.000Z'));
    orchestrator.recoverOrphaned();
    await waitFor(() => orchestrator.get(job.id)?.status === 'COMPLETED');

    expect(requestedSymbols).toEqual(['000660', '005930']);
    expect(modes).toEqual(['INCREMENTAL', 'INCREMENTAL']);
    orchestrator.stop();
    ctx.handle.close();
  });

  it('모든 rebalance entry가 비면 한국어 원인으로 FAILED에 수렴한다', async () => {
    const ctx = makeDeps({ resolver: { resolveOrDescribeNeeds: async () => ready([]), isPeriodCovered: () => true } });
    const orchestrator = new BacktestPreparationOrchestrator(ctx.deps as never);
    const job = orchestrator.start(INPUT);

    await waitFor(() => orchestrator.get(job.id)?.status === 'FAILED');

    expect(orchestrator.get(job.id)?.error).toMatch(/선정된 종목|유니버스/);
    orchestrator.stop();
    ctx.handle.close();
  });
});
