# Swing Strategy Minimal Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** EMA 추세 스위치와 RSI 되돌림의 상관그룹 수명주기 중복과 중복 상태를 동작 변경 없이 하나의 공용 구현으로 줄인다.

**Architecture:** `shared/pair-groups.ts`에 전략 독립적인 `CorrelationGroupingState`와 상태 전이 함수를 둔다. EMA와 RSI 상태는 이 인터페이스를 확장하고, 기존 진입·청산 로직과 행동 회귀 테스트는 그대로 유지한다.

**Tech Stack:** TypeScript 5.9, Vitest 4, custom backtest engine

## Global Constraints

- `TradingStrategy`, `StrategyBarContext`, `activeUniverseSymbols`, `completionWarnings` 공개 계약을 바꾸지 않는다.
- EMA·RSI 전략 버전은 `1.0.2`를 유지한다.
- 가격·주문·그룹 결과와 경고 문구를 바꾸지 않는다.
- 기존 행동 회귀 테스트를 삭제하거나 전역 fixture로 옮기지 않는다.
- `buildCorrelationGroups()`와 독립 상관·결정성 테스트는 유지한다.
- 새 추상화는 EMA·RSI 지표나 주문 의미를 알지 않는다.

---

### Task 1: 공용 상관그룹 상태와 수명주기

**Files:**
- Modify: `src/server/modules/strategy/strategies/shared/pair-groups.ts`
- Verify: `tests/unit/pair-groups.test.ts`
- Verify: `tests/unit/swing-strategies.test.ts`

**Interfaces:**
- Produces: `CorrelationGroupingState`
- Produces: `newCorrelationGroupingState(): CorrelationGroupingState`
- Produces: `recordCorrelationClose(state, symbol, tsMs, close): void`
- Produces: `updateCorrelationGrouping(input): readonly string[]`
- Produces: `correlationWarmupWarnings(state, correlationBars, strategyName): readonly string[]`
- Produces: `scaleCorrelationGrouping(state, symbol, ratio): void`

- [ ] **Step 1: 현재 수명주기 행동 테스트를 기준선으로 실행한다**

Run:

```bash
pnpm exec vitest run tests/unit/pair-groups.test.ts tests/unit/swing-strategies.test.ts tests/unit/ema-trend-switch.test.ts tests/unit/rsi-reversion.test.ts --reporter=verbose
```

Expected: 모든 테스트 PASS. 이 테스트들이 리팩터링의 특성화 테스트이므로 같은 계약을 반복하는 새 테스트를 추가하지 않는다.

- [ ] **Step 2: 공용 상태 타입과 생성 함수를 작성한다**

`pair-groups.ts`에 다음 상태를 추가한다. `groupedSymbolsKey`와 `lastActiveSymbols` 대신 정렬된 `groupedSymbols` 하나만 저장한다.

```ts
export interface CorrelationGroupingState {
  groupOf: Map<string, string> | null;
  groupedSymbols: readonly string[];
  groupReadyCount: number;
  warmup: CorrelationWarmup | null;
}

export function newCorrelationGroupingState(): CorrelationGroupingState {
  return {
    groupOf: null,
    groupedSymbols: [],
    groupReadyCount: 0,
    warmup: newCorrelationWarmup(),
  };
}
```

- [ ] **Step 3: 기록·스케일·경고 wrapper를 작성한다**

호출자가 매번 `warmup !== null`을 확인하지 않게 다음 함수를 추가한다.

```ts
export function recordCorrelationClose(
  state: CorrelationGroupingState,
  symbol: string,
  tsMs: number,
  close: number,
): void {
  if (state.warmup !== null) recordClose(state.warmup, symbol, tsMs, close);
}

export function scaleCorrelationGrouping(
  state: CorrelationGroupingState,
  symbol: string,
  ratio: number,
): void {
  if (state.warmup !== null) scaleWarmupCloses(state.warmup, symbol, ratio);
}

export function correlationWarmupWarnings(
  state: CorrelationGroupingState,
  correlationBars: number,
  strategyName: string,
): readonly string[] {
  if (state.groupOf !== null) return [];
  const maxBars = Math.max(
    0,
    ...state.groupedSymbols.map(
      (symbol) => state.warmup?.closesBySymbol.get(symbol)?.size ?? 0,
    ),
  );
  return [
    `${strategyName}: 상관 그룹 워밍업 부족 (필요 ${correlationBars}봉, `
      + `확보 최대 ${maxBars}봉). 워밍업 중에는 신규 진입을 평가하지 않습니다.`,
  ];
}
```

