import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { BacktestRequest } from '../../src/shared/schemas/backtest-request.js';
import { CORPORATE_ACTION_FIELD } from '../../src/server/modules/facts/domain/fact.js';
import type {
  FactIngestionResult,
  FactSource,
  FetchFinancialsRequest,
} from '../../src/server/modules/facts/application/ports.js';
import type { FactSyncService } from '../../src/server/modules/facts/application/fact-sync-service.js';
import { createTestAdmin, createTestApp, type TestApp } from '../helpers/test-app.js';
import { registerSymbols, seedDailyBars } from '../helpers/seed.js';
import { seedSymbolMasterUniverse } from '../helpers/symbol-master-seed.js';

/**
 * `FactSyncService` 의 `source` 는 private 필드다.
 * `symbol-info-fallback.test.ts` 의 `injectFakeStockInfoSource` 와 같은 방식으로
 * 실제 DART 호출 없이 서비스를 태운다.
 * 컨테이너가 조립한 `factSyncService` 인스턴스는 그대로 두고 내부 소스만 바꿔치기한다.
 */
function injectFakeFactSource(factSyncService: FactSyncService, source: FactSource): void {
  (factSyncService as unknown as { source: FactSource }).source = source;
}

/**
 * 종목 하나(하나의 fetchCorporateActions 호출)마다 테스트가 통제하는 게이트에서
 * 멈추는 가짜 소스다.
 * 취소·동시성 테스트는 "이 종목까지는 저장되고 다음은 시작도 안 했다" 는 시점을
 * 정확히 짚어야 한다.
 * 그래서 실제 시간 대기 대신 수동으로 여는 게이트를 쓴다.
 */
function gatedCorporateActionSource(): {
  source: FactSource;
  calls: string[];
  /** 가장 먼저 대기 중인 호출을 하나 연다. 대기 중인 호출이 없으면 아무 일도 하지 않는다 */
  release(): void;
} {
  const calls: string[] = [];
  const pending: Array<() => void> = [];
  const source: FactSource = {
    fetchFinancials: () => Promise.resolve({ facts: [], gaps: [] }),
    fetchCorporateActions: (request: FetchFinancialsRequest): Promise<FactIngestionResult> => {
      const symbol = request.symbols[0]!;
      calls.push(symbol);
      return new Promise<FactIngestionResult>((resolve) => {
        pending.push(() =>
          resolve({
            facts: request.years.map((year) => ({
              scope: 'SYMBOL',
              key: symbol,
              field: CORPORATE_ACTION_FIELD,
              periodKey: `${year}-01-05`,
              asOfTsMs: 1,
              value: 2,
              unit: 'RATIO',
            })),
            gaps: [],
          }),
        );
      });
    },
  };
  return {
    source,
    calls,
    release: () => pending.shift()?.(),
  };
}

