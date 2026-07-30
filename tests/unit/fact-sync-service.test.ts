import { describe, expect, it } from 'vitest';
import type { FactCoverageStore } from '../../src/server/modules/facts/application/fact-coverage-store.js';
import {
  FactSyncService,
  type FactSyncRequest,
} from '../../src/server/modules/facts/application/fact-sync-service.js';
import type {
  DatasetVersionBumper,
  FactIngestionResult,
  FactRepository,
  FactSource,
  FetchFinancialsRequest,
} from '../../src/server/modules/facts/application/ports.js';
import type { Fact } from '../../src/server/modules/facts/domain/fact.js';

const LOGGER = { debug() {}, info() {}, warn() {}, error() {} } as never;
const CLOCK = { now: () => 1_700_000_000_000 };

/** 기록을 메모리에 쌓는 가짜 이력 저장소 */
function fakeCoverage(
  initial: ReadonlyMap<string, readonly number[]> = new Map(),
): FactCoverageStore & { added: Array<{ symbol: string; years: readonly number[] }> } {
  const store = new Map<string, number[]>(
    [...initial].map(([symbol, years]) => [symbol, [...years]]),
  );
  const added: Array<{ symbol: string; years: readonly number[] }> = [];
  return {
    added,
    getCoveredYears: () => new Map([...store].map(([symbol, years]) => [symbol, [...years]])),
    addCoveredYears: (_datasetId, symbol, years) => {
      if (years.length === 0) return;
      added.push({ symbol, years: [...years] });
      store.set(
        symbol,
        [...new Set([...(store.get(symbol) ?? []), ...years])].sort((a, b) => a - b),
      );
    },
  };
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
  };
}

/** bumpVersion 호출을 기록하는 가짜 포트 */
function fakeVersions(): DatasetVersionBumper & {
  bumps: Array<{ datasetId: string; seed: string; nowMs: number }>;
} {
  const bumps: Array<{ datasetId: string; seed: string; nowMs: number }> = [];
  return {
    bumps,
    bumpVersion: (datasetId, seed, nowMs) => {
      bumps.push({ datasetId, seed, nowMs });
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
  };
}

/**
 * 인메모리 저장소. `getFacts` 가 늘 빈 배열을 주는 스텁으로는 "저장된 내용이 실제로
 * 바뀌었는가" 를 판정하는 버전 승격 경로를 검증할 수 없으므로, ParquetFactRepository 와
 * 같은 병합 키((key, field, periodKey, asOf) 가 같으면 뒤에 온 것이 이긴다)로 실제
 * 상태를 들고 있는 가짜를 쓴다.
 */
function fakeRepository(): FactRepository & {
  saved: Array<{ datasetId: string; facts: readonly Fact[] }>;
} {
  const saved: Array<{ datasetId: string; facts: readonly Fact[] }> = [];
  const store = new Map<string, Map<string, Fact>>();
  return {
    saved,
    getFacts: async (query) => {
      const scoped = store.get(`${query.datasetId}:${query.scope}`);
      return scoped ? [...scoped.values()] : [];
    },
    saveFacts: async (datasetId, facts) => {
      saved.push({ datasetId, facts });
      for (const fact of facts) {
        const partitionKey = `${datasetId}:${fact.scope}`;
        const partition = store.get(partitionKey) ?? new Map<string, Fact>();
        partition.set(
          JSON.stringify([fact.key, fact.field, fact.periodKey, fact.asOfTsMs]),
          fact,
        );
        store.set(partitionKey, partition);
      }
    },
    hasFacts: (datasetId, scope) => (store.get(`${datasetId}:${scope}`)?.size ?? 0) > 0,
  };
}

describe('FactSyncService', () => {
  it('두 소스의 gap 합집합이 리포트에 도달한다', async () => {
    const financials: FactIngestionResult = {
      facts: [fact('CURRENT_ASSETS', 1)],
      gaps: [{ symbol: '005930', periodKey: '2025Q1', reason: '재무 gap' }],
    };
    const actions: FactIngestionResult = {
      facts: [fact('SPLIT_RATIO', 2)],
      gaps: [{ symbol: '005930', periodKey: '2025-03-14', reason: '자본변동 gap' }],
    };
    const repository = fakeRepository();
    const service = new FactSyncService(
      fakeSource(financials, actions),
      repository,
      LOGGER,
      fakeVersions(),
      CLOCK,
      fakeCoverage(),
    );

    const report = await service.sync({
      datasetId: 'ds-1',
      symbols: ['005930'],
      fromYear: 2025,
      toYear: 2025,
      consolidated: true,
      mode: 'FULL',
    });

    expect(report.gaps).toHaveLength(2);
    expect(report.gaps.map((gap) => gap.reason).sort()).toEqual(['자본변동 gap', '재무 gap'].sort());
  });

  it('saveFacts 는 두 소스의 팩트 합집합을 받는다', async () => {
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
    );

    const report = await service.sync({
      datasetId: 'ds-1',
      symbols: ['005930'],
      fromYear: 2025,
      toYear: 2025,
      consolidated: true,
      mode: 'FULL',
    });

    expect(report.savedFacts).toBe(2);
    expect(repository.saved).toHaveLength(1);
    expect(repository.saved[0]?.datasetId).toBe('ds-1');
    expect(repository.saved[0]?.facts.map((f) => f.field).sort()).toEqual(
      ['CURRENT_ASSETS', 'SPLIT_RATIO'].sort(),
    );
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
    );

    const report = await service.sync({
      datasetId: 'ds-1',
      symbols: ['005930'],
      fromYear: 2025,
      toYear: 2025,
      consolidated: true,
      mode: 'FULL',
    });

    expect(report.savedFacts).toBe(0);
    expect(report.gaps).toHaveLength(0);
    expect(repository.saved).toHaveLength(1);
    expect(repository.saved[0]?.facts).toHaveLength(0);
  });
});

