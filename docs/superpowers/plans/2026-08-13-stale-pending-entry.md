# Stale Pending Entry Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Clear canceled EMA/RSI entry reservations when a symbol leaves the active universe so a later barless reactivation cannot block its tradable inverse-correlated peer.

**Architecture:** Keep the engine and `TradingStrategy` contract unchanged. Immediately after resolving current active membership, each swing strategy clears `pendingEntry` only for already-created symbol states outside `activeUniverseSymbols`; membership members that are merely absent from `tradableSymbols` retain their reservation.

**Tech Stack:** TypeScript 5.9, Vitest 4, pnpm, existing synchronous backtest engine

## Global Constraints

- Modify both `ema-trend-switch` and `rsi-reversion`.
- Clear `pendingEntry` based on `activeUniverseSymbols`, never on day-level `tradableSymbols`.
- Do not create state for symbols that have no existing strategy state.
- Do not change the engine order queue, `TradingStrategy` contract, correlation grouping, parameter schemas, or strategy versions (`1.0.2`).
- Preserve the existing suspended-active-member group-ownership tests.
- Update the existing feature branch and Draft PR #7 after verification.

---

## File Map

- `tests/unit/swing-strategies.test.ts`: add the EMA engine-level regression scenario.
- `tests/unit/rsi-reversion.test.ts`: add the equivalent RSI engine-level regression scenario.
- `src/server/modules/strategy/strategies/ema-trend-switch.ts`: clear stale entry reservations for symbols outside active membership.
- `src/server/modules/strategy/strategies/rsi-reversion.ts`: apply the same strategy-local state transition.

### Task 1: Reproduce the canceled-reservation deadlock

**Files:**
- Modify: `tests/unit/swing-strategies.test.ts`
- Modify: `tests/unit/rsi-reversion.test.ts`

**Interfaces:**
- Consumes: `runBacktest(strategy, input)`, each strategy's existing `FAST_PARAMS`, `Candle`, and universe schedule input.
- Produces: two engine-level regression tests whose expected observable result is a filled `BBB` BUY after `AAA` is removed and reactivated without a bar.

- [ ] **Step 1: Add the failing EMA regression test**

Add this test inside `describe('그룹 배타성', ...)` in `tests/unit/swing-strategies.test.ts`:

```ts
it('편출로 취소된 진입 예약이 봉 없는 재편입 뒤 같은 그룹 종목을 막지 않는다', () => {
  const aaa = levPath(20, 15);
  const bbb = [
    ...aaa.map((close) => 1_000_000 / close),
    900,
    2_000,
    2_000,
  ];
  const candles = [
    ...toCandles(new Map([['AAA', aaa]]), '1d', DAY),
    ...toCandles(new Map([['BBB', bbb]]), '1d', DAY),
  ].sort((left, right) => left.tsMs - right.tsMs || left.symbol.localeCompare(right.symbol));

  const result = runBacktest(emaTrendSwitchStrategy, {
    candles,
    initialCash: 10_000_000,
    execution: ZERO_COST,
    parameters: FAST_PARAMS,
    randomSeed: 1,
    maxPositions: 5,
    universeSchedule: [
      { fromTsMs: START, symbols: ['AAA', 'BBB'] },
      { fromTsMs: START + 20 * DAY, symbols: ['BBB'] },
      { fromTsMs: START + 21 * DAY, symbols: ['AAA', 'BBB'] },
    ],
  });

  expect(result.fills.filter((fill) => fill.side === 'BUY').map((fill) => fill.symbol)).toEqual([
    'BBB',
  ]);
});
```

The first 20 common bars create an inverse-correlation group and make `AAA` emit a BUY on day 19. The day-20 membership cancels that engine order while `AAA` has no bar. On day 21, `AAA` returns without a bar and `BBB` becomes a strong EMA entry; stale `AAA.pendingEntry` must not reserve the group.

- [ ] **Step 2: Add the failing RSI regression test**

Add this test inside `describe('실행 동작', ...)` in `tests/unit/rsi-reversion.test.ts`:

```ts
it('편출로 취소된 진입 예약이 봉 없는 재편입 뒤 같은 그룹 종목을 막지 않는다', () => {
  const rising = Array.from({ length: 20 }, (_, index) =>
    index < 15
      ? 1_000 + (index % 2 === 0 ? 10 : -10)
      : 1_000 + (index - 15 + 1) * 15,
  );
  const aaa = rising.map((close) => 1_000_000 / close);
  const bbb = [...rising, 1_100, 500, 500];
  const candles = [
    ...aaa.map((close, index) => candle('AAA', index, close)),
    ...bbb.map((close, index) => candle('BBB', index, close)),
  ].sort((left, right) => left.tsMs - right.tsMs || left.symbol.localeCompare(right.symbol));

  const result = runBacktest(rsiReversionStrategy, {
    candles,
    initialCash: 10_000_000,
    execution: ZERO_COST,
    parameters: FAST_PARAMS,
    randomSeed: 1,
    maxPositions: 5,
    universeSchedule: [
      { fromTsMs: START, symbols: ['AAA', 'BBB'] },
      { fromTsMs: START + 20 * DAY, symbols: ['BBB'] },
      { fromTsMs: START + 21 * DAY, symbols: ['AAA', 'BBB'] },
    ],
  });

  expect(result.fills.filter((fill) => fill.side === 'BUY').map((fill) => fill.symbol)).toEqual([
    'BBB',
  ]);
});
```

