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
import { MAX_UNIVERSE_SYMBOLS } from '../../src/shared/schemas/universe-limit.js';
import { backtestRequestSchema } from '../../src/shared/schemas/backtest-request.js';

/** 전 단계를 통과하는 상태 — 각 테스트는 여기서 한 가지만 무너뜨린다 */
const complete: StepGateState = {
  strategyId: 'range-breakout',
  from: '2026-01-05',
  to: '2026-03-31',
  initialCash: '10000000',
  universePreviewOk: true,
  unionSymbols: ['005930'],
};

const empty: StepGateState = {
  strategyId: null,
  from: '',
  to: '',
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

  it('유니버스 규칙 미리보기가 성공해야 통과한다', () => {
    expect(stepBlocker(1, { ...complete, universePreviewOk: false })).toBe(
      '유니버스 규칙을 미리보기하고 경고를 모두 해결하세요',
    );
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
    // 전략만 고른 상태 — 유니버스까지는 갈 수 있고 그 뒤는 못 간다
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
      "'유니버스' 단계를 먼저 마치세요 — 유니버스 규칙을 미리보기하고 경고를 모두 해결하세요",
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

/**
 * 유니버스 규칙 topN 상한 — 요청 스키마 경계 확인 (스펙 2026-08-05).
 *
 * 종목 수 상한(200)은 더 이상 이 파일의 게이트가 세지 않는다 — `universeRuleSchema` 의
 * `topN` 자체가 그 범위를 벗어난 값을 거부하므로, `UniverseRuleStep` 의 입력이 애초에
 * 그 범위를 벗어나지 못한다. 그래도 화면 상한(MAX_UNIVERSE_SYMBOLS)과 요청 스키마 상한이
 * 같은 상수인지는 여기서 계속 확인한다 — 어긋나면 그 어긋남은 제출해 봐야 드러난다.
 */
describe('유니버스 규칙 topN 상한 — 요청 스키마 경계', () => {
  it('게이트가 참조하는 상한이 요청 스키마 상한과 같다', () => {
    const request = {
      strategyId: 'rsi-reversion',
      parameters: {},
      period: { from: '2024-01-01', to: '2024-12-31' },
      capital: { initialCash: 10_000_000, currency: 'KRW' as const },
      execution: {
        fillTiming: 'NEXT_BAR_OPEN' as const,
        commissionProfileId: 'kr-equity-default',
        slippageProfileId: 'fixed-5bps',
      },
      risk: { maxPositions: 20 },
    };
    const parse = (topN: number): boolean =>
      backtestRequestSchema.safeParse({
        ...request,
        universeRule: { markets: ['KOSPI'], topN, sortKey: 'MKTCAP' },
      }).success;

    expect(parse(MAX_UNIVERSE_SYMBOLS)).toBe(true);
    expect(parse(MAX_UNIVERSE_SYMBOLS + 1)).toBe(false);
  });
});

/**
 * 재무 필요 전략 + 재무 없는 유니버스 게이트 (D-034 후속).
 * **서버 422 와 같은 조건이어야 한다** — 전 종목이 비었을 때만 막고, 일부만 없으면
 * 통과시켜 워커 경고에 맡긴다 (D-025).
 */
describe('stepBlocker — 재무 조합 게이트 (단계 1)', () => {
  const base = {
    ...complete,
    unionSymbols: ['005930', '000660'],
    requiresFundamentals: true,
  };

  it('전 종목에 재무가 없으면 막는다', () => {
    const reason = stepBlocker(1, { ...base, symbolsWithFacts: [] });
    expect(reason).toMatch(/재무 데이터가 필요하지만/);
  });

  it('한 종목이라도 재무가 있으면 통과한다 — 서버 422 와 같은 조건이다', () => {
    // 일부만 없는 경우는 거부 사유가 아니다: 신규 상장처럼 이력이 짧은 종목 하나 때문에
    // 유니버스 전체를 막지 않는다. 빠진 종목은 워커가 실행 경고에 이름으로 남긴다.
    expect(stepBlocker(1, { ...base, symbolsWithFacts: ['005930'] })).toBeNull();
  });

  it('선택과 무관한 종목의 재무는 통과 근거가 아니다', () => {
    expect(stepBlocker(1, { ...base, symbolsWithFacts: ['035420'] })).not.toBeNull();
  });

  it('봉만 쓰는 전략은 재무가 없어도 통과한다', () => {
    expect(
      stepBlocker(1, { ...base, requiresFundamentals: false, symbolsWithFacts: [] }),
    ).toBeNull();
  });

  it('전략의 재무 요구를 모르면 막지 않는다 — 근거 없이 문을 잠그지 않는다', () => {
    // 서버가 필드를 안 내렸거나 응답이 아직 없는 상태. false 로 좁히면 게이트가 조용히
    // 열리고, true 로 좁히면 열 수 없는 문이 된다 — 둘 다 아니라 통과 + 서버 422 방어선.
    expect(
      stepBlocker(1, { ...base, requiresFundamentals: undefined, symbolsWithFacts: [] }),
    ).toBeNull();
  });

  it('종목 목록이 아직 없으면 막지 않는다 — undefined 와 빈 배열을 구분한다', () => {
    expect(stepBlocker(1, { ...base, symbolsWithFacts: undefined })).toBeNull();
  });

  it('미리보기가 안 됐으면 재무 검사보다 먼저 막는다 — 원인을 뒤집어 말하지 않는다', () => {
    expect(
      stepBlocker(1, { ...base, universePreviewOk: false, symbolsWithFacts: [] }),
    ).toBe('유니버스 규칙을 미리보기하고 경고를 모두 해결하세요');
  });
});

/**
 * `hasFacts` 가 빠진 응답에서 게이트가 잠기지 않는지는 위저드가 `symbolsWithFacts` 를
 * 만드는 규칙이 지킨다 — 선택 종목 전부를 알 때만 배열을 만들고, 하나라도 모르면
 * undefined 다. 그 규칙을 여기서 계약으로 고정한다.
 */
describe('symbolsWithFacts 계약 — 모르는 종목이 섞이면 undefined', () => {
  /** new-backtest-wizard.tsx 의 파생 규칙과 같은 모양 */
  function derive(
    selected: readonly string[],
    listed: ReadonlyArray<{ code: string; hasFacts?: boolean }> | undefined,
  ): readonly string[] | undefined {
    if (listed === undefined) return undefined;
    const known = new Map(listed.map((s) => [s.code, s.hasFacts]));
    if (selected.some((code) => known.get(code) === undefined)) return undefined;
    return selected.filter((code) => known.get(code) === true);
  }

  const selected = ['005930', '000660'];

  it('전부 알면 재무 가진 코드만 남는다', () => {
    expect(
      derive(selected, [
        { code: '005930', hasFacts: true },
        { code: '000660', hasFacts: false },
      ]),
    ).toEqual(['005930']);
  });

  it('hasFacts 가 빠진 응답은 undefined — 빈 배열로 접으면 게이트가 잠긴다', () => {
    expect(derive(selected, [{ code: '005930' }, { code: '000660' }])).toBeUndefined();
  });

  it('목록에 없는 종목이 선택돼 있으면 undefined', () => {
    expect(derive(selected, [{ code: '005930', hasFacts: true }])).toBeUndefined();
  });

  it('응답 자체가 없으면 undefined', () => {
    expect(derive(selected, undefined)).toBeUndefined();
  });
});
