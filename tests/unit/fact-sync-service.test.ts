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