/**
 * 200종목 × 12년 백필은 종목·연도당 9회 + 앵커 4회 ≈ 22,400 호출(일 한도 40,000)에
 * rate limiter 로 최소 45분이다. 전 종목을 모아 마지막에 한 번 저장하면 180번째 종목의
 * 오류 하나가 앞선 179종목을 통째로 버린다. 아래 테스트가 그 경로를 막는다.
 */
describe('FactSyncService — 종목 단위 저장과 부분 실패 (긴 백필 생존)', () => {
  const request: FactSyncRequest = {
    datasetId: 'ds-1',
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
    );
    await service.sync(request);
    expect(repository.saved).toHaveLength(3);
    expect(repository.saved.map((entry) => entry.facts[0]?.key)).toEqual([
      '005930',
      '000660',
      '035720',
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
    );

    // 던지지 않는다 — 리포트로 되돌려야 CLI 가 어디까지 갔는지 말할 수 있다
    const report = await service.sync(request);

    // 첫 종목은 저장됐다
    const stored = await repository.getFacts({ datasetId: 'ds-1', scope: 'SYMBOL' });
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
    ).sync(
      {
        datasetId: 'ds-1',
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
    datasetId: 'ds-1',
    symbols: ['005930'],
    fromYear: 2025,
    toYear: 2025,
    consolidated: true,
    mode: 'FULL',
  };

  function serviceWith(
    repository: FactRepository,
    versions: DatasetVersionBumper,
    facts: readonly Fact[],
  ): FactSyncService {
    return new FactSyncService(
      fakeSource({ facts, gaps: [] }, { facts: [], gaps: [] }),
      repository,
      LOGGER,
      versions,
      CLOCK,
      fakeCoverage(),
    );
  }

  it('팩트가 추가되면 데이터셋 버전을 올린다', async () => {
    const repository = fakeRepository();
    const versions = fakeVersions();
    await serviceWith(repository, versions, [fact('CURRENT_ASSETS', 1)]).sync(request);

    expect(versions.bumps).toHaveLength(1);
    expect(versions.bumps[0]?.datasetId).toBe('ds-1');
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
  it('INCREMENTAL 은 미수집 연도 + 현재 연도만 요청한다', async () => {
    const source = recordingSource();
    const coverage = fakeCoverage(new Map([['005930', [2020, 2021]]]));
    const service = new FactSyncService(
      source,
      fakeRepository(),
      LOGGER,
      fakeVersions(),
      { now: () => Date.UTC(2022, 5, 1) },
      coverage,
    );

    await service.sync({
      datasetId: 'ds-1',
      symbols: ['005930'],
      fromYear: 2020,
      toYear: 2022,
      consolidated: true,
      mode: 'INCREMENTAL',
    });

    expect(source.requests[0]?.years).toEqual([2022]);
    expect(source.requests[0]?.shareYears).toEqual([2021, 2022]);
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
    );

    await service.sync({
      datasetId: 'ds-1',
      symbols: ['005930'],
      fromYear: 2020,
      toYear: 2022,
      consolidated: true,
      mode: 'FULL',
    });

    expect(source.requests[0]?.years).toEqual([2020, 2021, 2022]);
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
    );

    await service.sync({
      datasetId: 'ds-1',
      symbols: ['005930', '000660'],
      fromYear: 2021,
      toYear: 2022,
      consolidated: true,
      mode: 'INCREMENTAL',
    });

    expect(coverage.added).toEqual([
      { symbol: '005930', years: [2021, 2022] },
      { symbol: '000660', years: [2021, 2022] },
    ]);
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
    );

    const report = await service.sync(
      {
        datasetId: 'ds-1',
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
    };
    const service = new FactSyncService(
      source,
      fakeRepository(),
      LOGGER,
      fakeVersions(),
      { now: () => Date.UTC(2022, 5, 1) },
      coverage,
    );

    const report = await service.sync({
      datasetId: 'ds-1',
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
      saveFacts: async () => {
        saveCalls += 1;
        // 두 번째 종목에서 디스크 쓰기가 터진다 (parquet 저장은 실패할 수 있다)
        if (saveCalls === 2) throw new Error('parquet 쓰기 실패');
      },
      hasFacts: () => false,
    };
    const service = new FactSyncService(
      recordingSource(),
      repository,
      LOGGER,
      fakeVersions(),
      { now: () => Date.UTC(2022, 5, 1) },
      coverage,
    );

    const report = await service.sync({
      datasetId: 'ds-1',
      symbols: ['005930', '000660', '035720'],
      fromYear: 2022,
      toYear: 2022,
      consolidated: true,
      mode: 'INCREMENTAL',
    });

    expect(report.stopReason).toBe('ERROR');
    expect(report.stoppedAtSymbol).toBe('000660');
    expect(report.failureMessage).toContain('parquet 쓰기 실패');
    // 저장이 성공한 종목만 이력에 남는다 — 이력 기록이 저장보다 앞서면 여기에
    // '000660' 이 섞이고, 다음 증분 실행이 그 종목의 2022 를 건너뛴다
    expect(coverage.added.map((entry) => entry.symbol)).toEqual(['005930']);
  });

  it('수집할 연도가 없는 종목은 소스를 부르지 않는다', async () => {
    const source = recordingSource();
    const service = new FactSyncService(
      source,
      fakeRepository(),
      LOGGER,
      fakeVersions(),
      { now: () => Date.UTC(2030, 0, 1) },
      fakeCoverage(new Map([['005930', [2021, 2022]]])),
    );

    await service.sync({
      datasetId: 'ds-1',
      symbols: ['005930'],
      fromYear: 2021,
      toYear: 2022,
      consolidated: true,
      mode: 'INCREMENTAL',
    });

    expect(source.requests).toEqual([]);
  });
});
