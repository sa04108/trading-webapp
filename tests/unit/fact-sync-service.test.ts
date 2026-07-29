import { describe, expect, it } from 'vitest';
import { FactSyncService } from '../../src/server/modules/facts/application/fact-sync-service.js';
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
    );

    const report = await service.sync({
      datasetId: 'ds-1',
      symbols: ['005930'],
      fromYear: 2025,
      toYear: 2025,
      consolidated: true,
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
    );

    const report = await service.sync({
      datasetId: 'ds-1',
      symbols: ['005930'],
      fromYear: 2025,
      toYear: 2025,
      consolidated: true,
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
    );

    const report = await service.sync({
      datasetId: 'ds-1',
      symbols: ['005930'],
      fromYear: 2025,
      toYear: 2025,
      consolidated: true,
    });

    expect(report.savedFacts).toBe(0);
    expect(report.gaps).toHaveLength(0);
    expect(repository.saved).toHaveLength(1);
    expect(repository.saved[0]?.facts).toHaveLength(0);
  });
});

/**
 * 200종목 × 12년 백필은 종목·연도당 9회 ≈ 21,600 호출(일 한도 20,000)에 rate limiter 로
 * 최소 40분이다. 전 종목을 모아 마지막에 한 번 저장하면 180번째 종목의 오류 하나가
 * 앞선 179종목을 통째로 버린다 — 한도는 이미 소진된 상태로. 아래 테스트가 그 경로를 막는다.
 */
describe('FactSyncService — 종목 단위 저장과 부분 실패 (긴 백필 생존)', () => {
  const request = {
    datasetId: 'ds-1',
    symbols: ['005930', '000660', '035720'],
    fromYear: 2025,
    toYear: 2025,
    consolidated: true,
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
    expect(report.failureMessage).toContain('--from');
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
    ).sync(request);
    expect(report.stoppedAtSymbol).toBeNull();
    expect(report.failureMessage).toBeNull();
    expect(report.savedFacts).toBe(3);
  });

  it('종목마다 진행 콜백을 부른다 — 40분짜리 실행이 조용하지 않게 한다', async () => {
    const progress: string[] = [];
    await new FactSyncService(
      sourceFailingAt('035720', []),
      fakeRepository(),
      LOGGER,
      fakeVersions(),
      CLOCK,
    ).sync(request, {
      onSymbolDone: (event) =>
        progress.push(`${event.index}/${event.total} ${event.symbol} ${event.savedFacts}`),
    });
    // 실패한 종목은 완료로 보고하지 않는다
    expect(progress).toEqual(['1/3 005930 1', '2/3 000660 1']);
  });
});

/**
 * 팩트는 백테스트 입력인데도 지금까지 데이터셋 버전 체인을 올리지 않았다 — §9.5 의
 * 열세 필드가 전부 일치하면서 자산 곡선만 달라지는 상태가 만들어졌다. 아래 세 테스트가
 * 그 경로를 고정한다: 내용이 늘면 올린다 / 같은 내용을 다시 받으면 올리지 않는다 /
 * 정정공시로 값만 달라져도 올린다.
 */
describe('FactSyncService — 데이터셋 버전 승격 (재현성 §9.5)', () => {
  const request = {
    datasetId: 'ds-1',
    symbols: ['005930'],
    fromYear: 2025,
    toYear: 2025,
    consolidated: true,
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
