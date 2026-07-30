import { describe, expect, it } from 'vitest';
import {
  buildCorrelationGroups,
  newCorrelationWarmup,
  pearsonCorrelation,
  recordClose,
  tryBuildGroups,
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

const DAY = 86_400_000;
const T0 = Date.UTC(2025, 0, 2);

/** 주기 2 진동 — 한 봉만 밀려도 로그수익률 상관이 −1 → +1 로 뒤집히는 경로 */
function oscillate(bars: number): number[] {
  return Array.from({ length: bars }, (_, index) => 1_000 + (index % 2 === 0 ? 10 : -10));
}

describe('tryBuildGroups', () => {
  it('중간 상장(5봉 늦게 시작)이어도 공통 봉이 차면 역상관 쌍을 병합한다', () => {
    const path = oscillate(30);
    const warmup = newCorrelationWarmup();
    for (let index = 0; index < 30; index += 1) {
      const close = path[index] as number;
      recordClose(warmup, 'LEV', T0 + index * DAY, close);
      if (index >= 5) recordClose(warmup, 'INV', T0 + index * DAY, 1_000_000 / close);
    }
    // 공통 봉 25개 ≥ 20개 → 확정. 배열 인덱스로 맞췄다면 5봉(홀수) 밀려 +1 이 나온다
    const groups = tryBuildGroups(warmup, ['INV', 'LEV'], 20, 0.5);
    expect(groups).not.toBeNull();
    expect(groups?.get('LEV')).toBe(groups?.get('INV'));
  });

  it('공통 봉이 부족하면 null — 인덱스로 억지로 맞추지 않는다', () => {
    const path = oscillate(30);
    const warmup = newCorrelationWarmup();
    for (let index = 0; index < 30; index += 1) {
      const close = path[index] as number;
      recordClose(warmup, 'LEV', T0 + index * DAY, close);
      if (index >= 20) recordClose(warmup, 'INV', T0 + index * DAY, 1_000_000 / close);
    }
    // LEV 는 30봉이라 예전 조건(종목별 종가 개수 ≥ 20)은 충족하지만 공통 봉은 10개다
    expect(tryBuildGroups(warmup, ['INV', 'LEV'], 20, 0.5)).toBeNull();
  });

  it('봉이 아예 없는 종목이 유니버스에 있으면 영영 null 이다', () => {
    const path = oscillate(30);
    const warmup = newCorrelationWarmup();
    path.forEach((close, index) => recordClose(warmup, 'LEV', T0 + index * DAY, close));
    expect(tryBuildGroups(warmup, ['LEV', 'NO_BARS'], 20, 0.5)).toBeNull();
  });

  it('한 봉 밀린 인덱스 정렬은 단독 그룹 2개지만 시각 정렬은 병합한다', () => {
    const path = oscillate(25);
    // (가) 옛 방식 재현: 늦게 상장한 쪽의 배열을 그대로 인덱스 대응시킨다
    const indexAligned = buildCorrelationGroups(
      new Map([
        ['LEV', path.slice(0, 24)],
        ['INV', path.slice(1, 25).map((value) => 1_000_000 / value)],
      ]),
      0.5,
    );
    expect(indexAligned.get('LEV')).not.toBe(indexAligned.get('INV'));
    expect(new Set(indexAligned.values()).size).toBe(2); // 단독 그룹 2개

    // (나) 같은 데이터를 봉 시각으로 맞추면 하나의 그룹이다
    const warmup = newCorrelationWarmup();
    path.forEach((close, index) => {
      recordClose(warmup, 'LEV', T0 + index * DAY, close);
      if (index >= 1) recordClose(warmup, 'INV', T0 + index * DAY, 1_000_000 / close);
    });
    const timeAligned = tryBuildGroups(warmup, ['INV', 'LEV'], 20, 0.5);
    expect(timeAligned?.get('LEV')).toBe(timeAligned?.get('INV'));
    expect(new Set(timeAligned?.values()).size).toBe(1);
  });

  it('전 종목 커버리지면 예전과 같은 봉에서 같은 그룹이 확정된다', () => {
    const path = oscillate(20);
    const warmup = newCorrelationWarmup();
    path.forEach((close, index) => {
      recordClose(warmup, 'LEV', T0 + index * DAY, close);
      recordClose(warmup, 'INV', T0 + index * DAY, 1_000_000 / close);
      // 19봉까지는 미확정, 20봉째에 확정 — 예전 조건(종가 개수 ≥ correlationBars)과 동일
      const groups = tryBuildGroups(warmup, ['INV', 'LEV'], 20, 0.5);
      if (index < 19) expect(groups).toBeNull();
      else expect(groups?.get('LEV')).toBe(groups?.get('INV'));
    });
  });
});
