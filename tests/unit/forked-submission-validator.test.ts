import { EventEmitter } from 'node:events';
import { fork, type ChildProcess } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import { test as appTest } from '../helpers/test-fixtures.js';
import { ForkedSubmissionValidator } from '../../src/server/modules/backtest/infrastructure/forked-submission-validator.js';
import { createSubmissionValidator, type SubmissionValidationInput } from '../../src/server/modules/backtest/application/submission-validation.js';
import { datasetIdentity } from '../../src/runtime/shared/db/database-layout.js';
import { registerSymbols } from '../helpers/seed.js';
import { seedSymbolMasterUniverse } from '../helpers/symbol-master-seed.js';
import { krxDailyBars } from '../../src/runtime/shared/db/schema.js';
import { PreparationReferenceError } from '../../src/server/modules/backtest/application/preparation-reference-service.js';

const input: SubmissionValidationInput = {
  body: {
    strategyId: 'range-breakout', parameters: { lookbackBars: 10, atrPeriod: 5, stopAtrMultiplier: 2, takeProfitAtrMultiplier: 3, riskPerTradePercent: 2 },
    universeRule: { markets: ['KOSPI'], stages: [{ criterion: 'MARKET_CAP', direction: 'HIGH', limit: 1 }], rebalanceInterval: { value: 1, unit: 'MONTH' } },
    period: { from: '2026-01-05', to: '2026-01-06' }, capital: { initialCash: 10_000_000, currency: 'KRW' },
    execution: { fillTiming: 'NEXT_BAR_OPEN', commissionProfileId: 'kr-equity-default', slippageProfileId: 'fixed-5bps' }, risk: { maxPositions: 5 }, randomSeed: 42,
  },
  preview: { schedule: [{ rebalanceDate: '2026-01-05', effectiveDate: '2026-01-05', fromTsMs: Date.UTC(2026, 0, 5), members: [{ symbol: '005930', standardCode: 'KR7005930003', marketCapKrw: '1000000', volume: null, tradingValueKrw: null }], excludedNonTradingCount: 0 }], diagnostics: [], stages: [], unionSymbols: ['005930'], scheduleHash: '', uncoveredDates: [], periodCovered: true, missingCandleSymbols: [], warnings: [] },
  snapshot: { datasetId: 'test', revision: 0 }, maxBars: 1_000_000, nowMs: Date.UTC(2026, 8, 24),
};
const output = { ok: false as const, status: 400 as const, errors: ['검증 오류'] };
class FakeChild extends EventEmitter {
  readonly send = vi.fn();
  readonly kill = vi.fn(() => true);
}
function harness(options: { maxPending?: number; timeoutMs?: number } = {}) {
  const children: FakeChild[] = [];
  const forkProcess = vi.fn(() => {
    const child = new FakeChild(); children.push(child); return child as unknown as ChildProcess;
  });
  const validator = new ForkedSubmissionValidator('/tmp/operations.sqlite', '/tmp/data.sqlite', { ...options, memoryBudget: () => 192 * 1024 * 1024, forkProcess: forkProcess as typeof fork });
  return { children, validator };
}

describe('제출 검증 프로세스 수명', () => {
  it('동시 프로세스 하나와 대기 상한을 지키고 close 전 다음 작업을 시작하지 않는다', async () => {
    const h = harness({ maxPending: 2 });
    const first = h.validator.validate(input);
    const second = h.validator.validate(input);
    await expect(h.validator.validate(input)).rejects.toMatchObject({ statusCode: 429 });
    await vi.waitFor(() => expect(h.children).toHaveLength(1));
    h.children[0]!.emit('message', { type: 'completed', output });
    await Promise.resolve();
    expect(h.children).toHaveLength(1);
    h.children[0]!.emit('close', 0);
    await expect(first).resolves.toEqual(output);
    await vi.waitFor(() => expect(h.children).toHaveLength(2));
    h.children[1]!.emit('message', { type: 'completed', output }); h.children[1]!.emit('close', 0);
    await expect(second).resolves.toEqual(output);
    await h.validator.stop();
  });

  it('실행 및 대기 요청 취소 후 결과를 사용하지 않고 자식을 회수한다', async () => {
    const h = harness(); const running = new AbortController(); const queued = new AbortController();
    const first = h.validator.validate(input, running.signal).catch((error: unknown) => error);
    const second = h.validator.validate(input, queued.signal).catch((error: unknown) => error);
    await vi.waitFor(() => expect(h.children).toHaveLength(1));
    queued.abort(); running.abort();
    expect(await first).toMatchObject({ statusCode: 503 });
    expect(await second).toMatchObject({ statusCode: 503 });
    expect(h.children[0]!.kill).toHaveBeenCalledWith('SIGTERM');
    h.children[0]!.emit('message', { type: 'completed', output }); h.children[0]!.emit('close', 0);
    await h.validator.stop();
    expect(h.children).toHaveLength(1);
  });

  it('시간 초과를 반환하고 실제 종료까지 stop을 기다린다', async () => {
    const h = harness({ timeoutMs: 10 });
    const completion = h.validator.validate(input).catch((error: unknown) => error);
    await vi.waitFor(() => expect(h.children[0]?.kill).toHaveBeenCalledWith('SIGTERM'));
    let stopped = false; const stop = h.validator.stop().then(() => { stopped = true; });
    await Promise.resolve(); expect(stopped).toBe(false);
    h.children[0]!.emit('close', null);
    expect(await completion).toMatchObject({ statusCode: 503 }); await stop;
  });

  it('자원이 부족하면 프로세스를 만들지 않는다', async () => {
    const spawn = vi.fn();
    const validator = new ForkedSubmissionValidator('', '', { memoryBudget: () => 0, forkProcess: spawn });
    await expect(validator.validate(input)).rejects.toMatchObject({ statusCode: 507 });
    expect(spawn).not.toHaveBeenCalled(); await validator.stop();
  });
});

