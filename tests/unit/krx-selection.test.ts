import { describe, expect, it } from 'vitest';
import { selectionMethodOf, togglePageSelection, topNCodes } from '../../src/web/features/backtests/krx-selection.js';
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
    sortValue: null,
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

  // 적격 후보가 n(=TOP_N, 예: 200) 보다 적을 때의 회귀 테스트다. topNCodes(candidates, n)
  // 는 candidates.length 만큼만 돌려주는데(위 topNCodes 테스트가 이미 보장), 이 선택은
  // 그래도 TOP_MARKET_CAP_N 이다 — 「상위 N」이라는 방식 자체는 후보 부족과 무관하게
  // 성립한다. 다만 확정 요청의 selectionN 은 n 이 아니라 이 실제 크기(top.length)를
  // 보내야 한다 — n 을 그대로 보내면 서버 검증(selectionN 과 실제 상위 크기 불일치)에
  // 걸려 정당한 확정이 거부된다(krx-snapshot-step.tsx confirm() 참고).
  it('후보 수가 n 보다 적어도 상위 전체 선택은 TOP_MARKET_CAP_N 이고, 보낼 selectionN 은 n 이 아니라 실제 개수다', () => {
    const n = 200;
    const top = new Set(topNCodes(candidates, n));

    expect(top.size).toBe(3); // rank 있는 후보는 c1·c2·c3 셋뿐 — n=200 을 채우지 못한다
    expect(selectionMethodOf(top, candidates, n)).toBe('TOP_MARKET_CAP_N');
    // confirm() 이 selectionN 으로 보내야 할 값은 top.size(=3) 다 — n(=200) 을 그대로
    // 보내면 서버가 기대하는 「상위 200」과 어긋난다.
  });
});

describe('togglePageSelection', () => {
  it('페이지에 미선택이 하나라도 있으면 페이지 전체를 추가한다', () => {
    const next = togglePageSelection(new Set(['a']), ['a', 'b', 'c']);
    expect([...next].sort()).toEqual(['a', 'b', 'c']);
  });

  it('페이지 전체가 이미 선택돼 있으면 페이지 몫만 해제한다 — 다른 페이지 선택은 남는다', () => {
    const next = togglePageSelection(new Set(['a', 'b', 'z']), ['a', 'b']);
    expect([...next]).toEqual(['z']);
  });

  it('빈 페이지는 그대로 돌려준다', () => {
    const original = new Set(['a']);
    expect(togglePageSelection(original, [])).toBe(original);
  });
});
