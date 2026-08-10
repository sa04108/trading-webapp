import { describe, expect, it } from 'vitest';
import {
  provenanceDiagnostics,
  selectionMethodLabel,
  universeSourceLabel,
} from '../../src/web/features/backtests/universe-provenance.js';
import type { ProvenancePin } from '../../src/shared/schemas/provenance-pin.js';

// 옛 완료 run 이 저장해 둔 모양 — 새 run 은 더 이상 이 값을 쓰지 않지만, 읽을 때는
// 그대로 표시할 수 있어야 한다 (union 잔류, 2026-08-10 결정).
const legacyPin: ProvenancePin = {
  sourceKind: 'SYMBOL_MASTER',
  filterPolicyVersion: 'v1',
  selectionMethod: 'TOP_MARKET_CAP_N',
  scheduleHash: 'hash',
};

const pipelinePin: ProvenancePin = {
  sourceKind: 'SYMBOL_MASTER',
  filterPolicyVersion: 'v1',
  selectionMethod: 'ORDERED_UNIVERSE_PIPELINE',
  universeRule: {
    markets: ['KOSPI'],
    stages: [{ criterion: 'MARKET_CAP', limit: 200 }],
    rebalanceInterval: { unit: 'MONTH', value: 1 },
  },
  scheduleHash: 'hash2',
  diagnostics: [
    {
      rebalanceDate: '2026-01-02',
      effectiveDate: '2025-12-30',
      stages: [
        {
          criterion: 'MARKET_CAP',
          inputCount: 900,
          eligibleCount: 850,
          selectedCount: 200,
          excludedMissingCount: 50,
        },
      ],
    },
    {
      rebalanceDate: '2026-02-02',
      effectiveDate: '2026-02-02',
      stages: [
        {
          criterion: 'MARKET_CAP',
          inputCount: 910,
          eligibleCount: 860,
          selectedCount: 200,
          excludedMissingCount: 50,
        },
      ],
    },
  ],
  preparedAtMs: 1_754_000_000_000,
};

describe('universeSourceLabel', () => {
  it('pin 이 있으면 종목 마스터 출처를 답한다', () => {
    expect(universeSourceLabel(legacyPin)).toBe('종목 마스터 (유니버스 규칙)');
  });

  it('pin 이 없으면 - 를 적는다', () => {
    expect(universeSourceLabel(null)).toBe('-');
  });
});

describe('selectionMethodLabel', () => {
  it('TOP_MARKET_CAP_N 을 사람이 읽는 문구로 바꾼다', () => {
    expect(selectionMethodLabel('TOP_MARKET_CAP_N')).toBe('시가총액 상위 N종목');
  });

  it('MANUAL_FROM_KRX_SNAPSHOT 을 수동 선택으로 바꾼다', () => {
    expect(selectionMethodLabel('MANUAL_FROM_KRX_SNAPSHOT')).toBe('수동 선택');
  });

  it('ORDERED_UNIVERSE_PIPELINE 을 순서형 유니버스 파이프라인으로 바꾼다', () => {
    expect(selectionMethodLabel('ORDERED_UNIVERSE_PIPELINE')).toBe('순서형 유니버스 파이프라인');
  });

  it('null 이면 - 를 적는다', () => {
    expect(selectionMethodLabel(null)).toBe('-');
  });
});

describe('provenanceDiagnostics', () => {
  it('새 pin 은 저장·조회(JSON round-trip)를 거쳐도 각 rebalance entry 의 단계 진단과 effective date 를 그대로 보존한다', () => {
    const roundTripped = JSON.parse(JSON.stringify(pipelinePin)) as ProvenancePin;
    const diagnostics = provenanceDiagnostics(roundTripped);
    expect(diagnostics).toEqual(pipelinePin.diagnostics);
    expect(diagnostics[0]?.effectiveDate).toBe('2025-12-30');
    expect(diagnostics[0]?.rebalanceDate).toBe('2026-01-02');
    expect(diagnostics[1]?.effectiveDate).toBe('2026-02-02');
    expect(diagnostics[0]?.stages[0]).toEqual({
      criterion: 'MARKET_CAP',
      inputCount: 900,
      eligibleCount: 850,
      selectedCount: 200,
      excludedMissingCount: 50,
    });
  });

  it('옛 pin·pin 없음은 단계 진단이 없으므로 빈 배열을 답한다', () => {
    expect(provenanceDiagnostics(legacyPin)).toEqual([]);
    expect(provenanceDiagnostics(null)).toEqual([]);
  });
});
