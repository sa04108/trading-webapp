import { describe, expect, it } from 'vitest';
import { selectionMethodLabel, universeSourceLabel } from '../../src/web/features/backtests/universe-provenance.js';
import type { ProvenancePin } from '../../src/shared/schemas/provenance-pin.js';

const pin: ProvenancePin = {
  sourceKind: 'SYMBOL_MASTER',
  filterPolicyVersion: 'v1',
  selectionMethod: 'TOP_MARKET_CAP_N',
  scheduleHash: 'hash',
};

describe('universeSourceLabel', () => {
  it('pin 이 있으면 종목 마스터 출처를 답한다', () => {
    expect(universeSourceLabel(pin)).toBe('종목 마스터 (유니버스 규칙)');
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

  it('null 이면 - 를 적는다', () => {
    expect(selectionMethodLabel(null)).toBe('-');
  });
});