async function waitFor(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timeout');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const JOBS_URL = '/api/v1/facts/corporate-action-sync-jobs';

describe('자본변동 수집 잡 (Task 7)', () => {
  let ctx: TestApp;
  let cookie: string;

  beforeEach(async () => {
    ctx = await createTestApp();
    const { username, password } = await createTestAdmin(ctx.container);
    const login = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username, password },
    });
    cookie = login.cookies.find((c) => c.name === 'qp_session')!.value;
  });

  afterEach(async () => {
    await ctx.close();
  });

  it('계획만 미리 본다 — 잡을 만들지 않는다 (Task 8)', async () => {
    registerSymbols(ctx.container, 'KR', ['005930', '000660']);

    const previewed = await ctx.app.inject({
      method: 'POST',
      url: `${JOBS_URL.replace('-sync-jobs', '-sync-plan')}`,
      cookies: { qp_session: cookie },
      payload: { symbols: ['005930', '000660'], fromYear: 2020, toYear: 2022 },
    });
    expect(previewed.statusCode).toBe(200);
    const body = previewed.json() as { calls: number; estimatedMs: number; overDailyLimit: boolean };
    // 첫 수집(커버리지 없음)이므로 종목당 3년×1 + 4개 shareYears×4 = 19, 2종목 38
    expect(body.calls).toBe(38);
    expect(body.estimatedMs).toBe(38 * 120);
    expect(body.overDailyLimit).toBe(false);

    // 잡을 만들지 않았으니 실제 수집을 시작해도 409 가 아니어야 한다
    const fake = gatedCorporateActionSource();
    injectFakeFactSource(ctx.container.factSyncService, fake.source);
    const created = await ctx.app.inject({
      method: 'POST',
      url: JOBS_URL,
      cookies: { qp_session: cookie },
      payload: { symbols: ['005930'], fromYear: 2020, toYear: 2022 },
    });
    expect(created.statusCode).toBe(201);
    const jobId = (created.json().job as { id: string }).id;

    // 뒷정리 — 잡을 끝내 다음 테스트에 영향이 남지 않게 한다
    fake.release();
    await waitFor(() =>
      ctx.container.corporateActionSyncOrchestrator.isTerminal(
        ctx.container.corporateActionSyncOrchestrator.getJob(jobId)?.status ?? '',
      ),
    );
  });

  it('연도 범위가 잘못되면 계획 미리보기도 400 이다', async () => {
    const previewed = await ctx.app.inject({
      method: 'POST',
      url: `${JOBS_URL.replace('-sync-jobs', '-sync-plan')}`,
      cookies: { qp_session: cookie },
      payload: { symbols: ['005930'], fromYear: 2022, toYear: 2020 },
    });
    expect(previewed.statusCode).toBe(400);
  });

  it('잡을 만들고 진행률을 준다', async () => {
    registerSymbols(ctx.container, 'KR', ['005930', '000660']);
    const fake = gatedCorporateActionSource();
    injectFakeFactSource(ctx.container.factSyncService, fake.source);

    const created = await ctx.app.inject({
      method: 'POST',
      url: JOBS_URL,
      cookies: { qp_session: cookie },
      payload: { symbols: ['005930', '000660'], fromYear: 2026, toYear: 2026 },
    });
    expect(created.statusCode).toBe(201);
    const job = created.json().job as { id: string; status: string; totalSymbols: number; doneSymbols: number };
    expect(job.totalSymbols).toBe(2);
    expect(job.doneSymbols).toBe(0);
    // run() 은 첫 await 전까지 동기로 진행되므로 응답 시점에 이미 RUNNING 이다 —
    // 잡이 뒤에서 실제로 돌기 시작했다는 뜻이다 (QUEUED 로 멈춰 있지 않는다).
    expect(job.status).toBe('RUNNING');

    // 첫 종목이 아직 안 끝났으므로 조회도 진행 없음을 보고한다
    const mid = await ctx.app.inject({
      method: 'GET',
      url: `${JOBS_URL}/${job.id}`,
      cookies: { qp_session: cookie },
    });
    expect((mid.json().job as { doneSymbols: number }).doneSymbols).toBe(0);

    fake.release(); // 005930 완료
    await waitFor(() => {
      const row = ctx.container.corporateActionSyncOrchestrator.getJob(job.id);
      return row !== null && row.doneSymbols === 1;
    });
    const afterFirst = ctx.container.corporateActionSyncOrchestrator.getJob(job.id)!;
    expect(afterFirst.status).toBe('RUNNING');
    expect(afterFirst.doneSymbols).toBe(1);

    fake.release(); // 000660 완료
    await waitFor(() => ctx.container.corporateActionSyncOrchestrator.getJob(job.id)?.status === 'COMPLETED');

    const finished = ctx.container.corporateActionSyncOrchestrator.getJob(job.id)!;
    expect(finished.doneSymbols).toBe(2);
    expect(finished.savedFacts).toBe(2);
    expect(finished.gapCount).toBe(0);
    expect(finished.completedAtMs).not.toBeNull();

    // SSE — 이미 종료된 작업은 스냅샷 1건 후 종료한다 (백테스트 이벤트와 같은 계약)
    const events = await ctx.app.inject({
      method: 'GET',
      url: `${JOBS_URL}/${job.id}/events`,
      cookies: { qp_session: cookie },
    });
    expect(events.headers['content-type']).toContain('text/event-stream');
    expect(events.payload).toContain('"status":"COMPLETED"');
  });

  it('취소하면 그 지점까지 저장된 커버리지가 남는다', async () => {
    registerSymbols(ctx.container, 'KR', ['005930', '000660']);
    const fake = gatedCorporateActionSource();
    injectFakeFactSource(ctx.container.factSyncService, fake.source);

    const created = await ctx.app.inject({
      method: 'POST',
      url: JOBS_URL,
      cookies: { qp_session: cookie },
      payload: { symbols: ['005930', '000660'], fromYear: 2026, toYear: 2026 },
    });
    const jobId = (created.json().job as { id: string }).id;

    const cancelled = await ctx.app.inject({
      method: 'POST',
      url: `${JOBS_URL}/${jobId}/cancel`,
      cookies: { qp_session: cookie },
    });
    expect(cancelled.statusCode).toBe(200);
    expect((cancelled.json() as { status: string }).status).toBe('CANCELLING');

    // 005930 은 이미 게이트에 걸려 대기 중이었다 — 취소 신호는 "다음 종목 시작 전"
    // 경계에서만 확인하므로 진행 중인 이 종목은 끝까지 처리되고 저장된다.
    fake.release();
    await waitFor(() => ctx.container.corporateActionSyncOrchestrator.getJob(jobId)?.status === 'CANCELLED');

    const finished = ctx.container.corporateActionSyncOrchestrator.getJob(jobId)!;
    expect(finished.doneSymbols).toBe(1);
    expect(finished.error).toContain('취소');

    // 000660 은 시작조차 하지 않았다 — fetchCorporateActions 가 두 번째로 불리지 않았다
    expect(fake.calls).toEqual(['005930']);

    const covered = ctx.container.actionCoverageStore.getCoveredYears(['005930', '000660']);
    expect(covered.get('005930')).toEqual([2026]);
    expect(covered.get('000660')).toBeUndefined();
  });

  it('동시에 두 잡을 만들지 않는다', async () => {
    registerSymbols(ctx.container, 'KR', ['005930']);
    const fake = gatedCorporateActionSource();
    injectFakeFactSource(ctx.container.factSyncService, fake.source);

    const first = await ctx.app.inject({
      method: 'POST',
      url: JOBS_URL,
      cookies: { qp_session: cookie },
      payload: { symbols: ['005930'], fromYear: 2026, toYear: 2026 },
    });
    expect(first.statusCode).toBe(201);
    const firstId = (first.json().job as { id: string }).id;
    // 아직 게이트에 걸려 실행 중이다
    expect(ctx.container.corporateActionSyncOrchestrator.getJob(firstId)?.status).toBe('RUNNING');

    const second = await ctx.app.inject({
      method: 'POST',
      url: JOBS_URL,
      cookies: { qp_session: cookie },
      payload: { symbols: ['005930'], fromYear: 2026, toYear: 2026 },
    });
    expect(second.statusCode).toBe(409);
    expect((second.json() as { error: string }).error).toContain('실행 중');

    // 뒷정리 — 게이트를 열어 첫 잡을 끝내고 종료 상태로 만든다 (테스트 간 누수 방지)
    fake.release();
    await waitFor(() => ctx.container.corporateActionSyncOrchestrator.isTerminal(
      ctx.container.corporateActionSyncOrchestrator.getJob(firstId)?.status ?? '',
    ));
  });

  it('끝나면 커버리지가 늘어 게이트가 통과한다', async () => {
    const date = '2026-01-05';
    const CODE = '900050';

    ctx.container.symbolService.addSymbol(CODE, 'KR', '게이트테스트');
    seedSymbolMasterUniverse(ctx.container, [date], [
      {
        standardCode: 'KR7900050006',
        shortCode: CODE,
        name: '게이트테스트',
        market: 'KOSPI',
        marketCapKrw: '500000000000000',
      },
    ]);
    seedDailyBars(ctx.container.database.db, [
      {
        symbol: CODE,
        market: 'KR',
        timeframe: '1d',
        tsMs: Date.UTC(2026, 0, 5),
        open: 1_000,
        high: 1_100,
        low: 900,
        close: 1_050,
        volume: 12_345,
      },
    ]);

    const buildRequest = (): BacktestRequest => ({
      strategyId: 'range-breakout',
      parameters: {
        lookbackBars: 10,
        atrPeriod: 5,
        stopAtrMultiplier: 2,
        takeProfitAtrMultiplier: 3,
        riskPerTradePercent: 2,
      },
      universeRule: { markets: ['KOSPI'], topN: 1, sortKey: 'MKTCAP' },
      period: { from: date, to: date },
      capital: { initialCash: 10_000_000, currency: 'KRW' },
      execution: {
        fillTiming: 'NEXT_BAR_OPEN',
        commissionProfileId: 'kr-equity-default',
        slippageProfileId: 'fixed-5bps',
      },
      risk: { maxPositions: 1 },
      randomSeed: 42,
    });

    // 자본변동을 한 번도 수집하지 않은 상태 — 제출 게이트(Task 6)가 400 으로 막는다
    const blocked = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/backtests',
      cookies: { qp_session: cookie },
      payload: buildRequest(),
    });
    expect(blocked.statusCode).toBe(400);

    const fake = gatedCorporateActionSource();
    injectFakeFactSource(ctx.container.factSyncService, fake.source);

    const created = await ctx.app.inject({
      method: 'POST',
      url: JOBS_URL,
      cookies: { qp_session: cookie },
      payload: { symbols: [CODE], fromYear: 2026, toYear: 2026 },
    });
    const jobId = (created.json().job as { id: string }).id;

    fake.release();
    await waitFor(() => ctx.container.corporateActionSyncOrchestrator.getJob(jobId)?.status === 'COMPLETED');

    expect(ctx.container.actionCoverageStore.getCoveredYears([CODE]).get(CODE)).toEqual([2026]);

    const allowed = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/backtests',
      cookies: { qp_session: cookie },
      payload: buildRequest(),
    });
    expect(allowed.statusCode).toBe(201);
  });
});
