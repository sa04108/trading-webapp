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

/**
 * '기간' 이 '유니버스' 보다 앞이다(리뷰 fix — 원래 유니버스가 먼저였다).
 * `POST /backtests/universe-preview` 는 리밸런스 날짜 계산에 기간이 필요한데, 기간이
 * 뒤에 있으면 유니버스 단계에 들어갈 때 기간이 아직 없어 미리보기를 만들 수 없는
 * 교착이 생긴다. 기간을 먼저 확정해야 유니버스 단계가 그 값을 그대로 쓸 수 있다.
 */
export const WIZARD_STEPS = ['전략', '기간', '유니버스', '자본·비용', '검토', '실행'] as const;

/**
 * URL 에 쓰는 단계 이름. 화면 라벨(`WIZARD_STEPS`)에서 만들지 않는다 — 라벨은 문구라
 * 언제든 바뀌고, 바뀌면 공유된 옛 링크가 죽는다. 순서는 `WIZARD_STEPS` 와 같고, 두
 * 배열의 길이가 같은지는 단위 테스트가 지킨다.
 */
export const WIZARD_STEP_SLUGS = [
  'strategy',
  'period',
  'universe',
  'capital',
  'review',
  'run',
] as const;

export type WizardStepSlug = (typeof WIZARD_STEP_SLUGS)[number];

/** 범위 밖 인덱스는 첫 단계로 접는다 — 호출부가 따로 실패를 다루지 않게 한다 */
export function stepSlug(index: number): WizardStepSlug {
  return WIZARD_STEP_SLUGS[index] ?? WIZARD_STEP_SLUGS[0];
}

/** 모르는 slug 는 null. 호출부(위저드)가 첫 단계로 되돌린다 */
export function stepIndexOf(slug: string | undefined): number | null {
  const index = (WIZARD_STEP_SLUGS as readonly string[]).indexOf(slug ?? '');
  return index === -1 ? null : index;
}

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
export type StepGateState = Pick<WizardFormState, 'strategyId' | 'from' | 'to' | 'initialCash'> & {
  /**
   * 유니버스 규칙 미리보기가 **지금 값 기준으로** 성공했고, 그 결과에 uncoveredDates·
   * missingCandleSymbols 가 하나도 없는지 (스펙 2026-08-05). 종목 수 상한(200)은 이제
   * `universeRuleSchema` 의 `topN` 자체가 막으므로 이 게이트가 따로 세지 않는다 —
   * `UniverseRuleStep` 의 입력이 애초에 그 범위를 벗어나지 못한다.
   *
   * new-backtest-wizard.tsx 가 매 렌더 다시 계산하는 값이다(state 로 저장해 두고
   * 수동으로 무효화하지 않는다) — `UniverseRuleStep` 이 화면에 없어도(다른 단계에
   * 있어도) 규칙·기간이 바뀌면 다음 렌더에 바로 false 가 된다. 컴포넌트 마운트
   * 생명주기에 매달아 두면, 유니버스 단계를 벗어난 뒤 '기간' 을 바꿔도 이 값이 낡은
   * true 로 남는 버그가 생긴다(리뷰에서 지적).
   */
  universePreviewOk: boolean;
  /**
   * 고른 전략이 재무를 요구하는지. **모를 때는 undefined 여야 한다** — false 로 좁히면
   * 서버가 알려주지 않은 상황을 "재무 안 씀" 으로 단정해 게이트가 조용히 열린다
   * (D-032 의 배지와 같은 이유).
   */
  requiresFundamentals?: boolean;
  /**
   * 유니버스 종목 중 재무를 **가진** 코드. 종목 목록을 아직 못 받았으면 undefined 다 —
   * 빈 배열과 구분해야 한다: 빈 배열은 "전부 없다", undefined 는 "모른다" 다.
   */
  symbolsWithFacts?: readonly string[];
  /**
   * 마지막으로 유효했던 미리보기의 unionSymbols. 유니버스는 더 이상 화면이 고르는
   * 종목 목록이 아니라 서버가 규칙으로 재구성한 결과라서(스펙 2026-08-05), 재무 게이트가
   * 볼 "선택 종목" 도 이 목록이다.
   */
  unionSymbols: readonly string[];
};

/** 이 단계를 아직 떠날 수 없는 이유. null 이면 통과 */
export function stepBlocker(index: number, state: StepGateState): string | null {
  switch (index) {
    case 0:
      return state.strategyId ? null : '전략을 선택하세요';
    case 1:
      if (!state.from || !state.to) return '시작일과 종료일을 입력하세요';
      if (state.from > state.to) return '시작일이 종료일보다 늦습니다';
      return null;
    case 2:
      if (!state.universePreviewOk) {
        return '유니버스 규칙을 미리보기하고 경고를 모두 해결하세요';
      }
      return fundamentalsBlocker(state);
    case 3: {
      const cash = Number(state.initialCash);
      return Number.isFinite(cash) && cash > 0 ? null : '초기 자본이 올바르지 않습니다';
    }
    default:
      return null;
  }
}

