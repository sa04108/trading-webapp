import { describe, expect, it } from 'vitest';
import {
  addStage,
  changeStageCriterion,
  changeStageDirection,
  changeStageLimit,
  moveStage,
  normalizePriceChangeLookbackInput,
  normalizeStageLimitInput,
  parseStageLimitInput,
  removeStage,
} from '../../src/web/features/backtests/universe-pipeline.js';

describe('changeStageCriterion', () => {
  it('PER로 바꾸면 선호 방향 LOW를 넣고 DECLINE 전용 조회기간을 제거한다', () => {
    expect(changeStageCriterion([
      { criterion: 'DECLINE', direction: 'LOW', limit: 50, lookbackTradingDays: 60 },
    ], 0, 'PER')).toEqual({
      stages: [{ criterion: 'PER', direction: 'LOW', limit: 50 }],
      changedIndices: [],
    });
  });

  it('가격 변동으로 바꾸면 선호 방향 HIGH와 조회기간 20일을 넣는다', () => {
    expect(changeStageCriterion([
      { criterion: 'MARKET_CAP', direction: 'LOW', limit: 50 },
    ], 0, 'DECLINE')).toEqual({
      stages: [{
        criterion: 'DECLINE', direction: 'HIGH', limit: 50, lookbackTradingDays: 20,
      }],
      changedIndices: [],
    });
  });
});

describe('changeStageDirection', () => {
  it('고른 단계의 방향만 바꾸고 cascade 표시를 만들지 않는다', () => {
    expect(changeStageDirection([
      { criterion: 'MARKET_CAP', direction: 'HIGH', limit: 100 },
      { criterion: 'PER', direction: 'LOW', limit: 50 },
    ], 1, 'HIGH')).toEqual({
      stages: [
        { criterion: 'MARKET_CAP', direction: 'HIGH', limit: 100 },
        { criterion: 'PER', direction: 'HIGH', limit: 50 },
      ],
      changedIndices: [],
    });
  });
});

describe('addStage', () => {
  it('새 단계의 N 을 직전 단계 값으로 복사한다', () => {
    expect(addStage([{ criterion: 'MARKET_CAP', direction: 'HIGH', limit: 100 }], 'PER')).toEqual({
      stages: [
        { criterion: 'MARKET_CAP', direction: 'HIGH', limit: 100 },
        { criterion: 'PER', direction: 'LOW', limit: 100 },
      ],
      changedIndices: [],
    });
  });

  it('급하락 단계를 추가하면 lookbackTradingDays 기본값 20 을 붙인다', () => {
    const result = addStage([{ criterion: 'MARKET_CAP', direction: 'HIGH', limit: 100 }], 'DECLINE');
    expect(result).toEqual({
      stages: [
        { criterion: 'MARKET_CAP', direction: 'HIGH', limit: 100 },
        { criterion: 'DECLINE', direction: 'HIGH', limit: 100, lookbackTradingDays: 20 },
      ],
      changedIndices: [],
    });
  });

  it('첫 단계가 없으면 200 을 기본값으로 쓴다', () => {
    expect(addStage([], 'MARKET_CAP')).toEqual({
      stages: [{ criterion: 'MARKET_CAP', direction: 'HIGH', limit: 200 }],
      changedIndices: [],
    });
  });

  it('이미 쓰인 criterion 은 거부한다', () => {
    expect(() => addStage([{ criterion: 'MARKET_CAP', direction: 'HIGH', limit: 100 }], 'MARKET_CAP')).toThrow();
  });

  it('6번째 단계 추가는 거부한다', () => {
    const fiveStages = [
      { criterion: 'MARKET_CAP' as const, direction: 'HIGH' as const, limit: 100 },
      { criterion: 'VOLUME' as const, direction: 'HIGH' as const, limit: 90 },
      { criterion: 'TRADING_VALUE' as const, direction: 'HIGH' as const, limit: 80 },
      { criterion: 'PER' as const, direction: 'LOW' as const, limit: 70 },
      { criterion: 'DECLINE' as const, direction: 'LOW' as const, limit: 60, lookbackTradingDays: 20 },
    ];
    expect(() => addStage(fiveStages, 'MARKET_CAP')).toThrow();
  });
});

