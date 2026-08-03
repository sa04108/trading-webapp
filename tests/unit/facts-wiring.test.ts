import { describe, expect, it } from 'vitest';
import {
  createFactsPhase,
  createFactsSyncEstimator,
  type FactSyncPort,
} from '../../src/server/bootstrap/facts-wiring.js';
import type {
  FactSyncHooks,
  FactSyncReport,
  FactSyncRequest,
} from '../../src/server/modules/facts/application/fact-sync-service.js';
import {
  DART_MIN_INTERVAL_MS,
  planFactSync,
} from '../../src/server/modules/facts/domain/sync-plan.js';
import type { FactIngestionGap } from '../../src/server/modules/facts/application/ports.js';
import type { FactYearRangeCoverageRow } from '../../src/server/modules/market-data/domain/fact-year-range.js';
import type { Market } from '../../src/server/modules/market-data/domain/candle.js';

/** 2026-07-08 21:00 KST — currentYear = 2026 */
const CLOCK = { now: () => Date.UTC(2026, 6, 8, 12, 0) };

function gaps(count: number): FactIngestionGap[] {
  return Array.from({ length: count }, (_, i) => ({
    symbol: '005930',
    periodKey: `2026Q${i + 1}`,
    reason: '계정 없음',
  }));
}

function report(overrides: Partial<FactSyncReport> = {}): FactSyncReport {
  return {
    savedFacts: 0,
    gaps: [],
    stoppedAtSymbol: null,
    stopReason: null,
    failureMessage: null,
    ...overrides,
  };
}

/**
 * `onSymbolDone` 을 종목마다 한 번씩 부르는 fake. **종목 단위** 값을 넘긴다 —
 * 실제 `FactSyncService` 와 같은 계약이다 (`이 종목에서 저장된 팩트 수`).
 */
class FakeFactSyncService implements FactSyncPort {
  readonly requests: FactSyncRequest[] = [];
  readonly hooks: FactSyncHooks[] = [];

  constructor(
    private readonly perSymbol: readonly { savedFacts: number; gapCount: number }[],
    private readonly result: FactSyncReport,
  ) {}

  async sync(request: FactSyncRequest, hooks: FactSyncHooks = {}): Promise<FactSyncReport> {
    this.requests.push(request);
    this.hooks.push(hooks);
    for (const [index, symbol] of this.perSymbol.entries()) {
      hooks.onSymbolDone?.({
        symbol: `sym-${index}`,
        index: index + 1,
        total: this.perSymbol.length,
        savedFacts: symbol.savedFacts,
        gapCount: symbol.gapCount,
      });
    }
    return this.result;
  }
}

interface Progress {
  symbolsDone: number;
  symbolTotal: number;
  savedFacts: number;
  gapCount: number;
}

async function runPhase(
  perSymbol: readonly { savedFacts: number; gapCount: number }[],
  result = report(),
  symbols: readonly string[] = ['005930', '000660', '035420'],
) {
  const factSyncService = new FakeFactSyncService(perSymbol, result);
  const phase = createFactsPhase({ factSyncService });
  const progress: Progress[] = [];
  const phaseResult = await phase({
    codes: symbols,
    fromYear: 2019,
    toYear: 2026,
    onProgress: (p) => progress.push({ ...p }),
    shouldStop: () => false,
  });
  return { progress, phaseResult, factSyncService };
}

