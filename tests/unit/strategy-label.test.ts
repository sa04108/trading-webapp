import { describe, expect, it } from 'vitest';
import { strategyLabel } from '../../src/web/features/backtests/strategy-label.js';

const STRATEGIES = [
  { id: 'cross-sectional-momentum', name: '횡단면 모멘텀' },
  { id: 'range-breakout', name: '전고점 돌파' },
];

describe('strategyLabel', () => {
  it('등록된 전략은 한국어 이름으로 바꾼다', () => {
    expect(strategyLabel('cross-sectional-momentum', STRATEGIES)).toBe('횡단면 모멘텀');
  });

  it('목록에 없는 전략은 strategyId 를 그대로 쓴다 — 등록이 풀린 전략의 지난 결과가 빈칸이 되면 안 된다', () => {
    expect(strategyLabel('deleted-strategy', STRATEGIES)).toBe('deleted-strategy');
  });

  it('응답이 아직 없으면 strategyId 를 쓴다 — 로딩 중 빈칸이 깜빡이면 안 된다', () => {
    expect(strategyLabel('range-breakout', undefined)).toBe('range-breakout');
  });
});
