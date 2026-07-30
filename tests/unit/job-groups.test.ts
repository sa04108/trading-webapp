import { describe, expect, it } from 'vitest';
import { groupJobsByStrategy } from '../../src/web/features/backtests/job-groups.js';

function job(strategyId: string, createdAtMs: number): { strategyId: string; createdAtMs: number } {
  return { strategyId, createdAtMs };
}

describe('groupJobsByStrategy', () => {
  it('전략별로 묶고, 그룹 내부는 최신순으로 정렬한다', () => {
    const groups = groupJobsByStrategy([
      job('rsi-reversion', 100),
      job('ema-trend-switch', 200),
      job('rsi-reversion', 300),
    ]);
    expect(groups.map((g) => g.strategyId)).toEqual(['rsi-reversion', 'ema-trend-switch']);
    expect(groups[0]?.jobs.map((j) => j.createdAtMs)).toEqual([300, 100]);
  });

  it('그룹 순서는 그룹 내 최신 잡의 생성 시각 내림차순이다', () => {
    const groups = groupJobsByStrategy([
      job('a', 500),
      job('b', 900),
      job('a', 100),
    ]);
    expect(groups.map((g) => g.strategyId)).toEqual(['b', 'a']);
  });

  it('빈 목록이면 빈 배열', () => {
    expect(groupJobsByStrategy([])).toEqual([]);
  });
});