/**
 * 재무 필요 전략 + 재무 없는 유니버스 조합을 제출 전에 막는다.
 *
 * **서버의 422 와 같은 조건이다** (`checkFundamentalsRequirement`): unionSymbols 가
 * **전부** 비었을 때만 막는다. 일부만 없는 경우는 거부 사유가 아니고 워커가 실행 경고에
 * 이름으로 남긴다 (D-025). 여기서 더 조이면 화면과 서버가 서로 다른 정책을 갖게 되고, 화면이
 * 막은 제출은 서버가 허용했을 것이라는 사실을 사용자가 알 방법이 없다.
 *
 * 모르는 상태에서는 통과시킨다 — `requiresFundamentals`·`symbolsWithFacts` 가 undefined
 * 면 아직 응답이 없거나 낡은 서버다. 근거 없이 막으면 사용자가 열 수 없는 문이 된다.
 * 그 경우의 방어선은 서버 422 가 그대로 맡는다.
 */
function fundamentalsBlocker(state: StepGateState): string | null {
  if (state.requiresFundamentals !== true) return null;
  if (state.symbolsWithFacts === undefined) return null;
  if (state.unionSymbols.some((code) => state.symbolsWithFacts!.includes(code))) return null;
  return (
    '이 전략은 재무 데이터가 필요하지만 이 유니버스에는 재무 있는 종목이 없습니다 — ' +
    '미리보기를 다시 실행해 데이터 준비를 완료하거나 봉만 쓰는 전략을 고르세요'
  );
}

/** 통과하지 못한 첫 단계. 전부 통과면 -1 */
export function firstIncompleteStep(state: StepGateState): number {
  return WIZARD_STEPS.findIndex((_, index) => stepBlocker(index, state) !== null);
}

/** 앞으로 갈 수 있는 상한. 현재 단계를 근거로 삼지 않는 순수한 값이다 */
function forwardStepLimit(state: StepGateState): number {
  const blocked = firstIncompleteStep(state);
  return Math.min(blocked === -1 ? REVIEW_STEP : blocked, REVIEW_STEP);
}

/**
 * 지금 버튼으로 갈 수 있는 마지막 단계.
 *
 * n 단계에 들어가려면 그 앞이 모두 통과해야 하므로, 첫 미완료 단계가 곧 앞으로의
 * 상한이다. 현재 단계는 언제나 포함된다 — 뒤로 갈 길은 막지 않는다.
 */
export function navigableStepLimit(currentStep: number, state: StepGateState): number {
  return Math.max(currentStep, forwardStepLimit(state));
}

/**
 * 게이트 밖에서 URL 도달 판정에 필요한 사실. 둘 다 이 페이지 세션에 매인 값이라
 * 새로고침하면 0·false 로 돌아간다 — 그래서 딥링크는 게이트로만 판정된다.
 */
export interface UrlStepAccess {
  /** 위저드가 스스로 이동해 실제로 도달한 가장 앞 단계 */
  traversed: number;
  /** 검토 단계에서 '다음' 을 눌렀는지 */
  reviewPassed: boolean;
}

/**
 * URL 이 가리켜도 되는 최대 단계.
 *
 * `navigableStepLimit` 을 쓸 수 없는 이유: 그쪽은 **지금 서 있는** 단계를 무조건
 * 통과시키는데, URL 은 딥링크·새로고침으로 아무 단계나 가리킬 수 있어 현재 단계 자체가
 * 근거가 못 된다. 대신 "이 세션에서 실제로 지나온 단계" 를 근거로 삼는다.
 *
 * `traversed` 를 보는 이유(규칙 1 — 지나온 곳은 다시 검사하지 않는다): 게이트는 뒤늦게
 * 무너질 수 있다. 유니버스 미리보기가 성공하면 그 자리에서 `['symbols']` 를 무효화하고,
 * 그 재조회가 도착하는 순간 재무 게이트가 통과에서 차단으로 뒤집힌다. 앞으로의 상한만
 * 보면 그 순간 검토·실행 화면에 서 있던 사용자가 유니버스로 밀려난다.
 *
 * `reviewPassed` 를 보는 이유(규칙 2 — 제출 화면은 검토를 거쳐서만): 앞으로의 상한은
 * 검토까지라서 이것만으로는 검토에서 '다음' 을 눌러 정당하게 도착한 실행 단계도 튕긴다.
 * `traversed` 로 열지 않고 별도 플래그로 두는 건, 실행까지 갔다가 뒤로 돌아가 설정을
 * 고친 뒤 앞으로가기로 제출 화면에 되돌아오는 길을 막아야 하기 때문이다 — 위저드가
 * 검토보다 앞선 단계로 돌아갈 때 이 플래그를 끈다.
 */
export function reachableStepFromUrl(state: StepGateState, access: UrlStepAccess): number {
  if (access.reviewPassed) return RUN_STEP;
  return Math.max(Math.min(access.traversed, REVIEW_STEP), forwardStepLimit(state));
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