빈 `groupedSymbols` fallback은 상태 전이 함수가 첫 봉부터 전체 심볼 또는 활성 멤버십을 저장하므로 필요 없다. 봉이 전혀 없는 실행은 엔진이 전략을 호출하지 않아 기존에도 전략 완료 경고가 생성되지 않는다.

- [ ] **Step 4: 활성 멤버십 선택과 그룹 전이를 한 함수로 옮긴다**

다음 입력 타입과 함수를 추가한다.

```ts
export interface UpdateCorrelationGroupingInput {
  readonly state: CorrelationGroupingState;
  readonly allSymbols: readonly string[];
  readonly activeUniverseSymbols: ReadonlySet<string> | null;
  readonly isRebalanceBar: boolean;
  readonly correlationBars: number;
  readonly threshold: number;
}

export function updateCorrelationGrouping(
  input: UpdateCorrelationGroupingInput,
): readonly string[] {
  const symbols = input.activeUniverseSymbols === null
    ? input.allSymbols
    : input.allSymbols.filter((symbol) => input.activeUniverseSymbols?.has(symbol) === true);
  const membershipChanged = !sameSymbols(symbols, input.state.groupedSymbols);
  input.state.groupedSymbols = symbols;

  const warmup = input.state.warmup;
  if (warmup === null) return symbols;
  pruneWarmupCloses(warmup, input.correlationBars * 2 + 14);
  const readyCount = symbols.filter(
    (symbol) => (warmup.closesBySymbol.get(symbol)?.size ?? 0) >= input.correlationBars,
  ).length;
  if (
    input.state.groupOf !== null
    && !membershipChanged
    && !input.isRebalanceBar
    && readyCount <= input.state.groupReadyCount
  ) return symbols;

  const groupOf = tryBuildGroups(warmup, symbols, input.correlationBars, input.threshold);
  if (groupOf !== null) {
    input.state.groupOf = groupOf;
    input.state.groupReadyCount = readyCount;
    if (input.activeUniverseSymbols === null && readyCount === input.allSymbols.length) {
      input.state.warmup = null;
    }
  } else if (membershipChanged) {
    input.state.groupOf = null;
    input.state.groupReadyCount = readyCount;
  }
  return symbols;
}
```

`sameSymbols()`는 길이와 같은 인덱스의 문자열만 비교하는 비공개 함수로 둔다. `allSymbols`와 엔진 멤버십이 이미 정렬·결정적이므로 Set 직렬화나 구분자 문자열은 만들지 않는다.

- [ ] **Step 5: 공용 파일의 기존 테스트와 정적 검사를 실행한다**

Run:

```bash
pnpm exec vitest run tests/unit/pair-groups.test.ts --reporter=verbose
pnpm typecheck
```

Expected: PASS. 새 API는 아직 전략에서 소비하지 않아 기존 동작이 바뀌지 않는다.

- [ ] **Step 6: Task 1을 커밋한다**

```bash
git add src/server/modules/strategy/strategies/shared/pair-groups.ts
git commit -m "refactor: centralize correlation group lifecycle"
```

### Task 2: EMA를 공용 수명주기로 전환

**Files:**
- Modify: `src/server/modules/strategy/strategies/ema-trend-switch.ts`
- Verify: `tests/unit/ema-trend-switch.test.ts`
- Verify: `tests/unit/swing-strategies.test.ts`

**Interfaces:**
- Consumes: Task 1의 `CorrelationGroupingState`와 생성·기록·갱신·경고·스케일 함수
- Preserves: `EmaTrendSwitchState.groupOf`, `EmaTrendSwitchState.warmup` 접근 가능성

- [ ] **Step 1: EMA 상태가 공용 상태를 확장하도록 바꾼다**

