import { describe, expect, it } from 'vitest';
import type { CorporateActionCoverageStore } from '../../src/server/modules/facts/application/corporate-action-coverage.js';
import type { FactCoverageStore } from '../../src/server/modules/facts/application/fact-coverage-store.js';
import {
  FactSyncService,
  factsFingerprint,
  type FactSyncRequest,
} from '../../src/server/modules/facts/application/fact-sync-service.js';
import {
  DartQuotaError,
  FactSourceNotConfiguredError,
  type SymbolVersionBumper,
  type FactIngestionResult,
  type FactRepository,
  type FactSource,
  type FetchFinancialsRequest,
  type PeriodicFiling,
} from '../../src/server/modules/facts/application/ports.js';
import { CORPORATE_ACTION_FIELD, type Fact } from '../../src/server/modules/facts/domain/fact.js';

const LOGGER = { debug() {}, info() {}, warn() {}, error() {} } as never;
const CLOCK = { now: () => 1_700_000_000_000 };

/** 기록을 메모리에 쌓는 가짜 이력 저장소 */
function fakeCoverage(
  initial: ReadonlyMap<string, readonly number[]> = new Map(),
  initialUpdatedAtMs: ReadonlyMap<string, number> = new Map(),
): FactCoverageStore & {
  added: Array<{ symbol: string; years: readonly number[] }>;
  results: Array<{
    symbol: string;
    years: readonly number[];
    gaps: readonly import('../../src/server/modules/facts/application/ports.js').FactIngestionGap[];
  }>;
  processedReceiptNos: Set<string>;
} {
  const store = new Map<string, number[]>(
    [...initial].map(([symbol, years]) => [symbol, [...years]]),
  );
  const updatedAt = new Map<string, number>(initialUpdatedAtMs);
  // 실물(SqliteFactCoverageStore)처럼, 이력이 있는 종목은 watermark 도 있다
  for (const symbol of store.keys()) {
    if (!updatedAt.has(symbol)) updatedAt.set(symbol, 0);
  }
  const added: Array<{ symbol: string; years: readonly number[] }> = [];
  const results: Array<{
    symbol: string;
    years: readonly number[];
    gaps: readonly import('../../src/server/modules/facts/application/ports.js').FactIngestionGap[];
  }> = [];
  const processedReceiptNos = new Set<string>();
  const add = (symbol: string, years: readonly number[], nowMs: number): void => {
    if (years.length === 0) return;
    added.push({ symbol, years: [...years] });
    updatedAt.set(symbol, nowMs);
    store.set(
      symbol,
      [...new Set([...(store.get(symbol) ?? []), ...years])].sort((a, b) => a - b),
    );
  };
  return {
    added,
    results,
    processedReceiptNos,
    getCoveredYears: () => new Map([...store].map(([symbol, years]) => [symbol, [...years]])),
    getCoverageState: () => new Map([...store].map(([symbol, years]) => [symbol, {
      verifiedYears: [...years],
      blockingGapYears: results
        .filter((result) => result.symbol === symbol)
        .flatMap((result) => result.years.filter((year) => result.gaps.some(
          (gap) => gap.severity === 'BLOCKING'
            && (!/^\d{4}/.test(gap.periodKey) || Number(gap.periodKey.slice(0, 4)) === year),
        ))),
      blockingGapDetails: [],
    }])),
    getUpdatedAtMs: (codes) =>
      new Map([...updatedAt].filter(([symbol]) => codes.includes(symbol))),
    getProcessedFilingReceiptNos: (receiptNos) =>
      new Set(receiptNos.filter((receiptNo) => processedReceiptNos.has(receiptNo))),
    addProcessedFilings: (filings) => {
      for (const filing of filings) processedReceiptNos.add(filing.receiptNo);
    },
    addCoveredYears: add,
    addCoverageResult: (symbol, years, gaps, nowMs) => {
      results.push({ symbol, years: [...years], gaps: [...gaps] });
      add(symbol, years, nowMs);
    },
  };
}

/** 자본변동 커버리지와 독립 watermark를 메모리에 쌓는 가짜 저장소. */
function fakeActionCoverage(): CorporateActionCoverageStore {
  const covered = new Map<string, number[]>();
  const gaps = new Map<string, number[]>();
  const updatedAt = new Map<string, number>();
  const merge = (store: Map<string, number[]>, symbol: string, years: readonly number[]): void => {
    if (years.length === 0) return;
    store.set(
      symbol,
      [...new Set([...(store.get(symbol) ?? []), ...years])].sort((a, b) => a - b),
    );
  };
  const add = (
    store: Map<string, number[]>,
    symbol: string,
    years: readonly number[],
    nowMs: number,
  ): void => {
    merge(store, symbol, years);
    if (years.length > 0) updatedAt.set(symbol, nowMs);
  };
  return {
    getCoveredYears: () => new Map([...covered].map(([symbol, years]) => [symbol, [...years]])),
    getGapYears: () => new Map([...gaps].map(([symbol, years]) => [symbol, [...years]])),
    getUpdatedAtMs: (codes) =>
      new Map([...updatedAt].filter(([symbol]) => codes.includes(symbol))),
    addCoveredYears: (symbol, years, nowMs) => add(covered, symbol, years, nowMs),
    addGapYears: (symbol, years, nowMs) => add(gaps, symbol, years, nowMs),
    addCoverageResult: (symbol, coveredYears, gapYears, nowMs) => {
      merge(covered, symbol, coveredYears);
      const completed = new Set(coveredYears);
      const retained = (gaps.get(symbol) ?? []).filter((year) => !completed.has(year));
      if (retained.length > 0) gaps.set(symbol, retained);
      else gaps.delete(symbol);
      merge(gaps, symbol, gapYears);
      if (coveredYears.length > 0) updatedAt.set(symbol, nowMs);
    },
  };
}

/** fetchFinancials 와 fetchCorporateActions 호출 횟수를 각각 세는 가짜 소스 —
 *  자본변동 전용 경로가 재무를 부르지 않는지는 두 횟수를 따로 봐야 확인할 수 있다. */
function fakeSourceWithCounts(): FactSource & { financialsCalls: number; actionsCalls: number } {
  const result = {
    financialsCalls: 0,
    actionsCalls: 0,
    fetchFinancials: async (): Promise<FactIngestionResult> => {
      result.financialsCalls += 1;
      return { facts: [], gaps: [] };
    },
    fetchCorporateActions: async (): Promise<FactIngestionResult> => {
      result.actionsCalls += 1;
      return { facts: [], gaps: [] };
    },
    listRecentPeriodicFilings: async () => [],
  };
  return result;
}

/** 요청을 기록하는 가짜 소스 — 어떤 연도를 요청했는지 확인한다 */
function recordingSource(): FactSource & { requests: FetchFinancialsRequest[] } {
  const requests: FetchFinancialsRequest[] = [];
  return {
    requests,
    fetchFinancials: async (request) => {
      requests.push(request);
      return { facts: [], gaps: [] };
    },
    fetchCorporateActions: async (request) => {
      requests.push(request);
      return { facts: [], gaps: [] };
    },
    listRecentPeriodicFilings: async () => [],
  };
}

/** bumpVersion 호출을 기록하는 가짜 포트 */
function fakeVersions(): SymbolVersionBumper & {
  bumps: Array<{ code: string; slice: string; seed: string; nowMs: number }>;
} {
  const bumps: Array<{ code: string; slice: string; seed: string; nowMs: number }> = [];
  return {
    bumps,
    bumpVersion: (code, slice, seed, nowMs) => {
      bumps.push({ code, slice, seed, nowMs });
    },
  };
}

function fact(field: string, value: number): Fact {
  return {
    scope: 'SYMBOL',
    key: '005930',
    field,
    periodKey: '2025Q1',
    asOfTsMs: 1,
    value,
    unit: 'KRW',
  };
}

/**
 * ports.ts 는 `FactIngestionResult.gaps` 라는 이름이 파서(ParsedFinancials.gaps)와
 * 어댑터 경계를 넘나들며 그대로 이어져야 한다고 경고한다 — 필드 이름이 하나라도
 * 어긋나면 이 서비스가 조용히 빈 배열을 합치게 된다. 그 계약을 이 테스트가 지킨다:
 * 두 소스 각각의 facts/gaps 가 합쳐진 결과에 실제로 도달하는지 직접 확인한다.
 */
function fakeSource(
  financials: FactIngestionResult,
  actions: FactIngestionResult,
): FactSource {
  return {
    fetchFinancials: (_request: FetchFinancialsRequest) => Promise.resolve(financials),
    fetchCorporateActions: (_request: FetchFinancialsRequest) => Promise.resolve(actions),
    listRecentPeriodicFilings: () => Promise.resolve([]),
  };
}

/**
 * 인메모리 저장소. `getFacts` 가 늘 빈 배열을 주는 스텁으로는 "저장된 내용이 실제로
 * 바뀌었는가" 를 판정하는 버전 승격 경로를 검증할 수 없으므로, SQLite repository와
 * 같은 병합 키((key, field, periodKey, asOf) 가 같으면 뒤에 온 것이 이긴다)로 실제
 * 상태를 들고 있는 가짜를 쓴다.
 */
function fakeRepository(): FactRepository & {
  saved: Array<{ facts: readonly Fact[] }>;
} {
  const saved: Array<{ facts: readonly Fact[] }> = [];
  const store = new Map<string, Map<string, Fact>>();
  return {
    saved,
    getFacts: async (query) => {
      // 종목 파티션 — keys 를 주면 그 종목만, 없으면 스코프 전체
      const out: Fact[] = [];
      for (const [key, partition] of store) {
        const [scope, code] = key.split(':');
        if (scope !== query.scope) continue;
        if (query.keys !== undefined && !query.keys.includes(code!)) continue;
        out.push(...partition.values());
      }
      return out;
    },
    saveFacts: async (facts) => {
      if (facts.length === 0) return;
      saved.push({ facts });
      for (const fact of facts) {
        const partitionKey = `${fact.scope}:${fact.key}`;
        const partition = store.get(partitionKey) ?? new Map<string, Fact>();
        partition.set(
          JSON.stringify([fact.key, fact.field, fact.periodKey, fact.asOfTsMs]),
          fact,
        );
        store.set(partitionKey, partition);
      }
    },
    replaceSymbolFinancialFactsForYear: async (symbol, year, facts) => {
      const partitionKey = `SYMBOL:${symbol}`;
      const partition = store.get(partitionKey) ?? new Map<string, Fact>();
      for (const [key, existing] of partition) {
        if (
          existing.field !== CORPORATE_ACTION_FIELD
          && existing.periodKey.startsWith(String(year))
        ) partition.delete(key);
      }
      saved.push({ facts });
      for (const fact of facts) {
        partition.set(
          JSON.stringify([fact.key, fact.field, fact.periodKey, fact.asOfTsMs]),
          fact,
        );
      }
      store.set(partitionKey, partition);
    },
    replaceSymbolCorporateActionFactsForYear: async (symbol, year, facts) => {
      const partitionKey = `SYMBOL:${symbol}`;
      const partition = store.get(partitionKey) ?? new Map<string, Fact>();
      for (const [key, existing] of partition) {
        if (
          existing.field === CORPORATE_ACTION_FIELD
          && existing.periodKey.startsWith(String(year))
        ) partition.delete(key);
      }
      saved.push({ facts });
      for (const fact of facts) {
        partition.set(
          JSON.stringify([fact.key, fact.field, fact.periodKey, fact.asOfTsMs]),
          fact,
        );
      }
      store.set(partitionKey, partition);
    },
  };
}