describe('changeStageLimit', () => {
  it('앞 단계 N 을 낮추면 뒤 단계까지 min(existing, previous) 로 cascade 한다', () => {
    expect(
      changeStageLimit(
        [
          { criterion: 'MARKET_CAP', direction: 'HIGH', limit: 100 },
          { criterion: 'PER', direction: 'LOW', limit: 80 },
          { criterion: 'VOLUME', direction: 'HIGH', limit: 60 },
        ],
        0,
        50,
      ),
    ).toEqual({
      stages: [
        { criterion: 'MARKET_CAP', direction: 'HIGH', limit: 50 },
        { criterion: 'PER', direction: 'LOW', limit: 50 },
        { criterion: 'VOLUME', direction: 'HIGH', limit: 50 },
      ],
      changedIndices: [1, 2],
    });
  });

  it('cascade 가 필요 없으면 changedIndices 가 빈 배열이다', () => {
    expect(
      changeStageLimit(
        [
          { criterion: 'MARKET_CAP', direction: 'HIGH', limit: 100 },
          { criterion: 'PER', direction: 'LOW', limit: 80 },
        ],
        1,
        50,
      ),
    ).toEqual({
      stages: [
        { criterion: 'MARKET_CAP', direction: 'HIGH', limit: 100 },
        { criterion: 'PER', direction: 'LOW', limit: 50 },
      ],
      changedIndices: [],
    });
  });

  it('DECLINE 단계의 lookbackTradingDays 는 cascade 뒤에도 보존한다', () => {
    const result = changeStageLimit(
      [
        { criterion: 'MARKET_CAP', direction: 'HIGH', limit: 100 },
        { criterion: 'DECLINE', direction: 'LOW', limit: 80, lookbackTradingDays: 20 },
      ],
      0,
      50,
    );
    expect(result).toEqual({
      stages: [
        { criterion: 'MARKET_CAP', direction: 'HIGH', limit: 50 },
        { criterion: 'DECLINE', direction: 'LOW', limit: 50, lookbackTradingDays: 20 },
      ],
      changedIndices: [1],
    });
  });
});

describe('moveStage', () => {
  it('뒤 단계를 앞으로 옮겨 앞 단계보다 커지면 뒤 단계까지 cascade 한다', () => {
    const result = moveStage(
      [
        { criterion: 'MARKET_CAP', direction: 'HIGH', limit: 90 },
        { criterion: 'PER', direction: 'LOW', limit: 80 },
        { criterion: 'VOLUME', direction: 'HIGH', limit: 30 },
      ],
      1,
      0,
    );
    expect(result).toEqual({
      stages: [
        { criterion: 'PER', direction: 'LOW', limit: 80 },
        { criterion: 'MARKET_CAP', direction: 'HIGH', limit: 80 },
        { criterion: 'VOLUME', direction: 'HIGH', limit: 30 },
      ],
      changedIndices: [1],
    });
  });

  it('cascade 가 필요 없는 이동은 changedIndices 가 빈 배열이다', () => {
    const result = moveStage(
      [
        { criterion: 'MARKET_CAP', direction: 'HIGH', limit: 100 },
        { criterion: 'PER', direction: 'LOW', limit: 80 },
        { criterion: 'VOLUME', direction: 'HIGH', limit: 80 },
      ],
      1,
      2,
    );
    expect(result).toEqual({
      stages: [
        { criterion: 'MARKET_CAP', direction: 'HIGH', limit: 100 },
        { criterion: 'VOLUME', direction: 'HIGH', limit: 80 },
        { criterion: 'PER', direction: 'LOW', limit: 80 },
      ],
      changedIndices: [],
    });
  });
});