appTest('실제 읽기 전용 worker 결과는 같은 검증과 일치하고 변경된 revision은 거부한다', async ({ ctx }) => {
  const c = ctx.container;
  registerSymbols(c, 'KR', ['005930']);
  seedSymbolMasterUniverse(c, ['2026-01-05', '2026-01-06'], [{ standardCode: 'KR7005930003', shortCode: '005930', name: '삼성전자', market: 'KOSPI', marketCapKrw: '1000000' }]);
  c.database.db.insert(krxDailyBars).values(['2026-01-05', '2026-01-06'].map((date) => ({ shortCode: '005930', date, market: 'KOSPI', open: 100, high: 110, low: 90, close: 105, volume: 100 }))).run();
  const request = { ...input, snapshot: datasetIdentity(c.database.sqlite) };
  const direct = await createSubmissionValidator({ database: c.database, clock: { now: () => input.nowMs }, strategies: c.strategyRegistry, symbolService: c.symbolService, symbolMaster: c.symbolMasterService, candleCoverage: c.candleCoverageService, factCoverage: c.factCoverageStore, financialFacts: c.financialFactAvailabilityService, facts: c.factRepository, maxBacktestBars: () => input.maxBars }).validate(request.body, request.preview);
  expect(direct, JSON.stringify(direct)).toMatchObject({ ok: true });
  const validator = new ForkedSubmissionValidator(c.config.databasePath, c.database.dataPath, { memoryBudget: () => 192 * 1024 * 1024 });
  try {
    await expect(validator.validate(request)).resolves.toEqual(direct);
    expect(datasetIdentity(c.database.sqlite)).toEqual(request.snapshot);
    c.database.sqlite.prepare("UPDATE krx_daily_bars SET close = 106 WHERE date = '2026-01-06'").run();
    await expect(validator.validate(request)).rejects.toBeInstanceOf(PreparationReferenceError);
    if (direct.ok) {
      expect(() => c.jobQueue.enqueue(request.body, direct.resolved.schedule, direct.universe, direct.provenancePin, [], undefined, { submissionSnapshot: direct.snapshot })).toThrow(PreparationReferenceError);
      expect(c.jobQueue.countByStatus(['QUEUED'])).toBe(0);
    }
  } finally { await validator.stop(); }
});

appTest('자식의 긴 동기 SQL 동안에도 상태 HTTP 응답은 1초 안에 돌아온다', async ({ ctx }) => {
  let signalStarted!: () => void;
  const started = new Promise<void>((resolve) => { signalStarted = resolve; });
  const validator = new ForkedSubmissionValidator(ctx.container.config.databasePath, ctx.container.database.dataPath, {
    memoryBudget: () => 192 * 1024 * 1024,
    forkProcess: ((file, args, options) => {
      const child = fork(file, args, { ...options, execArgv: [...options!.execArgv!, '--import', new URL('../fixtures/slow-submission-preload.mjs', import.meta.url).href] });
      child.on('message', (message: { type: string }) => { if (message.type === 'test.sql.started') signalStarted(); });
      return child;
    }) as typeof fork,
  });
  const completion = validator.validate({ ...input, snapshot: datasetIdentity(ctx.container.database.sqlite) });
  try {
    await started;
    const before = performance.now();
    const response = await ctx.app.inject('/api/v1/health/ready');
    expect(response.statusCode).toBe(200);
    expect(performance.now() - before).toBeLessThan(1000);
    await completion;
  } finally { await validator.stop(); }
});
