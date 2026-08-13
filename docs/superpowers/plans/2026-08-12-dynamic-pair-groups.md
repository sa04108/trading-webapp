# Dynamic Universe Pair Groups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** EMA 추세 스위치와 RSI 되돌림이 동적 유니버스의 짧은 이력·미래 편입 종목 때문에 거래 0건으로 교착되는 문제를 고친다.

**Architecture:** 상관 그룹은 전체 종목 공통 시각이 아니라 종목 pair별 공통 시각으로 계산한다. 전략은 활성 멤버십만 그룹과 진입에 사용하고 리밸런스마다 다시 계산한다. 엔진의 선택적 전략 완료 경고 hook으로 실제 워밍업 미완료를 결과에 남긴다.

**Tech Stack:** TypeScript 5.9, Vitest 4, Zod 4, custom backtest engine

## Global Constraints

- 원본 OHLCV와 체결가는 수정하지 않는다.
- 상관 계산은 현재 시각까지 기록된 종가만 사용한다.
- 같은 입력은 심볼 순서와 무관하게 같은 그룹과 주문을 만든다.
- EMA와 RSI의 기존 파라미터 기본값과 범위는 바꾸지 않는다.
- 두 전략 버전은 `1.0.2`로 올리고 과거 실행 결과는 수정하지 않는다.
- 구현 코드는 테스트가 기대한 이유로 실패한 것을 확인한 뒤 작성한다.

---

### Task 1: Pair별 상관 그룹 계약

**Files:**
- Modify: `src/server/modules/strategy/strategies/shared/pair-groups.ts`
- Test: `tests/unit/pair-groups.test.ts`

**Interfaces:**
- Consumes: `CorrelationWarmup.closesBySymbol`, `pearsonCorrelation()`
- Produces: `tryBuildGroups(warmup, symbols, correlationBars, threshold): Map<string, string> | null`
- Produces: `pruneWarmupCloses(warmup, maxEntriesPerSymbol): void`

- [ ] **Step 1: 짧은 이력 종목이 전체 준비를 막지 않는 실패 테스트를 작성한다**

`tests/unit/pair-groups.test.ts`에 충분한 이력의 `A`와 10봉뿐인 `B`를 넣는다. `correlationBars=20`에서 결과가 `null`이 아니며 둘이 각각 단독 그룹인지 literal로 단언한다. 기존 “봉이 없는 종목이면 영영 null” 테스트도 `NO_BARS`가 단독 그룹으로 남는 기대값으로 바꾼다.

```ts
const groups = tryBuildGroups(warmup, ['A', 'B'], 20, 0.5);
expect(groups).not.toBeNull();
expect(groups?.get('A')).toBe('A');
expect(groups?.get('B')).toBe('B');
```

- [ ] **Step 2: pair별 정렬을 검증하는 실패 테스트를 작성한다**

`A/B`는 공통 20봉의 완전 역상관, `C`는 마지막 5봉만 존재하는 fixture를 만든다. 전체 공통 봉은 5개뿐이어도 `A/B`만 같은 그룹이고 `C`는 단독인지 확인한다.

- [ ] **Step 3: 테스트가 기존 전체 공통 시각 구현 때문에 실패하는지 확인한다**

Run: `pnpm exec vitest run tests/unit/pair-groups.test.ts --reporter=verbose`

Expected: 새 테스트가 `groups === null` 또는 `A/B`가 병합되지 않아 FAIL한다.

- [ ] **Step 4: pair별 공통 시각 구현을 작성한다**

`tryBuildGroups`는 활성 심볼 중 하나도 `correlationBars`개 종가가 없을 때만 `null`을 반환한다. 그 뒤 모든 심볼을 자기 그룹으로 초기화하고 심볼 pair마다 다음 절차를 수행한다.

```ts
const commonTs = [...left.keys()]
  .filter((tsMs) => right.has(tsMs))
  .sort((a, b) => a - b)
  .slice(-correlationBars);
if (commonTs.length < correlationBars) continue;
const correlation = pearsonCorrelation(
  logReturns(commonTs.map((tsMs) => left.get(tsMs)!)),
  logReturns(commonTs.map((tsMs) => right.get(tsMs)!)),
);
if (correlation !== null && correlation <= -threshold) union(leftSymbol, rightSymbol);
```

결정적 union root는 기존처럼 사전순 최소 심볼로 유지한다. `pruneWarmupCloses`는 각 종목 Map의 시각을 오름차순으로 정렬하고 최근 `maxEntriesPerSymbol`개만 남긴다.

- [ ] **Step 5: pair-group 테스트를 통과시킨다**

Run: `pnpm exec vitest run tests/unit/pair-groups.test.ts --reporter=verbose`

Expected: PASS.