describe('factsFingerprint', () => {
  it('자본변동 절대 주식수가 바뀌면 데이터셋 버전 지문도 바뀐다', () => {
    const base = {
      ...fact('SPLIT_RATIO', 5),
      corporateActionBeforeShares: 10,
      corporateActionAfterShares: 50,
    };
    const changed = { ...base, corporateActionBeforeShares: 11 };

    expect(factsFingerprint([base])).not.toBe(factsFingerprint([changed]));
  });
});

describe('FactSyncService', () => {
  it('두 소스의 gap 합집합이 리포트에 도달한다', async () => {
    const financials: FactIngestionResult = {
      facts: [fact('CURRENT_ASSETS', 1)],
      gaps: [{
        symbol: '005930', periodKey: '2025Q1', reason: '재무 gap', severity: 'BLOCKING',
      }],
    };
    const actions: FactIngestionResult = {
      facts: [fact('SPLIT_RATIO', 2)],
      gaps: [{
        symbol: '005930', periodKey: '2025-03-14', reason: '자본변동 gap', severity: 'BLOCKING',
      }],
    };
    const repository = fakeRepository();
    const service = new FactSyncService(
      fakeSource(financials, actions),
      repository,
      LOGGER,
      fakeVersions(),
      CLOCK,
      fakeCoverage(),
      fakeActionCoverage(),
    );

    const report = await service.sync({
      symbols: ['005930'],
      fromYear: 2025,
      toYear: 2025,
      consolidated: true,
      mode: 'FULL',
    });

    expect(report.gaps).toHaveLength(2);
    expect(report.gaps.map((gap) => gap.reason).sort()).toEqual(['자본변동 gap', '재무 gap'].sort());
  });

  it('재무 snapshot 교체와 자본변동 저장을 각 경계로 나눈다', async () => {
    const financials: FactIngestionResult = { facts: [fact('CURRENT_ASSETS', 1)], gaps: [] };
    const actions: FactIngestionResult = { facts: [fact('SPLIT_RATIO', 2)], gaps: [] };
    const repository = fakeRepository();
    const service = new FactSyncService(
      fakeSource(financials, actions),
      repository,
      LOGGER,
      fakeVersions(),
      CLOCK,
      fakeCoverage(),
      fakeActionCoverage(),
    );

    const report = await service.sync({
      symbols: ['005930'],
      fromYear: 2025,
      toYear: 2025,
      consolidated: true,
      mode: 'FULL',
    });

    expect(report.savedFacts).toBe(2);
    expect(repository.saved).toHaveLength(2);
    expect(repository.saved.map((entry) => entry.facts.map((fact) => fact.field))).toEqual([
      ['CURRENT_ASSETS'],
      ['SPLIT_RATIO'],
    ]);
  });

  it('양쪽 소스 모두 비어 있으면 저장도 gap 도 0건이다', async () => {
    const empty: FactIngestionResult = { facts: [], gaps: [] };
    const repository = fakeRepository();
    const service = new FactSyncService(
      fakeSource(empty, empty),
      repository,
      LOGGER,
      fakeVersions(),
      CLOCK,
      fakeCoverage(),
      fakeActionCoverage(),
    );

    const report = await service.sync({
      symbols: ['005930'],
      fromYear: 2025,
      toYear: 2025,
      consolidated: true,
      mode: 'FULL',
    });

    expect(report.savedFacts).toBe(0);
    expect(report.gaps).toHaveLength(0);
    expect(repository.saved).toHaveLength(2);
    expect(repository.saved.every((entry) => entry.facts.length === 0)).toBe(true);
  });

  /**
   * `sync` 는 자본변동도 같이 받는다 — 그 사실을 자본변동 커버리지에도 남겨야
   * `syncCorporateActions` 가 이미 받은 연도를 재무 없이 다시 청구하지 않는다.
   */
  it('재무와 자본변동 커버리지를 모두 갱신한다', async () => {
    const financials: FactIngestionResult = { facts: [fact('CURRENT_ASSETS', 1)], gaps: [] };
    const actions: FactIngestionResult = { facts: [fact('SPLIT_RATIO', 2)], gaps: [] };
    const financialCoverage = fakeCoverage();
    const actionCoverage = fakeActionCoverage();
    const service = new FactSyncService(
      fakeSource(financials, actions),
      fakeRepository(),
      LOGGER,
      fakeVersions(),
      CLOCK,
      financialCoverage,
      actionCoverage,
    );

    await service.sync({
      symbols: ['005930'],
      fromYear: 2025,
      toYear: 2025,
      consolidated: true,
      mode: 'FULL',
    });

    expect(financialCoverage.getCoveredYears().get('005930')).toEqual([2025]);
    expect(actionCoverage.getCoveredYears().get('005930')).toEqual([2025]);
  });

  /**
   * 자본변동 커버리지의 gap 연도는 자본변동 자신의 gap 에서만 뽑는다.
   * 재무 gap 을 섞으면 엉뚱한 연도가 자본변동 커버리지에 남는다.
   */
  it('재무 gap 은 자본변동 커버리지에 섞이지 않는다', async () => {
    const financials: FactIngestionResult = {
      facts: [],
      gaps: [{
        symbol: '005930', periodKey: '2020Q1', reason: '재무 gap', severity: 'BLOCKING',
      }],
    };
    const actions: FactIngestionResult = {
      facts: [],
      gaps: [{
        symbol: '005930', periodKey: '2025-03-14', reason: '자본변동 gap', severity: 'BLOCKING',
      }],
    };
    const actionCoverage = fakeActionCoverage();
    const service = new FactSyncService(
      fakeSource(financials, actions),
      fakeRepository(),
      LOGGER,
      fakeVersions(),
      CLOCK,
      fakeCoverage(),
      actionCoverage,
    );

    await service.sync({
      symbols: ['005930'],
      fromYear: 2025,
      toYear: 2025,
      consolidated: true,
      mode: 'FULL',
    });

    expect(actionCoverage.getGapYears().get('005930')).toEqual([2025]);
  });

  it('현재 연도 재무 snapshot만 교체하고 전년도 주식수 앵커는 저장하지 않는다', async () => {
    const repository = fakeRepository();
    await repository.saveFacts([
      fact('CURRENT_ASSETS', 1),
      { ...fact('SHARES_OUTSTANDING', 90), periodKey: '2024Q4', unit: 'SHARES' },
    ]);
    repository.saved.length = 0;
    const financials: FactIngestionResult = {
      facts: [
        { ...fact('SHARES_OUTSTANDING', 100), periodKey: '2024Q4', unit: 'SHARES' },
        fact('NET_INCOME', 10),
      ],
      gaps: [],
    };
    const service = new FactSyncService(
      fakeSource(financials, { facts: [], gaps: [] }),
      repository,
      LOGGER,
      fakeVersions(),
      CLOCK,
      fakeCoverage(),
      fakeActionCoverage(),
    );

    const report = await service.sync({
      symbols: ['005930'], fromYear: 2025, toYear: 2025, consolidated: true, mode: 'FULL',
    });
    const stored = await repository.getFacts({ scope: 'SYMBOL', keys: ['005930'] });

    expect(report.savedFacts).toBe(1);
    expect(stored.map((row) => `${row.field}:${row.periodKey}:${row.value}`).sort()).toEqual([
      'NET_INCOME:2025Q1:10',
      'SHARES_OUTSTANDING:2024Q4:90',
    ]);
  });

  it('현재 연도의 재무 gap과 severity를 coverage manifest에 전달한다', async () => {
    const coverage = fakeCoverage();
    const financials: FactIngestionResult = {
      facts: [],
      gaps: [
        { symbol: '005930', periodKey: '2024Q4', reason: '앵커 정보', severity: 'BLOCKING' },
        { symbol: '005930', periodKey: '2025Q1', reason: '파서 실패', severity: 'BLOCKING' },
        {
          symbol: '005930', periodKey: '2025Q1', reason: '미사용 계정',
          severity: 'INFORMATIONAL',
        },
      ],
    };
    const service = new FactSyncService(
      fakeSource(financials, { facts: [], gaps: [] }),
      fakeRepository(),
      LOGGER,
      fakeVersions(),
      CLOCK,
      coverage,
      fakeActionCoverage(),
    );

    await service.sync({
      symbols: ['005930'], fromYear: 2025, toYear: 2025, consolidated: true, mode: 'FULL',
    });

    expect(coverage.results[0]?.gaps.map((gap) => gap.reason)).toEqual([
      '파서 실패', '미사용 계정',
    ]);
    expect(coverage.getCoverageState().get('005930')?.blockingGapYears).toEqual([2025]);
  });

  it('재무 소스가 요청·앵커 연도 밖 팩트를 반환하면 저장과 coverage를 모두 중단한다', async () => {
    const repository = fakeRepository();
    const coverage = fakeCoverage();
    const service = new FactSyncService(
      fakeSource(
        { facts: [{ ...fact('NET_INCOME', 1), periodKey: '2023Q4' }], gaps: [] },
        { facts: [], gaps: [] },
      ),
      repository,
      LOGGER,
      fakeVersions(),
      CLOCK,
      coverage,
      fakeActionCoverage(),
    );

    const report = await service.sync({
      symbols: ['005930'], fromYear: 2025, toYear: 2025, consolidated: true, mode: 'FULL',
    });

    expect(report.stopReason).toBe('ERROR');
    expect(report.failureMessage).toContain('재무 응답이 요청 범위를 벗어났습니다');
    expect(await repository.getFacts({ scope: 'SYMBOL' })).toEqual([]);
    expect(coverage.getCoveredYears().size).toBe(0);
  });

  it('자본변동 소스가 일반 재무 팩트를 반환하면 저장과 coverage를 모두 중단한다', async () => {
    const repository = fakeRepository();
    const actionCoverage = fakeActionCoverage();
    const service = new FactSyncService(
      fakeSource({ facts: [], gaps: [] }, { facts: [fact('NET_INCOME', 1)], gaps: [] }),
      repository,
      LOGGER,
      fakeVersions(),
      CLOCK,
      fakeCoverage(),
      actionCoverage,
    );

    const report = await service.syncCorporateActions({
      symbols: ['005930'], fromYear: 2025, toYear: 2025, consolidated: true, mode: 'FULL',
    });

    expect(report.stopReason).toBe('ERROR');
    expect(report.failureMessage).toContain('자본변동 응답이 요청 범위를 벗어났습니다');
    expect(await repository.getFacts({ scope: 'SYMBOL' })).toEqual([]);
    expect(actionCoverage.getCoveredYears().size).toBe(0);
  });
});

