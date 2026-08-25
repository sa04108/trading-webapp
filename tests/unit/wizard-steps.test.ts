import { describe, expect, it } from 'vitest';
import {
  firstIncompleteStep,
  navigableStepLimit,
  reachableStepFromUrl,
  REVIEW_STEP,
  RUN_STEP,
  stepBlocker,
  stepIndexOf,
  stepJumpBlockReason,
  stepSlug,
  WIZARD_STEP_SLUGS,
  WIZARD_STEPS,
  type StepGateState,
} from '../../src/web/features/backtests/wizard-steps.js';

/** 전 단계를 통과하는 상태 — 각 테스트는 여기서 한 가지만 무너뜨린다 */
const complete: StepGateState = {
  strategyId: 'range-breakout',
  from: '2026-01-05',
  to: '2026-03-31',
  benchmarkCoverageOk: true,
  initialCash: '10000000',
  universePreviewOk: true,
  unionSymbols: ['005930'],
};

const empty: StepGateState = {
  strategyId: null,
  from: '',
  to: '',
  benchmarkCoverageOk: false,
  initialCash: '10000000',
  universePreviewOk: false,
  unionSymbols: [],
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

  it('기간은 두 날짜가 있어야 하고 순서도 맞아야 한다', () => {
    expect(stepBlocker(1, { ...complete, to: '' })).toBe('시작일과 종료일을 입력하세요');
    expect(stepBlocker(1, { ...complete, from: '2026-04-01' })).toBe(
      '시작일이 종료일보다 늦습니다',
    );
    // 같은 날 하루짜리 기간은 허용한다
    expect(stepBlocker(1, { ...complete, from: '2026-03-31' })).toBeNull();
    expect(stepBlocker(1, { ...complete, benchmarkCoverageOk: false })).toBe(
      '벤치마크 기간을 확인하세요',
    );
  });

  it('유니버스 규칙 미리보기가 성공해야 통과한다', () => {
    expect(stepBlocker(2, { ...complete, universePreviewOk: false })).toBe(
      '유니버스 규칙을 미리보기하고 경고를 모두 해결하세요',
    );
    expect(stepBlocker(2, complete)).toBeNull();
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
    // 전략만 고른 상태 — 기간까지는 갈 수 있고 그 뒤는 못 간다
    expect(navigableStepLimit(0, { ...empty, strategyId: 'x' })).toBe(1);
    expect(navigableStepLimit(1, { ...complete, benchmarkCoverageOk: false })).toBe(1);
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
      "'기간' 단계를 먼저 마치세요 — 시작일과 종료일을 입력하세요",
    );
    expect(stepJumpBlockReason(2, 1, { ...complete, benchmarkCoverageOk: false })).toBe(
      "'기간' 단계를 먼저 마치세요 — 벤치마크 기간을 확인하세요",
    );
  });

  it('막힌 이유는 첫 미완료 단계 것 하나다', () => {
    expect(stepJumpBlockReason(3, 0, empty)).toBe(
      "'전략' 단계를 먼저 마치세요 — 전략을 선택하세요",
    );
  });

  it('실행 단계에서 뒤로 물러난 뒤 다시 앞을 보면 검토까지만 열린다', () => {
    const stepped = 2; // 실행까지 갔다가 유니버스 단계로 돌아온 상황
    expect(stepJumpBlockReason(REVIEW_STEP, stepped, complete)).toBeNull();
    expect(stepJumpBlockReason(RUN_STEP, stepped, complete)).toBe(
      "'검토' 단계에서 '다음' 을 눌러 진행하세요",
    );
  });
});

/**
 * 재무 필요 전략 + 재무 없는 유니버스 게이트 (D-034 후속).
 * 완료 preview의 PIT 실제 재무 기준으로 전 종목이 비었을 때만 막고, 일부만 없으면
 * 통과시켜 worker 경고에 맡긴다. coverage 결측은 preview 완료 전에 막힌다(D-069).
 */
