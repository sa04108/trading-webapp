import { describe, expect, it } from 'vitest';
import { selectionMethodOf, topNCodes } from '../../src/web/features/backtests/krx-selection.js';
import type { HistoricalCandidateDto } from '../../src/shared/schemas/historical-universe.js';

function candidate(
  standardCode: string,
  rank: number | null,
  marketCapKrw: string | null = '1000',
): HistoricalCandidateDto {
  return {
    standardCode,
    shortCode: standardCode,
    name: standardCode,
    market: 'KOSPI',
    marketCapKrw,
    rank,
  };
}

const c1 = candidate('KR001', 2, '200');
const c2 = candidate('KR002', 1, '300');
const c3 = candidate('KR003', 3, '100');
const unknown = candidate('KR004', null, null);

const candidates: readonly HistoricalCandidateDto[] = [c1, c2, c3, unknown];

describe('topNCodes', () => {
  it('rank 오름차순으로 상위 N개를 뽑는다', () => {
    expect(topNCodes(candidates, 2)).toEqual(['KR002', 'KR001']);
  });

  it('시가총액을 모르는(rank 없는) 후보는 상위 N 에서 제외한다', () => {
    expect(topNCodes(candidates, 10)).toEqual(['KR002', 'KR001', 'KR003']);
  });

  it('입력 배열의 순서와 무관하다 — rank 로만 정렬한다', () => {
    const shuffled = [unknown, c3, c1, c2];
    expect(topNCodes(shuffled, 2)).toEqual(['KR002', 'KR001']);
  });

  it('n 이 0이면 빈 배열이다', () => {
    expect(topNCodes(candidates, 0)).toEqual([]);
  });
});

describe('selectionMethodOf', () => {
  it('선택이 정확히 상위 N 이면 TOP_MARKET_CAP_N 이다', () => {
    const top2 = new Set(topNCodes(candidates, 2));
    expect(selectionMethodOf(top2, candidates, 2)).toBe('TOP_MARKET_CAP_N');
  });

  it('수동으로 하나를 더 넣으면 MANUAL_FROM_KRX_SNAPSHOT 이다', () => {
    const added = new Set(topNCodes(candidates, 2));
    added.add('KR003');
    expect(selectionMethodOf(added, candidates, 2)).toBe('MANUAL_FROM_KRX_SNAPSHOT');
  });

  it('상위 N 중 하나를 빼면 MANUAL_FROM_KRX_SNAPSHOT 이다', () => {
    const removed = new Set(topNCodes(candidates, 2));
    removed.delete('KR001');
    expect(selectionMethodOf(removed, candidates, 2)).toBe('MANUAL_FROM_KRX_SNAPSHOT');
  });

  it('상위 N 중 하나를 다른 종목으로 바꿔도(크기는 같아도) MANUAL_FROM_KRX_SNAPSHOT 이다', () => {
    const swapped = new Set(topNCodes(candidates, 2));
    swapped.delete('KR001');
    swapped.add('KR003');
    expect(selectionMethodOf(swapped, candidates, 2)).toBe('MANUAL_FROM_KRX_SNAPSHOT');
  });

  it('검색·페이지로 후보 배열의 순서가 달라져도 판정은 같다', () => {
    const top2 = new Set(topNCodes(candidates, 2));
    const reordered = [...candidates].reverse();
    expect(selectionMethodOf(top2, reordered, 2)).toBe('TOP_MARKET_CAP_N');
  });

  it('선택이 비어 있으면 상위 N 이 아니다', () => {
    expect(selectionMethodOf(new Set(), candidates, 2)).toBe('MANUAL_FROM_KRX_SNAPSHOT');
  });
});
