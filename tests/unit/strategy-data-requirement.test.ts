import { describe, expect, it } from 'vitest';
import {
  STRATEGY_DATA_DETAILS,
  STRATEGY_DATA_LABELS,
  strategyDataRequirement,
} from '../../src/web/features/backtests/strategy-data-requirement.js';

describe('strategyDataRequirement', () => {
  it('true 는 재무, false 는 봉 전용으로 가른다', () => {
    expect(strategyDataRequirement(true)).toBe('FUNDAMENTALS');
    expect(strategyDataRequirement(false)).toBe('BARS_ONLY');
  });

  it('필드가 없으면 null — false 로 뭉개지 않는다', () => {
    // 여기서 BARS_ONLY 를 돌려주면 재무 전략에 「봉 데이터만」이 붙어, 사용자가
    // 피하려던 상황을 화면이 보증한다. 잘못 안심시키는 것보다 말하지 않는 게 낫다.
    expect(strategyDataRequirement(undefined)).toBeNull();
  });
});

describe('표시 문구', () => {
  it('두 상태 모두 라벨과 설명이 있다 — 배지 없음을 봉 전용으로 읽게 두지 않는다', () => {
    for (const requirement of ['FUNDAMENTALS', 'BARS_ONLY'] as const) {
      expect(STRATEGY_DATA_LABELS[requirement]).toBeTruthy();
      expect(STRATEGY_DATA_DETAILS[requirement]).toBeTruthy();
    }
  });

  it('봉 전용 설명은 재무가 개입하지 않는다고 분명히 말한다', () => {
    expect(STRATEGY_DATA_DETAILS.BARS_ONLY).toContain('OHLCV');
    expect(STRATEGY_DATA_DETAILS.BARS_ONLY).toContain('재무');
  });

  it('재무 전략 설명은 데이터셋 조건까지 알려준다 — 제출 단계 422 를 미리 막는다', () => {
    expect(STRATEGY_DATA_DETAILS.FUNDAMENTALS).toContain('데이터셋');
  });
});
