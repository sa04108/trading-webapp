import { describe, expect, it } from 'vitest';
import {
  addStage,
  changeStageLimit,
  moveStage,
  removeStage,
} from '../../src/web/features/backtests/universe-pipeline.js';

describe('addStage', () => {
  it('새 단계의 N 을 직전 단계 값으로 복사한다', () => {
    expect(addStage([{ criterion: 'MARKET_CAP', limit: 100 }], 'PER')).toEqual({
      stages: [
        { criterion: 'MARKET_CAP', limit: 100 },
        { criterion: 'PER', limit: 100 },
      ],
      changedIndices: [],
    });
  });

  it('급하락 단계를 추가하면 lookbackTradingDays 기본값 20 을 붙인다', () => {
    const result = addStage([{ criterion: 'MARKET_CAP', limit: 100 }], 'DECLINE');
    expect(result).toEqual({
      stages: [
        { criterion: 'MARKET_CAP', limit: 100 },
        { criterion: 'DECLINE', limit: 100, lookbackTradingDays: 20 },
      ],
      changedIndices: [],
    });
  });

  it('첫 단계가 없으면 200 을 기본값으로 쓴다', () => {
    expect(addStage([], 'MARKET_CAP')).toEqual({
      stages: [{ criterion: 'MARKET_CAP', limit: 200 }],
      changedIndices: [],
    });
  });

  it('이미 쓰인 criterion 은 거부한다', () => {
    expect(() => addStage([{ criterion: 'MARKET_CAP', limit: 100 }], 'MARKET_CAP')).toThrow();
  });

  it('6번째 단계 추가는 거부한다', () => {
    const fiveStages = [
      { criterion: 'MARKET_CAP' as const, limit: 100 },
      { criterion: 'VOLUME' as const, limit: 90 },
      { criterion: 'TRADING_VALUE' as const, limit: 80 },
      { criterion: 'PER' as const, limit: 70 },
      { criterion: 'DECLINE' as const, limit: 60, lookbackTradingDays: 20 },
    ];
    expect(() => addStage(fiveStages, 'MARKET_CAP')).toThrow();
  });
});

describe('changeStageLimit', () => {
  it('앞 단계 N 을 낮추면 뒤 단계까지 min(existing, previous) 로 cascade 한다', () => {
    expect(
      changeStageLimit(
        [
          { criterion: 'MARKET_CAP', limit: 100 },
          { criterion: 'PER', limit: 80 },
          { criterion: 'VOLUME', limit: 60 },
        ],
        0,
        50,
      ),
    ).toEqual({
      stages: [
        { criterion: 'MARKET_CAP', limit: 50 },
        { criterion: 'PER', limit: 50 },
        { criterion: 'VOLUME', limit: 50 },
      ],
      changedIndices: [1, 2],
    });
  });

  it('cascade 가 필요 없으면 changedIndices 가 빈 배열이다', () => {
    expect(
      changeStageLimit(
        [
          { criterion: 'MARKET_CAP', limit: 100 },
          { criterion: 'PER', limit: 80 },
        ],
        1,
        50,
      ),
    ).toEqual({
      stages: [
        { criterion: 'MARKET_CAP', limit: 100 },
        { criterion: 'PER', limit: 50 },
      ],
      changedIndices: [],
    });
  });

  it('DECLINE 단계의 lookbackTradingDays 는 cascade 뒤에도 보존한다', () => {
    const result = changeStageLimit(
      [
        { criterion: 'MARKET_CAP', limit: 100 },
        { criterion: 'DECLINE', limit: 80, lookbackTradingDays: 20 },
      ],
      0,
      50,
    );
    expect(result).toEqual({
      stages: [
        { criterion: 'MARKET_CAP', limit: 50 },
        { criterion: 'DECLINE', limit: 50, lookbackTradingDays: 20 },
      ],
      changedIndices: [1],
    });
  });
});

describe('moveStage', () => {
  it('뒤 단계를 앞으로 옮겨 앞 단계보다 커지면 뒤 단계까지 cascade 한다', () => {
    const result = moveStage(
      [
        { criterion: 'MARKET_CAP', limit: 90 },
        { criterion: 'PER', limit: 80 },
        { criterion: 'VOLUME', limit: 30 },
      ],
      1,
      0,
    );
    expect(result).toEqual({
      stages: [
        { criterion: 'PER', limit: 80 },
        { criterion: 'MARKET_CAP', limit: 80 },
        { criterion: 'VOLUME', limit: 30 },
      ],
      changedIndices: [1],
    });
  });

  it('cascade 가 필요 없는 이동은 changedIndices 가 빈 배열이다', () => {
    const result = moveStage(
      [
        { criterion: 'MARKET_CAP', limit: 100 },
        { criterion: 'PER', limit: 80 },
        { criterion: 'VOLUME', limit: 80 },
      ],
      1,
      2,
    );
    expect(result).toEqual({
      stages: [
        { criterion: 'MARKET_CAP', limit: 100 },
        { criterion: 'VOLUME', limit: 80 },
        { criterion: 'PER', limit: 80 },
      ],
      changedIndices: [],
    });
  });
});

describe('removeStage', () => {
  it('삭제 뒤에도 첫 원소부터 cascade 한다', () => {
    const result = removeStage(
      [
        { criterion: 'MARKET_CAP', limit: 50 },
        { criterion: 'PER', limit: 80 },
        { criterion: 'VOLUME', limit: 30 },
      ],
      2,
    );
    expect(result).toEqual({
      stages: [
        { criterion: 'MARKET_CAP', limit: 50 },
        { criterion: 'PER', limit: 50 },
      ],
      changedIndices: [1],
    });
  });

  it('마지막 한 단계는 삭제를 거부한다', () => {
    expect(() => removeStage([{ criterion: 'MARKET_CAP', limit: 100 }], 0)).toThrow();
  });
});