/**
 * 200종목 × 12년 백필은 종목·연도당 12회 + 앵커 4회 ≈ 29,600 호출(일 한도 40,000)에
 * rate limiter 로 최소 59분이다. 전 종목을 모아 마지막에 한 번 저장하면 180번째 종목의
 * 오류 하나가 앞선 179종목을 통째로 버린다. 아래 테스트가 그 경로를 막는다.
 */
describe('FactSyncService — 종목 단위 저장과 부분 실패 (긴 백필 생존)', () => {
  const request: FactSyncRequest = {
    symbols: ['005930', '000660', '035720'],
    fromYear: 2025,
    toYear: 2025,
    consolidated: true,
    mode: 'FULL',
  };

  function symbolFact(symbol: string): Fact {
    return {
      scope: 'SYMBOL',
      key: symbol,
      field: 'CURRENT_ASSETS',
      periodKey: '2025Q1',
      asOfTsMs: 1,
      value: 1,
      unit: 'KRW',
    };
  }

  /** 지정한 종목에서 던지는 소스. 그 앞 종목들은 정상 응답한다 */
  function sourceFailingAt(failSymbol: string, calls: string[]): FactSource {
    const respond = (symbols: readonly string[]): Promise<FactIngestionResult> => {
      const symbol = symbols[0] as string;
      calls.push(symbol);
      if (symbol === failSymbol) {
        return Promise.reject(new Error('DART 응답 오류 020: 요청 제한을 초과하였습니다.'));
      }
      return Promise.resolve({ facts: [symbolFact(symbol)], gaps: [] });
    };
    return {
      fetchFinancials: (req) => respond(req.symbols),
      // 자본변동은 이 테스트의 관심사가 아니다 — 항상 비어 있다
      fetchCorporateActions: () => Promise.resolve({ facts: [], gaps: [] }),
      listRecentPeriodicFilings: () => Promise.resolve([]),
    };
  }

  it('종목마다 따로 저장한다 — 한 번에 모아 저장하지 않는다', async () => {
    const repository = fakeRepository();
    const service = new FactSyncService(
      sourceFailingAt('없음', []),
      repository,
      LOGGER,
      fakeVersions(),
      CLOCK,
      fakeCoverage(),
      fakeActionCoverage(),
    );
    await service.sync(request);
    expect(repository.saved).toHaveLength(6);
    expect(repository.saved.map((entry) => entry.facts[0]?.key)).toEqual([
      '005930',
      undefined,
      '000660',
      undefined,
      '035720',
      undefined,
    ]);
  });

  it('소스가 중간에 던지면 앞선 종목의 팩트는 저장된 채로 남고 멈춘 지점을 보고한다', async () => {
    const repository = fakeRepository();
    const versions = fakeVersions();
    const calls: string[] = [];
    const service = new FactSyncService(
      sourceFailingAt('000660', calls),
      repository,
      LOGGER,
      versions,
      CLOCK,
      fakeCoverage(),
      fakeActionCoverage(),
    );

    // 던지지 않는다 — 리포트로 되돌려야 CLI 가 어디까지 갔는지 말할 수 있다
    const report = await service.sync(request);

    // 첫 종목은 저장됐다
    const stored = await repository.getFacts({ scope: 'SYMBOL' });
    expect(stored.map((fact) => fact.key)).toEqual(['005930']);
    expect(report.savedFacts).toBe(1);

    // 멈춘 지점과 이어받는 방법을 밝힌다
    expect(report.stoppedAtSymbol).toBe('000660');
    expect(report.failureMessage).toContain('000660');
    expect(report.failureMessage).toContain('1/3종목 완료');
    expect(report.failureMessage).toContain('팩트 1건은 이미 저장');
    // 이어받는 방법을 반드시 말한다 — 예전에는 `--from/--to` 를 좁히라고 안내했지만
    // 이제 수집 이력이 남아 CLI·웹 모두 다시 실행만 하면 남은 구간을 이어받는다
    expect(report.failureMessage).toContain('남은 구간만 이어받습니다');
    expect(report.failureMessage).toContain('요청 제한을 초과');

    // 실패 이후 종목은 호출하지 않는다 — 한도를 더 쓰지 않는다
    expect(calls).toEqual(['005930', '000660']);

    // 저장된 것이 있으므로 버전은 움직여야 한다 (중단이라고 §9.5 가 면제되지 않는다)
    expect(versions.bumps).toHaveLength(1);
  });

  it('완주하면 stoppedAtSymbol·failureMessage 가 null 이다', async () => {
    const repository = fakeRepository();
    const report = await new FactSyncService(
      sourceFailingAt('없음', []),
      repository,
      LOGGER,
      fakeVersions(),
      CLOCK,
      fakeCoverage(),
      fakeActionCoverage(),
    ).sync(request);
    expect(report.stoppedAtSymbol).toBeNull();
    expect(report.failureMessage).toBeNull();
    expect(report.savedFacts).toBe(3);
  });

  it('종목마다 진행 콜백을 부른다 — 45분짜리 실행이 조용하지 않게 한다', async () => {
    const progress: string[] = [];
    await new FactSyncService(
      sourceFailingAt('035720', []),
      fakeRepository(),
      LOGGER,
      fakeVersions(),
      CLOCK,
      fakeCoverage(),
      fakeActionCoverage(),
    ).sync(request, {
      onSymbolDone: (event) =>
        progress.push(`${event.index}/${event.total} ${event.symbol} ${event.savedFacts}`),
    });
    // 실패한 종목은 완료로 보고하지 않는다
    expect(progress).toEqual(['1/3 005930 1', '2/3 000660 1']);
  });

  /**
   * `planFactSync` 는 심볼을 Set 으로 접는다. 순회가 접지 않으면 실제 호출이 계획의
   * `calls` 를 넘고(`fnlttSinglAcntAll`·`irdsSttus` 는 캐시가 없다) 화면의 예상 시간과
   * 실행이 갈라진다 — 이 절의 전제가 깨진다 (스펙 §3).
   */
  it('중복 심볼은 한 번만 수집한다', async () => {
    const source = recordingSource();
    const progress: string[] = [];
    const report = await new FactSyncService(
      source,
      fakeRepository(),
      LOGGER,
      fakeVersions(),
      CLOCK,
      fakeCoverage(),
      fakeActionCoverage(),
    ).sync(
      {
        symbols: ['005930', '005930', '000660'],
        fromYear: 2025,
        toYear: 2025,
        consolidated: true,
        mode: 'FULL',
      },
      { onSymbolDone: (event) => progress.push(`${event.index}/${event.total} ${event.symbol}`) },
    );

    // 종목마다 fetchFinancials + fetchCorporateActions 두 번 — 고유 2종목이면 4회다
    expect(source.requests.map((request) => request.symbols.join(','))).toEqual([
      '005930',
      '005930',
      '000660',
      '000660',
    ]);
    // total 도 고유 종목 수다 — 중복을 세면 진행률이 100% 에 못 미치고 끝난다
    expect(progress).toEqual(['1/2 005930', '2/2 000660']);
    expect(report.stopReason).toBeNull();
  });
});

/**
 * 팩트는 백테스트 입력인데도 지금까지 데이터셋 버전 체인을 올리지 않았다 — §9.5 의
 * 열세 필드가 전부 일치하면서 자산 곡선만 달라지는 상태가 만들어졌다. 아래 세 테스트가
 * 그 경로를 고정한다: 내용이 늘면 올린다 / 같은 내용을 다시 받으면 올리지 않는다 /
 * 정정공시로 값만 달라져도 올린다.
 */
describe('FactSyncService — 데이터셋 버전 승격 (재현성 §9.5)', () => {
  const request: FactSyncRequest = {
    symbols: ['005930'],
    fromYear: 2025,
    toYear: 2025,
    consolidated: true,
    mode: 'FULL',
  };

  function serviceWith(
    repository: FactRepository,
    versions: SymbolVersionBumper,
    facts: readonly Fact[],
  ): FactSyncService {
    return new FactSyncService(
      fakeSource({ facts, gaps: [] }, { facts: [], gaps: [] }),
      repository,
      LOGGER,
      versions,
      CLOCK,
      fakeCoverage(),
      fakeActionCoverage(),
    );
  }

  it('팩트가 추가되면 그 종목의 재무 버전을 올린다', async () => {
    const repository = fakeRepository();
    const versions = fakeVersions();
    await serviceWith(repository, versions, [fact('CURRENT_ASSETS', 1)]).sync(request);

    expect(versions.bumps).toHaveLength(1);
    expect(versions.bumps[0]?.code).toBe('005930');
    // 재무는 봉 슬라이스 축이 없다 — FACTS 자리에 기록된다
    expect(versions.bumps[0]?.slice).toBe('FACTS');
    expect(versions.bumps[0]?.seed).toMatch(/^facts:[0-9a-f]{64}$/);
    expect(versions.bumps[0]?.nowMs).toBe(CLOCK.now());
  });

  it('같은 팩트를 다시 수집하면 버전을 올리지 않는다 (idempotent 재수집)', async () => {
    const repository = fakeRepository();
    const versions = fakeVersions();
    const facts = [fact('CURRENT_ASSETS', 1)];

    await serviceWith(repository, versions, facts).sync(request);
    expect(versions.bumps).toHaveLength(1);

    // 두 번째 수집은 저장소 내용을 하나도 바꾸지 않는다 — 버전이 헛돌면 안 된다
    await serviceWith(repository, versions, facts).sync(request);
    expect(versions.bumps).toHaveLength(1);
  });

  it('정정공시로 값이 달라지면 버전을 올린다', async () => {
    const repository = fakeRepository();
    const versions = fakeVersions();

    await serviceWith(repository, versions, [fact('CURRENT_ASSETS', 1)]).sync(request);
    // 같은 (key, field, periodKey, asOf) 인데 값만 다르다 — 병합 키로는 덮어쓰기,
    // 지문으로는 다른 내용이다. 행 수만 세는 구현은 이 변화를 놓친다.
    await serviceWith(repository, versions, [fact('CURRENT_ASSETS', 2)]).sync(request);

    expect(versions.bumps).toHaveLength(2);
    expect(versions.bumps[0]?.seed).not.toBe(versions.bumps[1]?.seed);
  });

  it('저장된 팩트가 하나도 없으면 버전을 올리지 않는다', async () => {
    const repository = fakeRepository();
    const versions = fakeVersions();
    await serviceWith(repository, versions, []).sync(request);
    expect(versions.bumps).toHaveLength(0);
  });
});