describe('createFactsPhase', () => {
  it('종목 단위 진행을 누적으로 바꿔 넘긴다 — 5, 0, 7 이 5 → 5 → 12 로 나간다', async () => {
    // FactPhaseProgress 는 누적, FactSyncProgress 는 종목 단위다. 필드를 1:1 로 옮기면
    // (둘 다 number 라 타입으로는 잡히지 않는다) 카운터가 종목마다 0 으로 주저앉는다.
    const { progress } = await runPhase([
      { savedFacts: 5, gapCount: 1 },
      { savedFacts: 0, gapCount: 0 },
      { savedFacts: 7, gapCount: 2 },
    ]);

    expect(progress.map((p) => p.savedFacts)).toEqual([5, 5, 12]);
    expect(progress.map((p) => p.gapCount)).toEqual([1, 1, 3]);
  });


  it('symbolsDone 은 1부터, symbolTotal 은 요청에 실어 보낸 종목 목록의 길이다', async () => {
    const symbols = ['005930', '000660', '035420'];
    const { progress, factSyncService } = await runPhase(
      [
        { savedFacts: 1, gapCount: 0 },
        { savedFacts: 1, gapCount: 0 },
        { savedFacts: 1, gapCount: 0 },
      ],
      report(),
      symbols,
    );

    expect(progress.map((p) => p.symbolsDone)).toEqual([1, 2, 3]);
    expect(progress.map((p) => p.symbolTotal)).toEqual([3, 3, 3]);
    // 같은 목록이어야 한다 — 따로 세면 화면의 분모가 실제 수집 대상과 어긋난다
    expect(factSyncService.requests[0]!.symbols).toEqual(symbols);
    expect(progress[0]!.symbolTotal).toBe(factSyncService.requests[0]!.symbols.length);
  });

  it('반환 gapCount 는 누적기가 아니라 report.gaps.length 다', async () => {
    // 누적기는 3 이지만 리포트는 5건을 들고 있다 — 리포트가 권위 있는 총계다
    const { phaseResult, progress } = await runPhase(
      [
        { savedFacts: 1, gapCount: 1 },
        { savedFacts: 2, gapCount: 0 },
        { savedFacts: 3, gapCount: 2 },
      ],
      report({ savedFacts: 6, gaps: gaps(5) }),
    );

    expect(progress.at(-1)!.gapCount).toBe(3);
    expect(phaseResult.gapCount).toBe(5);
    expect(phaseResult.savedFacts).toBe(6);
  });

  it('중단 신호와 사유를 리포트에서 그대로 옮긴다', async () => {
    const { phaseResult } = await runPhase(
      [{ savedFacts: 1, gapCount: 0 }],
      report({ savedFacts: 1, stoppedAtSymbol: '000660', stopReason: 'CANCELLED', failureMessage: '취소됨' }),
    );

    expect(phaseResult.stopReason).toBe('CANCELLED');
    expect(phaseResult.failureMessage).toBe('취소됨');
  });

  it('웹 경로는 증분이다 — mode INCREMENTAL·consolidated 로 요청한다', async () => {
    const { factSyncService } = await runPhase([{ savedFacts: 1, gapCount: 0 }]);
    const request = factSyncService.requests[0]!;

    expect(request.mode).toBe('INCREMENTAL');
    expect(request.consolidated).toBe(true);
    expect(request.fromYear).toBe(2019);
    expect(request.toYear).toBe(2026);
  });

  it('취소 신호를 hooks.shouldStop 으로 잇는다', async () => {
    const factSyncService = new FakeFactSyncService([], report());
    const phase = createFactsPhase({ factSyncService });
    let stop = false;
    await phase({
      codes: ['005930'],
      fromYear: 2026,
      toYear: 2026,
      onProgress: () => {},
      shouldStop: () => stop,
    });

    expect(factSyncService.hooks[0]!.shouldStop!()).toBe(false);
    stop = true;
    expect(factSyncService.hooks[0]!.shouldStop!()).toBe(true);
  });
});

function coverageRow(
  firstTsMs: number,
  lastTsMs: number,
  barCount = 100,
): Omit<FactYearRangeCoverageRow, 'symbol'> & { code: string } {
  // 커버리지 행의 종목 필드는 code 다 — 추정 경로가 symbol 로 되매핑해 넘긴다
  return { code: '005930', firstTsMs, lastTsMs, barCount };
}

function makeEstimator(options: {
  dartApiKey?: string | null;
  symbols?: ReadonlyArray<{ code: string; market: Market }>;
  coverage?: ReadonlyArray<Omit<FactYearRangeCoverageRow, 'symbol'> & { code: string }>;
  covered?: ReadonlyMap<string, readonly number[]>;
}) {
  return createFactsSyncEstimator({
    dartApiKey: options.dartApiKey === undefined ? 'key' : options.dartApiKey,
    symbolService: {
      listSymbols: () => options.symbols ?? [{ code: '005930', market: 'KR' as const }],
      getCoverage: () => options.coverage ?? [],
    },
    factCoverageStore: { getCoveredYears: () => options.covered ?? new Map() },
    clock: CLOCK,
  });
}