Here `AAA` is the declining inverse path and emits the day-19 RSI BUY. `BBB` drops into oversold territory only after `AAA`'s order has been canceled.

- [ ] **Step 3: Run both tests and verify RED**

Run:

```bash
pnpm exec vitest run tests/unit/swing-strategies.test.ts tests/unit/rsi-reversion.test.ts --reporter=verbose
```

Expected: exactly the two new tests fail because their BUY symbol arrays are `[]` instead of `['BBB']`; all pre-existing tests in both files pass.

### Task 2: Clear reservations when membership ends

**Files:**
- Modify: `src/server/modules/strategy/strategies/ema-trend-switch.ts`
- Modify: `src/server/modules/strategy/strategies/rsi-reversion.ts`
- Test: `tests/unit/swing-strategies.test.ts`
- Test: `tests/unit/rsi-reversion.test.ts`

**Interfaces:**
- Consumes: `context.activeUniverseSymbols: ReadonlySet<string> | null`, each strategy state's `bySymbol` map, and `HoldingState.pendingEntry`.
- Produces: no new public API; only a corrected state transition inside each `onBars()` implementation.

- [ ] **Step 1: Implement the minimal EMA state cleanup**

Immediately after `updateCorrelationGrouping(...)` returns in `ema-trend-switch.ts`, add:

```ts
if (context.activeUniverseSymbols !== null) {
  for (const [symbol, symbolState] of state.bySymbol) {
    if (!context.activeUniverseSymbols.has(symbol)) {
      symbolState.holding.pendingEntry = false;
    }
  }
}
```

Do not call `getSymbolState()` here: symbols with no prior bars have no stale reservation and should not allocate indicator state.

- [ ] **Step 2: Implement the minimal RSI state cleanup**

Immediately after `updateCorrelationGrouping(...)` returns in `rsi-reversion.ts`, add the same membership-scoped loop:

```ts
if (context.activeUniverseSymbols !== null) {
  for (const [symbol, symbolState] of state.bySymbol) {
    if (!context.activeUniverseSymbols.has(symbol)) {
      symbolState.holding.pendingEntry = false;
    }
  }
}
```

Keep the existing `tradableSymbols` check in the bar loop. It handles the different case where a bar is present but a BUY cannot be issued that day.

- [ ] **Step 3: Run the focused tests and verify GREEN**

Run:

```bash
pnpm exec vitest run tests/unit/swing-strategies.test.ts tests/unit/ema-trend-switch.test.ts tests/unit/rsi-reversion.test.ts tests/unit/backtest-engine-universe-schedule.test.ts --reporter=verbose
```

Expected: all tests pass, including both new `편출로 취소된 진입 예약...` cases and the existing suspended-active-member ownership cases.

- [ ] **Step 4: Run static checks**

Run:

```bash
git diff --check
pnpm lint
pnpm typecheck
```

Expected: all commands exit 0 with no lint or type errors.

- [ ] **Step 5: Commit the bug fix**

```bash
git add \
  src/server/modules/strategy/strategies/ema-trend-switch.ts \
  src/server/modules/strategy/strategies/rsi-reversion.ts \
  tests/unit/swing-strategies.test.ts \
  tests/unit/rsi-reversion.test.ts
git commit -m "fix: clear canceled swing entry reservations"
```

### Task 3: Verify and publish the review fix

**Files:**
- No additional source files.
- Inspect: `docs/superpowers/specs/2026-08-13-stale-pending-entry-design.md`
- Inspect: `docs/superpowers/plans/2026-08-13-stale-pending-entry.md`

**Interfaces:**
- Consumes: the completed two-strategy fix and its two regression tests.
- Produces: a verified commit pushed to `origin/agent/fix-dynamic-universe-pair-groups` and an updated Draft PR #7.

- [ ] **Step 1: Review the completed diff against the spec**

Run:

```bash
git diff 90c96bd..HEAD --stat
git diff 90c96bd..HEAD -- \
  src/server/modules/strategy/strategies/ema-trend-switch.ts \
  src/server/modules/strategy/strategies/rsi-reversion.ts \
  tests/unit/swing-strategies.test.ts \
  tests/unit/rsi-reversion.test.ts
```

Confirm that only inactive-membership `pendingEntry` cleanup and the two regression tests changed; `tradableSymbols` handling, group calculation, and strategy versions remain unchanged.

- [ ] **Step 2: Request a read-only code review**

Ask the reviewer to inspect the implementation commit range and specifically verify:

- the original GitHub thread scenario is reproduced and fixed;
- a suspended but still-active symbol retains group ownership;
- no engine/public-contract expansion was introduced;
- no Critical or Important issue remains.

Fix any valid Critical or Important finding and rerun the focused tests before continuing.

- [ ] **Step 3: Run full verification**

Run:

```bash
git diff --check origin/main...HEAD
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

Expected:

- diff check, lint, typecheck, and build exit 0;
- 129 test files pass;
- 1,321 tests pass (the previous 1,319 plus two regressions);
- the existing Vite chunk-size warning is non-blocking.

- [ ] **Step 4: Push the existing feature branch**

```bash
git push origin agent/fix-dynamic-universe-pair-groups
git rev-list --left-right --count origin/agent/fix-dynamic-universe-pair-groups...HEAD
```

Expected: push succeeds and the divergence output is `0 0`.

- [ ] **Step 5: Report the GitHub thread disposition**

Report that the code and tests addressing thread `discussion_r3771729798` are pushed. Do not reply to or resolve the GitHub review thread unless the user separately authorizes that GitHub write action.
