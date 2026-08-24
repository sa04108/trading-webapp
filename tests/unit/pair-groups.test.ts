import { describe, expect, it } from 'vitest';
import { createRng } from '../../src/server/modules/backtest/domain/seeded-rng.js';
import {
  buildCorrelationGroups,
  newCorrelationGroupingState,
  newCorrelationWarmup,
  pearsonCorrelation,
  pruneWarmupCloses,
  recordClose,
  recordCorrelationClose,
  scaleWarmupCloses,
  selectSeededGroupEntries,
  tryBuildGroups,
  updateCorrelationGrouping,
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

describe('selectSeededGroupEntries', () => {
  const candidates = [
    { symbol: 'A', group: 'PAIR' },
    { symbol: 'B', group: 'PAIR' },
    { symbol: 'C', group: 'PAIR' },
    { symbol: 'ONLY', group: 'SINGLE' },
  ];
  const selected = (seed: number, rows = candidates) =>
    selectSeededGroupEntries(rows, createRng(seed)).map((row) => row.symbol);

  it('같은 seed는 같은 그룹 선점 종목을 고르고 입력 순서에 무관하다', () => {
    expect(selected(42)).toEqual(selected(42));
    expect(selected(42)).toEqual(selected(42, [...candidates].reverse()));
    expect(selected(42)).toContain('ONLY');
  });

  it('seed를 바꾸면 경쟁 그룹의 선점 종목이 달라진다', () => {
    const pairWinners = Array.from({ length: 8 }, (_, seed) => selected(seed)[0]);
    expect(new Set(pairWinners).size).toBeGreaterThan(1);
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

  it('짧은 이력 종목은 단독 그룹으로 남고 준비된 종목을 막지 않는다', () => {
    const path = oscillate(30);
    const warmup = newCorrelationWarmup();
    for (let index = 0; index < 30; index += 1) {
      const close = path[index] as number;
      recordClose(warmup, 'LEV', T0 + index * DAY, close);
      if (index >= 20) recordClose(warmup, 'INV', T0 + index * DAY, 1_000_000 / close);
    }
    const groups = tryBuildGroups(warmup, ['INV', 'LEV'], 20, 0.5);
    expect(groups).not.toBeNull();
    expect(groups?.get('INV')).toBe('INV');
    expect(groups?.get('LEV')).toBe('LEV');
  });

  it('봉이 아예 없는 종목도 단독 그룹으로 남아 전체 준비를 막지 않는다', () => {
    const path = oscillate(30);
    const warmup = newCorrelationWarmup();
    path.forEach((close, index) => recordClose(warmup, 'LEV', T0 + index * DAY, close));
    const groups = tryBuildGroups(warmup, ['LEV', 'NO_BARS'], 20, 0.5);
    expect(groups).not.toBeNull();
    expect(groups?.get('LEV')).toBe('LEV');
    expect(groups?.get('NO_BARS')).toBe('NO_BARS');
  });

  it('전체 공통 봉이 부족해도 충분한 역상관 pair만 병합한다', () => {
    const path = oscillate(30);
    const warmup = newCorrelationWarmup();
    for (let index = 0; index < 30; index += 1) {
      const close = path[index] as number;
      recordClose(warmup, 'A', T0 + index * DAY, close);
      recordClose(warmup, 'B', T0 + index * DAY, 1_000_000 / close);
      if (index >= 25) recordClose(warmup, 'C', T0 + index * DAY, 2_000 + index);
    }

    const groups = tryBuildGroups(warmup, ['A', 'B', 'C'], 20, 0.5);
    expect(groups).not.toBeNull();
    expect(groups?.get('A')).toBe('A');
    expect(groups?.get('B')).toBe('A');
    expect(groups?.get('C')).toBe('C');
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

describe('CorrelationGroupingState', () => {
  it('종가를 기록할 때 해당 종목의 오래된 이력만 즉시 제거한다', () => {
    const state = newCorrelationGroupingState();
    for (let index = 0; index < 5; index += 1) {
      recordCorrelationClose(state, 'A', T0 + index * DAY, 1_000 + index, 3);
      recordCorrelationClose(state, 'B', T0 + index * DAY, 2_000 + index, 10);
    }

    expect([...(state.warmup.closesBySymbol.get('A')?.keys() ?? [])]).toEqual([
      T0 + 2 * DAY,
      T0 + 3 * DAY,
      T0 + 4 * DAY,
    ]);
    expect(state.warmup.closesBySymbol.get('B')?.size).toBe(5);
  });

  it('공용 수명주기가 종가를 누적해 준비된 역상관 그룹을 확정한다', () => {
    const state = newCorrelationGroupingState();
    const path = oscillate(20);
    path.forEach((close, index) => {
      recordCorrelationClose(state, 'A', T0 + index * DAY, close, 1_000);
      recordCorrelationClose(state, 'B', T0 + index * DAY, 1_000_000 / close, 1_000);
    });
    const symbols = updateCorrelationGrouping({
      state,
      allSymbols: ['A', 'B'],
      activeUniverseSymbols: new Set(['A', 'B']),
      isRebalanceBar: false,
      correlationBars: 20,
      threshold: 0.5,
    });

    expect(symbols).toEqual(['A', 'B']);
    expect(state.groupOf?.get('A')).toBe('A');
    expect(state.groupOf?.get('B')).toBe('A');
  });

  it('개별 준비 뒤 공통 봉이 차면 리밸런싱 없이 역상관 pair를 다시 묶는다', () => {
    const state = newCorrelationGroupingState();
    const initialA = oscillate(20);
    const initialB = oscillate(20);
    initialA.forEach((close, index) => {
      recordCorrelationClose(state, 'A', T0 + index * DAY, close, 1_000);
      recordCorrelationClose(
        state,
        'B',
        T0 + (100 + index) * DAY,
        initialB[index] as number,
        1_000,
      );
    });
    const input = {
      state,
      allSymbols: ['A', 'B'],
      activeUniverseSymbols: new Set(['A', 'B']),
      isRebalanceBar: false,
      correlationBars: 20,
      threshold: 0.5,
    };

    updateCorrelationGrouping(input);
    expect(state.groupOf?.get('A')).toBe('A');
    expect(state.groupOf?.get('B')).toBe('B');

    oscillate(20).forEach((close, index) => {
      recordCorrelationClose(state, 'A', T0 + (200 + index) * DAY, close, 1_000);
      recordCorrelationClose(
        state,
        'B',
        T0 + (200 + index) * DAY,
        1_000_000 / close,
        1_000,
      );
    });

    updateCorrelationGrouping(input);
    expect(state.groupOf?.get('A')).toBe('A');
    expect(state.groupOf?.get('B')).toBe('A');
  });

  it('정적 유니버스도 향후 멤버십 축소 재계산을 위해 제한된 워밍업 이력을 유지한다', () => {
    const state = newCorrelationGroupingState();
    oscillate(20).forEach((close, index) => {
      recordCorrelationClose(state, 'A', T0 + index * DAY, close, 1_000);
      recordCorrelationClose(
        state,
        'B',
        T0 + (100 + index) * DAY,
        1_000_000 / close,
        1_000,
      );
    });
    const input = {
      state,
      allSymbols: ['A', 'B'],
      activeUniverseSymbols: null,
      isRebalanceBar: false,
      correlationBars: 20,
      threshold: 0.5,
    };

    updateCorrelationGrouping(input);
    expect(state.warmup).not.toBeNull();

    oscillate(20).forEach((close, index) => {
      recordCorrelationClose(state, 'A', T0 + (200 + index) * DAY, close, 1_000);
      recordCorrelationClose(
        state,
        'B',
        T0 + (200 + index) * DAY,
        1_000_000 / close,
        1_000,
      );
    });

    updateCorrelationGrouping(input);
    expect(state.groupOf?.get('A')).toBe('A');
    expect(state.groupOf?.get('B')).toBe('A');
    expect(state.warmup).not.toBeNull();

    updateCorrelationGrouping({
      ...input,
      activeUniverseSymbols: new Set(['B']),
    });
    expect(state.groupOf).toEqual(new Map([['B', 'B']]));
  });
});

describe('scaleWarmupCloses — 분할이 상관 계산을 오염시키지 않게 한다', () => {
  /** A 는 진동하고 B 는 그 역수라 로그수익률이 정확히 반대다 */
  function seedInversePair(bars: number) {
    const warmup = newCorrelationWarmup();
    for (let index = 0; index < bars; index += 1) {
      const a = 100_000 + (index % 2 === 0 ? 4_000 : -4_000);
      recordClose(warmup, 'A', index, a);
      recordClose(warmup, 'B', index, 1e10 / a);
    }
    return warmup;
  }

  it('지정한 종목의 누적 종가만 내린다', () => {
    const warmup = newCorrelationWarmup();
    recordClose(warmup, 'A', 1, 100_000);
    recordClose(warmup, 'A', 2, 110_000);
    recordClose(warmup, 'B', 1, 50_000);

    scaleWarmupCloses(warmup, 'A', 5);

    expect([...(warmup.closesBySymbol.get('A') as Map<number, number>).values()]).toEqual([
      20_000, 22_000,
    ]);
    expect([...(warmup.closesBySymbol.get('B') as Map<number, number>).values()]).toEqual([50_000]);
  });

  it('쌓인 적 없는 종목이면 아무 일도 하지 않는다', () => {
    const warmup = newCorrelationWarmup();
    expect(() => scaleWarmupCloses(warmup, 'A', 5)).not.toThrow();
  });

  it('분할 봉을 먹이기 전에 내리면 역상관 판정이 살아남는다', () => {
    // 판별력 확인: `scaleWarmupCloses` 호출을 빼면 아래 두 단언 중 뒤엣것이 깨진다.
    const unscaled = seedInversePair(20);
    const scaled = seedInversePair(20);
    scaleWarmupCloses(scaled, 'A', 5);

    // 21번째 봉에서 A 에 5대 1 분할이 나 종가가 1/5 이 된다. B 는 그대로다.
    const splitClose = (100_000 + 4_000) / 5;
    recordClose(unscaled, 'A', 20, splitClose);
    recordClose(scaled, 'A', 20, splitClose);
    recordClose(unscaled, 'B', 20, 1e10 / (100_000 + 4_000));
    recordClose(scaled, 'B', 20, 1e10 / (100_000 + 4_000));

    // 조정하면 A 와 B 는 여전히 한 묶음이다
    const scaledGroups = tryBuildGroups(scaled, ['A', 'B'], 21, 0.5) as Map<string, string>;
    expect(scaledGroups.get('A')).toBe(scaledGroups.get('B'));

    // 조정하지 않으면 −80% 한 점이 상관을 끌고 가 묶음이 깨진다
    const unscaledGroups = tryBuildGroups(unscaled, ['A', 'B'], 21, 0.5) as Map<string, string>;
    expect(unscaledGroups.get('A')).not.toBe(unscaledGroups.get('B'));
  });
});

describe('pruneWarmupCloses', () => {
  it('종목별로 최근 N개 시각만 남긴다', () => {
    const warmup = newCorrelationWarmup();
    for (let index = 0; index < 5; index += 1) {
      recordClose(warmup, 'A', T0 + index * DAY, 1_000 + index);
      if (index >= 3) recordClose(warmup, 'B', T0 + index * DAY, 2_000 + index);
    }
    pruneWarmupCloses(warmup, 3);

    expect([...(warmup.closesBySymbol.get('A')?.keys() ?? [])]).toEqual([
      T0 + 2 * DAY,
      T0 + 3 * DAY,
      T0 + 4 * DAY,
    ]);
    expect([...(warmup.closesBySymbol.get('B')?.keys() ?? [])]).toEqual([
      T0 + 3 * DAY,
      T0 + 4 * DAY,
    ]);
  });
});