describe('createFactsSyncEstimator', () => {
  it('DART 키가 없으면 UNSUPPORTED 다', () => {
    expect(makeEstimator({ dartApiKey: null })(['005930'])).toEqual({
      basis: 'UNSUPPORTED',
      reason: 'DART 인증키가 설정되지 않아 재무를 수집할 수 없습니다.',
    });
  });

  it('등록되지 않은 종목은 UNSUPPORTED 다', () => {
    expect(makeEstimator({ symbols: [] })(['005930'])).toEqual({
      basis: 'UNSUPPORTED',
      reason: '등록되지 않은 종목입니다.',
    });
  });

  it('KR 이 아닌 시장은 UNSUPPORTED 다 — DART 는 국내 공시만 담는다', () => {
    expect(makeEstimator({ symbols: [{ code: '005930', market: 'US' }] })(['005930'])).toEqual({
      basis: 'UNSUPPORTED',
      reason: '재무 데이터 수집은 국내(KR) 종목만 지원합니다 — 005930 는 대상이 아닙니다.',
    });
  });

  it('봉이 없어 연도 범위가 안 나오면 AFTER_CANDLES 다', () => {
    // 커버리지가 비었거나 barCount 0 이면 deriveFactYearRange 가 null 을 준다
    expect(makeEstimator({ coverage: [] })(['005930'])).toEqual({ basis: 'AFTER_CANDLES' });
    expect(makeEstimator({ coverage: [coverageRow(1, 2, 0)] })(['005930'])).toEqual({
      basis: 'AFTER_CANDLES',
    });
  });

  it('PLANNED 는 planFactSync 의 calls·estimatedMs 를 그대로 싣는다 (불연속 증분)', () => {
    // 2019–2026 요청, 2021–2025 는 이미 받았다 → 대상 연도 [2019, 2020, 2026] 로
    // 갈라진다. 앵커는 연속 구간마다 붙으므로 2개(2018, 2025)다:
    //   3연도 × 9 = 27, 앵커 2 × 4 = 8 → 35 호출.
    // 종목당 상수로 재계산했다면 3 × 9 + 4 = 31 이 나온다 — 이 테스트가 그것을 막는다.
    const symbols = ['005930'];
    const covered = new Map([['005930', [2021, 2022, 2023, 2024, 2025]]]);
    const estimate = makeEstimator({
      symbols: [{ code: '005930', market: 'KR' }],
      coverage: [coverageRow(Date.UTC(2019, 5, 1), Date.UTC(2026, 5, 1))],
      covered,
    })(['005930']);

    expect(estimate).toEqual({
      basis: 'PLANNED',
      fromYear: 2019,
      toYear: 2026,
      calls: 35,
      estimatedMs: 35 * DART_MIN_INTERVAL_MS,
      overDailyLimit: false,
    });

    // 같은 인자로 부른 planFactSync 와 한 글자도 다르지 않아야 한다 — 추정 경로가
    // 계획 함수를 우회해 자기 산수를 하기 시작하면 여기서 깨진다
    const plan = planFactSync({
      symbols,
      fromYear: 2019,
      toYear: 2026,
      currentYear: 2026,
      coveredBySymbol: covered,
      mode: 'INCREMENTAL',
    });
    expect(estimate).toMatchObject({ calls: plan.calls, estimatedMs: plan.estimatedMs });
  });

  it('일 한도를 넘기면 overDailyLimit 을 그대로 전달한다', () => {
    // 200종목 × 12년 백필 ≈ 22,400 호출은 한도 아래다 — 한도를 넘기려면 더 넓어야 한다
    const symbols = Array.from({ length: 500 }, (_, i) => `S${String(i).padStart(5, '0')}`);
    // 추정도 같은 500종목을 받아야 한도 초과가 재현된다 — 종목 수가 곧 호출 수다
    const estimate = makeEstimator({
      symbols: symbols.map((code) => ({ code, market: 'KR' as const })),
      coverage: [coverageRow(Date.UTC(2015, 5, 1), Date.UTC(2026, 5, 1))],
    })(symbols);

    const plan = planFactSync({
      symbols,
      fromYear: 2015,
      toYear: 2026,
      currentYear: 2026,
      coveredBySymbol: new Map(),
      mode: 'INCREMENTAL',
    });
    expect(plan.overDailyLimit).toBe(true);
    expect(estimate).toMatchObject({ basis: 'PLANNED', overDailyLimit: true, calls: plan.calls });
  });

  it('연도 범위는 거래소 현지 시각으로 자른다 — KST 1월 1일 개장 봉이 전년으로 밀리지 않는다', () => {
    // 2020-01-01 09:00 KST = 2019-12-31 24:00 UTC. UTC 로 자르면 2019 가 된다.
    const estimate = makeEstimator({
      coverage: [coverageRow(Date.UTC(2020, 0, 1, 0, 0), Date.UTC(2026, 5, 1))],
    })(['005930']);

    expect(estimate).toMatchObject({ basis: 'PLANNED', fromYear: 2020 });
  });
});
