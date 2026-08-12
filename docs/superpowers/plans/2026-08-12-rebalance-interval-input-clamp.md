# Rebalance Interval Input Clamp Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow temporary empty and out-of-range rebalance interval input, restore an empty input's last valid value on blur, and clamp out-of-range integers on blur.

**Architecture:** Keep `UniverseRule` valid by adding a local string draft to `UniverseRuleStep`. Valid in-range integers continue to update the parent immediately; empty, malformed, and out-of-range drafts remain local until blur resolves them.

**Tech Stack:** React 19, TypeScript 5.9, Playwright 1.62, Vitest 4.1, pnpm 10

## Global Constraints

- Keep the existing interval limits: day `365`, week `52`, month `12`, year `1`.
- Keep year input disabled and fixed at `1`.
- Empty or non-integer input restores the last valid parent value on blur.
- Integers below `1` clamp to `1`; integers above the current unit maximum clamp to that maximum.
- Do not change server schemas, period-fit validation, or other numeric inputs.

---

### Task 1: Rebalance interval draft input and blur normalization

**Files:**
- Modify: `tests/e2e/universe-pipeline.spec.ts`
- Modify: `src/web/features/backtests/universe-rule-step.tsx:216-225,484-504`

**Interfaces:**
- Consumes: `UniverseRuleStepProps.value.rebalanceInterval`, `UniverseRuleStepProps.onChange`, and `REBALANCE_UNIT_MAX`.
- Produces: local `rebalanceIntervalText: string`; no exported interface changes.

- [ ] **Step 1: Write the failing browser test**

Add this test after the strategy-list test in `tests/e2e/universe-pipeline.spec.ts`:

```typescript
test('리밸런스 주기 입력은 편집 중 임시값을 허용하고 blur에서 보정한다', async ({
  page,
}) => {
  await login(page);
  await page.goto('/backtests/new');
  await page.getByRole('button', { name: /전고점 돌파/ }).click();
  await page.getByLabel('돌파 기준 봉 수', { exact: true }).fill('10');
  await page.getByLabel('변동성(ATR) 계산 기간', { exact: true }).fill('5');
  await page.getByRole('button', { name: '다음' }).click();

  await page.getByLabel('시작일').fill('2026-01-01');
  await page.getByLabel('종료일').fill('2026-12-31');
  await page.getByRole('button', { name: '다음' }).click();

  const interval = page.getByLabel('리밸런스 주기', { exact: true });
  await expect(interval).toHaveValue('1');

  await interval.fill('');
  await expect(interval).toHaveValue('');
  await interval.fill('3');
  await expect(interval).toHaveValue('3');

  await interval.fill('99');
  await expect(interval).toHaveValue('99');
  await interval.blur();
  await expect(interval).toHaveValue('12');

  await interval.fill('0');
  await expect(interval).toHaveValue('0');
  await interval.blur();
  await expect(interval).toHaveValue('1');

  await interval.fill('3');
  await interval.fill('');
  await interval.blur();
  await expect(interval).toHaveValue('3');
});
```

This test catches the current controlled-input bug: removing `rebalanceIntervalText` or binding the input back to `value.rebalanceInterval.value` makes the empty-value assertion fail.

- [ ] **Step 2: Run the test and verify the RED state**

Build the unchanged production application:

```bash
pnpm build
```

Then run only the new desktop scenario:

```bash
pnpm exec playwright test tests/e2e/universe-pipeline.spec.ts --project=desktop --grep "리밸런스 주기 입력은"
```

Expected: FAIL at `toHaveValue('')`; the input has returned to `1` because the current `onChange` rejects the empty draft.

- [ ] **Step 3: Add the minimal local draft implementation**

Near the existing local state declarations in `UniverseRuleStep`, add a string draft synchronized from the valid parent interval:

```typescript
const [rebalanceIntervalText, setRebalanceIntervalText] = useState(() =>
  String(value.rebalanceInterval.value),
);

useEffect(() => {
  setRebalanceIntervalText(String(value.rebalanceInterval.value));
}, [value.rebalanceInterval.unit, value.rebalanceInterval.value]);
```

Replace the interval input's `value` and `onChange`, then add `onBlur`:

```tsx
value={rebalanceIntervalText}
onChange={(e) => {
  const text = e.target.value;
  setRebalanceIntervalText(text);

  if (text.trim() === '') return;
  const n = Number(text);
  const max = REBALANCE_UNIT_MAX[value.rebalanceInterval.unit];
  if (!Number.isInteger(n) || n < 1 || n > max) return;

  onChange({
    ...value,
    rebalanceInterval: buildRebalanceInterval(value.rebalanceInterval.unit, n),
  });
}}
onBlur={() => {
  const text = rebalanceIntervalText.trim();
  const n = Number(text);

  if (text === '' || !Number.isInteger(n)) {
    setRebalanceIntervalText(String(value.rebalanceInterval.value));
    return;
  }

  const max = REBALANCE_UNIT_MAX[value.rebalanceInterval.unit];
  const clamped = Math.min(max, Math.max(1, n));
  setRebalanceIntervalText(String(clamped));

  if (clamped !== value.rebalanceInterval.value) {
    onChange({
      ...value,
      rebalanceInterval: buildRebalanceInterval(value.rebalanceInterval.unit, clamped),
    });
  }
}}
```

Do not change `min`, `max`, the year disabled state, unit-change clamping, or period-fit validation.

- [ ] **Step 4: Rebuild and verify the GREEN state**

```bash
pnpm build
```

```bash
pnpm exec playwright test tests/e2e/universe-pipeline.spec.ts --project=desktop --grep "리밸런스 주기 입력은"
```

Expected: PASS.

- [ ] **Step 5: Run focused regression checks**

```bash
pnpm test tests/unit/universe-stage-editor-markup.test.tsx
```

```bash
pnpm exec playwright test tests/e2e/universe-pipeline.spec.ts --project=desktop
```

```bash
pnpm typecheck
```

```bash
pnpm lint
```

Expected: every command exits successfully without new warnings or errors.

- [ ] **Step 6: Commit the implementation**

```bash
git add tests/e2e/universe-pipeline.spec.ts src/web/features/backtests/universe-rule-step.tsx
git commit -m "fix(web): 리밸런스 주기 입력을 blur에서 보정한다"
```