- [ ] **Step 6: Task 1 변경을 커밋한다**

```bash
git add src/server/modules/strategy/strategies/shared/pair-groups.ts tests/unit/pair-groups.test.ts
git commit -m "fix: build correlation groups per pair"
```

### Task 2: 활성 멤버십 기반 EMA·RSI 그룹 수명주기

**Files:**
- Modify: `src/server/modules/strategy/strategies/ema-trend-switch.ts`
- Modify: `src/server/modules/strategy/strategies/rsi-reversion.ts`
- Modify: `tests/unit/ema-trend-switch.test.ts`
- Modify: `tests/unit/rsi-reversion.test.ts`
- Modify: `tests/unit/swing-strategies.test.ts`

**Interfaces:**
- Consumes: Task 1의 pair별 `tryBuildGroups()`와 `pruneWarmupCloses()`
- Produces: 현재 `tradableSymbols`만 포함한 `groupOf`
- Produces: EMA·RSI 전략 version `1.0.2`

- [ ] **Step 1: EMA 동적 유니버스 실패 테스트를 작성한다**

140봉 상승 종목 `A`와 마지막 10봉만 있는 `B`를 만든다. 일정은 처음 `A`만, 130번째 봉부터 `A/B`로 둔다. 첫 일정에서 `A` 매수가 실제 fill로 발생해야 한다고 단언한다. 이 테스트가 전체 합집합 gate를 제거하지 않으면 거래 0건으로 실패한다.

- [ ] **Step 2: 비활성 미래 종목의 그룹 선점 실패 테스트를 작성한다**

워밍업 중 역상관이고 이후 함께 상승하는 `AAA/ZZZ`를 만든다. 마지막 리밸런스 전에는 `ZZZ`만 활성화한다. `AAA`가 미래 멤버라는 이유로 `ZZZ` 매수를 막지 않으며, 엔진 경고에 `AAA 매수 거부`가 없어야 한다고 단언한다.

- [ ] **Step 3: RSI에도 짧은 미래 멤버 회귀 테스트를 작성한다**

충분한 워밍업 뒤 과매도로 내려가는 활성 종목과 마지막에 편입되는 짧은 이력 종목을 만든다. 활성 종목의 `REVERSION` 매수가 발생해야 한다고 단언한다.

- [ ] **Step 4: 세 회귀 테스트가 현재 구현에서 실패하는지 확인한다**

Run: `pnpm exec vitest run tests/unit/ema-trend-switch.test.ts tests/unit/rsi-reversion.test.ts tests/unit/swing-strategies.test.ts --reporter=verbose`

Expected: 새 동적 유니버스 테스트가 fills 0건 또는 비활성 매수 거부로 FAIL한다.

- [ ] **Step 5: 두 전략의 그룹 수명주기를 수정한다**

두 전략은 각 봉에서 다음 활성 심볼을 계산한다.

```ts
const activeSymbols = context.tradableSymbols === null
  ? state.symbols
  : state.symbols.filter((symbol) => context.tradableSymbols!.has(symbol));
```

`state.groupOf === null || context.isRebalanceBar`일 때만 `activeSymbols`로 그룹 계산을 시도한다. 성공하면 그룹을 교체한다. 일정이 있는 실행은 `correlationBars * 2 + 14`개로 warmup을 줄이고 계속 기록한다. 일정이 없는 실행은 첫 성공 뒤 warmup을 `null`로 비운다. 리밸런스 계산이 준비 부족으로 `null`이면 이전 멤버십 그룹을 버린다.

보유·대기 그룹 선점과 신규 진입 loop는 `activeSymbols`만 사용한다. 비활성 종목의 `pendingEntry`는 지워 다음 활성화 때 낡은 대기가 남지 않게 한다. 두 전략 version을 `1.0.2`로 올린다.

- [ ] **Step 6: EMA·RSI와 공유 swing 테스트를 통과시킨다**

Run: `pnpm exec vitest run tests/unit/ema-trend-switch.test.ts tests/unit/rsi-reversion.test.ts tests/unit/swing-strategies.test.ts tests/unit/pair-groups.test.ts --reporter=verbose`

Expected: PASS.

- [ ] **Step 7: Task 2 변경을 커밋한다**

```bash
git add src/server/modules/strategy/strategies/ema-trend-switch.ts src/server/modules/strategy/strategies/rsi-reversion.ts tests/unit/ema-trend-switch.test.ts tests/unit/rsi-reversion.test.ts tests/unit/swing-strategies.test.ts
git commit -m "fix: scope swing entries to active universe"
```

### Task 3: 워밍업 완료 경고와 문서 동기화

