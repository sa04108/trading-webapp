import { describe, expect, it } from 'vitest';
import {
  buildCorrelationGroups,
  pearsonCorrelation,
} from '../../src/server/modules/strategy/strategies/shared/pair-groups.js';

/** 기하 경로 — B = 1e6/A 면 로그수익률이 정확히 반대(상관 −1)다 */
function inversePath(path: readonly number[]): number[] {
  return path.map((value) => 1_000_000 / value);
}

// 단조 아님(분산 확보) + 전 구간 양수
const PATH_A = [100, 103, 101, 106, 104, 110, 108, 115, 112, 120];
const PATH_C = [100, 101, 102, 103, 104, 105, 106, 107, 108, 109]; // A 와 무관한 다른 모양

describe('pearsonCorrelation', () => {
  it('완전 역방향 수익률은 −1', () => {
    const a = [0.01, -0.02, 0.03, -0.01];
    const b = a.map((value) => -value);
    expect(pearsonCorrelation(a, b)).toBeCloseTo(-1);
  });

  it('분산이 0 이거나 표본이 2 미만이면 null', () => {
    expect(pearsonCorrelation([0.01], [0.02])).toBeNull();
    expect(pearsonCorrelation([0.01, 0.01, 0.01], [0.01, -0.02, 0.03])).toBeNull();
  });
});

describe('buildCorrelationGroups', () => {
  it('역상관 쌍만 묶고 무관한 종목은 단독 그룹이다', () => {
    const groups = buildCorrelationGroups(
      new Map([
        ['LEV_A', PATH_A],
        ['INV_A', inversePath(PATH_A)],
        ['OTHER', PATH_C],
      ]),
      0.5,
    );
    expect(groups.get('LEV_A')).toBe(groups.get('INV_A'));
    expect(groups.get('OTHER')).not.toBe(groups.get('LEV_A'));
    // 그룹 id 는 그룹 내 사전순 최소 심볼
    expect(groups.get('LEV_A')).toBe('INV_A');
    expect(groups.get('OTHER')).toBe('OTHER');
  });

  it('4종목(두 기초자산 × 레버리지·인버스)이면 그룹 2개다', () => {
    const groups = buildCorrelationGroups(
      new Map([
        ['A_LEV', PATH_A],
        ['A_INV', inversePath(PATH_A)],
        ['C_LEV', PATH_C],
        ['C_INV', inversePath(PATH_C)],
      ]),
      0.5,
    );
    expect(groups.get('A_LEV')).toBe(groups.get('A_INV'));
    expect(groups.get('C_LEV')).toBe(groups.get('C_INV'));
    expect(groups.get('A_LEV')).not.toBe(groups.get('C_LEV'));
  });

  it('입력 Map 의 삽입 순서를 뒤집어도 같은 그룹이 나온다 (재현성)', () => {
    const forward = buildCorrelationGroups(
      new Map([
        ['A_LEV', PATH_A],
        ['A_INV', inversePath(PATH_A)],
      ]),
      0.5,
    );
    const reversed = buildCorrelationGroups(
      new Map([
        ['A_INV', inversePath(PATH_A)],
        ['A_LEV', PATH_A],
      ]),
      0.5,
    );
    expect([...forward.entries()].sort()).toEqual([...reversed.entries()].sort());
  });
});