describe('stepBlocker — 재무 조합 게이트 (단계 2)', () => {
  const base = {
    ...complete,
    unionSymbols: ['005930', '000660'],
    requiresFundamentals: true,
  };

  it('전 종목에 재무가 없으면 막는다', () => {
    const reason = stepBlocker(2, { ...base, symbolsWithFacts: [] });
    expect(reason).toMatch(/coverage 기록은 있지만.*재무 데이터/);
    expect(reason).toMatch(/기간 종료일·유니버스·전략/);
    expect(reason).not.toContain('미리보기');
  });

  it('한 종목이라도 실제 PIT 재무가 있으면 통과한다 — 서버 422 와 같은 조건이다', () => {
    // 일부만 없는 경우는 거부 사유가 아니다: 신규 상장처럼 이력이 짧은 종목 하나 때문에
    // 유니버스 전체를 막지 않는다. 빠진 종목은 워커가 실행 경고에 이름으로 남긴다.
    expect(stepBlocker(2, { ...base, symbolsWithFacts: ['005930'] })).toBeNull();
  });

  it('선택과 무관한 종목의 재무는 통과 근거가 아니다', () => {
    expect(stepBlocker(2, { ...base, symbolsWithFacts: ['035420'] })).not.toBeNull();
  });

  it('봉만 쓰는 전략은 재무가 없어도 통과한다', () => {
    expect(
      stepBlocker(2, { ...base, requiresFundamentals: false, symbolsWithFacts: [] }),
    ).toBeNull();
  });

  it('전략의 재무 요구를 모르면 막지 않는다 — 근거 없이 문을 잠그지 않는다', () => {
    // 서버가 필드를 안 내렸거나 응답이 아직 없는 상태. false 로 좁히면 게이트가 조용히
    // 열리고, true 로 좁히면 열 수 없는 문이 된다 — 둘 다 아니라 통과 + 서버 422 방어선.
    expect(
      stepBlocker(2, { ...base, requiresFundamentals: undefined, symbolsWithFacts: [] }),
    ).toBeNull();
  });

  it('종목 목록이 아직 없으면 막지 않는다 — undefined 와 빈 배열을 구분한다', () => {
    expect(stepBlocker(2, { ...base, symbolsWithFacts: undefined })).toBeNull();
  });

  it('미리보기가 안 됐으면 재무 검사보다 먼저 막는다 — 원인을 뒤집어 말하지 않는다', () => {
    expect(
      stepBlocker(2, { ...base, universePreviewOk: false, symbolsWithFacts: [] }),
    ).toBe('유니버스 규칙을 미리보기하고 경고를 모두 해결하세요');
  });
});

describe('단계 slug', () => {
  it('라벨과 개수가 같다 — 어긋나면 URL 이 다른 단계를 가리킨다', () => {
    expect(WIZARD_STEP_SLUGS).toHaveLength(WIZARD_STEPS.length);
  });

  it('인덱스 → slug → 인덱스 왕복이 제자리로 돌아온다', () => {
    WIZARD_STEPS.forEach((_, index) => {
      expect(stepIndexOf(stepSlug(index))).toBe(index);
    });
  });

  it('범위 밖 인덱스는 첫 단계 slug 다', () => {
    expect(stepSlug(-1)).toBe('strategy');
    expect(stepSlug(WIZARD_STEPS.length)).toBe('strategy');
  });

  it('모르는 slug 와 undefined 는 null 이다 — 호출부가 첫 단계로 되돌린다', () => {
    expect(stepIndexOf('헛것')).toBeNull();
    expect(stepIndexOf('')).toBeNull();
    expect(stepIndexOf(undefined)).toBeNull();
  });
});

describe('reachableStepFromUrl', () => {
  /** 새로 열린 화면 — 지나온 단계도 없고 검토도 지나지 않았다 */
  const fresh = { traversed: 0, reviewPassed: false };

  it('빈 폼으로는 첫 단계까지만 — 딥링크는 현재 단계를 근거로 삼지 못한다', () => {
    expect(reachableStepFromUrl(empty, fresh)).toBe(0);
  });

  it('벤치마크 기간을 확인하기 전에는 유니버스 딥링크를 열지 않는다', () => {
    expect(reachableStepFromUrl({ ...complete, benchmarkCoverageOk: false }, fresh)).toBe(1);
  });

  it('전 단계를 통과해도 검토를 지나지 않았으면 검토가 상한이다', () => {
    expect(reachableStepFromUrl(complete, fresh)).toBe(REVIEW_STEP);
  });

  it('검토를 눈으로 지난 뒤에만 실행 단계에 닿는다', () => {
    expect(reachableStepFromUrl(complete, { traversed: RUN_STEP, reviewPassed: true })).toBe(
      RUN_STEP,
    );
  });

  it('실제로 지나온 단계는 게이트가 뒤늦게 무너져도 유지된다 — 서 있던 자리에서 밀어내지 않는다', () => {
    // 미리보기가 무효화한 ['symbols'] 재조회가 도착해 재무 게이트가 뒤집힌 상황
    const brokenUniverse: StepGateState = {
      ...complete,
      requiresFundamentals: true,
      symbolsWithFacts: [],
    };
    expect(reachableStepFromUrl(brokenUniverse, fresh)).toBe(2);
    expect(reachableStepFromUrl(brokenUniverse, { traversed: REVIEW_STEP, reviewPassed: false })).toBe(
      REVIEW_STEP,
    );
  });

  it('지나온 단계만으로는 실행 단계가 열리지 않는다 — 검토를 다시 지나야 한다', () => {
    // 실행까지 갔다가 자본 단계로 돌아가면 위저드가 reviewPassed 를 끈다. 그 뒤
    // 앞으로가기로 제출 화면에 되돌아오는 길이 traversed 로 열려선 안 된다.
    expect(reachableStepFromUrl(complete, { traversed: RUN_STEP, reviewPassed: false })).toBe(
      REVIEW_STEP,
    );
  });

  it('검토를 지났으면 게이트가 무너져도 실행 단계에 머문다 — 제출 화면이 클릭 도중 사라지지 않는다', () => {
    const brokenPeriod: StepGateState = { ...complete, from: '', to: '' };
    expect(reachableStepFromUrl(brokenPeriod, { traversed: RUN_STEP, reviewPassed: true })).toBe(
      RUN_STEP,
    );
  });
});