describe('FactSyncService — 증분과 취소', () => {
  it('완전한 raw snapshot은 coverage 재처리 계획을 DART 네트워크 작업으로 세지 않는다', () => {
    const source = recordingSource();
    source.countRawSnapshotMisses = (fetchRequest) =>
      fetchRequest.rawSnapshotPolicy === 'REFRESH' ? 12 : 0;
    const now = Date.UTC(2026, 7, 11);
    const freshCoverage = fakeCoverage(
      new Map(),
      new Map([['005930', now - 60_000]]),
    );
    freshCoverage.getCollectedYears = () => new Map([['005930', [2025]]]);
    const freshService = new FactSyncService(
      source,
      fakeRepository(),
      LOGGER,
      fakeVersions(),
      { now: () => now },
      freshCoverage,
      fakeActionCoverage(),
    );

    expect(freshService.planFinancialSync(['005930'], 2025, 2025).calls).toBe(0);

    const staleCoverage = fakeCoverage(
      new Map(),
      new Map([['005930', now - 100 * 86_400_000]]),
    );
    staleCoverage.getCollectedYears = () => new Map([['005930', [2025]]]);
    const staleService = new FactSyncService(
      source,
      fakeRepository(),
      LOGGER,
      fakeVersions(),
      { now: () => now },
      staleCoverage,
      fakeActionCoverage(),
    );
    expect(staleService.planFinancialSync(['005930'], 2025, 2025).calls).toBe(12);

    const staleCoveredCoverage = fakeCoverage(
      new Map([['005930', [2025]]]),
      new Map([['005930', now - 100 * 86_400_000]]),
    );
    const staleCoveredService = new FactSyncService(
      source,
      fakeRepository(),
      LOGGER,
      fakeVersions(),
      { now: () => now },
      staleCoveredCoverage,
      fakeActionCoverage(),
    );
    expect(staleCoveredService.planFinancialSync(['005930'], 2025, 2025).calls).toBe(12);

    const neverCollectedService = new FactSyncService(
      source,
      fakeRepository(),
      LOGGER,
      fakeVersions(),
      { now: () => now },
      fakeCoverage(),
      fakeActionCoverage(),
    );
    expect(neverCollectedService.planFinancialSync(['005930'], 2025, 2025).calls).toBe(12);

    const watermarkOnlyService = new FactSyncService(
      source,
      fakeRepository(),
      LOGGER,
      fakeVersions(),
      { now: () => now },
      fakeCoverage(new Map(), new Map([['005930', now - 60_000]])),
      fakeActionCoverage(),
    );
    expect(watermarkOnlyService.planFinancialSync(['005930'], 2025, 2025).calls).toBe(12);
  });

  it('같은 원문 계획의 여러 종목은 한 번의 bulk cache 조회로 묶는다', () => {
    const source = recordingSource();
    const countedRequests: FetchFinancialsRequest[] = [];
    source.countRawSnapshotMisses = (request) => {
      countedRequests.push(request);
      return 0;
    };
    const now = Date.UTC(2026, 7, 11);
    const coverage = fakeCoverage(
      new Map(),
      new Map([
        ['005930', now - 60_000],
        ['000660', now - 60_000],
      ]),
    );
    coverage.getCollectedYears = () => new Map([
      ['005930', [2025]],
      ['000660', [2025]],
    ]);
    const service = new FactSyncService(
      source,
      fakeRepository(),
      LOGGER,
      fakeVersions(),
      { now: () => now },
      coverage,
      fakeActionCoverage(),
    );

    expect(service.planFinancialSync(['005930', '000660'], 2025, 2025).calls).toBe(0);
    expect(countedRequests).toHaveLength(1);
    expect(countedRequests[0]?.symbols).toEqual(['005930', '000660']);
  });

  it('watermark 없는 최초 INCREMENTAL 수집은 원문 cache로 최신성을 추정하지 않는다', async () => {
    const source = recordingSource();
    const service = new FactSyncService(
      source,
      fakeRepository(),
      LOGGER,
      fakeVersions(),
      CLOCK,
      fakeCoverage(),
      fakeActionCoverage(),
    );

    await service.sync({
      symbols: ['005930'],
      fromYear: 2025,
      toYear: 2025,
      consolidated: true,
      mode: 'INCREMENTAL',
    });

    expect(source.requests[0]?.rawSnapshotPolicy).toBe('REFRESH');
  });

  it('INCREMENTAL 은 fresh coverage를 건너뛰고 미수집 연도만 요청한다', async () => {
    const source = recordingSource();
    const now = Date.UTC(2022, 5, 1);
    const coverage = fakeCoverage(
      new Map([['005930', [2020, 2021]]]),
      new Map([['005930', now - 60_000]]),
    );
    const service = new FactSyncService(
      source,
      fakeRepository(),
      LOGGER,
      fakeVersions(),
      { now: () => now },
      coverage,
      fakeActionCoverage(),
    );

    await service.sync({
      symbols: ['005930'],
      fromYear: 2020,
      toYear: 2022,
      consolidated: true,
      mode: 'INCREMENTAL',
    });

    expect(source.requests[0]?.years).toEqual([2022]);
    expect(source.requests[0]?.shareYears).toEqual([2021, 2022]);
    expect(source.requests[0]?.rawSnapshotPolicy).toBe('PREFER_CACHE');
  });

  it('protocol만 무효이고 watermark가 오래됐으면 legacy 수집연도를 원천에서 갱신한다', async () => {
    const source = recordingSource();
    const now = Date.UTC(2026, 7, 11);
    const coverage = fakeCoverage(
      new Map(),
      new Map([['005930', now - 100 * 86_400_000]]),
    );
    coverage.getCollectedYears = () => new Map([['005930', [2025]]]);
    const service = new FactSyncService(
      source,
      fakeRepository(),
      LOGGER,
      fakeVersions(),
      { now: () => now },
      coverage,
      fakeActionCoverage(),
    );

    await service.sync({
      symbols: ['005930'],
      fromYear: 2025,
      toYear: 2025,
      consolidated: true,
      mode: 'INCREMENTAL',
    });

    expect(source.requests[0]?.years).toEqual([2025]);
    expect(source.requests[0]?.rawSnapshotPolicy).toBe('REFRESH');
  });

  it('API key 없이 원문만 재처리하면 검증하지 못한 freshness watermark를 보존한다', async () => {
    const source = recordingSource();
    source.listRecentPeriodicFilings = async () => {
      throw new FactSourceNotConfiguredError();
    };
    const now = Date.UTC(2026, 7, 11);
    const previousWatermark = now - 60_000;
    const coverage = fakeCoverage(
      new Map(),
      new Map([['005930', previousWatermark]]),
    );
    coverage.getCollectedYears = () => new Map([['005930', [2025]]]);
    const service = new FactSyncService(
      source,
      fakeRepository(),
      LOGGER,
      fakeVersions(),
      { now: () => now },
      coverage,
      fakeActionCoverage(),
    );

    await service.sync({
      symbols: ['005930'],
      fromYear: 2025,
      toYear: 2025,
      consolidated: true,
      mode: 'INCREMENTAL',
    });

    expect(coverage.getUpdatedAtMs(['005930']).get('005930')).toBe(previousWatermark);
    expect(source.requests[0]?.rawSnapshotPolicy).toBe('PREFER_CACHE');
  });

  it('fresh·stale 혼합 요청은 미검증 종목만 watermark를 보존한다', async () => {
    const source = recordingSource();
    source.listRecentPeriodicFilings = async () => {
      throw new FactSourceNotConfiguredError();
    };
    const now = Date.UTC(2026, 7, 11);
    const freshWatermark = now - 60_000;
    const staleWatermark = now - 100 * 86_400_000;
    const coverage = fakeCoverage(
      new Map(),
      new Map([
        ['005930', freshWatermark],
        ['000660', staleWatermark],
      ]),
    );
    coverage.getCollectedYears = () => new Map([
      ['005930', [2025]],
      ['000660', [2025]],
    ]);
    const service = new FactSyncService(
      source,
      fakeRepository(),
      LOGGER,
      fakeVersions(),
      { now: () => now },
      coverage,
      fakeActionCoverage(),
    );

    await service.sync({
      symbols: ['005930', '000660'],
      fromYear: 2025,
      toYear: 2025,
      consolidated: true,
      mode: 'INCREMENTAL',
    });

    const watermarks = coverage.getUpdatedAtMs(['005930', '000660']);
    expect(watermarks.get('005930')).toBe(freshWatermark);
    expect(watermarks.get('000660')).toBe(now);
    expect(source.requests[0]?.rawSnapshotPolicy).toBe('PREFER_CACHE');
    expect(source.requests[2]?.rawSnapshotPolicy).toBe('REFRESH');
  });

  it('durable resume은 이미 커버한 현재연도 symbol-year도 다시 요청하지 않는다', async () => {
    const source = recordingSource();
    const now = Date.UTC(2022, 5, 1);
    const service = new FactSyncService(
      source,
      fakeRepository(),
      LOGGER,
      fakeVersions(),
      { now: () => now },
      // quota 재개는 직전 실행이 방금 닫은 coverage 를 그대로 본다 — watermark 가
      // 신선하고 그 사이 새 공시가 없으므로(recordingSource 는 빈 목록) 다시 받지 않는다
      fakeCoverage(new Map([['005930', [2022]]]), new Map([['005930', now - 60_000]])),
      fakeActionCoverage(),
    );

    await service.sync({
      symbols: ['005930'],
      fromYear: 2022,
      toYear: 2022,
      consolidated: true,
      mode: 'INCREMENTAL',
    });

    expect(source.requests).toEqual([]);
  });

  it('FULL 은 수집 이력을 무시한다', async () => {
    const source = recordingSource();
    const service = new FactSyncService(
      source,
      fakeRepository(),
      LOGGER,
      fakeVersions(),
      { now: () => Date.UTC(2022, 5, 1) },
      fakeCoverage(new Map([['005930', [2020, 2021, 2022]]])),
      fakeActionCoverage(),
    );

    await service.sync({
      symbols: ['005930'],
      fromYear: 2020,
      toYear: 2022,
      consolidated: true,
      mode: 'FULL',
    });

    // 재무 + 자본변동 두 소스가 각각 연도 work unit으로 호출된다.
    expect(source.requests.map((request) => request.years)).toEqual([
      [2020], [2020], [2021], [2021], [2022], [2022],
    ]);
    expect(source.requests.every(
      (fetchRequest) => fetchRequest.rawSnapshotPolicy === 'REFRESH',
    )).toBe(true);
    expect(source.requests[0]?.rawSnapshotScope).toBeDefined();
    expect(new Set(source.requests.map(
      (fetchRequest) => fetchRequest.rawSnapshotScope,
    )).size).toBe(1);
  });

  it('종목을 저장한 직후 그 종목의 연도를 이력에 남긴다', async () => {
    const coverage = fakeCoverage();
    const service = new FactSyncService(
      recordingSource(),
      fakeRepository(),
      LOGGER,
      fakeVersions(),
      { now: () => Date.UTC(2022, 5, 1) },
      coverage,
      fakeActionCoverage(),
    );

    await service.sync({
      symbols: ['005930', '000660'],
      fromYear: 2021,
      toYear: 2022,
      consolidated: true,
      mode: 'INCREMENTAL',
    });

    expect(coverage.added).toEqual([
      { symbol: '005930', years: [2021] },
      { symbol: '005930', years: [2022] },
      { symbol: '000660', years: [2021] },
      { symbol: '000660', years: [2022] },
    ]);
  });

  it('세 번째 실제 DART 요청 직전에 quota로 멈추고 완료 연도의 저장·이력을 보존한다', async () => {
    const coverage = fakeCoverage();
    const repository = fakeRepository();
    const sentRequests: string[] = [];
    const source: FactSource = {
      fetchFinancials: async (request, hooks) => {
        hooks?.beforeRequest?.();
        sentRequests.push(`financial:${request.years[0]}`);
        return {
          facts: [
            { ...fact('CURRENT_ASSETS', request.years[0]!), periodKey: `${request.years[0]}Q1` },
            { ...fact('CURRENT_LIABILITIES', request.years[0]!), periodKey: `${request.years[0]}Q1` },
          ],
          gaps: [],
        };
      },
      fetchCorporateActions: async (request, hooks) => {
        hooks?.beforeRequest?.();
        sentRequests.push(`actions:${request.years[0]}`);
        return { facts: [], gaps: [] };
      },
      listRecentPeriodicFilings: async () => [],
    };
    const service = new FactSyncService(
      source,
      repository,
      LOGGER,
      fakeVersions(),
      CLOCK,
      coverage,
      fakeActionCoverage(),
    );
    let reservedRequests = 0;

    const report = await service.sync(
      {
        symbols: ['005930'],
        fromYear: 2024,
        toYear: 2025,
        consolidated: true,
        mode: 'FULL',
      },
      {
        beforeDartRequest: () => {
          if (reservedRequests >= 2) return 'PAUSE_DAILY_QUOTA';
          reservedRequests += 1;
          return 'CONTINUE';
        },
      },
    );

    expect(sentRequests).toEqual(['financial:2024', 'actions:2024']);
    expect(reservedRequests).toBe(2);
    expect(report).toMatchObject({
      savedFacts: 2,
      stoppedAtSymbol: '005930',
      stopReason: 'DAILY_QUOTA',
    });
    expect(repository.saved).toHaveLength(2);
    expect(coverage.added).toEqual([{ symbol: '005930', years: [2024] }]);
  });

  it('shouldStop 이 true 면 그 종목 전에 멈추고 CANCELLED 로 보고한다', async () => {
    const coverage = fakeCoverage();
    let calls = 0;
    const service = new FactSyncService(
      recordingSource(),
      fakeRepository(),
      LOGGER,
      fakeVersions(),
      { now: () => Date.UTC(2022, 5, 1) },
      coverage,
      fakeActionCoverage(),
    );

    const report = await service.sync(
      {
        symbols: ['005930', '000660', '035720'],
        fromYear: 2022,
        toYear: 2022,
        consolidated: true,
        mode: 'INCREMENTAL',
      },
      {
        shouldStop: () => {
          calls += 1;
          return calls > 2; // 두 종목 처리 후 취소
        },
      },
    );

    expect(report.stopReason).toBe('CANCELLED');
    expect(report.stoppedAtSymbol).toBe('035720');
    // 취소 전 두 종목은 이력에 남아 다음 실행이 이어받는다
    expect(coverage.added.map((entry) => entry.symbol)).toEqual(['005930', '000660']);
  });

  it('소스가 던지면 ERROR 로 보고하고 앞선 종목 이력은 남는다', async () => {
    const coverage = fakeCoverage();
    const source: FactSource = {
      fetchFinancials: async (request) => {
        if (request.symbols[0] === '000660') throw new Error('DART 응답 오류 020');
        return { facts: [], gaps: [] };
      },
      fetchCorporateActions: async () => ({ facts: [], gaps: [] }),
      listRecentPeriodicFilings: async () => [],
    };
    const service = new FactSyncService(
      source,
      fakeRepository(),
      LOGGER,
      fakeVersions(),
      { now: () => Date.UTC(2022, 5, 1) },
      coverage,
      fakeActionCoverage(),
    );

    const report = await service.sync({
      symbols: ['005930', '000660'],
      fromYear: 2022,
      toYear: 2022,
      consolidated: true,
      mode: 'INCREMENTAL',
    });

    expect(report.stopReason).toBe('ERROR');
    expect(report.stoppedAtSymbol).toBe('000660');
    expect(report.failureMessage).toContain('DART 응답 오류 020');
    expect(coverage.added.map((entry) => entry.symbol)).toEqual(['005930']);
  });

  it('DART의 실제 한도 응답은 일반 실패가 아니라 DAILY_QUOTA 중단으로 보고한다', async () => {
    const source: FactSource = {
      fetchFinancials: async () => { throw new DartQuotaError(); },
      fetchCorporateActions: async () => ({ facts: [], gaps: [] }),
      listRecentPeriodicFilings: async () => [],
    };
    const service = new FactSyncService(
      source,
      fakeRepository(),
      LOGGER,
      fakeVersions(),
      { now: () => Date.UTC(2022, 5, 1) },
      fakeCoverage(),
      fakeActionCoverage(),
    );

    const report = await service.sync({
      symbols: ['005930'],
      fromYear: 2022,
      toYear: 2022,
      consolidated: true,
      mode: 'INCREMENTAL',
    });

    expect(report.stopReason).toBe('DAILY_QUOTA');
    expect(report.failureMessage).toContain('일일 호출 한도');
  });

  /**
   * `saveFacts` → `addCoveredYears` 순서를 못박는다. 두 줄을 맞바꿔도 나머지 테스트는
   * 전부 초록이다 — 소스가 던지는 테스트는 두 호출 **앞에서** 터지고, 가짜 저장소의
   * `saveFacts` 는 던지지 않기 때문이다. 정작 막아야 하는 회귀는 "저장이 실패한 연도를
   * 수집했다고 기록해 다음 증분 실행이 그 구간을 영구히 건너뛴다" 이므로, 저장 실패를
   * 직접 만들어 이력이 남지 않는 것을 확인한다.
   */
  it('팩트 저장이 실패한 종목은 이력에 남지 않는다', async () => {
    const coverage = fakeCoverage();
    let saveCalls = 0;
    const repository: FactRepository = {
      getFacts: async () => [],
      saveFacts: async () => {},
      replaceSymbolFinancialFactsForYear: async () => {
        saveCalls += 1;
        // 두 번째 종목에서 DB 쓰기가 실패한다.
        if (saveCalls === 2) throw new Error('fact 쓰기 실패');
      },
      replaceSymbolCorporateActionFactsForYear: async () => {},
    };
    const service = new FactSyncService(
      recordingSource(),
      repository,
      LOGGER,
      fakeVersions(),
      { now: () => Date.UTC(2022, 5, 1) },
      coverage,
      fakeActionCoverage(),
    );

    const report = await service.sync({
      symbols: ['005930', '000660', '035720'],
      fromYear: 2022,
      toYear: 2022,
      consolidated: true,
      mode: 'INCREMENTAL',
    });

    expect(report.stopReason).toBe('ERROR');
    expect(report.stoppedAtSymbol).toBe('000660');
    expect(report.failureMessage).toContain('fact 쓰기 실패');
    // 저장이 성공한 종목만 이력에 남는다 — 이력 기록이 저장보다 앞서면 여기에
    // '000660' 이 섞이고, 다음 증분 실행이 그 종목의 2022 를 건너뛴다
    expect(coverage.added.map((entry) => entry.symbol)).toEqual(['005930']);
  });

  it('저장 뒤 coverage 갱신이 실패해도 이미 저장된 팩트와 gap을 리포트에 센다', async () => {
    const repository = fakeRepository();
    const gap = {
      symbol: '005930', periodKey: '2025Q1', reason: '계정 누락', severity: 'BLOCKING' as const,
    };
    const baseCoverage = fakeCoverage();
    const failingCoverage: FactCoverageStore = {
      ...baseCoverage,
      addCoverageResult: () => {
        throw new Error('coverage 쓰기 실패');
      },
    };
    const service = new FactSyncService(
      fakeSource(
        { facts: [fact('CURRENT_ASSETS', 1)], gaps: [gap] },
        { facts: [], gaps: [] },
      ),
      repository,
      LOGGER,
      fakeVersions(),
      { now: () => Date.UTC(2025, 5, 1) },
      failingCoverage,
      fakeActionCoverage(),
    );

    const report = await service.sync({
      symbols: ['005930'],
      fromYear: 2025,
      toYear: 2025,
      consolidated: true,
      mode: 'FULL',
    });

    expect(await repository.getFacts({ scope: 'SYMBOL' })).toHaveLength(1);
    expect(report).toMatchObject({
      savedFacts: 1,
      gaps: [gap],
      stoppedAtSymbol: '005930',
      stopReason: 'ERROR',
    });
    expect(report.failureMessage).toContain('coverage 쓰기 실패');
    expect(report.failureMessage).toContain('팩트 1건은 이미 저장');
  });

  it('수집할 연도가 없는 종목은 소스를 부르지 않는다', async () => {
    const source = recordingSource();
    const now = Date.UTC(2030, 0, 1);
    const service = new FactSyncService(
      source,
      fakeRepository(),
      LOGGER,
      fakeVersions(),
      { now: () => now },
      fakeCoverage(
        new Map([['005930', [2021, 2022]]]),
        new Map([['005930', now - 60_000]]),
      ),
      fakeActionCoverage(),
    );

    await service.sync({
      symbols: ['005930'],
      fromYear: 2021,
      toYear: 2022,
      consolidated: true,
      mode: 'INCREMENTAL',
    });

    expect(source.requests).toEqual([]);
  });
});