```ts
export interface EmaTrendSwitchState extends CorrelationGroupingState {
  readonly bySymbol: Map<string, SymbolState>;
  readonly symbols: readonly string[];
}
```

`groupedSymbolsKey`, `lastActiveSymbols`, `groupReadyCount`, `warmup`, `groupOf`의 중복 선언을 제거한다. 초기화는 공용 생성 결과를 펼친다.

```ts
return {
  bySymbol: new Map(),
  symbols: [...context.symbols].sort(),
  ...newCorrelationGroupingState(),
};
```

- [ ] **Step 2: EMA의 중복 수명주기 코드를 공용 호출로 교체한다**

종가 기록은 `recordCorrelationClose(state, symbol, bar.tsMs, bar.close)`로 바꾼다. 기존 `activeSymbols()` 함수와 그룹 갱신 블록 전체를 제거하고 다음 호출만 남긴다.

```ts
const currentSymbols = updateCorrelationGrouping({
  state,
  allSymbols: state.symbols,
  activeUniverseSymbols: context.activeUniverseSymbols,
  isRebalanceBar: context.isRebalanceBar,
  correlationBars: parameters.correlationBars,
  threshold: parameters.correlationThreshold,
});
```

진입·청산·claimed group 로직은 수정하지 않는다.

- [ ] **Step 3: 경고와 자본변동 처리를 공용 호출로 교체한다**

```ts
completionWarnings(state, parameters) {
  return correlationWarmupWarnings(state, parameters.correlationBars, 'EMA 추세 스위치');
}
```

`onCorporateAction`의 마지막 null check는 `scaleCorrelationGrouping(state, symbol, ratio)`로 바꾼다. EMA·ATR·holding 스케일 코드는 그대로 둔다.

- [ ] **Step 4: EMA 행동 회귀를 검증한다**

Run:

```bash
pnpm exec vitest run tests/unit/ema-trend-switch.test.ts tests/unit/swing-strategies.test.ts tests/unit/pair-groups.test.ts --reporter=verbose
pnpm typecheck
```

Expected: 모든 테스트 PASS. `swing-strategies.test.ts`의 `finalState.groupOf` 단언은 공용 상태를 확장하므로 수정하지 않는다.

- [ ] **Step 5: Task 2를 커밋한다**

```bash
git add src/server/modules/strategy/strategies/ema-trend-switch.ts
git commit -m "refactor: reuse correlation lifecycle in EMA strategy"
```

### Task 3: RSI를 공용 수명주기로 전환하고 중복 제거 확인

**Files:**
- Modify: `src/server/modules/strategy/strategies/rsi-reversion.ts`
- Verify: `tests/unit/rsi-reversion.test.ts`
- Verify: `tests/unit/swing-strategies.test.ts`

**Interfaces:**
- Consumes: Task 1의 `CorrelationGroupingState`와 생성·기록·갱신·경고·스케일 함수
- Preserves: RSI 진입·청산·보유 상태 의미와 경고 literal

- [ ] **Step 1: RSI 상태가 공용 상태를 확장하도록 바꾼다**

```ts
export interface RsiReversionState extends CorrelationGroupingState {
  readonly bySymbol: Map<string, SymbolState>;
  readonly symbols: readonly string[];
}
```

초기화는 EMA와 같은 `...newCorrelationGroupingState()`를 사용한다.

- [ ] **Step 2: RSI의 중복 수명주기 코드를 공용 호출로 교체한다**

종가 기록을 `recordCorrelationClose()`로 바꾸고, `activeSymbols()`와 그룹 갱신 블록을 제거한다. `updateCorrelationGrouping()`에는 RSI의 `correlationBars`, `correlationThreshold`를 전달한다. RSI 계산, 청산 사유, 진입 조건과 주문 생성은 수정하지 않는다.

- [ ] **Step 3: 경고와 자본변동 처리를 공용 호출로 교체한다**

```ts
completionWarnings(state, parameters) {
  return correlationWarmupWarnings(state, parameters.correlationBars, 'RSI 되돌림');
}
```

