import { describe, expect, it } from 'vitest';
import {
  selectionMethodLabel,
  universeSourceLabel,
} from '../../src/web/features/backtests/universe-provenance.js';
import type { ProvenancePin } from '../../src/shared/schemas/provenance-pin.js';

const currentPin: ProvenancePin = {
  sourceKind: 'SYMBOL_MASTER',
  filterPolicyVersion: 'v1',
  selectionMethod: 'ORDERED_UNIVERSE_PIPELINE',
  universeRule: {
    markets: ['KOSPI'],
    stages: [{ criterion: 'MARKET_CAP', direction: 'HIGH', limit: 40 }],
    rebalanceInterval: { value: 1, unit: 'MONTH' },
  },
  scheduleHash: 'schedule-hash',
  diagnostics: [],
  preparedAtMs: 0,
};

describe('universeSourceLabel', () => {
  it('pin 이 있으면 종목 마스터 출처를 답한다', () => {
    expect(universeSourceLabel(currentPin)).toBe('종목 마스터 (유니버스 규칙)');
  });

  it('pin 이 없으면 - 를 적는다', () => {
    expect(universeSourceLabel(null)).toBe('-');
  });
});

describe('selectionMethodLabel', () => {
  it('ORDERED_UNIVERSE_PIPELINE 을 순서형 유니버스 파이프라인으로 바꾼다', () => {
    expect(selectionMethodLabel('ORDERED_UNIVERSE_PIPELINE')).toBe('순서형 유니버스 파이프라인');
  });

  it('null 이면 - 를 적는다', () => {
    expect(selectionMethodLabel(null)).toBe('-');
  });
});
