import { describe, expect, it } from 'vitest';
import { FactSyncService } from '../../src/server/modules/facts/application/fact-sync-service.js';
import type {
  FactIngestionResult,
  FactRepository,
  FactSource,
  FetchFinancialsRequest,
} from '../../src/server/modules/facts/application/ports.js';
import type { Fact } from '../../src/server/modules/facts/domain/fact.js';

const LOGGER = { debug() {}, info() {}, warn() {}, error() {} } as never;

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

function fakeRepository(): FactRepository & { saved: Array<{ datasetId: string; facts: readonly Fact[] }> } {
  const saved: Array<{ datasetId: string; facts: readonly Fact[] }> = [];
  return {
    saved,
    getFacts: async () => [],
    saveFacts: async (datasetId, facts) => {
      saved.push({ datasetId, facts });
    },
    hasFacts: () => false,
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
    const service = new FactSyncService(fakeSource(financials, actions), repository, LOGGER);

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
    const service = new FactSyncService(fakeSource(financials, actions), repository, LOGGER);

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
    const service = new FactSyncService(fakeSource(empty, empty), repository, LOGGER);

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