상관 워밍업 스케일은 `scaleCorrelationGrouping()`을 사용하고 RSI·ATR·holding 스케일은 그대로 둔다.

- [ ] **Step 4: 명백한 중복과 불필요 테스트가 남았는지 재감사한다**

Run:

```bash
rg -n "groupedSymbolsKey|lastActiveSymbols|function activeSymbols|pruneWarmupCloses\(|tryBuildGroups\(" src/server/modules/strategy/strategies/{ema-trend-switch,rsi-reversion}.ts
rg -n "buildCorrelationGroups\(" src tests --glob '*.ts'
```

Expected:

- 첫 명령은 결과가 없다.
- 두 번째 명령은 `pair-groups.ts` 정의와 독립 단위 테스트 호출만 보여 준다.
- 행동 회귀 테스트는 서로 다른 엔진 경계를 검증하므로 삭제하지 않는다.
- 테스트 fixture 전역 공용화는 테스트 간 결합을 늘리므로 하지 않는다.

- [ ] **Step 5: RSI와 전체 관련 회귀를 검증한다**

Run:

```bash
pnpm exec vitest run tests/unit/pair-groups.test.ts tests/unit/swing-strategies.test.ts tests/unit/ema-trend-switch.test.ts tests/unit/rsi-reversion.test.ts tests/unit/engine.test.ts tests/unit/backtest-engine-universe-schedule.test.ts --reporter=verbose
pnpm typecheck
```

Expected: 모든 테스트 PASS.

- [ ] **Step 6: Task 3을 커밋한다**

```bash
git add src/server/modules/strategy/strategies/rsi-reversion.ts
git commit -m "refactor: reuse correlation lifecycle in RSI strategy"
```

### Task 4: 문서 동기화, 전체 검증, 리뷰와 PR 갱신

**Files:**
- Modify: `docs/superpowers/specs/2026-08-13-swing-strategy-minimal-cleanup-design.md` only if implementation differs from the approved design
- Verify: whole repository

**Interfaces:**
- Produces: 기존 Draft PR에 push할 검증된 cleanup commits

- [ ] **Step 1: diff와 작업 트리를 검사한다**

Run:

```bash
git diff --check origin/main...HEAD
git status -sb
git diff --stat origin/main...HEAD
```

Expected: 공백 오류 없음. 의도하지 않은 파일 변경 없음.

- [ ] **Step 2: lint와 typecheck를 실행한다**

Run:

```bash
pnpm lint
pnpm typecheck
```

Expected: 둘 다 exit 0.

- [ ] **Step 3: 전체 테스트를 실행한다**

Run:

```bash
pnpm test
```

Expected: 모든 테스트 PASS. 기준선은 129 files, 1,318 tests이고 새 테스트를 추가하지 않으므로 총수도 동일해야 한다.

- [ ] **Step 4: 프로덕션 빌드를 실행한다**

Run:

```bash
pnpm build
```

Expected: 서버와 웹 빌드 exit 0. 기존 웹 chunk size 경고는 비차단이다.

- [ ] **Step 5: 독립 코드 리뷰를 요청한다**

리뷰어에게 `f47bdb9`부터 cleanup HEAD까지 읽기 전용 검토를 요청한다. 다음을 명시한다.

- 동작·경고·전략 버전이 유지됐는가
- 공유 API가 EMA·RSI 세부사항을 알지 않는가
- 상태 중복이 실제로 줄었는가
- 과도한 추상화나 테스트 공백이 생기지 않았는가

Critical/Important 지적은 수정하고 관련 검증을 다시 실행한다.

- [ ] **Step 6: cleanup 커밋을 기존 원격 브랜치에 push한다**

```bash
git push origin agent/fix-dynamic-universe-pair-groups
```

- [ ] **Step 7: Draft PR 상태와 원격 동기화를 확인한다**

```bash
git rev-list --left-right --count origin/agent/fix-dynamic-universe-pair-groups...HEAD
gh pr view 7 --json state,isDraft,url,headRefName,baseRefName,title
```

Expected: ahead/behind `0 0`, PR #7은 OPEN·Draft이고 head가 `agent/fix-dynamic-universe-pair-groups`다.
