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
  datasetId: 'ds_1',
  symbols: ['005930'],
  from: '2026-01-05',
  to: '2026-03-31',
  initialCash: '10000000',
  universeMode: 'DATASET',
};

const empty: StepGateState = {
  strategyId: null,
  datasetId: null,
  symbols: [],
  from: '',
  to: '',
  initialCash: '10000000',
  universeMode: 'DATASET',
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

/**
 * 종목 수 상한 게이트 (D-038).
 *
 * 위저드는 종목을 골라내지 않는다 — 데이터셋이 유니버스를 정한다. 그러면 상한을 넘는
 * 데이터셋은 **돌릴 수 없다**: 알아서 잘라 넣으면 같은 데이터셋으로 돌린 두 결과가 서로
 * 다른 유니버스를 갖게 되고, 무엇이 달랐는지는 저장된 요청을 펼쳐 봐야만 안다.
 */
describe('stepBlocker — 종목 수 상한 게이트 (단계 1)', () => {
  const symbols = (count: number): string[] =>
    Array.from({ length: count }, (_, index) => String(index).padStart(6, '0'));

  it('상한과 같으면 통과한다', () => {
    expect(stepBlocker(1, { ...complete, symbols: symbols(MAX_UNIVERSE_SYMBOLS) })).toBeNull();
  });

  it('하나만 넘어도 막고, 몇 종목인지와 무엇을 하라는지를 함께 말한다', () => {
    const reason = stepBlocker(1, { ...complete, symbols: symbols(MAX_UNIVERSE_SYMBOLS + 1) });
    expect(reason).toContain(String(MAX_UNIVERSE_SYMBOLS + 1));
    expect(reason).toMatch(/데이터 화면에서 종목을 줄이거나/);
  });

  /**
   * 게이트가 통과시킨 유니버스를 서버가 400 으로 막으면 그 어긋남은 제출해 봐야 드러난다.
   * 화면 상한과 요청 스키마 상한이 같은 상수인지 스키마로 직접 확인한다.
   */
  it('게이트 경계가 요청 스키마 경계와 같다', () => {
    const request = {
      strategyId: 'rsi-reversion',
      parameters: {},
      datasetId: 'ds_1',
      period: { from: '2024-01-01', to: '2024-12-31' },
      capital: { initialCash: 10_000_000, currency: 'KRW' as const },
      execution: {
        fillTiming: 'NEXT_BAR_OPEN' as const,
        commissionProfileId: 'kr-equity-default',
        slippageProfileId: 'fixed-5bps',
      },
      risk: { maxPositions: 20 },
    };
    const parse = (count: number): boolean =>
      backtestRequestSchema.safeParse({
        ...request,
        universe: { type: 'SYMBOLS', symbols: symbols(count) },
      }).success;

    expect(parse(MAX_UNIVERSE_SYMBOLS)).toBe(true);
    expect(parse(MAX_UNIVERSE_SYMBOLS + 1)).toBe(false);
  });

  it('막으면 앞으로 갈 수 있는 상한도 그 단계에 걸린다 — 검토까지 갈 수 없다', () => {
    const blocked = { ...complete, symbols: symbols(MAX_UNIVERSE_SYMBOLS + 1) };
    expect(firstIncompleteStep(blocked)).toBe(1);
    expect(navigableStepLimit(0, blocked)).toBe(1);
    expect(stepJumpBlockReason(REVIEW_STEP, 0, blocked)).toMatch(
      /'데이터·종목' 단계를 먼저 마치세요/,
    );
  });

  it('데이터셋 미선택이 상한보다 먼저다 — 원인을 뒤집어 말하지 않는다', () => {
    expect(
      stepBlocker(1, {
        ...complete,
        datasetId: null,
        symbols: symbols(MAX_UNIVERSE_SYMBOLS + 1),
      }),
    ).toBe('데이터셋을 선택하세요');
  });
});

/**
 * KRX 과거 시점 스냅샷 모드 게이트 (Task 13).
 *
 * 이 모드는 데이터셋을 고르지 않는다 — `krx-snapshot-step.tsx` 가 스냅샷을 확정하면
 * 그 종목 목록이 그대로 `symbols` 가 된다. 그래서 datasetId 없이도 통과해야 하고,
 * 대신 스냅샷을 아직 확정하지 않은 상태(빈 symbols)를 막아야 한다. 200종목 상한은
 * 모드와 무관하게 그대로 적용된다 — 서버가 받아들이는 유니버스 크기는 유니버스의
 * 출처가 아니라 크기만으로 정해진다.
 */
describe('stepBlocker — KRX 스냅샷 모드 게이트 (단계 1)', () => {
  const symbols = (count: number): string[] =>
    Array.from({ length: count }, (_, index) => String(index).padStart(6, '0'));

  const snapshotComplete: StepGateState = {
    ...complete,
    universeMode: 'KRX_SNAPSHOT',
    datasetId: null,
    symbols: ['005930'],
  };

  it('스냅샷 모드에서는 datasetId 없이 스냅샷 종목만으로 통과한다', () => {
    expect(stepBlocker(1, snapshotComplete)).toBeNull();
  });

  it('스냅샷을 아직 확정하지 않았으면(종목 없음) 막는다', () => {
    expect(stepBlocker(1, { ...snapshotComplete, symbols: [] })).toBe(
      '과거 KRX 시점 스냅샷을 확정하세요',
    );
  });

  it('데이터셋 모드는 여전히 datasetId 를 요구한다 — 두 모드가 서로의 검사를 건너뛰지 않는다', () => {
    expect(stepBlocker(1, { ...complete, datasetId: null })).toBe('데이터셋을 선택하세요');
  });

  it('스냅샷 모드도 200종목 상한을 넘으면 막는다 — 상한은 모드와 무관하다', () => {
    const reason = stepBlocker(1, {
      ...snapshotComplete,
      symbols: symbols(MAX_UNIVERSE_SYMBOLS + 1),
    });
    expect(reason).toContain(String(MAX_UNIVERSE_SYMBOLS + 1));
  });

  it('상한과 같은 개수는 스냅샷 모드에서도 통과한다', () => {
    expect(
      stepBlocker(1, { ...snapshotComplete, symbols: symbols(MAX_UNIVERSE_SYMBOLS) }),
    ).toBeNull();
  });

  it('스냅샷 미확정이 상한 초과보다 먼저다 — 원인을 뒤집어 말하지 않는다', () => {
    // symbols 가 비어 있으면(스냅샷 미확정) 상한 검사에 닿지 않는다
    expect(stepBlocker(1, { ...snapshotComplete, symbols: [] })).toBe(
      '과거 KRX 시점 스냅샷을 확정하세요',
    );
  });
});

/**
 * 재무 필요 전략 + 재무 없는 종목 게이트 (D-034 후속).
 * **서버 422 와 같은 조건이어야 한다** — 전 종목이 비었을 때만 막고, 일부만 없으면
 * 통과시켜 워커 경고에 맡긴다 (D-025).
 */
describe('stepBlocker — 재무 조합 게이트 (단계 1)', () => {
  const base = {
    ...complete,
    symbols: ['005930', '000660'],
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

  it('데이터셋·종목 미선택이 재무 검사보다 먼저다 — 원인을 뒤집어 말하지 않는다', () => {
    expect(stepBlocker(1, { ...base, datasetId: null, symbolsWithFacts: [] })).toBe(
      '데이터셋을 선택하세요',
    );
    expect(stepBlocker(1, { ...base, symbols: [], symbolsWithFacts: [] })).toBe(
      '종목을 1개 이상 선택하세요',
    );
  });

  it('게이트가 막으면 앞으로 갈 수 있는 상한도 그 단계에 걸린다', () => {
    const blocked = { ...base, symbolsWithFacts: [] };
    expect(firstIncompleteStep(blocked)).toBe(1);
    expect(navigableStepLimit(1, blocked)).toBe(1);
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

  it('undefined 를 게이트에 넘기면 막지 않는다 (두 규칙이 맞물린다)', () => {
    const state = { ...complete, symbols: selected, requiresFundamentals: true };
    expect(stepBlocker(1, { ...state, symbolsWithFacts: derive(selected, undefined) })).toBeNull();
    expect(
      stepBlocker(1, {
        ...state,
        symbolsWithFacts: derive(selected, [{ code: '005930' }, { code: '000660' }]),
      }),
    ).toBeNull();
  });
});
