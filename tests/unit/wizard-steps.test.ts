import { describe, expect, it } from 'vitest';
import {
  firstIncompleteStep,
  navigableStepLimit,
  REVIEW_STEP,
  RUN_STEP,
  stepBlocker,
  stepJumpBlockReason,
  WIZARD_STEPS,
  type StepGateState,
} from '../../src/web/features/backtests/wizard-steps.js';

/** 전 단계를 통과하는 상태 — 각 테스트는 여기서 한 가지만 무너뜨린다 */
const complete: StepGateState = {
  strategyId: 'hourly-breakout',
  datasetId: 'ds_1',
  symbols: ['005930'],
  from: '2026-01-05',
  to: '2026-03-31',
  initialCash: '10000000',
};

const empty: StepGateState = {
  strategyId: null,
  datasetId: null,
  symbols: [],
  from: '',
  to: '',
  initialCash: '10000000',
};

describe('단계 상수', () => {
  it('검토는 앞으로 갈 수 있는 마지막 단계이고 실행은 그 뒤다', () => {
    expect(WIZARD_STEPS[REVIEW_STEP]).toBe('검토');
    expect(WIZARD_STEPS[RUN_STEP]).toBe('실행');
    expect(RUN_STEP).toBe(REVIEW_STEP + 1);
  });
});

describe('stepBlocker', () => {
  it('전략을 고르지 않으면 0단계에서 막힌다', () => {
    expect(stepBlocker(0, { ...complete, strategyId: null })).toBe('전략을 선택하세요');
    expect(stepBlocker(0, complete)).toBeNull();
  });

  it('데이터셋과 종목을 각각 확인한다', () => {
    expect(stepBlocker(1, { ...complete, datasetId: null })).toBe('데이터셋을 선택하세요');
    expect(stepBlocker(1, { ...complete, symbols: [] })).toBe('종목을 1개 이상 선택하세요');
    expect(stepBlocker(1, complete)).toBeNull();
  });

  it('기간은 두 날짜가 있어야 하고 순서도 맞아야 한다', () => {
    expect(stepBlocker(2, { ...complete, to: '' })).toBe('시작일과 종료일을 입력하세요');
    expect(stepBlocker(2, { ...complete, from: '2026-04-01' })).toBe(
      '시작일이 종료일보다 늦습니다',
    );
    // 같은 날 하루짜리 기간은 허용한다
    expect(stepBlocker(2, { ...complete, from: '2026-03-31' })).toBeNull();
  });

  it('초기 자본은 양수여야 한다', () => {
    const message = '초기 자본이 올바르지 않습니다';
    expect(stepBlocker(3, { ...complete, initialCash: '' })).toBe(message);
    expect(stepBlocker(3, { ...complete, initialCash: '0' })).toBe(message);
    expect(stepBlocker(3, { ...complete, initialCash: '-1' })).toBe(message);
    expect(stepBlocker(3, { ...complete, initialCash: 'abc' })).toBe(message);
    expect(stepBlocker(3, complete)).toBeNull();
  });

  it('검토·실행 단계에는 게이트가 없다 — 요청 조립이 검사를 맡는다', () => {
    expect(stepBlocker(REVIEW_STEP, empty)).toBeNull();
    expect(stepBlocker(RUN_STEP, empty)).toBeNull();
  });
});

describe('firstIncompleteStep', () => {
  it('전부 통과하면 -1 이다', () => {
    expect(firstIncompleteStep(complete)).toBe(-1);
  });

  it('앞쪽 미완료를 먼저 집는다 — 여러 곳이 비어도 하나만 안내한다', () => {
    expect(firstIncompleteStep(empty)).toBe(0);
    expect(firstIncompleteStep({ ...empty, strategyId: 'x' })).toBe(1);
  });
});

describe('navigableStepLimit', () => {
  it('입력이 다 차 있어도 앞으로는 검토까지다 — 실행은 점프 대상이 아니다', () => {
    expect(navigableStepLimit(0, complete)).toBe(REVIEW_STEP);
  });

  it('첫 미완료 단계가 앞으로의 상한이다', () => {
    // 전략만 고른 상태 — 데이터·종목까지는 갈 수 있고 그 뒤는 못 간다
    expect(navigableStepLimit(0, { ...empty, strategyId: 'x' })).toBe(1);
    expect(navigableStepLimit(0, empty)).toBe(0);
  });

  it('현재 단계는 언제나 포함된다 — 뒤로 가는 길은 막지 않는다', () => {
    // 실행 단계에 서서 폼을 비워도 지금 자리와 그 앞은 전부 열려 있다
    expect(navigableStepLimit(RUN_STEP, empty)).toBe(RUN_STEP);
    expect(navigableStepLimit(2, empty)).toBe(2);
  });
});

describe('stepJumpBlockReason', () => {
  it('갈 수 있는 단계는 이유가 없다', () => {
    expect(stepJumpBlockReason(REVIEW_STEP, 0, complete)).toBeNull();
    expect(stepJumpBlockReason(0, REVIEW_STEP, complete)).toBeNull();
  });

  it('실행은 폼이 완전해도 잠긴다 — 검토에서 다음을 누르라고 알린다', () => {
    expect(stepJumpBlockReason(RUN_STEP, REVIEW_STEP, complete)).toBe(
      "'검토' 단계에서 '다음' 을 눌러 진행하세요",
    );
  });

  it('실행 단계에 도착한 뒤에는 그 버튼이 현재 자리이므로 잠기지 않는다', () => {
    expect(stepJumpBlockReason(RUN_STEP, RUN_STEP, complete)).toBeNull();
  });

  it('앞 단계가 비면 어느 단계를 먼저 마쳐야 하는지 알린다', () => {
    expect(stepJumpBlockReason(REVIEW_STEP, 0, { ...empty, strategyId: 'x' })).toBe(
      "'데이터·종목' 단계를 먼저 마치세요 — 데이터셋을 선택하세요",
    );
  });

  it('막힌 이유는 첫 미완료 단계 것 하나다', () => {
    expect(stepJumpBlockReason(3, 0, empty)).toBe(
      "'전략' 단계를 먼저 마치세요 — 전략을 선택하세요",
    );
  });

  it('실행 단계에서 뒤로 물러난 뒤 다시 앞을 보면 검토까지만 열린다', () => {
    const stepped = 2; // 실행까지 갔다가 기간 단계로 돌아온 상황
    expect(stepJumpBlockReason(REVIEW_STEP, stepped, complete)).toBeNull();
    expect(stepJumpBlockReason(RUN_STEP, stepped, complete)).toBe(
      "'검토' 단계에서 '다음' 을 눌러 진행하세요",
    );
  });
});
