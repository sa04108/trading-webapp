/**
 * 위저드 단계 이동 규칙의 단일 출처.
 *
 * 상단 버튼으로 원하는 단계에 바로 갈 수 있게 하되, 앞 단계를 건너뛰고 빈 폼을
 * 들고 제출 화면에 도착하는 길은 남기지 않는다. 규칙은 두 줄이다 —
 *
 * 1. 뒤로는 언제나 자유롭다. 이미 지나온 곳이므로 새로 검사할 것이 없다.
 * 2. 앞으로는 지나칠 단계가 모두 통과했을 때만, 그것도 '검토' 까지만 간다.
 *
 * 실행 단계를 점프 대상에서 빼는 건 안전장치다. 제출 버튼이 있는 화면에는 검토를
 * 눈으로 거쳐서만 들어오게 한다 — 잘못된 설정으로 큐를 채우는 실수를 한 단계
 * 늦추는 값이 그 불편보다 크다.
 *
 * 렌더링은 new-backtest-wizard.tsx 가 맡는다. 이 파일은 인덱스와 문자열만 다루므로
 * 컴포넌트 테스트 환경 없이 단위 테스트할 수 있다. 확장자 .js 와 별칭(@/) 회피는
 * prefill.ts 와 같은 이유다 — tests/unit 이 이 모듈을 NodeNext 프로그램에 편입한다.
 */
import type { WizardFormState } from './prefill.js';

export const WIZARD_STEPS = ['전략', '데이터·종목', '기간', '자본·비용', '검토', '실행'] as const;

const REVIEW_LABEL = '검토';

/** 앞으로 한 번에 갈 수 있는 마지막 단계 */
export const REVIEW_STEP = WIZARD_STEPS.indexOf(REVIEW_LABEL);

/** 제출 화면 — 점프로는 들어올 수 없고 검토에서 '다음' 을 눌러야 한다 */
export const RUN_STEP = WIZARD_STEPS.length - 1;

/**
 * 단계 게이트가 보는 값만. 파라미터·프로파일·시드는 여기서 보지 않는다 — 검토
 * 단계의 buildRequest 가 요청을 만들면서 한 번에 검사하고, 그 오류는 검토 화면에
 * 그대로 뜬다. 게이트가 같은 검사를 중복하면 규칙이 둘이 된다.
 */
export type StepGateState = Pick<
  WizardFormState,
  'strategyId' | 'datasetId' | 'symbols' | 'from' | 'to' | 'initialCash'
> & {
  /**
   * 고른 전략이 재무를 요구하는지. **모를 때는 undefined 여야 한다** — false 로 좁히면
   * 서버가 알려주지 않은 상황을 "재무 안 씀" 으로 단정해 게이트가 조용히 열린다
   * (D-032 의 배지와 같은 이유).
   */
  requiresFundamentals?: boolean;
  /**
   * 선택 종목 중 재무를 **가진** 코드. 종목 목록을 아직 못 받았으면 undefined 다 —
   * 빈 배열과 구분해야 한다: 빈 배열은 "전부 없다", undefined 는 "모른다" 다.
   */
  symbolsWithFacts?: readonly string[];
};

/** 이 단계를 아직 떠날 수 없는 이유. null 이면 통과 */
export function stepBlocker(index: number, state: StepGateState): string | null {
  switch (index) {
    case 0:
      return state.strategyId ? null : '전략을 선택하세요';
    case 1:
      if (!state.datasetId) return '데이터셋을 선택하세요';
      if (state.symbols.length === 0) return '종목을 1개 이상 선택하세요';
      return fundamentalsBlocker(state);
    case 2:
      if (!state.from || !state.to) return '시작일과 종료일을 입력하세요';
      if (state.from > state.to) return '시작일이 종료일보다 늦습니다';
      return null;
    case 3: {
      const cash = Number(state.initialCash);
      return Number.isFinite(cash) && cash > 0 ? null : '초기 자본이 올바르지 않습니다';
    }
    default:
      return null;
  }
}

/**
 * 재무 필요 전략 + 재무 없는 종목 조합을 제출 전에 막는다.
 *
 * **서버의 422 와 같은 조건이다** (`checkFundamentalsRequirement`): 선택 종목이 **전부**
 * 비었을 때만 막는다. 일부만 없는 경우는 거부 사유가 아니고 워커가 실행 경고에 이름으로
 * 남긴다 (D-025). 여기서 더 조이면 화면과 서버가 서로 다른 정책을 갖게 되고, 화면이
 * 막은 제출은 서버가 허용했을 것이라는 사실을 사용자가 알 방법이 없다.
 *
 * 모르는 상태에서는 통과시킨다 — `requiresFundamentals`·`symbolsWithFacts` 가 undefined
 * 면 아직 응답이 없거나 낡은 서버다. 근거 없이 막으면 사용자가 열 수 없는 문이 된다.
 * 그 경우의 방어선은 서버 422 가 그대로 맡는다.
 */
function fundamentalsBlocker(state: StepGateState): string | null {
  if (state.requiresFundamentals !== true) return null;
  if (state.symbolsWithFacts === undefined) return null;
  if (state.symbols.some((code) => state.symbolsWithFacts!.includes(code))) return null;
  return (
    '이 전략은 재무 데이터가 필요하지만 선택한 종목에는 없습니다 — ' +
    '종목 화면에서 「재무」를 함께 동기화하거나 봉만 쓰는 전략을 고르세요'
  );
}

/** 통과하지 못한 첫 단계. 전부 통과면 -1 */
export function firstIncompleteStep(state: StepGateState): number {
  return WIZARD_STEPS.findIndex((_, index) => stepBlocker(index, state) !== null);
}

/**
 * 지금 버튼으로 갈 수 있는 마지막 단계.
 *
 * n 단계에 들어가려면 그 앞이 모두 통과해야 하므로, 첫 미완료 단계가 곧 앞으로의
 * 상한이다. 현재 단계는 언제나 포함된다 — 뒤로 갈 길은 막지 않는다.
 */
export function navigableStepLimit(currentStep: number, state: StepGateState): number {
  const blocked = firstIncompleteStep(state);
  const forward = Math.min(blocked === -1 ? REVIEW_STEP : blocked, REVIEW_STEP);
  return Math.max(currentStep, forward);
}

/**
 * 잠긴 단계 버튼이 알려 줄 이유. 갈 수 있는 단계면 null.
 * 버튼을 `disabled` 로 죽이지 않고 이 문장을 오류 영역에 띄우는 쪽을 택했다 —
 * 왜 못 가는지 모른 채 회색 버튼만 보는 상태를 만들지 않는다.
 */
export function stepJumpBlockReason(
  index: number,
  currentStep: number,
  state: StepGateState,
): string | null {
  if (index <= navigableStepLimit(currentStep, state)) return null;
  if (index === RUN_STEP) return `'${REVIEW_LABEL}' 단계에서 '다음' 을 눌러 진행하세요`;
  const blocked = firstIncompleteStep(state);
  const label = WIZARD_STEPS[blocked];
  const reason = blocked === -1 ? null : stepBlocker(blocked, state);
  // navigableStepLimit 가 이미 통과시킨 조합이면 위에서 걸러졌다 — 타입 좁히기용 가드다
  if (label === undefined || reason === null) return null;
  return `'${label}' 단계를 먼저 마치세요 — ${reason}`;
}