/**
 * 분할 보정만 필요한 전략에 재무제표 호출 비용을 물리지 않으려고
 * `syncCorporateActions` 를 낸다. 원문 snapshot cache 유무와 무관하게 이 경로는
 * fnlttSinglAcntAll을 호출하지 않아야 한다.
 */
describe('FactSyncService — 공시 기반 강제 재수집 (INCREMENTAL)', () => {
  const DAY_MS = 86_400_000;
  const NOW = Date.UTC(2026, 7, 11); // KST 2026-08-11
  const CLOCK_2026 = { now: () => NOW };

  function filingSource(
    filings: readonly PeriodicFiling[],
  ): FactSource & { requests: FetchFinancialsRequest[]; listCalls: Array<[string, string]> } {
    const requests: FetchFinancialsRequest[] = [];
    const listCalls: Array<[string, string]> = [];
    return {
      requests,
      listCalls,
      fetchFinancials: async (request) => {
        requests.push(request);
        return { facts: [], gaps: [] };
      },
      fetchCorporateActions: async () => ({ facts: [], gaps: [] }),
      listRecentPeriodicFilings: async (fromDate, toDate) => {
        listCalls.push([fromDate, toDate]);
        return filings;
      },
    };
  }

  function service(
    source: FactSource,
    coverage: FactCoverageStore,
  ): FactSyncService {
    return new FactSyncService(
      source,
      fakeRepository(),
      LOGGER,
      fakeVersions(),
      CLOCK_2026,
      coverage,
      fakeActionCoverage(),
    );
  }

  const request: FactSyncRequest = {
    symbols: ['005930'],
    fromYear: 2024,
    toYear: 2025,
    consolidated: true,
    mode: 'INCREMENTAL',
  };

  it('새 공시가 없으면 covered 연도를 다시 받지 않는다', async () => {
    const source = filingSource([]);
    const coverage = fakeCoverage(
      new Map([['005930', [2024, 2025]]]),
      new Map([['005930', NOW - 5 * DAY_MS]]),
    );

    await service(source, coverage).sync(request);

    expect(source.requests).toEqual([]);
    // watermark(2026-08-06)부터 오늘까지 조회했다
    expect(source.listCalls).toEqual([['2026-08-06', '2026-08-11']]);
  });

  it('정기공시가 접수된 종목만 그 사업연도를 다시 받는다', async () => {
    const source = filingSource([
      {
        receiptNo: '20260810000001',
        stockCode: '005930',
        businessYear: 2025,
        receiptDate: '2026-08-10',
      },
    ]);
    const coverage = fakeCoverage(
      new Map([['005930', [2024, 2025]], ['000660', [2024, 2025]]]),
      new Map([['005930', NOW - 5 * DAY_MS], ['000660', NOW - 5 * DAY_MS]]),
    );

    await service(source, coverage).sync({ ...request, symbols: ['005930', '000660'] });

    expect(source.requests.map((r) => [r.symbols[0], ...r.years])).toEqual([['005930', 2025]]);
    expect(source.requests[0]?.rawSnapshotPolicy).toBe('REFRESH');
  });

  it('watermark 당일의 같은 접수번호는 성공 후 다시 수집하지 않는다', async () => {
    const source = filingSource([
      {
        receiptNo: '20260811000001',
        stockCode: '005930',
        businessYear: 2025,
        receiptDate: '2026-08-11',
      },
    ]);
    const coverage = fakeCoverage(
      new Map([['005930', [2024, 2025]]]),
      new Map([['005930', NOW]]),
    );
    const sync = service(source, coverage);

    await sync.sync(request);
    await sync.sync(request);

    expect(source.requests.map((item) => item.years)).toEqual([[2025]]);
    expect(coverage.processedReceiptNos).toEqual(new Set(['20260811000001']));
    // 날짜 경계는 계속 포함하지만, 두 번째 실행은 영속 접수번호로 걸러진다.
    expect(source.listCalls).toEqual([
      ['2026-08-11', '2026-08-11'],
      ['2026-08-11', '2026-08-11'],
    ]);
  });

  it('같은 날 새 접수번호가 생기면 해당 사업연도를 한 번 더 수집한다', async () => {
    const filings: PeriodicFiling[] = [
      {
        receiptNo: '20260811000001',
        stockCode: '005930',
        businessYear: 2025,
        receiptDate: '2026-08-11',
      },
    ];
    const source = filingSource(filings);
    const coverage = fakeCoverage(
      new Map([['005930', [2024, 2025]]]),
      new Map([['005930', NOW]]),
    );
    const sync = service(source, coverage);

    await sync.sync(request);
    filings.push({
      receiptNo: '20260811000002',
      stockCode: '005930',
      businessYear: 2025,
      receiptDate: '2026-08-11',
    });
    await sync.sync(request);

    expect(source.requests.map((item) => item.years)).toEqual([[2025], [2025]]);
    expect(coverage.processedReceiptNos).toEqual(
      new Set(['20260811000001', '20260811000002']),
    );
  });

  it('재무 수집이 실패한 접수번호는 기록하지 않고 다음 실행에서 재시도한다', async () => {
    const source = filingSource([
      {
        receiptNo: '20260811000001',
        stockCode: '005930',
        businessYear: 2025,
        receiptDate: '2026-08-11',
      },
    ]);
    let attempts = 0;
    source.fetchFinancials = async (fetchRequest) => {
      source.requests.push(fetchRequest);
      attempts += 1;
      if (attempts === 1) throw new Error('일시적인 DART 오류');
      return { facts: [], gaps: [] };
    };
    const coverage = fakeCoverage(
      new Map([['005930', [2024, 2025]]]),
      new Map([['005930', NOW]]),
    );
    const sync = service(source, coverage);

    const failed = await sync.sync(request);
    expect(failed.stopReason).toBe('ERROR');
    expect(coverage.processedReceiptNos).toEqual(new Set());

    const retried = await sync.sync(request);
    expect(retried.stopReason).toBeNull();
    expect(attempts).toBe(2);
    expect(coverage.processedReceiptNos).toEqual(new Set(['20260811000001']));
  });

  it('watermark 이전에 접수된 공시는 이미 반영된 것으로 보고 무시한다', async () => {
    const source = filingSource([
      {
        receiptNo: '20260801000001',
        stockCode: '005930',
        businessYear: 2025,
        receiptDate: '2026-08-01',
      },
    ]);
    const coverage = fakeCoverage(
      new Map([['005930', [2024, 2025]]]),
      new Map([['005930', NOW - 5 * DAY_MS]]),
    );

    await service(source, coverage).sync(request);

    expect(source.requests).toEqual([]);
  });

  it('새 공시의 사업연도를 해석할 수 없으면 현재 연도로 추정하지 않고 중단한다', async () => {
    const source = filingSource([{
      receiptNo: '20260810000009',
      stockCode: '005930',
      businessYear: null,
      receiptDate: '2026-08-10',
    }]);
    const watermark = NOW - 5 * DAY_MS;
    const coverage = fakeCoverage(
      new Map([['005930', [2024, 2025]]]),
      new Map([['005930', watermark]]),
    );

    const report = await service(source, coverage).sync(request);

    expect(source.requests).toEqual([]);
    expect(report.stopReason).toBe('ERROR');
    expect(report.failureMessage).toContain('사업연도를 보고서명에서 확인할 수 없습니다');
    expect(coverage.getUpdatedAtMs(['005930']).get('005930')).toBe(watermark);
  });

  it('stale watermark는 좁은 요청이어도 종목의 covered 연도를 모두 다시 받는다', async () => {
    const source = filingSource([]);
    const coverage = fakeCoverage(
      new Map([['005930', [2025, 2026]]]),
      new Map([['005930', NOW - 100 * DAY_MS]]),
    );

    await service(source, coverage).sync({ ...request, fromYear: 2025, toYear: 2025 });

    // 목록 조회 범위 밖에 생긴 후속 공시의 연도를 알 수 없어 이 종목의 기존 coverage를
    // 전부 보수적으로 갱신한다. 목록 조회 자체는 하지 않는다.
    expect(source.requests.map((r) => r.years)).toEqual([[2025], [2026]]);
    expect(source.listCalls).toEqual([]);
  });

  it('공시 목록 조회가 실패하면 최신 여부를 숨기지 않고 ERROR로 중단한다', async () => {
    const source = filingSource([]);
    source.listRecentPeriodicFilings = async () => {
      throw new Error('일시적인 DART 목록 오류');
    };
    const coverage = fakeCoverage(
      new Map([['005930', [2025]]]),
      new Map([['005930', NOW - 5 * DAY_MS]]),
    );

    const report = await service(source, coverage).sync(request);

    expect(source.requests).toEqual([]);
    expect(report).toMatchObject({
      savedFacts: 0,
      stoppedAtSymbol: '005930',
      stopReason: 'ERROR',
    });
    expect(report.failureMessage).toContain('정기공시 목록 또는 워터마크 조회에 실패');
    expect(report.failureMessage).toContain('일시적인 DART 목록 오류');
  });

  it('DART를 의도적으로 설정하지 않았고 연도가 모두 covered면 기존 데이터를 사용한다', async () => {
    const source = filingSource([]);
    source.listRecentPeriodicFilings = async () => {
      throw new FactSourceNotConfiguredError();
    };
    const coverage = fakeCoverage(
      new Map([['005930', [2024, 2025]]]),
      new Map([['005930', NOW - 5 * DAY_MS]]),
    );

    const report = await service(source, coverage).sync(request);

    expect(source.requests).toEqual([]);
    expect(report).toMatchObject({
      savedFacts: 0,
      stoppedAtSymbol: null,
      stopReason: null,
      failureMessage: null,
    });
  });

  it('공시 목록의 실제 HTTP 요청 전에도 일일 quota를 적용한다', async () => {
    const source = filingSource([]);
    let sentRequests = 0;
    source.listRecentPeriodicFilings = async (_fromDate, _toDate, hooks) => {
      hooks?.beforeRequest?.();
      sentRequests += 1;
      return [];
    };
    const coverage = fakeCoverage(
      new Map([['005930', [2025]]]),
      new Map([['005930', NOW - 5 * DAY_MS]]),
    );

    const report = await service(source, coverage).sync(request, {
      beforeDartRequest: () => 'PAUSE_DAILY_QUOTA',
    });

    expect(sentRequests).toBe(0);
    expect(source.requests).toEqual([]);
    expect(report.stopReason).toBe('DAILY_QUOTA');
    expect(report.failureMessage).toContain('한도 초과 요청은 보내지 않았습니다');
  });
});

