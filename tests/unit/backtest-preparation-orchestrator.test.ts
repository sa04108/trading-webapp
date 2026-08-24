import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/server/shared/db/database.js';
import { backtestPreparationJobs } from '../../src/server/shared/db/schema.js';
import {
  BacktestPreparationOrchestrator,
  type PreparationInput,
} from '../../src/server/modules/backtest/application/backtest-preparation-orchestrator.js';
import { backtestPreparationRequestHash } from '../../src/server/modules/backtest/application/backtest-preparation-plan.js';
import { StrategyRegistry } from '../../src/server/modules/strategy/application/strategy-registry.js';
import { KrxQuotaError } from '../../src/server/modules/market-data/application/ports.js';
import type { SymbolMasterEntry } from '../../src/server/modules/market-data/domain/symbol-master.js';

const LOGGER = { debug() {}, info() {}, warn() {}, error() {} } as never;

const INPUT: PreparationInput = {
  universeRule: {
    markets: ['KOSPI'],
    stages: [{ criterion: 'MARKET_CAP', direction: 'HIGH', limit: 1 }],
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

function candidateEntries(symbols: readonly string[]): Map<string, SymbolMasterEntry> {
  return new Map(symbols.map((symbol) => [symbol, { ...ENTRY, shortCode: symbol }]));
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
      getRegisteredIdentity: (code: string) => ({ code, standardCode: ENTRY.standardCode }),
      getRegisteredIdentityByStandardCode: () => null,
      addSymbol: () => undefined,
    },
    factSync: {
      sync: async () => ({ savedFacts: 0, gaps: [], stoppedAtSymbol: null, stopReason: null, failureMessage: null }),
      syncCorporateActions: async () => ({ savedFacts: 0, gaps: [], stoppedAtSymbol: null, stopReason: null, failureMessage: null }),
    },
    actionCoverage: {
      getCoveredYears: () => new Map<string, readonly number[]>(),
      getGapYears: () => new Map<string, readonly number[]>(),
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

const MARKET_ONLY_NEEDS = {
  kind: 'NEEDS_DATA' as const,
  candidateScopeKnown: true,
  unionEntries: new Map([['005930', ENTRY]]),
  needs: {
    factSymbols: [], actionSymbols: [], priceSymbols: [],
    selectionMetricDates: ['2026-01-05'], priceRange: null,
  },
};

function dartPlanningDeps() {
  return {
    sync: async () => ({ savedFacts: 0, gaps: [], stoppedAtSymbol: null, stopReason: null, failureMessage: null }),
    syncCorporateActions: async () => ({ savedFacts: 0, gaps: [], stoppedAtSymbol: null, stopReason: null, failureMessage: null }),
    planFinancialSync: (symbols: readonly string[]) => ({ calls: symbols.length }),
    planCorporateActionSync: (symbols: readonly string[]) => ({ calls: symbols.length }),
  };
}

describe('BacktestPreparationOrchestrator NEEDS_DATA DART gate', () => {
  it('실전 value 전략은 market-data 공백 단계에서도 알려진 후보의 future final-union을 계획한다', async () => {
    const ctx = makeDeps({
      resolver: { resolveOrDescribeNeeds: async () => MARKET_ONLY_NEEDS, isPeriodCovered: () => true },
      strategies: new StrategyRegistry(),
      factSync: dartPlanningDeps(),
    });
    const orchestrator = new BacktestPreparationOrchestrator(ctx.deps as never);

    const required = await orchestrator.needsDart({ ...INPUT, strategyId: 'value-quality-rank' });

    expect(required).toBe(true);
    await orchestrator.stop();
    ctx.handle.close();
  });

  it('master 미수집으로 후보 scope가 미상이면 DART 전략의 future sync를 예고한다', async () => {
    const ctx = makeDeps({
      resolver: {
        resolveOrDescribeNeeds: async () => ({
          ...MARKET_ONLY_NEEDS,
          candidateScopeKnown: false,
          unionEntries: new Map(),
        }),
        isPeriodCovered: () => false,
      },
      strategies: new StrategyRegistry(),
      factSync: dartPlanningDeps(),
    });
    const orchestrator = new BacktestPreparationOrchestrator(ctx.deps as never);

    const required = await orchestrator.needsDart({ ...INPUT, strategyId: 'value-quality-rank' });

    expect(required).toBe(true);
    await orchestrator.stop();
    ctx.handle.close();
  });

  it('후보 master scope가 비었으면 DART 전략이어도 future sync를 예고하지 않는다', async () => {
    const ctx = makeDeps({
      resolver: {
        resolveOrDescribeNeeds: async () => ({ ...MARKET_ONLY_NEEDS, unionEntries: new Map() }),
        isPeriodCovered: () => true,
      },
      strategies: new StrategyRegistry(),
      factSync: dartPlanningDeps(),
    });
    const orchestrator = new BacktestPreparationOrchestrator(ctx.deps as never);

    const required = await orchestrator.needsDart({ ...INPUT, strategyId: 'value-quality-rank' });

    expect(required).toBe(false);
    await orchestrator.stop();
    ctx.handle.close();
  });

  it.each([
    { criterion: 'PER' as const, stage: { criterion: 'PER' as const, direction: 'LOW' as const, limit: 1 } },
    { criterion: 'ROE' as const, stage: { criterion: 'ROE' as const, direction: 'HIGH' as const, limit: 1 } },
    {
      criterion: 'DECLINE' as const,
      stage: { criterion: 'DECLINE' as const, direction: 'LOW' as const, limit: 1, lookbackTradingDays: 20 },
    },
  ])('후보 scope 미상이면 price-only 전략이어도 $criterion stage 가 DART 를 예고한다', async ({ stage }) => {
    // 전략 metadata 가 아니라 유니버스 stage 가 DART 를 요구하는 경우 —
    // resolver 는 master 미수집이라 factSymbols/actionSymbols 를 아직 못 채웠다.
    const ctx = makeDeps({
      resolver: {
        resolveOrDescribeNeeds: async () => ({
          ...MARKET_ONLY_NEEDS,
          candidateScopeKnown: false,
          unionEntries: new Map(),
        }),
        isPeriodCovered: () => false,
      },
      factSync: dartPlanningDeps(),
    });
    const orchestrator = new BacktestPreparationOrchestrator(ctx.deps as never);

    const required = await orchestrator.needsDart({
      ...INPUT,
      universeRule: { ...INPUT.universeRule, stages: [stage] },
    });

    expect(required).toBe(true);
    await orchestrator.stop();
    ctx.handle.close();
  });

  it('후보 scope가 미상이어도 fact/action 요구가 없는 price-only 전략은 DART가 필요 없다', async () => {
    const ctx = makeDeps({
      resolver: {
        resolveOrDescribeNeeds: async () => ({
          ...MARKET_ONLY_NEEDS,
          candidateScopeKnown: false,
          unionEntries: new Map(),
        }),
        isPeriodCovered: () => false,
      },
      factSync: dartPlanningDeps(),
    });
    const orchestrator = new BacktestPreparationOrchestrator(ctx.deps as never);

    const required = await orchestrator.needsDart(INPUT);

    expect(required).toBe(false);
    await orchestrator.stop();
    ctx.handle.close();
  });
});

describe('BacktestPreparationOrchestrator MARKET_DATA 진행 표시', () => {
  it('분모는 수집할 날짜 수이고 날짜마다 진행을 갱신한다', async () => {
    // 운영 리포트(2026-08-10): 분모가 심볼 수(예: 275)인데 시장 데이터는 날짜 단위로
    // 돌아 진행이 phase 끝까지 0 에 머물렀다. metric 날짜 2개 + 가격 3일 = 5 를
    // 분모로 두고 날짜마다 1씩 오르는지 고정한다.
    let resolveCalls = 0;
    const marketNeeds = {
      kind: 'NEEDS_DATA' as const,
      candidateScopeKnown: true,
      unionEntries: new Map([['005930', ENTRY]]),
      needs: {
        factSymbols: [],
        actionSymbols: [],
        priceSymbols: ['005930'],
        selectionMetricDates: ['2026-01-05', '2026-01-06'],
        priceRange: { from: '2026-01-02', to: '2026-01-04' },
      },
    };
    const ctx = makeDeps({
      resolver: {
        resolveOrDescribeNeeds: async () => (resolveCalls++ === 0 ? marketNeeds : ready()),
        isPeriodCovered: () => true,
      },
    });
    const orchestrator = new BacktestPreparationOrchestrator(ctx.deps as never);

    const progress: { done: number; total: number }[] = [];
    const id = orchestrator.start(INPUT).id;
    const unsubscribe = orchestrator.subscribe(id, (job) => {
      // 생성 직후 QUEUED snapshot 도 기본 phase 가 MARKET_DATA 다 — 실제 수집 중
      // (RUNNING) 의 진행만 본다.
      if (job.status === 'RUNNING' && job.phase === 'MARKET_DATA') {
        progress.push({ done: job.doneSymbols, total: job.totalSymbols });
      }
    });
    await waitFor(() => orchestrator.get(id)?.status === 'COMPLETED');
    unsubscribe();

    // QUEUED→RUNNING 전이 직후의 snapshot 은 아직 분모를 못 받았다(total 0) —
    // 실제 수집이 시작된 snapshot 만 본다.
    const active = progress.filter((entry) => entry.total > 0);
    expect(new Set(active.map((entry) => entry.total))).toEqual(new Set([5]));
    expect(Math.max(...active.map((entry) => entry.done))).toBe(5);
    // 날짜마다 갱신 — 시작 0 과 완료 5 사이의 중간 값이 실제로 흐른다.
    expect(active.some((entry) => entry.done > 0 && entry.done < 5)).toBe(true);

    await orchestrator.stop();
    ctx.handle.close();
  });
});

describe('BacktestPreparationOrchestrator 자본변동 gap 차단', () => {
  it('최종 유니버스의 관련 연도에 보정 불가 gap이 있으면 COMPLETED preview를 만들지 않는다', async () => {
    let resolveCalls = 0;
    const ctx = makeDeps({
      resolver: {
        // 첫 READY 뒤 final sync가 입력을 바꿔 멤버가 교체되는 경계. gap 검사가 첫
        // 005930만 보면 새 최종 멤버 000660의 결측을 놓친다.
        resolveOrDescribeNeeds: async () => resolveCalls++ === 0
          ? ready(['005930'])
          : ready(['000660']),
        isPeriodCovered: () => true,
      },
      strategies: {
        get: (id: string) => id === INPUT.strategyId ? {
          id,
          version: '1.0.0',
          name: id,
          description: id,
          parameterSchema: { safeParse: (value: unknown) => ({ success: true, data: value }) },
          dataRequirements: { requiresCorporateActions: true },
          initialize: () => ({}),
          onBars: () => ({ orders: [] }),
        } : null,
      },
      actionCoverage: {
        // 실행구간 2026-01-05의 정렬 역투영 범위는 2025년까지 걸친다.
        getCoveredYears: () => new Map([['000660', [2025, 2026]]]),
        getGapYears: () => new Map([['000660', [2025]]]),
      },
    });
    const orchestrator = new BacktestPreparationOrchestrator(ctx.deps as never);

    const job = orchestrator.start(INPUT);
    await waitFor(() => orchestrator.get(job.id)?.status === 'FAILED');

    expect(orchestrator.get(job.id)?.error).toMatch(/보정 비율을 만들 수 없는 연도.*000660/);
    expect(orchestrator.getPreview(job.id)).toBeNull();
    await orchestrator.stop();
    ctx.handle.close();
  });

  it('final sync 뒤 A에서 B로 바뀌면 B 데이터까지 준비하고 일정이 안정된 뒤 완료한다', async () => {
    let resolveCalls = 0;
    const covered = new Map<string, number[]>();
    const syncedSymbols: string[][] = [];
    const ctx = makeDeps({
      resolver: {
        resolveOrDescribeNeeds: async () => resolveCalls++ === 0
          ? ready(['005930'])
          : ready(['000660']),
        isPeriodCovered: () => true,
      },
      strategies: {
        get: (id: string) => id === INPUT.strategyId ? {
          id,
          version: '1.0.0',
          name: id,
          description: id,
          parameterSchema: { safeParse: (value: unknown) => ({ success: true, data: value }) },
          dataRequirements: { requiresCorporateActions: true },
          initialize: () => ({}),
          onBars: () => ({ orders: [] }),
        } : null,
      },
      factSync: {
        sync: async () => ({ savedFacts: 0, gaps: [], stoppedAtSymbol: null, stopReason: null, failureMessage: null }),
        syncCorporateActions: async (request: {
          symbols: readonly string[];
          fromYear: number;
          toYear: number;
        }) => {
          syncedSymbols.push([...request.symbols]);
          for (const symbol of request.symbols) {
            const years: number[] = [];
            for (let year = request.fromYear; year <= request.toYear; year += 1) years.push(year);
            covered.set(symbol, years);
          }
          return { savedFacts: 0, gaps: [], stoppedAtSymbol: null, stopReason: null, failureMessage: null };
        },
      },
      actionCoverage: {
        getCoveredYears: (symbols: readonly string[]) => new Map(
          [...covered].filter(([symbol]) => symbols.includes(symbol)),
        ),
        getGapYears: () => new Map(),
      },
    });
    const orchestrator = new BacktestPreparationOrchestrator(ctx.deps as never);

    const job = orchestrator.start(INPUT);
    await waitFor(() => orchestrator.get(job.id)?.status === 'COMPLETED');

    expect(syncedSymbols).toEqual([['005930'], ['000660']]);
    expect(orchestrator.getPreview(job.id)?.unionSymbols).toEqual(['000660']);
    await orchestrator.stop();
    ctx.handle.close();
  });

  it('final schedule이 계속 진동하면 제한 없이 sync하지 않고 명시적으로 실패한다', async () => {
    let resolveCalls = 0;
    const ctx = makeDeps({
      resolver: {
        resolveOrDescribeNeeds: async () => ready([
          resolveCalls++ % 2 === 0 ? '005930' : '000660',
        ]),
        isPeriodCovered: () => true,
      },
    });
    const orchestrator = new BacktestPreparationOrchestrator(ctx.deps as never);

    const job = orchestrator.start(INPUT);
    await waitFor(() => orchestrator.get(job.id)?.status === 'FAILED');

    expect(orchestrator.get(job.id)?.error).toMatch(/8회 안에 안정되지 않았습니다/);
    expect(resolveCalls).toBe(9);
    await orchestrator.stop();
    ctx.handle.close();
  });
});

describe('BacktestPreparationOrchestrator single-flight와 직렬 실행', () => {
  it('공유 DB의 경쟁 write가 먼저 commit돼도 두 orchestrator는 같은 active id를 반환한다', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qp-prep-race-'));
    const databasePath = path.join(dir, 'app.sqlite');
    const firstHandle = openDatabase(databasePath);
    const secondHandle = openDatabase(databasePath);
    const firstCtx = makeDeps({ database: firstHandle });
    firstCtx.handle.close();
    const secondCtx = makeDeps({ database: secondHandle });
    secondCtx.handle.close();
    const first = new BacktestPreparationOrchestrator(firstCtx.deps as never);
    const second = new BacktestPreparationOrchestrator(secondCtx.deps as never);
    const requestHash = backtestPreparationRequestHash(INPUT, {
      version: '1.0.0',
    } as never);
    const competitorId = 'prep_competing';
    const worker = new Worker(`
      const { parentPort, workerData } = require('node:worker_threads');
      const Database = require('better-sqlite3');
      const db = new Database(workerData.databasePath);
      db.pragma('journal_mode = WAL');
      db.pragma('busy_timeout = 5000');
      db.exec('BEGIN IMMEDIATE');
      parentPort.postMessage('LOCKED');
      setTimeout(() => {
        db.prepare(\`
          INSERT INTO backtest_preparation_jobs
            (id, request_hash, request_json, status, phase, created_at_ms, updated_at_ms)
          VALUES (?, ?, ?, 'RUNNING', 'MARKET_DATA', 1, 1)
        \`).run(workerData.id, workerData.requestHash, workerData.requestJson);
        db.exec('COMMIT');
        db.close();
        parentPort.postMessage('COMMITTED');
      }, 100);
    `, {
      eval: true,
      workerData: { databasePath, id: competitorId, requestHash, requestJson: JSON.stringify(INPUT) },
    });
    await new Promise<void>((resolve, reject) => {
      worker.once('message', (message) => message === 'LOCKED' && resolve());
      worker.once('error', reject);
    });

    const raced = first.start(INPUT);
    await new Promise<void>((resolve, reject) => {
      worker.once('message', (message) => message === 'COMMITTED' && resolve());
      worker.once('error', reject);
    });
    const fromSecondInstance = second.start(INPUT);

    expect(raced.id).toBe(competitorId);
    expect(fromSecondInstance.id).toBe(competitorId);
    expect(firstHandle.db.select().from(backtestPreparationJobs).all()).toHaveLength(1);

    await first.stop();
    await second.stop();
    firstHandle.close();
    secondHandle.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

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
    await orchestrator.stop();
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
    await orchestrator.stop();
    ctx.handle.close();
  });
});

describe('BacktestPreparationOrchestrator 기존 종목 정체성 검증', () => {
  it('표준코드가 없는 기존 단축코드를 자동 병합하지 않는다', async () => {
    let addCalls = 0;
    const ctx = makeDeps({
      symbolService: {
        exists: () => true,
        getRegisteredIdentity: () => ({ code: ENTRY.shortCode, standardCode: null }),
        getRegisteredIdentityByStandardCode: () => null,
        addSymbol: () => { addCalls += 1; },
      },
    });
    const orchestrator = new BacktestPreparationOrchestrator(ctx.deps as never);

    const job = orchestrator.start(INPUT);
    await waitFor(() => orchestrator.get(job.id)?.status === 'FAILED');

    expect(orchestrator.get(job.id)?.error).toMatch(/표준코드가 없는 기존 등록.*자동|정체성을 검증·이관/);
    expect(addCalls).toBe(0);
    await orchestrator.stop();
    ctx.handle.close();
  });

  it('같은 단축코드의 기존 표준코드가 다르면 코드 재사용으로 보고 거부한다', async () => {
    const ctx = makeDeps({
      symbolService: {
        exists: () => true,
        getRegisteredIdentity: () => ({ code: ENTRY.shortCode, standardCode: 'KR7000000000' }),
        getRegisteredIdentityByStandardCode: () => null,
        addSymbol: () => undefined,
      },
    });
    const orchestrator = new BacktestPreparationOrchestrator(ctx.deps as never);

    const job = orchestrator.start(INPUT);
    await waitFor(() => orchestrator.get(job.id)?.status === 'FAILED');

    expect(orchestrator.get(job.id)?.error).toMatch(
      /KR7000000000.*KR7005930003.*다른 증권에 재사용/,
    );
    await orchestrator.stop();
    ctx.handle.close();
  });

  it('등록된 표준코드가 KRX entry와 같으면 기존 행을 재사용한다', async () => {
    let addCalls = 0;
    const ctx = makeDeps({
      symbolService: {
        exists: () => true,
        getRegisteredIdentity: () => ({ code: ENTRY.shortCode, standardCode: ENTRY.standardCode }),
        getRegisteredIdentityByStandardCode: () => ({
          code: ENTRY.shortCode,
          standardCode: ENTRY.standardCode,
        }),
        addSymbol: () => { addCalls += 1; },
      },
    });
    const orchestrator = new BacktestPreparationOrchestrator(ctx.deps as never);

    const job = orchestrator.start(INPUT);
    await waitFor(() => orchestrator.get(job.id)?.status === 'COMPLETED');

    expect(addCalls).toBe(0);
    await orchestrator.stop();
    ctx.handle.close();
  });

  it('같은 표준코드가 다른 단축코드에 등록돼 있으면 raw unique 오류 대신 안전하게 거부한다', async () => {
    let addCalls = 0;
    const ctx = makeDeps({
      symbolService: {
        exists: () => false,
        getRegisteredIdentity: () => null,
        getRegisteredIdentityByStandardCode: () => ({
          code: '000001',
          standardCode: ENTRY.standardCode,
        }),
        addSymbol: () => { addCalls += 1; },
      },
    });
    const orchestrator = new BacktestPreparationOrchestrator(ctx.deps as never);

    const job = orchestrator.start(INPUT);
    await waitFor(() => orchestrator.get(job.id)?.status === 'FAILED');

    expect(orchestrator.get(job.id)?.error).toMatch(/기존 단축코드\(000001\).*005930.*실행을 차단/);
    expect(addCalls).toBe(0);
    await orchestrator.stop();
    ctx.handle.close();
  });

  it('READY 일정 멤버의 identity 원본이 누락되면 조용히 등록을 건너뛰지 않는다', async () => {
    const malformed = { ...ready(), unionEntries: new Map<string, SymbolMasterEntry>() };
    const ctx = makeDeps({
      resolver: {
        resolveOrDescribeNeeds: async () => malformed,
        isPeriodCovered: () => true,
      },
    });
    const orchestrator = new BacktestPreparationOrchestrator(ctx.deps as never);

    const job = orchestrator.start(INPUT);
    await waitFor(() => orchestrator.get(job.id)?.status === 'FAILED');

    expect(orchestrator.get(job.id)?.error).toMatch(/identity 원본.*누락.*실행을 차단/);
    await orchestrator.stop();
    ctx.handle.close();
  });
});

describe('BacktestPreparationOrchestrator recovery와 취소', () => {
  it.each([
    { criterion: 'PER', stage: { criterion: 'PER', limit: 1 } },
    { criterion: 'DECLINE', stage: { criterion: 'DECLINE', limit: 1, lookbackTradingDays: 20 } },
  ] as const)('방향 없는 legacy $criterion 준비 작업을 LOW 방향과 canonical hash로 복구한다', async ({ stage }) => {
    const receivedRules: PreparationInput['universeRule'][] = [];
    const ctx = makeDeps({
      resolver: {
        resolveOrDescribeNeeds: async (rule: PreparationInput['universeRule']) => {
          receivedRules.push(rule);
          return ready();
        },
        isPeriodCovered: () => true,
      },
    });
    const legacyInput = {
      ...INPUT,
      universeRule: { ...INPUT.universeRule, stages: [stage] },
    };
    const canonicalInput: PreparationInput = {
      ...INPUT,
      universeRule: {
        ...INPUT.universeRule,
        stages: [{ ...stage, direction: 'LOW' }],
      },
    };
    const expectedHash = backtestPreparationRequestHash(canonicalInput, { version: '1.0.0' });
    ctx.handle.db.insert(backtestPreparationJobs).values({
      id: `prep_legacy_${stage.criterion}`,
      requestHash: 'legacy-directionless-hash',
      requestJson: JSON.stringify(legacyInput),
      status: 'RUNNING',
      phase: 'MARKET_DATA',
      doneSymbols: 0,
      totalSymbols: 0,
      savedFacts: 0,
      gapCount: 0,
      dartCallsUsed: 0,
      cancelRequested: false,
      createdAtMs: 1,
      updatedAtMs: 1,
    }).run();
    const orchestrator = new BacktestPreparationOrchestrator(ctx.deps as never);

    orchestrator.recoverOrphaned();

    await waitFor(() => orchestrator.get(`prep_legacy_${stage.criterion}`)?.status === 'COMPLETED');
    expect(receivedRules).not.toHaveLength(0);
    for (const rule of receivedRules) {
      expect(rule.stages[0]?.direction).toBe('LOW');
    }
    const row = ctx.handle.db.select().from(backtestPreparationJobs)
      .where(eq(backtestPreparationJobs.id, `prep_legacy_${stage.criterion}`))
      .get();
    expect(row?.requestHash).toBe(expectedHash);

    await orchestrator.stop();
    ctx.handle.close();
  });

  it('stop은 진행 중인 DART symbol 저장 경계까지 기다리고 RUNNING 복구점을 남긴다', async () => {
    const symbolStarted = deferred<void>();
    const finishSymbol = deferred<void>();
    const events: string[] = [];
    const ctx = makeDeps({
      resolver: {
        resolveOrDescribeNeeds: async () => ({
          kind: 'NEEDS_DATA',
          candidateScopeKnown: true,
          unionEntries: candidateEntries(['005930']),
          needs: {
            factSymbols: ['005930'], actionSymbols: [], priceSymbols: [],
            selectionMetricDates: [], priceRange: null,
          },
        }),
        isPeriodCovered: () => true,
      },
      factSync: {
        sync: async (_request: unknown, hooks: {
          onSymbolDone?: (progress: { index: number; total: number }) => void;
          shouldStop?: () => boolean;
        }) => {
          symbolStarted.resolve();
          await finishSymbol.promise;
          events.push('symbol-saved');
          hooks.onSymbolDone?.({ index: 1, total: 1 });
          return {
            savedFacts: 1,
            gaps: [],
            stoppedAtSymbol: hooks.shouldStop?.() ? '005930' : null,
            stopReason: hooks.shouldStop?.() ? 'CANCELLED' : null,
            failureMessage: null,
          };
        },
        syncCorporateActions: async () => ({ savedFacts: 0, gaps: [], stoppedAtSymbol: null, stopReason: null, failureMessage: null }),
      },
    });
    const orchestrator = new BacktestPreparationOrchestrator(ctx.deps as never);
    const job = orchestrator.start(INPUT);
    await symbolStarted.promise;

    let stopResolved = false;
    const stopping = Promise.resolve(orchestrator.stop()).then(() => {
      stopResolved = true;
      events.push('stop-resolved');
    });
    await Promise.resolve();
    const resolvedBeforeSymbolBoundary = stopResolved;
    finishSymbol.resolve();
    await stopping;
    await waitFor(() => events.includes('symbol-saved'));

    expect(resolvedBeforeSymbolBoundary).toBe(false);
    expect(events).toEqual(['symbol-saved', 'stop-resolved']);
    expect(orchestrator.get(job.id)?.status).toBe('RUNNING');
    expect(orchestrator.get(job.id)?.doneSymbols).toBe(1);

    ctx.handle.close();
    events.push('db-closed');
    await Promise.resolve();
    expect(events).toEqual(['symbol-saved', 'stop-resolved', 'db-closed']);
  });

  it('RUNNING은 QUEUED로 회수하고 미래 quota wait는 그대로 두며 만기 wait만 QUEUED로 회수한다', async () => {
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
    await orchestrator.stop();
    ctx.handle.close();
  });

  it('취소는 현재 symbol 저장 완료 뒤 CANCELLED가 되고 반복 취소도 성공한다', async () => {
    const savedOne = deferred<void>();
    const continueAfterCancel = deferred<void>();
    const ctx = makeDeps({
      resolver: {
        resolveOrDescribeNeeds: async () => ({
          kind: 'NEEDS_DATA',
          candidateScopeKnown: true,
          unionEntries: candidateEntries(['005930', '000660']),
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
    await orchestrator.stop();
    ctx.handle.close();
  });
});

describe('BacktestPreparationOrchestrator quota resume와 terminal 결과', () => {
  it('KRX 한도 다음 날 완료 날짜는 재요청하지 않고 실패한 날짜부터 자동 재개한다', async () => {
    const coveredDates = new Set<string>();
    const physicalRequests: string[] = [];
    let quotaReached = false;
    const marketNeeds = {
      kind: 'NEEDS_DATA' as const,
      candidateScopeKnown: true,
      unionEntries: candidateEntries(['005930']),
      needs: {
        factSymbols: [],
        actionSymbols: [],
        priceSymbols: [],
        selectionMetricDates: ['2026-01-05', '2026-01-06'],
        priceRange: null,
      },
    };
    const ctx = makeDeps({
      resolver: {
        resolveOrDescribeNeeds: async () => coveredDates.size === 2 ? ready() : marketNeeds,
        isPeriodCovered: () => coveredDates.size === 2,
      },
      symbolMaster: {
        ensureTradingDay: async (date: string) => {
          // 실물 SymbolMasterService.ingestDate와 같은 coverage gate: 재개 시 orchestrator가
          // 날짜를 다시 순회해도 이미 닫힌 날짜에는 물리 KRX 요청이 나가지 않는다.
          if (coveredDates.has(date)) {
            return { effectiveTradingDate: date, ingestedDates: [] };
          }
          physicalRequests.push(date);
          if (date === '2026-01-06' && !quotaReached) {
            quotaReached = true;
            throw new KrxQuotaError();
          }
          coveredDates.add(date);
          return { effectiveTradingDate: date, ingestedDates: [date] };
        },
        ensureSelectionMetrics: async () => undefined,
        ingestDate: async () => ({ kind: 'ALREADY_COVERED' as const }),
      },
    });
    const orchestrator = new BacktestPreparationOrchestrator(ctx.deps as never);
    const job = orchestrator.start(INPUT);

    await waitFor(() => orchestrator.get(job.id)?.status === 'WAITING_DAILY_QUOTA');
    expect(orchestrator.get(job.id)).toMatchObject({
      phase: 'MARKET_DATA',
      doneSymbols: 1,
      totalSymbols: 2,
      nextResumeAtMs: Date.parse('2026-01-05T15:00:00.000Z'),
    });
    expect(physicalRequests).toEqual(['2026-01-05', '2026-01-06']);

    ctx.setNow(Date.parse('2026-01-05T15:00:00.000Z'));
    orchestrator.recoverOrphaned();
    await waitFor(() => orchestrator.get(job.id)?.status === 'COMPLETED');

    // 01-05는 coverage로 건너뛰고, quota 응답 때문에 완료되지 않은 01-06만 재요청한다.
    expect(physicalRequests).toEqual(['2026-01-05', '2026-01-06', '2026-01-06']);
    await orchestrator.stop();
    ctx.handle.close();
  });

  it('진행 중인 KRX 요청에서 한도 오류가 나도 먼저 요청된 취소를 대기로 덮지 않는다', async () => {
    const requestStarted = deferred<void>();
    const finishRequest = deferred<void>();
    const ctx = makeDeps({
      resolver: {
        resolveOrDescribeNeeds: async () => MARKET_ONLY_NEEDS,
        isPeriodCovered: () => false,
      },
      symbolMaster: {
        ensureTradingDay: async () => {
          requestStarted.resolve();
          await finishRequest.promise;
          throw new KrxQuotaError();
        },
        ensureSelectionMetrics: async () => undefined,
        ingestDate: async () => ({ kind: 'ALREADY_COVERED' as const }),
      },
    });
    const orchestrator = new BacktestPreparationOrchestrator(ctx.deps as never);
    const job = orchestrator.start(INPUT);
    await requestStarted.promise;

    expect(orchestrator.cancel(job.id)).toBe(true);
    expect(orchestrator.get(job.id)?.status).toBe('RUNNING');
    finishRequest.resolve();
    await waitFor(() => orchestrator.get(job.id)?.status === 'CANCELLED');

    expect(orchestrator.get(job.id)).toMatchObject({
      status: 'CANCELLED',
      nextResumeAtMs: null,
      error: '사용자가 준비 작업을 취소했습니다.',
    });
    await orchestrator.stop();
    ctx.handle.close();
  });

  it('DART 공급자가 먼저 한도 초과를 반환해도 WAITING 상태와 영속 알림 신호를 남긴다', async () => {
    const quotaReports: string[] = [];
    const ctx = makeDeps({
      resolver: {
        resolveOrDescribeNeeds: async () => ({
          kind: 'NEEDS_DATA',
          candidateScopeKnown: true,
          unionEntries: candidateEntries(['005930']),
          needs: {
            factSymbols: ['005930'],
            actionSymbols: [],
            priceSymbols: [],
            selectionMetricDates: [],
            priceRange: null,
          },
        }),
        isPeriodCovered: () => true,
      },
      factSync: {
        sync: async () => ({
          savedFacts: 3,
          gaps: [],
          stoppedAtSymbol: '005930',
          stopReason: 'DAILY_QUOTA',
          failureMessage: 'DART 실제 응답으로 호출 한도를 확인했습니다.',
        }),
        syncCorporateActions: async () => ({ savedFacts: 0, gaps: [], stoppedAtSymbol: null, stopReason: null, failureMessage: null }),
      },
      externalApiUsage: {
        recordCall: () => 0,
        callsUsed: () => 0,
        maxCallsUsed: () => 0,
        quotaExceeded: () => false,
        reportQuotaExceeded: (_api: string, _scope: string, message: string) => {
          quotaReports.push(message);
          return true;
        },
      },
    });
    const orchestrator = new BacktestPreparationOrchestrator(ctx.deps as never);
    const job = orchestrator.start(INPUT);

    await waitFor(() => orchestrator.get(job.id)?.status === 'WAITING_DAILY_QUOTA');
    const waiting = orchestrator.get(job.id);
    expect(waiting?.error).toContain('실제 응답');
    expect(waiting?.savedFacts).toBe(3);
    expect(waiting?.nextResumeAtMs).toBe(Date.parse('2026-01-05T15:00:00.000Z'));
    expect(quotaReports).toEqual(['DART 실제 응답으로 호출 한도를 확인했습니다.']);

    await orchestrator.stop();
    ctx.handle.close();
  });

  it('KST 다음 자정까지 기다렸다가 INCREMENTAL로 완료된 현재연도 symbol-year를 반복하지 않는다', async () => {
    const completedSymbols = new Set<string>();
    const requestedSymbols: string[] = [];
    const modes: string[] = [];
    const ctx = makeDeps({
      dartDailyCallLimit: 1,
      resolver: {
        resolveOrDescribeNeeds: async () => completedSymbols.size === 2 ? ready() : ({
          kind: 'NEEDS_DATA',
          candidateScopeKnown: true,
          unionEntries: candidateEntries(['005930', '000660']),
          needs: { factSymbols: ['005930', '000660'], actionSymbols: [], priceSymbols: [], selectionMetricDates: [], priceRange: null },
        }),
        isPeriodCovered: () => true,
      },
      factSync: {
        sync: async (
          request: { symbols: readonly string[]; mode: string },
          hooks: {
            beforeDartRequest?: () => string;
            onSymbolDone?: (progress: { index: number; total: number }) => void;
          },
        ) => {
          modes.push(request.mode);
          for (const [index, symbol] of request.symbols.entries()) {
            // 실물 INCREMENTAL 은 coverage 로 닫힌 symbol-year 를 건너뛴다 (공시 갱신이
            // 없는 한) — 이 가짜는 그 성질만 모델링한다
            if (completedSymbols.has(symbol) && request.mode === 'INCREMENTAL') {
              hooks.onSymbolDone?.({ index: index + 1, total: request.symbols.length });
              continue;
            }
            const decision = hooks.beforeDartRequest?.();
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
    await orchestrator.stop();
    ctx.handle.close();
  });

  it('모든 rebalance entry가 비면 한국어 원인으로 FAILED에 수렴한다', async () => {
    const ctx = makeDeps({ resolver: { resolveOrDescribeNeeds: async () => ready([]), isPeriodCovered: () => true } });

    const orchestrator = new BacktestPreparationOrchestrator(ctx.deps as never);
    const job = orchestrator.start(INPUT);

    await waitFor(() => orchestrator.get(job.id)?.status === 'FAILED');

    expect(orchestrator.get(job.id)?.error).toMatch(/선정된 종목|유니버스/);
    await orchestrator.stop();
    ctx.handle.close();
  });

  it('공시 목록 실패로 FactSync가 ERROR를 반환하면 준비 잡도 FAILED가 된다', async () => {
    const ctx = makeDeps({
      resolver: {
        resolveOrDescribeNeeds: async () => ({
          kind: 'NEEDS_DATA',
          candidateScopeKnown: true,
          unionEntries: candidateEntries(['005930']),
          needs: {
            factSymbols: ['005930'],
            actionSymbols: [],
            priceSymbols: [],
            selectionMetricDates: [],
            priceRange: null,
          },
        }),
        isPeriodCovered: () => true,
      },
      factSync: {
        sync: async () => ({
          savedFacts: 0,
          gaps: [],
          stoppedAtSymbol: '005930',
          stopReason: 'ERROR',
          failureMessage: '정기공시 목록 조회 실패',
        }),
        syncCorporateActions: async () => ({ savedFacts: 0, gaps: [], stoppedAtSymbol: null, stopReason: null, failureMessage: null }),
      },
    });
    const orchestrator = new BacktestPreparationOrchestrator(ctx.deps as never);
    const job = orchestrator.start(INPUT);

    await waitFor(() => orchestrator.get(job.id)?.status === 'FAILED');
    expect(orchestrator.get(job.id)?.error).toContain('정기공시 목록 조회 실패');
    await orchestrator.stop();
    ctx.handle.close();
  });
});