describe('removeStage', () => {
  it('삭제 뒤에도 첫 원소부터 cascade 한다', () => {
    const result = removeStage(
      [
        { criterion: 'MARKET_CAP', direction: 'HIGH', limit: 50 },
        { criterion: 'PER', direction: 'LOW', limit: 80 },
        { criterion: 'VOLUME', direction: 'HIGH', limit: 30 },
      ],
      2,
    );
    expect(result).toEqual({
      stages: [
        { criterion: 'MARKET_CAP', direction: 'HIGH', limit: 50 },
        { criterion: 'PER', direction: 'LOW', limit: 50 },
      ],
      changedIndices: [1],
    });
  });

  it('마지막 한 단계는 삭제를 거부한다', () => {
    expect(() => removeStage([{ criterion: 'MARKET_CAP', direction: 'HIGH', limit: 100 }], 0)).toThrow();
  });
});

describe('parseStageLimitInput', () => {
  // HTML max 속성은 키보드 입력을 막지 않는다 — 첫 단계는 cascadeLimits 가 절대
  // 건드리지 않으므로(리뷰 지적), 이 함수가 changeStageLimit() 앞에서 상한을
  // 확인해야 500 같은 값이 그대로 상태에 반영되지 않는다.
  it('첫 단계 상한(200)을 넘는 입력은 거부한다', () => {
    expect(parseStageLimitInput('500', 200)).toBeNull();
  });

  it('상한 이하의 정수는 그대로 통과시킨다', () => {
    expect(parseStageLimitInput('200', 200)).toBe(200);
    expect(parseStageLimitInput('1', 200)).toBe(1);
  });

  it('뒤 단계는 직전 단계 값(예: 80)을 넘는 입력을 거부한다', () => {
    expect(parseStageLimitInput('81', 80)).toBeNull();
    expect(parseStageLimitInput('80', 80)).toBe(80);
  });

  it('정수가 아니거나 1 미만인 입력은 거부한다', () => {
    expect(parseStageLimitInput('0', 200)).toBeNull();
    expect(parseStageLimitInput('1.5', 200)).toBeNull();
    expect(parseStageLimitInput('', 200)).toBeNull();
  });
});

describe('normalizeStageLimitInput', () => {
  it('빈 값과 정수가 아닌 값은 직전 유효값을 복구한다', () => {
    expect(normalizeStageLimitInput('', 37, 200)).toBe(37);
    expect(normalizeStageLimitInput('1.5', 37, 200)).toBe(37);
  });

  it('범위 밖 정수는 1과 현재 단계 상한으로 clamp한다', () => {
    expect(normalizeStageLimitInput('0', 37, 200)).toBe(1);
    expect(normalizeStageLimitInput('-5', 37, 200)).toBe(1);
    expect(normalizeStageLimitInput('500', 37, 200)).toBe(200);
    expect(normalizeStageLimitInput('81', 37, 80)).toBe(80);
  });

  it('범위 안 정수는 그대로 확정한다', () => {
    expect(normalizeStageLimitInput('42', 37, 200)).toBe(42);
  });
});

describe('normalizePriceChangeLookbackInput', () => {
  it('빈 값과 정수가 아닌 값은 직전 유효값을 복구한다', () => {
    expect(normalizePriceChangeLookbackInput('', 20)).toBe(20);
    expect(normalizePriceChangeLookbackInput('1.5', 20)).toBe(20);
  });

  it('범위 밖 정수는 1~252 거래일로 보정한다', () => {
    expect(normalizePriceChangeLookbackInput('0', 20)).toBe(1);
    expect(normalizePriceChangeLookbackInput('-5', 20)).toBe(1);
    expect(normalizePriceChangeLookbackInput('253', 20)).toBe(252);
  });

  it('범위 안 정수는 그대로 확정한다', () => {
    expect(normalizePriceChangeLookbackInput('60', 20)).toBe(60);
  });
});