describe('FactSyncService — 자본변동 전용 수집', () => {
  const request: FactSyncRequest = {
    symbols: ['005930'],
    fromYear: 2025,
    toYear: 2025,
    consolidated: true,
    mode: 'FULL',
  };

  /**
   * 증분 판단은 자본변동 자신의 커버리지를 봐야 한다. 재무 커버리지를 봤다면
   * 이 테스트에서 2020 이 이미 재무로 커버됐다는 이유로 다시 요청하지 않았을 것이다.
   * 재무 커버리지는 2020 만 알고, 자본변동 커버리지는 아무것도 모르는 상태다.
   */
  it('재무가 아니라 자본변동 자신의 커버리지로 증분을 판단한다', async () => {
    const source = recordingSource();
    // 재무 커버리지는 2020 을 이미 받았다고 알고 있다. 대상 연도가 `currentYear` 가
    // 아니어야 "현재 연도는 항상 다시 받는다" 규칙에 가려지지 않는다.
    // 그래서 `clock` 을 2022 로 둔다.
    const financialCoverage = fakeCoverage(new Map([['005930', [2020]]]));
    const service = new FactSyncService(
      source,
      fakeRepository(),
      LOGGER,
      fakeVersions(),
      { now: () => Date.UTC(2022, 5, 1) },
      financialCoverage,
      fakeActionCoverage(),
    );

    await service.syncCorporateActions({
      symbols: ['005930'],
      fromYear: 2020,
      toYear: 2020,
      consolidated: true,
      mode: 'INCREMENTAL',
    });

    // 자본변동 커버리지는 비어 있으므로 2020 을 다시 요청해야 한다. 재무 커버리지를
    // 잘못 봤다면 이미 커버됐다는 이유로 요청 자체가 나가지 않는다.
    expect(source.requests[0]?.years).toEqual([2020]);
  });

  it('자본변동 공시 조회 하한에는 재무가 아닌 자본변동 watermark를 쓴다', async () => {
    const now = Date.UTC(2026, 7, 11);
    const dayMs = 86_400_000;
    const listCalls: Array<[string, string]> = [];
    let actionCalls = 0;
    const source: FactSource = {
      fetchFinancials: async () => ({ facts: [], gaps: [] }),
      fetchCorporateActions: async () => {
        actionCalls += 1;
        return { facts: [], gaps: [] };
      },
      listRecentPeriodicFilings: async (fromDate, toDate) => {
        listCalls.push([fromDate, toDate]);
        return [];
      },
    };
    const financialCoverage = fakeCoverage(
      new Map([['005930', [2025]]]),
      new Map([['005930', now - dayMs]]),
    );
    const actionCoverage = fakeActionCoverage();
    actionCoverage.addCoveredYears('005930', [2025], now - 5 * dayMs);
    const service = new FactSyncService(
      source,
      fakeRepository(),
      LOGGER,
      fakeVersions(),
      { now: () => now },
      financialCoverage,
      actionCoverage,
    );

    const report = await service.syncCorporateActions({
      symbols: ['005930'],
      fromYear: 2025,
      toYear: 2025,
      consolidated: true,
      mode: 'INCREMENTAL',
    });

    // 재무 watermark(8/10)가 아니라 자본변동 watermark(8/6)부터 조회한다.
    expect(listCalls).toEqual([['2026-08-06', '2026-08-11']]);
    expect(actionCalls).toBe(0);
    expect(report.stopReason).toBeNull();
  });

  it('진행 중 연도를 covered한 뒤 90일 넘어 제출된 자본변동도 다시 수집한다', async () => {
    let now = Date.UTC(2026, 7, 11);
    let actionCalls = 0;
    const requestedYears: number[] = [];
    const lateAction: Fact = {
      scope: 'SYMBOL',
      key: '005930',
      field: CORPORATE_ACTION_FIELD,
      periodKey: '2026-12-15',
      asOfTsMs: Date.UTC(2027, 1, 20),
      value: 2,
      unit: 'RATIO',
    };
    const source: FactSource = {
      fetchFinancials: async () => {
        throw new Error('자본변동 전용 수집이 재무를 호출했습니다.');
      },
      fetchCorporateActions: async (fetchRequest) => {
        actionCalls += 1;
        requestedYears.push(...fetchRequest.years);
        return { facts: actionCalls === 1 ? [] : [lateAction], gaps: [] };
      },
      listRecentPeriodicFilings: async () => [],
    };
    const repository = fakeRepository();
    const actionCoverage = fakeActionCoverage();
    const service = new FactSyncService(
      source,
      repository,
      LOGGER,
      fakeVersions(),
      { now: () => now },
      fakeCoverage(),
      actionCoverage,
    );
    const incremental2026: FactSyncRequest = {
      symbols: ['005930'],
      fromYear: 2026,
      toYear: 2026,
      consolidated: true,
      mode: 'INCREMENTAL',
    };

    // 8월에는 아직 존재하지 않는 Q3·사업보고서까지 포함해 2026년을 covered로 닫는다.
    await service.syncCorporateActions(incremental2026);
    now = Date.UTC(2027, 1, 20);
    await service.syncCorporateActions(incremental2026);

    expect(requestedYears).toEqual([2026, 2026]);
    expect(await repository.getFacts({ scope: 'SYMBOL', keys: ['005930'] })).toContainEqual(
      lateAction,
    );
  });

  it('stale·fresh 혼합 요청에서 DART 미설정이어도 stale 강제 계획을 버리지 않는다', async () => {
    const now = Date.UTC(2026, 7, 11);
    const fetchAttempts: string[] = [];
    const source: FactSource = {
      fetchFinancials: async () => ({ facts: [], gaps: [] }),
      fetchCorporateActions: async (fetchRequest) => {
        fetchAttempts.push(fetchRequest.symbols[0]!);
        throw new FactSourceNotConfiguredError();
      },
      listRecentPeriodicFilings: async () => {
        throw new FactSourceNotConfiguredError();
      },
    };
    const actionCoverage = fakeActionCoverage();
    actionCoverage.addCoveredYears('005930', [2025], now - 100 * 86_400_000);
    actionCoverage.addCoveredYears('000660', [2025], now - 5 * 86_400_000);
    const service = new FactSyncService(
      source,
      fakeRepository(),
      LOGGER,
      fakeVersions(),
      { now: () => now },
      fakeCoverage(),
      actionCoverage,
    );

    const report = await service.syncCorporateActions({
      symbols: ['000660', '005930'],
      fromYear: 2025,
      toYear: 2025,
      consolidated: true,
      mode: 'INCREMENTAL',
    });

    expect(fetchAttempts).toEqual(['005930']);
    expect(report.stopReason).toBe('ERROR');
    expect(report.stoppedAtSymbol).toBe('005930');
    expect(report.failureMessage).toContain('DART');
  });

  it('여러 강제 연도 중간 실패가 남은 연도보다 watermark를 먼저 전진시키지 않는다', async () => {
    const now = Date.UTC(2027, 1, 20);
    const oldWatermark = Date.UTC(2026, 7, 11);
    const attempts: number[] = [];
    let injectedFailure = false;
    const source: FactSource = {
      fetchFinancials: async () => ({ facts: [], gaps: [] }),
      fetchCorporateActions: async (fetchRequest) => {
        const year = fetchRequest.years[0]!;
        attempts.push(year);
        if (year === 2026 && !injectedFailure) {
          injectedFailure = true;
          throw new Error('injected year failure');
        }
        return { facts: [], gaps: [] };
      },
      listRecentPeriodicFilings: async () => [],
    };
    const actionCoverage = fakeActionCoverage();
    actionCoverage.addCoveredYears('005930', [2025, 2026], oldWatermark);
    const service = new FactSyncService(
      source,
      fakeRepository(),
      LOGGER,
      fakeVersions(),
      { now: () => now },
      fakeCoverage(),
      actionCoverage,
    );
    const narrowRequest: FactSyncRequest = {
      symbols: ['005930'],
      fromYear: 2025,
      toYear: 2025,
      consolidated: true,
      mode: 'INCREMENTAL',
    };

    const failed = await service.syncCorporateActions(narrowRequest);
    expect(failed.stopReason).toBe('ERROR');
    expect(actionCoverage.getUpdatedAtMs(['005930']).get('005930')).toBe(oldWatermark);

    const retried = await service.syncCorporateActions(narrowRequest);
    expect(retried.stopReason).toBeNull();
    expect(attempts).toEqual([2025, 2026, 2025, 2026]);
    expect(actionCoverage.getUpdatedAtMs(['005930']).get('005930')).toBe(now);
  });

  it('요청 밖에서 발견한 새 공시도 다른 연도 sync가 watermark를 앞지르기 전에 받는다', async () => {
    const now = Date.UTC(2026, 11, 1);
    const requestedYears: number[] = [];
    const source: FactSource = {
      fetchFinancials: async () => ({ facts: [], gaps: [] }),
      fetchCorporateActions: async (fetchRequest) => {
        requestedYears.push(...fetchRequest.years);
        return { facts: [], gaps: [] };
      },
      listRecentPeriodicFilings: async () => [{
        receiptNo: '20261120000001',
        stockCode: '005930',
        businessYear: 2026,
        receiptDate: '2026-11-20',
      }],
    };
    const actionCoverage = fakeActionCoverage();
    actionCoverage.addCoveredYears('005930', [2026], Date.UTC(2026, 10, 1));
    const service = new FactSyncService(
      source,
      fakeRepository(),
      LOGGER,
      fakeVersions(),
      { now: () => now },
      fakeCoverage(),
      actionCoverage,
    );

    await service.syncCorporateActions({
      symbols: ['005930'],
      fromYear: 2025,
      toYear: 2025,
      consolidated: true,
      mode: 'INCREMENTAL',
    });
    await service.syncCorporateActions({
      symbols: ['005930'],
      fromYear: 2026,
      toYear: 2026,
      consolidated: true,
      mode: 'INCREMENTAL',
    });

    expect(requestedYears).toEqual([2025, 2026]);
  });

  it('재무를 부르지 않는다', async () => {
    const source = fakeSourceWithCounts();
    const service = new FactSyncService(
      source,
      fakeRepository(),
      LOGGER,
      fakeVersions(),
      CLOCK,
      fakeCoverage(),
      fakeActionCoverage(),
    );

    await service.syncCorporateActions(request);

    expect(source.financialsCalls).toBe(0);
    expect(source.actionsCalls).toBe(1);
  });

  it('자본변동 커버리지만 갱신한다', async () => {
    const financialCoverage = fakeCoverage();
    const actionCoverage = fakeActionCoverage();
    const service = new FactSyncService(
      fakeSourceWithCounts(),
      fakeRepository(),
      LOGGER,
      fakeVersions(),
      CLOCK,
      financialCoverage,
      actionCoverage,
    );

    await service.syncCorporateActions(request);

    expect(actionCoverage.getCoveredYears().get('005930')).toEqual([2025]);
    // 재무 쪽은 부르지 않았으니 그 커버리지에는 흔적이 남지 않아야 한다 — 안 그러면
    // 재무 전용 전략이 이 연도를 이미 받았다고 오판한다
    expect(financialCoverage.getCoveredYears().get('005930')).toBeUndefined();
  });

  it('gap 이 난 연도를 기록한다', async () => {
    const source: FactSource = {
      fetchFinancials: () => Promise.resolve({ facts: [], gaps: [] }),
      fetchCorporateActions: () =>
        Promise.resolve({
          facts: [],
          gaps: [{
            symbol: '005930',
            periodKey: '2025-03-14',
            reason: '자본변동 gap',
            severity: 'BLOCKING',
          }],
        }),
      listRecentPeriodicFilings: async () => [],
    };
    const actionCoverage = fakeActionCoverage();
    const service = new FactSyncService(
      source,
      fakeRepository(),
      LOGGER,
      fakeVersions(),
      CLOCK,
      fakeCoverage(),
      actionCoverage,
    );

    await service.syncCorporateActions(request);

    expect(actionCoverage.getGapYears().get('005930')).toEqual([2025]);
  });

  it('날짜를 읽지 못해 periodKey가 없는 gap도 현재 fetch 연도에 기록한다', async () => {
    const source: FactSource = {
      fetchFinancials: () => Promise.resolve({ facts: [], gaps: [] }),
      fetchCorporateActions: () => Promise.resolve({
        facts: [],
        gaps: [{
          symbol: '005930',
          periodKey: '-',
          reason: 'DART corp_code 매핑에 없는 종목코드입니다',
          severity: 'BLOCKING',
        }],
      }),
      listRecentPeriodicFilings: async () => [],
    };
    const actionCoverage = fakeActionCoverage();
    const service = new FactSyncService(
      source,
      fakeRepository(),
      LOGGER,
      fakeVersions(),
      CLOCK,
      fakeCoverage(),
      actionCoverage,
    );

    await service.syncCorporateActions(request);

    expect(actionCoverage.getCoveredYears().get('005930')).toEqual([2025]);
    expect(actionCoverage.getGapYears().get('005930')).toEqual([2025]);
  });

  it('coverage+gap 원자 write가 실패하면 covered-only로 닫지 않고 다음 incremental에서 재시도한다', async () => {
    let covered = false;
    let atomicAttempts = 0;
    let fetchCalls = 0;
    const gapYears = new Set<number>();
    const actionCoverage: CorporateActionCoverageStore = {
      getCoveredYears: () => covered ? new Map([['005930', [2025]]]) : new Map(),
      getGapYears: () => gapYears.size > 0
        ? new Map([['005930', [...gapYears]]])
        : new Map(),
      getUpdatedAtMs: () => new Map(),
      // 회귀 전 두-write 경로라면 첫 메서드가 covered만 남기고 두 번째가 실패한다.
      addCoveredYears: () => { covered = true; },
      addGapYears: () => { throw new Error('injected split write failure'); },
      addCoverageResult: (_symbol, years, gaps) => {
        atomicAttempts += 1;
        if (atomicAttempts === 1) throw new Error('injected atomic write failure');
        covered = years.includes(2025);
        for (const year of gaps) gapYears.add(year);
      },
    };
    const source: FactSource = {
      fetchFinancials: () => Promise.resolve({ facts: [], gaps: [] }),
      fetchCorporateActions: () => {
        fetchCalls += 1;
        return Promise.resolve({
          facts: [],
          gaps: [{
            symbol: '005930', periodKey: '-', reason: '날짜 필드 누락', severity: 'BLOCKING',
          }],
        });
      },
      listRecentPeriodicFilings: async () => [],
    };
    const service = new FactSyncService(
      source,
      fakeRepository(),
      LOGGER,
      fakeVersions(),
      CLOCK,
      fakeCoverage(),
      actionCoverage,
    );
    const incremental = { ...request, mode: 'INCREMENTAL' as const };

    const failed = await service.syncCorporateActions(incremental);
    const retried = await service.syncCorporateActions(incremental);

    expect(failed.stopReason).toBe('ERROR');
    expect(retried.stopReason).toBeNull();
    expect(fetchCalls).toBe(2);
    expect(actionCoverage.getGapYears().get('005930')).toEqual([2025]);
  });

  it('gap 이 나도 커버리지는 기록한다', async () => {
    const source: FactSource = {
      fetchFinancials: () => Promise.resolve({ facts: [], gaps: [] }),
      fetchCorporateActions: () =>
        Promise.resolve({
          facts: [],
          gaps: [{
            symbol: '005930',
            periodKey: '2025-03-14',
            reason: '자본변동 gap',
            severity: 'BLOCKING',
          }],
        }),
      listRecentPeriodicFilings: async () => [],
    };
    const actionCoverage = fakeActionCoverage();
    const service = new FactSyncService(
      source,
      fakeRepository(),
      LOGGER,
      fakeVersions(),
      CLOCK,
      fakeCoverage(),
      actionCoverage,
    );

    await service.syncCorporateActions(request);

    // "물어봤다" 는 사실은 gap 유무와 무관하게 남는다 — 그래야 상장폐지 종목이
    // 영원히 재시도 대상에서 막히지 않는다
    expect(actionCoverage.getCoveredYears().get('005930')).toEqual([2025]);
  });

  /**
   * irdsSttus 는 자본변동 이력을 누적 반환하므로 2025 요청에 2017 이벤트의 gap 이
   * 딸려 올 수 있다 (앵커 부재 등 — sync-plan.ts 의 uniqueYearsFromGaps 주석).
   * 그 연도를 gap 으로 적으면 2017 자체 수집이 이미 성공했어도 gap 기록이 남고,
   * 어떤 sync 도 지우지 못해(covered 연도는 증분 계획에서 제외) 준비 작업이 같은
   * needs 를 반복하다 실패한다 — 운영 장애 2026-08-11 의 원인.
   */
  it('요청 연도 밖의 gap 연도는 기록하지 않는다', async () => {
    const source: FactSource = {
      fetchFinancials: () => Promise.resolve({ facts: [], gaps: [] }),
      fetchCorporateActions: () =>
        Promise.resolve({
          facts: [],
          gaps: [
            {
              symbol: '005930',
              periodKey: '2017-05-10',
              reason: '직전 발행주식수를 찾을 수 없습니다',
              severity: 'BLOCKING',
            },
            {
              symbol: '005930',
              periodKey: '2025-03-14',
              reason: '자본변동 gap',
              severity: 'BLOCKING',
            },
          ],
        }),
      listRecentPeriodicFilings: async () => [],
    };
    const actionCoverage = fakeActionCoverage();
    const service = new FactSyncService(
      source,
      fakeRepository(),
      LOGGER,
      fakeVersions(),
      CLOCK,
      fakeCoverage(),
      actionCoverage,
    );

    await service.syncCorporateActions(request);

    expect(actionCoverage.getGapYears().get('005930')).toEqual([2025]);
  });

  it('종목마다 저장해 중단 지점까지 남는다', async () => {
    const repository = fakeRepository();
    const calls: string[] = [];
    const source: FactSource = {
      fetchFinancials: () => Promise.resolve({ facts: [], gaps: [] }),
      fetchCorporateActions: (req) => {
        const symbol = req.symbols[0] as string;
        calls.push(symbol);
        if (symbol === '000660') {
          return Promise.reject(new Error('DART 응답 오류 020: 요청 제한을 초과하였습니다.'));
        }
        return Promise.resolve({
          facts: [
            {
              scope: 'SYMBOL',
              key: symbol,
              field: 'SPLIT_RATIO',
              periodKey: '2025-03-14',
              asOfTsMs: 1,
              value: 2,
              unit: 'RATIO',
            },
          ],
          gaps: [],
        });
      },
      listRecentPeriodicFilings: async () => [],
    };
    const actionCoverage = fakeActionCoverage();
    const service = new FactSyncService(
      source,
      repository,
      LOGGER,
      fakeVersions(),
      CLOCK,
      fakeCoverage(),
      actionCoverage,
    );

    const report = await service.syncCorporateActions({
      symbols: ['005930', '000660', '035720'],
      fromYear: 2025,
      toYear: 2025,
      consolidated: true,
      mode: 'FULL',
    });

    // 첫 종목만 저장됐고 중단 지점이 보고된다 — 그다음 종목은 아예 부르지 않는다
    expect(repository.saved).toHaveLength(1);
    expect(report.stoppedAtSymbol).toBe('000660');
    expect(calls).toEqual(['005930', '000660']);
    expect(actionCoverage.getCoveredYears().get('005930')).toEqual([2025]);
    expect(actionCoverage.getCoveredYears().get('000660')).toBeUndefined();
  });
});