**Files:**
- Modify: `src/server/modules/strategy/domain/strategy.ts`
- Modify: `src/server/modules/backtest/domain/engine.ts`
- Modify: `src/server/modules/strategy/strategies/ema-trend-switch.ts`
- Modify: `src/server/modules/strategy/strategies/rsi-reversion.ts`
- Modify: `tests/unit/engine.test.ts`
- Modify: `tests/unit/ema-trend-switch.test.ts`
- Modify: `tests/unit/rsi-reversion.test.ts`
- Modify: `docs/SPEC.md`
- Modify: `docs/DECISIONS.md`

**Interfaces:**
- Produces: `TradingStrategy.completionWarnings?(state, parameters): readonly string[]`
- Consumes: 엔진 실행 종료 시 전략 완료 경고

- [ ] **Step 1: 엔진 완료 경고 hook 실패 테스트를 작성한다**

테스트 전략이 `completionWarnings()`에서 literal 경고 한 줄을 반환하게 하고 `runBacktest()` 결과의 `warnings`가 그 줄을 포함하는지 확인한다.

- [ ] **Step 2: EMA·RSI 워밍업 미완료 경고 실패 테스트를 작성한다**

각 전략을 `correlationBars`보다 짧은 봉으로 실행해 거래 0건과 함께 다음 의미의 경고가 있는지 확인한다.

```ts
expect(result.warnings.some((warning) =>
  warning.includes('상관 그룹 워밍업') && warning.includes('필요 20봉'),
)).toBe(true);
```

충분한 워밍업으로 그룹이 만들어진 기존 정상 fixture에는 이 경고가 없어야 한다.

- [ ] **Step 3: 새 테스트가 완료 경고 hook 부재로 실패하는지 확인한다**

Run: `pnpm exec vitest run tests/unit/engine.test.ts tests/unit/ema-trend-switch.test.ts tests/unit/rsi-reversion.test.ts --reporter=verbose`

Expected: 전략 경고가 결과에 없어서 FAIL한다.

- [ ] **Step 4: 선택적 완료 경고 hook을 구현한다**

`TradingStrategy`에 다음 선택 hook을 추가한다.

```ts
completionWarnings?(state: TState, parameters: TParameters): readonly string[];
```

엔진은 모든 실행 loop와 미체결·포지션 경고를 정리한 뒤 hook을 한 번 호출해 반환값을
`warnings`에 추가한다. EMA·RSI는 `groupOf === null`일 때 마지막 grouping 대상의 최대
종가 수와 `correlationBars`를 포함한 경고를 반환한다.

- [ ] **Step 5: 명세와 결정 기록을 동기화한다**

`docs/SPEC.md`의 EMA·RSI 설명을 pair별 공통 봉·활성 멤버십 재계산으로 바꾼다.
`docs/DECISIONS.md`에 D-051로 원인, pair별 계산, 활성 멤버십, 경고와 버전 영향을 기록한다.

- [ ] **Step 6: 관련 테스트와 정적 검사를 실행한다**

Run: `pnpm exec vitest run tests/unit/pair-groups.test.ts tests/unit/swing-strategies.test.ts tests/unit/ema-trend-switch.test.ts tests/unit/rsi-reversion.test.ts tests/unit/engine.test.ts --reporter=verbose`

Run: `pnpm typecheck`

Expected: 모두 exit 0.

- [ ] **Step 7: Task 3 변경을 커밋한다**

```bash
git add src/server/modules/strategy/domain/strategy.ts src/server/modules/backtest/domain/engine.ts src/server/modules/strategy/strategies/ema-trend-switch.ts src/server/modules/strategy/strategies/rsi-reversion.ts tests/unit/engine.test.ts tests/unit/ema-trend-switch.test.ts tests/unit/rsi-reversion.test.ts docs/SPEC.md docs/DECISIONS.md
git commit -m "fix: report unfinished strategy warmup"
```

### Task 4: 전체 검증과 게시 준비

**Files:**
- Verify only: whole repository

**Interfaces:**
- Consumes: Tasks 1~3의 commits
- Produces: push 가능한 검증된 branch

- [ ] **Step 1: formatter·diff 오류를 검사한다**

Run: `git diff --check origin/main...HEAD`

- [ ] **Step 2: lint와 typecheck를 실행한다**

Run: `pnpm lint`

Run: `pnpm typecheck`

- [ ] **Step 3: 전체 테스트를 실행한다**

Run: `pnpm test`

Expected: baseline 1,307개와 새 회귀 테스트가 모두 PASS한다.

- [ ] **Step 4: build를 실행한다**

Run: `pnpm build`

- [ ] **Step 5: commit·status·diff 범위를 확인한다**

Run: `git status -sb`

Run: `git log --oneline origin/main..HEAD`

Run: `git diff --stat origin/main...HEAD`
