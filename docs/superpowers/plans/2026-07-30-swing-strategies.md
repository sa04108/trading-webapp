# 단타·스윙 전략 2종 (`ema-trend-switch` · `rsi-reversion`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 봉 수로만 파라미터라이즈된 단기 전략 2개(EMA 추세 스위치, RSI 되돌림)를 추가한다. 역상관 상관 그룹핑으로 레버리지·곱버스 동시 보유를 막되, 전략은 상품 유형을 모른다.

**Architecture:** 공용 부품(지표·상관 그룹·수량 산정·스톱 관리)을 `strategies/shared/` 에 순수 함수로 만들고, 전략 2개가 이를 조합한다. 기존 전략 파일은 절대 수정하지 않는다(strategySourceHash 가 바뀐다). 엔진은 롱 온리 — 방향은 종목 선택으로 표현된다.

**Tech Stack:** TypeScript(ESM, `.js` import 확장자), zod v4(`.meta()` 한국어 라벨), vitest.

**Spec:** `docs/superpowers/specs/2026-07-30-swing-strategies-design.md`

## Global Constraints

- 기존 파일 중 수정 허용은 `strategy-registry.ts` 하나뿐. `hourly-breakout.ts` 등 기존 전략·shared 파일은 읽기만.
- import 는 상대 경로 + `.js` 확장자 (기존 관례).
- 파라미터 한국어 `title`/`description` 은 `.meta()` 로 — 위저드가 JSON 스키마에서 그대로 읽는다.
- 사용자 노출 문자열(이름·설명·라벨)에 스펙 참조(§)·CLI 명령·내부 식별자 금지.
- 모든 반복은 심볼 코드 오름차순 — 재현성 (같은 입력 → 같은 주문 시퀀스).
- 커밋 메시지는 한국어, 기존 스타일(`feat(strategy): …`).
- 각 태스크 종료 시 `npx tsc --noEmit -p tsconfig.json` 통과.

---

### Task 1: `shared/indicators.ts` — EMA · Wilder RSI · Wilder ATR

**Files:**
- Create: `src/server/modules/strategy/strategies/shared/indicators.ts`
- Test: `tests/unit/indicators.test.ts`

**Interfaces:**
- Consumes: 없음 (순수 모듈)
- Produces:
  - `EmaState { value: number | null; barsSeen: number }`, `newEma(): EmaState`, `updateEma(state, price: number, bars: number): void`
  - `AtrState { atr: number | null; prevClose: number | null; barsSeen: number }`, `newAtr(): AtrState`, `updateAtr(state, bar: { high: number; low: number; close: number }, period: number): void`
  - `RsiState { avgGain: number | null; avgLoss: number | null; prevClose: number | null; changesSeen: number; sumGain: number; sumLoss: number }`, `newRsi(): RsiState`, `updateRsi(state, close: number, period: number): void`, `rsiValue(state): number | null`

- [x] **Step 1: 실패하는 테스트 작성**

`tests/unit/indicators.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  newAtr,
  newEma,
  newRsi,
  rsiValue,
  updateAtr,
  updateEma,
  updateRsi,
} from '../../src/server/modules/strategy/strategies/shared/indicators.js';

describe('updateEma', () => {
  it('첫 값으로 시딩하고 이후 alpha=2/(n+1) 로 갱신한다', () => {
    const state = newEma();
    updateEma(state, 10, 3); // seed
    expect(state.value).toBe(10);
    updateEma(state, 20, 3); // alpha = 0.5 → 10 + 0.5×(20−10) = 15
    expect(state.value).toBeCloseTo(15);
    updateEma(state, 20, 3); // 15 + 0.5×5 = 17.5
    expect(state.value).toBeCloseTo(17.5);
    expect(state.barsSeen).toBe(3);
  });
});

describe('updateAtr (Wilder)', () => {
  it('첫 봉은 high−low, 이후 (prev×(n−1)+TR)/n — hourly-breakout 과 같은 정의', () => {
    const state = newAtr();
    updateAtr(state, { high: 12, low: 8, close: 10 }, 2);
    expect(state.atr).toBe(4); // 12−8
    // TR = max(14−9, |14−10|, |9−10|) = 5 → (4×1+5)/2 = 4.5
    updateAtr(state, { high: 14, low: 9, close: 13 }, 2);
    expect(state.atr).toBeCloseTo(4.5);
    expect(state.barsSeen).toBe(2);
  });
});

describe('updateRsi (Wilder)', () => {
  it('period 개 변화가 모이기 전엔 null', () => {
    const state = newRsi();
    updateRsi(state, 100, 3);
    updateRsi(state, 101, 3);
    updateRsi(state, 102, 3);
    expect(rsiValue(state)).toBeNull(); // 변화 2개뿐
    updateRsi(state, 103, 3);
    expect(rsiValue(state)).not.toBeNull(); // 변화 3개 — 시딩 완료
  });

  it('전부 상승이면 100, 손계산 값과 일치한다', () => {
    const up = newRsi();
    for (const close of [100, 101, 102, 103]) updateRsi(up, close, 3);
    expect(rsiValue(up)).toBe(100); // avgLoss = 0

    // 변화 +1, −1, +1 → avgGain = 2/3, avgLoss = 1/3 → RS=2 → RSI = 100−100/3
    const mixed = newRsi();
    for (const close of [100, 101, 100, 101]) updateRsi(mixed, close, 3);
    expect(rsiValue(mixed)).toBeCloseTo(100 - 100 / 3);
  });

  it('시딩 후에는 Wilder 평활로 갱신한다', () => {
    const state = newRsi();
    for (const close of [100, 101, 100, 101]) updateRsi(state, close, 3);
    // avgGain=2/3, avgLoss=1/3 에서 변화 +2 → avgGain=(2/3×2+2)/3, avgLoss=(1/3×2)/3
    updateRsi(state, 103, 3);
    const avgGain = (2 / 3 * 2 + 2) / 3;
    const avgLoss = (1 / 3 * 2) / 3;
    expect(rsiValue(state)).toBeCloseTo(100 - 100 / (1 + avgGain / avgLoss));
  });
});
```

- [x] **Step 2: 실패 확인**

Run: `npx vitest run tests/unit/indicators.test.ts`
Expected: FAIL — 모듈 없음.

- [x] **Step 3: 구현**

`src/server/modules/strategy/strategies/shared/indicators.ts`:

```ts
/**
 * 증분 갱신형 지표. 상태 객체 + 순수 갱신 함수 — 전략이 심볼별로 상태를 들고
 * 봉마다 한 번 호출한다. 배열 재계산이 없어 봉 수에 선형이다.
 *
 * ATR 정의는 hourly-breakout 의 것과 동일(Wilder)하지만 그 파일에서 옮기지
 * 않았다 — 기존 전략 파일이 바뀌면 strategySourceHash 가 바뀐다.
 */

export interface EmaState {
  value: number | null;
  barsSeen: number;
}

export function newEma(): EmaState {
  return { value: null, barsSeen: 0 };
}

/** 첫 값으로 시딩, 이후 표준 지수평활 (alpha = 2/(bars+1)) */
export function updateEma(state: EmaState, price: number, bars: number): void {
  state.barsSeen += 1;
  if (state.value === null) {
    state.value = price;
    return;
  }
  const alpha = 2 / (bars + 1);
  state.value = state.value + alpha * (price - state.value);
}

export interface AtrState {
  atr: number | null;
  prevClose: number | null;
  barsSeen: number;
}

export function newAtr(): AtrState {
  return { atr: null, prevClose: null, barsSeen: 0 };
}

/** Wilder ATR — 첫 봉은 high−low, 이후 (prev×(n−1)+TR)/n */
export function updateAtr(
  state: AtrState,
  bar: { high: number; low: number; close: number },
  period: number,
): void {
  const trueRange =
    state.prevClose === null
      ? bar.high - bar.low
      : Math.max(
          bar.high - bar.low,
          Math.abs(bar.high - state.prevClose),
          Math.abs(bar.low - state.prevClose),
        );
  state.atr = state.atr === null ? trueRange : (state.atr * (period - 1) + trueRange) / period;
  state.prevClose = bar.close;
  state.barsSeen += 1;
}

export interface RsiState {
  avgGain: number | null;
  avgLoss: number | null;
  prevClose: number | null;
  changesSeen: number;
  sumGain: number;
  sumLoss: number;
}

export function newRsi(): RsiState {
  return { avgGain: null, avgLoss: null, prevClose: null, changesSeen: 0, sumGain: 0, sumLoss: 0 };
}

/** Wilder RSI — 첫 period 개 변화는 단순평균으로 시딩, 이후 Wilder 평활 */
export function updateRsi(state: RsiState, close: number, period: number): void {
  if (state.prevClose === null) {
    state.prevClose = close;
    return;
  }
  const change = close - state.prevClose;
  state.prevClose = close;
  const gain = Math.max(change, 0);
  const loss = Math.max(-change, 0);
  state.changesSeen += 1;
  if (state.avgGain === null || state.avgLoss === null) {
    state.sumGain += gain;
    state.sumLoss += loss;
    if (state.changesSeen === period) {
      state.avgGain = state.sumGain / period;
      state.avgLoss = state.sumLoss / period;
    }
    return;
  }
  state.avgGain = (state.avgGain * (period - 1) + gain) / period;
  state.avgLoss = (state.avgLoss * (period - 1) + loss) / period;
}

/** 시딩 전(변화 < period)이면 null. avgLoss 0 이면 100. */
export function rsiValue(state: RsiState): number | null {
  if (state.avgGain === null || state.avgLoss === null) return null;
  if (state.avgLoss === 0) return 100;
  return 100 - 100 / (1 + state.avgGain / state.avgLoss);
}
```

- [x] **Step 4: 통과 확인**

Run: `npx vitest run tests/unit/indicators.test.ts && npx tsc --noEmit -p tsconfig.json`
Expected: PASS.

- [x] **Step 5: 커밋**

```bash
git add src/server/modules/strategy/strategies/shared/indicators.ts tests/unit/indicators.test.ts
git commit -m "feat(strategy): 증분 갱신형 EMA·RSI·ATR 지표 부품을 추가한다"
```

---

### Task 2: `shared/pair-groups.ts` — 상관 그룹

**Files:**
- Create: `src/server/modules/strategy/strategies/shared/pair-groups.ts`
- Test: `tests/unit/pair-groups.test.ts`

**Interfaces:**
- Consumes: 없음
- Produces:
  - `pearsonCorrelation(a: readonly number[], b: readonly number[]): number | null` — 길이 불일치 시 짧은 쪽, 표본 < 2 또는 분산 0 이면 null
  - `buildCorrelationGroups(closesBySymbol: ReadonlyMap<string, readonly number[]>, threshold: number): Map<string, string>` — 심볼 → 그룹 id (그룹 내 사전순 최소 심볼). 로그수익률 상관 ≤ −threshold 인 쌍을 전이적으로 병합.

- [x] **Step 1: 실패하는 테스트 작성**

`tests/unit/pair-groups.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  buildCorrelationGroups,
  pearsonCorrelation,
} from '../../src/server/modules/strategy/strategies/shared/pair-groups.js';

/** 기하 경로 — B = 1e6/A 면 로그수익률이 정확히 반대(상관 −1)다 */
function inversePath(path: readonly number[]): number[] {
  return path.map((value) => 1_000_000 / value);
}

// 단조 아님(분산 확보) + 전 구간 양수
const PATH_A = [100, 103, 101, 106, 104, 110, 108, 115, 112, 120];
const PATH_C = [50, 49, 52, 51, 55, 53, 58, 56, 61, 59]; // A 와 무관한 다른 모양

describe('pearsonCorrelation', () => {
  it('완전 역방향 수익률은 −1', () => {
    const a = [0.01, -0.02, 0.03, -0.01];
    const b = a.map((value) => -value);
    expect(pearsonCorrelation(a, b)).toBeCloseTo(-1);
  });

  it('분산이 0 이거나 표본이 2 미만이면 null', () => {
    expect(pearsonCorrelation([0.01], [0.02])).toBeNull();
    expect(pearsonCorrelation([0.01, 0.01, 0.01], [0.01, -0.02, 0.03])).toBeNull();
  });
});

describe('buildCorrelationGroups', () => {
  it('역상관 쌍만 묶고 무관한 종목은 단독 그룹이다', () => {
    const groups = buildCorrelationGroups(
      new Map([
        ['LEV_A', PATH_A],
        ['INV_A', inversePath(PATH_A)],
        ['OTHER', PATH_C],
      ]),
      0.5,
    );
    expect(groups.get('LEV_A')).toBe(groups.get('INV_A'));
    expect(groups.get('OTHER')).not.toBe(groups.get('LEV_A'));
    // 그룹 id 는 그룹 내 사전순 최소 심볼
    expect(groups.get('LEV_A')).toBe('INV_A');
    expect(groups.get('OTHER')).toBe('OTHER');
  });

  it('4종목(두 기초자산 × 레버리지·인버스)이면 그룹 2개다', () => {
    const groups = buildCorrelationGroups(
      new Map([
        ['A_LEV', PATH_A],
        ['A_INV', inversePath(PATH_A)],
        ['C_LEV', PATH_C],
        ['C_INV', inversePath(PATH_C)],
      ]),
      0.5,
    );
    expect(groups.get('A_LEV')).toBe(groups.get('A_INV'));
    expect(groups.get('C_LEV')).toBe(groups.get('C_INV'));
    expect(groups.get('A_LEV')).not.toBe(groups.get('C_LEV'));
  });

  it('입력 Map 의 삽입 순서를 뒤집어도 같은 그룹이 나온다 (재현성)', () => {
    const forward = buildCorrelationGroups(
      new Map([
        ['A_LEV', PATH_A],
        ['A_INV', inversePath(PATH_A)],
      ]),
      0.5,
    );
    const reversed = buildCorrelationGroups(
      new Map([
        ['A_INV', inversePath(PATH_A)],
        ['A_LEV', PATH_A],
      ]),
      0.5,
    );
    expect([...forward.entries()].sort()).toEqual([...reversed.entries()].sort());
  });
});
```

- [x] **Step 2: 실패 확인**

Run: `npx vitest run tests/unit/pair-groups.test.ts`
Expected: FAIL — 모듈 없음.

- [x] **Step 3: 구현**

`src/server/modules/strategy/strategies/shared/pair-groups.ts`:

```ts
/**
 * 역상관 종목 그룹핑 — "같은 기초자산의 레버리지·인버스" 를 상품 메타데이터 없이
 * 가격 움직임만으로 찾는다. 그룹당 1종목 보유 제한의 근거가 되는 유일한 계산.
 *
 * 결정성: 심볼 사전순으로만 순회·병합한다 — 입력 Map 순서에 결과가 의존하면
 * 같은 요청을 두 번 돌려도 결과가 달라진다 (재현성, rank.ts 와 같은 원칙).
 */

/** 로그수익률. 0 이하 가격이 끼면 그 구간은 건너뛴다 — NaN 이 상관을 오염시키지 않게 */
function logReturns(closes: readonly number[]): number[] {
  const returns: number[] = [];
  for (let index = 1; index < closes.length; index += 1) {
    const prev = closes[index - 1] as number;
    const current = closes[index] as number;
    if (prev > 0 && current > 0) returns.push(Math.log(current / prev));
  }
  return returns;
}

/** 표본 < 2 또는 한쪽 분산 0 이면 null — 판정 불가를 0 상관으로 위장하지 않는다 */
export function pearsonCorrelation(
  a: readonly number[],
  b: readonly number[],
): number | null {
  const n = Math.min(a.length, b.length);
  if (n < 2) return null;
  let meanA = 0;
  let meanB = 0;
  for (let index = 0; index < n; index += 1) {
    meanA += (a[index] as number) / n;
    meanB += (b[index] as number) / n;
  }
  let cov = 0;
  let varA = 0;
  let varB = 0;
  for (let index = 0; index < n; index += 1) {
    const da = (a[index] as number) - meanA;
    const db = (b[index] as number) - meanB;
    cov += da * db;
    varA += da * da;
    varB += db * db;
  }
  if (varA === 0 || varB === 0) return null;
  return cov / Math.sqrt(varA * varB);
}

/**
 * 로그수익률 상관 ≤ −threshold 인 쌍을 전이적으로 병합해 심볼 → 그룹 id 를 반환.
 * 그룹 id 는 그룹 내 사전순 최소 심볼 — 실행마다 같은 이름이 나온다.
 */
export function buildCorrelationGroups(
  closesBySymbol: ReadonlyMap<string, readonly number[]>,
  threshold: number,
): Map<string, string> {
  const symbols = [...closesBySymbol.keys()].sort();
  const returns = new Map(
    symbols.map((symbol) => [symbol, logReturns(closesBySymbol.get(symbol) ?? [])]),
  );

  const parent = new Map<string, string>(symbols.map((symbol) => [symbol, symbol]));
  const find = (symbol: string): string => {
    let root = symbol;
    while (parent.get(root) !== root) root = parent.get(root) as string;
    return root;
  };
  const union = (a: string, b: string): void => {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA === rootB) return;
    // 사전순 작은 쪽이 루트 — 그룹 id 가 입력 순서와 무관해진다
    if (rootA < rootB) parent.set(rootB, rootA);
    else parent.set(rootA, rootB);
  };

  for (let i = 0; i < symbols.length; i += 1) {
    for (let j = i + 1; j < symbols.length; j += 1) {
      const correlation = pearsonCorrelation(
        returns.get(symbols[i] as string) ?? [],
        returns.get(symbols[j] as string) ?? [],
      );
      if (correlation !== null && correlation <= -threshold) {
        union(symbols[i] as string, symbols[j] as string);
      }
    }
  }

  return new Map(symbols.map((symbol) => [symbol, find(symbol)]));
}
```

- [x] **Step 4: 통과 확인**

Run: `npx vitest run tests/unit/pair-groups.test.ts && npx tsc --noEmit -p tsconfig.json`
Expected: PASS.

- [x] **Step 5: 커밋**

```bash
git add src/server/modules/strategy/strategies/shared/pair-groups.ts tests/unit/pair-groups.test.ts
git commit -m "feat(strategy): 역상관 종목을 묶는 상관 그룹 부품을 추가한다"
```

---

### Task 3: `shared/position-sizing.ts` + `shared/trailing-stop.ts` — 포지션 관리 부품

**Files:**
- Create: `src/server/modules/strategy/strategies/shared/position-sizing.ts`
- Create: `src/server/modules/strategy/strategies/shared/trailing-stop.ts`
- Test: `tests/unit/position-management.test.ts`

**Interfaces:**
- Consumes: 없음
- Produces:
  - `riskQuantity(equity: number, riskPerTradePercent: number, stopDistance: number): number`
  - `HoldingState { entryAtr: number | null; stopLevel: number | null; highestClose: number | null; barsHeld: number; pendingEntry: boolean; exitPending: boolean }`
  - `newHolding(): HoldingState`
  - `confirmEntry(holding: HoldingState, avgEntryPrice: number, stopAtrMultiplier: number): void`
  - `updateTrail(holding: HoldingState, close: number, trailAtrMultiplier: number): void`
  - `holdLimitReached(holding: HoldingState, maxHoldBars: number | undefined): boolean`

- [x] **Step 1: 실패하는 테스트 작성**

`tests/unit/position-management.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { riskQuantity } from '../../src/server/modules/strategy/strategies/shared/position-sizing.js';
import {
  confirmEntry,
  holdLimitReached,
  newHolding,
  updateTrail,
} from '../../src/server/modules/strategy/strategies/shared/trailing-stop.js';

describe('riskQuantity', () => {
  it('equity × 리스크% ÷ 손절 폭, 내림', () => {
    // 1,000,000 × 1% ÷ 300 = 33.33 → 33
    expect(riskQuantity(1_000_000, 1, 300)).toBe(33);
  });

  it('손절 폭이나 자본이 0 이하면 0 — 진입하지 않는다', () => {
    expect(riskQuantity(1_000_000, 1, 0)).toBe(0);
    expect(riskQuantity(0, 1, 300)).toBe(0);
    expect(riskQuantity(1_000_000, 1, -5)).toBe(0);
  });
});

describe('trailing-stop', () => {
  it('체결 확인 시 실제 진입가 기준으로 스톱을 고정한다', () => {
    const holding = newHolding();
    holding.entryAtr = 100;
    confirmEntry(holding, 10_000, 2);
    expect(holding.stopLevel).toBe(9_800); // 10000 − 2×100
  });

  it('고점 갱신 시 스톱이 따라 오르고, 내려가지는 않는다', () => {
    const holding = newHolding();
    holding.entryAtr = 100;
    confirmEntry(holding, 10_000, 2);
    updateTrail(holding, 10_500, 2); // 고점 10500 → stop = max(9800, 10500−200)
    expect(holding.stopLevel).toBe(10_300);
    updateTrail(holding, 10_100, 2); // 고점 갱신 아님 — 스톱 유지
    expect(holding.stopLevel).toBe(10_300);
  });

  it('entryAtr 없이 confirmEntry 는 no-op — 잘못된 순서에 스톱을 만들지 않는다', () => {
    const holding = newHolding();
    confirmEntry(holding, 10_000, 2);
    expect(holding.stopLevel).toBeNull();
  });

  it('holdLimitReached: maxHoldBars 미지정이면 항상 false', () => {
    const holding = newHolding();
    holding.barsHeld = 9_999;
    expect(holdLimitReached(holding, undefined)).toBe(false);
    expect(holdLimitReached(holding, 9_999)).toBe(true);
    expect(holdLimitReached(holding, 10_000)).toBe(false);
  });
});
```

- [x] **Step 2: 실패 확인**

Run: `npx vitest run tests/unit/position-management.test.ts`
Expected: FAIL — 모듈 없음.

- [x] **Step 3: 구현**

`src/server/modules/strategy/strategies/shared/position-sizing.ts`:

```ts
/**
 * 리스크 기반 수량: floor(equity × riskPct% ÷ stopDistance).
 * 변동성(ATR) 반비례라 2x 레버리지 상품은 수량이 자동으로 절반쯤 된다 —
 * 전략이 상품 유형을 몰라도 리스크가 일정해지는 이유.
 */
export function riskQuantity(
  equity: number,
  riskPerTradePercent: number,
  stopDistance: number,
): number {
  if (!(equity > 0) || !(stopDistance > 0)) return 0;
  return Math.floor((equity * (riskPerTradePercent / 100)) / stopDistance);
}
```

`src/server/modules/strategy/strategies/shared/trailing-stop.ts`:

```ts
/**
 * 보유 상태 한 벌 — 진입 대기(pendingEntry)·청산 대기(exitPending)·스톱 레벨·
 * 보유 봉 수를 들고 다닌다. hourly-breakout 의 관례를 따르되 공용으로 새로 작성:
 * 스톱은 신호봉 종가가 아니라 **실제 체결가** 기준으로 고정한다 (갭 진입 대응).
 *
 * 트레일링은 updateTrail 을 부르는 전략만 쓴다 — rsi-reversion 처럼 고정 스톱
 * 전략은 confirmEntry 만 부른다.
 */
export interface HoldingState {
  /** 신호 시점 ATR — 체결 확인 후 스톱 폭 계산에 쓰인다 */
  entryAtr: number | null;
  stopLevel: number | null;
  highestClose: number | null;
  barsHeld: number;
  pendingEntry: boolean;
  exitPending: boolean;
}

export function newHolding(): HoldingState {
  return {
    entryAtr: null,
    stopLevel: null,
    highestClose: null,
    barsHeld: 0,
    pendingEntry: false,
    exitPending: false,
  };
}

/** 체결이 확인된 첫 봉에 호출 — 실제 진입가 기준으로 스톱을 고정한다 */
export function confirmEntry(
  holding: HoldingState,
  avgEntryPrice: number,
  stopAtrMultiplier: number,
): void {
  if (holding.entryAtr === null) return;
  holding.stopLevel = avgEntryPrice - stopAtrMultiplier * holding.entryAtr;
  holding.highestClose = avgEntryPrice;
}

/** 종가가 고점을 갱신하면 스톱을 (고점 − trail×ATR) 까지 끌어올린다. 내리지는 않는다 */
export function updateTrail(
  holding: HoldingState,
  close: number,
  trailAtrMultiplier: number,
): void {
  if (holding.entryAtr === null || holding.stopLevel === null) return;
  if (holding.highestClose === null || close > holding.highestClose) {
    holding.highestClose = close;
    holding.stopLevel = Math.max(
      holding.stopLevel,
      holding.highestClose - trailAtrMultiplier * holding.entryAtr,
    );
  }
}

/** maxHoldBars 미지정이면 무제한 */
export function holdLimitReached(
  holding: HoldingState,
  maxHoldBars: number | undefined,
): boolean {
  return maxHoldBars !== undefined && holding.barsHeld >= maxHoldBars;
}
```

- [x] **Step 4: 통과 확인**

Run: `npx vitest run tests/unit/position-management.test.ts && npx tsc --noEmit -p tsconfig.json`
Expected: PASS.

- [x] **Step 5: 커밋**

```bash
git add src/server/modules/strategy/strategies/shared/position-sizing.ts src/server/modules/strategy/strategies/shared/trailing-stop.ts tests/unit/position-management.test.ts
git commit -m "feat(strategy): 리스크 수량·스톱 관리 부품을 추가한다"
```

---

### Task 4: `ema-trend-switch` 전략 + 레지스트리 등록

**Files:**
- Create: `src/server/modules/strategy/strategies/ema-trend-switch.ts`
- Modify: `src/server/modules/strategy/application/strategy-registry.ts` (import + `STRATEGIES` 배열에 추가)
- Test: `tests/unit/ema-trend-switch.test.ts`

**Interfaces:**
- Consumes: Task 1 `newEma`/`updateEma`/`newAtr`/`updateAtr`, Task 2 `buildCorrelationGroups`, Task 3 전체
- Produces: `emaTrendSwitchParameters` (zod 스키마), `emaTrendSwitchStrategy: TradingStrategy<EmaTrendSwitchParameters, EmaTrendSwitchState>` — id `'ema-trend-switch'`, version `'1.0.0'`

- [x] **Step 1: 실패하는 테스트 작성**

`tests/unit/ema-trend-switch.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { runBacktest } from '../../src/server/modules/backtest/domain/engine.js';
import type { ExecutionProfile } from '../../src/server/modules/backtest/domain/types.js';
import type { Candle } from '../../src/server/modules/market-data/domain/candle.js';
import { StrategyRegistry } from '../../src/server/modules/strategy/application/strategy-registry.js';
import {
  emaTrendSwitchParameters,
  emaTrendSwitchStrategy,
} from '../../src/server/modules/strategy/strategies/ema-trend-switch.js';

const DAY = 86_400_000;
const START = Date.UTC(2025, 0, 2);

const ZERO_COST: ExecutionProfile = {
  cost: { id: 'zero', version: '1', buyCommissionRate: 0, sellCommissionRate: 0, sellTaxRate: 0 },
  slippage: { id: 'zero', version: '1', bps: 0, fixed: 0 },
  rules: { tickSize: 0, minOrderQty: 1 },
};

function candle(symbol: string, index: number, close: number): Candle {
  return {
    symbol,
    market: 'KR',
    timeframe: '1d',
    tsMs: START + index * DAY,
    open: close,
    high: close * 1.01,
    low: close * 0.99,
    close,
    volume: 1_000,
  };
}

/**
 * 역상관 쌍: LEV 가 진동하며 오르내리면 INV = 1e6/LEV 는 정확히 반대로 움직인다.
 * 워밍업(진동, 추세 없음) 뒤 LEV 만 상승 추세 — LEV 만 진입해야 한다.
 */
function pairCandles(bars: number, warmupBars: number): Candle[] {
  const candles: Candle[] = [];
  for (let index = 0; index < bars; index += 1) {
    const lev =
      index < warmupBars
        ? 1_000 + (index % 2 === 0 ? 10 : -10) // 진동 — 추세 없음, 상관은 뚜렷
        : 1_000 + (index - warmupBars + 1) * 15; // 상승 추세
    candles.push(candle('LEV', index, lev));
    candles.push(candle('INV', index, 1_000_000 / lev));
  }
  return candles.sort((a, b) => a.tsMs - b.tsMs);
}

const FAST_PARAMS = {
  fastEmaBars: 3,
  slowEmaBars: 6,
  entryThresholdPercent: 0.3,
  atrPeriod: 3,
  stopAtrMultiplier: 2,
  trailAtrMultiplier: 2,
  riskPerTradePercent: 1,
  correlationBars: 20,
  correlationThreshold: 0.5,
};

describe('emaTrendSwitchParameters', () => {
  it('기본값만으로 파싱된다 (maxHoldBars 는 선택)', () => {
    const parsed = emaTrendSwitchParameters.parse({});
    expect(parsed.fastEmaBars).toBe(12);
    expect(parsed.slowEmaBars).toBe(26);
    expect(parsed.maxHoldBars).toBeUndefined();
  });

  it('fastEmaBars ≥ slowEmaBars 를 거부한다', () => {
    expect(
      emaTrendSwitchParameters.safeParse({ fastEmaBars: 26, slowEmaBars: 26 }).success,
    ).toBe(false);
  });
});

describe('레지스트리 등록', () => {
  it('목록에 노출되고 JSON 스키마가 라벨과 함께 나온다 (refine 이 스키마 생성을 깨지 않는다)', () => {
    const registry = new StrategyRegistry();
    expect(registry.list().map((s) => s.id)).toContain('ema-trend-switch');
    const schema = registry.getParameterJsonSchema('ema-trend-switch');
    const properties = (schema as { properties: Record<string, Record<string, unknown>> })
      .properties;
    expect(properties.fastEmaBars?.title).toBe('단기 이동평균 봉 수');
    expect(properties.fastEmaBars?.default).toBe(12);
  });
});

describe('실행 동작', () => {
  it('상승 추세인 쪽만 사고, 역상관 짝은 같은 그룹이라 사지 않는다', () => {
    const result = runBacktest(emaTrendSwitchStrategy, {
      candles: pairCandles(60, 25),
      initialCash: 10_000_000,
      execution: ZERO_COST,
      parameters: FAST_PARAMS,
      randomSeed: 1,
      maxPositions: 5,
    });
    const buys = result.fills.filter((fill) => fill.side === 'BUY');
    expect(buys.length).toBeGreaterThan(0);
    expect(new Set(buys.map((fill) => fill.symbol))).toEqual(new Set(['LEV']));
  });

  it('상관 워밍업이 차기 전에는 진입하지 않는다', () => {
    // 전 구간 상승 추세 — 워밍업 20봉 없이는 진입 불가여야 한다
    const candles: Candle[] = [];
    for (let index = 0; index < 15; index += 1) {
      candles.push(candle('LEV', index, 1_000 + index * 15));
    }
    const result = runBacktest(emaTrendSwitchStrategy, {
      candles,
      initialCash: 10_000_000,
      execution: ZERO_COST,
      parameters: FAST_PARAMS,
      randomSeed: 1,
      maxPositions: 5,
    });
    expect(result.fills).toHaveLength(0);
  });

  it('추세가 꺾이면 청산한다 (TREND_END 또는 STOP)', () => {
    // 워밍업 25 + 상승 20 + 급락 15
    const candles: Candle[] = [];
    for (let index = 0; index < 60; index += 1) {
      const close =
        index < 25
          ? 1_000 + (index % 2 === 0 ? 10 : -10)
          : index < 45
            ? 1_000 + (index - 24) * 15
            : 1_300 - (index - 44) * 40;
      candles.push(candle('LEV', index, close));
    }
    const result = runBacktest(emaTrendSwitchStrategy, {
      candles,
      initialCash: 10_000_000,
      execution: ZERO_COST,
      parameters: FAST_PARAMS,
      randomSeed: 1,
      maxPositions: 5,
    });
    const sells = result.fills.filter((fill) => fill.side === 'SELL');
    expect(sells.length).toBeGreaterThan(0);
    expect(['STOP', 'TREND_END']).toContain(sells[0]?.reason);
  });
});
```

- [x] **Step 2: 실패 확인**

Run: `npx vitest run tests/unit/ema-trend-switch.test.ts`
Expected: FAIL — 모듈 없음.

- [x] **Step 3: 전략 구현**

`src/server/modules/strategy/strategies/ema-trend-switch.ts`:

```ts
import { z } from 'zod';
import type { OrderIntent } from '../../backtest/domain/types.js';
import type {
  StrategyBarContext,
  StrategyDecision,
  TradingStrategy,
  StrategyInitializeContext,
} from '../domain/strategy.js';
import {
  newAtr,
  newEma,
  updateAtr,
  updateEma,
  type AtrState,
  type EmaState,
} from './shared/indicators.js';
import { buildCorrelationGroups } from './shared/pair-groups.js';
import { riskQuantity } from './shared/position-sizing.js';
import {
  confirmEntry,
  holdLimitReached,
  newHolding,
  updateTrail,
  type HoldingState,
} from './shared/trailing-stop.js';

/**
 * EMA 추세 스위치 (설계 2026-07-30-swing-strategies-design.md §3).
 *
 * 단기·장기 EMA 간격이 임계%를 넘은 종목을 사고, 트레일링 스톱·추세 반전·보유
 * 상한으로 판다. 모든 창이 봉 수라 분봉 데이트레이딩부터 일봉 스윙까지 같은
 * 로직이다.
 *
 * 방향은 종목 선택으로 표현된다: 역상관 종목(예: 레버리지·곱버스)을 함께 넣으면
 * 상승 추세에선 한쪽만, 하락 추세에선 반대쪽만 조건을 만족한다. 워밍업 후 1회
 * 계산해 고정하는 상관 그룹이 같은 묶음의 동시 보유를 막는다 — 전략은 어느
 * 종목이 인버스인지 모른다.
 */
export const emaTrendSwitchParameters = z
  .object({
    fastEmaBars: z.number().int().min(2).max(100).default(12).meta({
      title: '단기 이동평균 봉 수',
      description:
        '최근 흐름을 재는 짧은 지수이동평균의 봉 수입니다. 장기 이동평균보다 작아야 합니다.',
    }),
    slowEmaBars: z.number().int().min(5).max(400).default(26).meta({
      title: '장기 이동평균 봉 수',
      description: '기준 추세를 재는 긴 지수이동평균의 봉 수입니다.',
    }),
    entryThresholdPercent: z.number().min(0.01).max(10).default(0.3).meta({
      title: '진입 간격 (%)',
      description:
        '단기 이동평균이 장기보다 이 비율(%) 이상 위에 있으면 진입합니다. 크게 잡으면 뚜렷한 추세만 잡습니다.',
    }),
    atrPeriod: z.number().int().min(2).max(100).default(14).meta({
      title: '변동성(ATR) 계산 기간',
      description: '손절 폭과 주문 수량의 기준이 되는 변동성을 몇 개 봉으로 평균낼지 정합니다.',
    }),
    stopAtrMultiplier: z.number().positive().max(20).default(2).meta({
      title: '손절 폭 (변동성 배수)',
      description: '진입가에서 변동성 × 이 값만큼 내려가면 손절합니다. 주문 수량 계산에도 쓰입니다.',
    }),
    trailAtrMultiplier: z.number().positive().max(20).default(2).meta({
      title: '추적 손절 폭 (변동성 배수)',
      description: '보유 중 고점에서 변동성 × 이 값만큼 내려오면 팝니다. 고점을 따라 손절선이 올라갑니다.',
    }),
    maxHoldBars: z.number().int().min(1).max(10_000).optional().meta({
      title: '최대 보유 봉 수 (선택)',
      description:
        '이 봉 수를 넘기면 신호와 무관하게 팝니다. 분봉이면 390이 약 하루, 일봉이면 20이 약 1달입니다. 비우면 제한이 없습니다.',
    }),
    riskPerTradePercent: z.number().positive().max(5).default(1).meta({
      title: '1회 거래 리스크 (%)',
      description: '한 번의 거래에서 감당할 자본 비율입니다. 주문 수량 = 자본 × 이 비율 ÷ 손절 폭.',
    }),
    correlationBars: z.number().int().min(20).max(500).default(60).meta({
      title: '상관 계산 봉 수',
      description:
        '이 봉 수가 쌓이면 종목간 상관을 한 번 계산해 반대로 움직이는 종목들을 한 묶음으로 봅니다. 이 구간에는 진입하지 않습니다.',
    }),
    correlationThreshold: z.number().min(0.1).max(0.95).default(0.5).meta({
      title: '역상관 판정 기준',
      description:
        '상관계수가 이 값보다 강하게 반대(-)면 같은 묶음으로 봅니다. 같은 묶음에서는 한 종목만 보유합니다.',
    }),
  })
  .refine((value) => value.fastEmaBars < value.slowEmaBars, {
    message: '단기 이동평균 봉 수는 장기보다 작아야 합니다',
    path: ['fastEmaBars'],
  });

export type EmaTrendSwitchParameters = z.infer<typeof emaTrendSwitchParameters>;

interface SymbolState {
  fast: EmaState;
  slow: EmaState;
  atr: AtrState;
  holding: HoldingState;
  /** 상관 계산용 종가 — 그룹 확정 후 비운다 */
  closes: number[];
}

export interface EmaTrendSwitchState {
  readonly bySymbol: Map<string, SymbolState>;
  readonly symbols: readonly string[];
  groupOf: Map<string, string> | null;
}

function getSymbolState(state: EmaTrendSwitchState, symbol: string): SymbolState {
  let symbolState = state.bySymbol.get(symbol);
  if (!symbolState) {
    symbolState = { fast: newEma(), slow: newEma(), atr: newAtr(), holding: newHolding(), closes: [] };
    state.bySymbol.set(symbol, symbolState);
  }
  return symbolState;
}

/** 워밍업 미충족이면 null — 진입 판단 불가를 0 으로 위장하지 않는다 */
function spreadPercent(symbolState: SymbolState, slowEmaBars: number): number | null {
  if (
    symbolState.fast.value === null ||
    symbolState.slow.value === null ||
    symbolState.slow.barsSeen < slowEmaBars ||
    symbolState.slow.value <= 0
  ) {
    return null;
  }
  return ((symbolState.fast.value - symbolState.slow.value) / symbolState.slow.value) * 100;
}

export const emaTrendSwitchStrategy: TradingStrategy<
  EmaTrendSwitchParameters,
  EmaTrendSwitchState
> = {
  id: 'ema-trend-switch',
  version: '1.0.0',
  name: 'EMA 추세 스위치',
  description:
    '단기·장기 이동평균 간격이 벌어진 종목에 올라타고, 고점에서 변동성 폭만큼 내려오면 팝니다. ' +
    '반대로 움직이는 종목(예: 레버리지·인버스 쌍)을 함께 넣으면 같은 묶음에서 한 종목만 보유해 ' +
    '방향 전환이 종목 교체로 표현됩니다.',
  parameterSchema: emaTrendSwitchParameters,

  initialize(context: StrategyInitializeContext): EmaTrendSwitchState {
    return { bySymbol: new Map(), symbols: [...context.symbols].sort(), groupOf: null };
  },

  onBars(
    context: StrategyBarContext,
    state: EmaTrendSwitchState,
    parameters: EmaTrendSwitchParameters,
  ): StrategyDecision {
    const orders: OrderIntent[] = [];
    const barSymbols = [...context.bars.keys()].sort();

    // 1) 지표 갱신 + 상관 워밍업 누적
    for (const symbol of barSymbols) {
      const bar = context.bars.get(symbol) as NonNullable<ReturnType<typeof context.bars.get>>;
      const symbolState = getSymbolState(state, symbol);
      updateEma(symbolState.fast, bar.close, parameters.fastEmaBars);
      updateEma(symbolState.slow, bar.close, parameters.slowEmaBars);
      updateAtr(symbolState.atr, bar, parameters.atrPeriod);
      if (state.groupOf === null) symbolState.closes.push(bar.close);
    }

    // 2) 그룹 확정 — 유니버스 전 종목이 correlationBars 개 종가를 모은 첫 시점 1회.
    //    봉이 아예 없는 종목이 있으면 영영 확정되지 않는다 — 진입도 영영 없다.
    //    조용히 거래를 시작하는 것보다 낫다 (데이터 결측이 드러난다).
    if (
      state.groupOf === null &&
      state.symbols.every(
        (symbol) => (state.bySymbol.get(symbol)?.closes.length ?? 0) >= parameters.correlationBars,
      )
    ) {
      const closesBySymbol = new Map<string, readonly number[]>(
        state.symbols.map((symbol) => [symbol, state.bySymbol.get(symbol)?.closes ?? []]),
      );
      state.groupOf = buildCorrelationGroups(closesBySymbol, parameters.correlationThreshold);
      for (const symbol of state.symbols) {
        const symbolState = state.bySymbol.get(symbol);
        if (symbolState) symbolState.closes = [];
      }
    }

    // 3) 청산 — 보유 종목만
    for (const symbol of barSymbols) {
      const bar = context.bars.get(symbol) as NonNullable<ReturnType<typeof context.bars.get>>;
      const symbolState = getSymbolState(state, symbol);
      const position = context.portfolio.positions.get(symbol);

      if (!position || position.quantity <= 0) {
        symbolState.holding.exitPending = false;
        continue;
      }

      symbolState.holding.pendingEntry = false;
      symbolState.holding.barsHeld += 1;
      if (symbolState.holding.exitPending) continue;

      if (symbolState.holding.stopLevel === null) {
        confirmEntry(symbolState.holding, position.avgEntryPrice, parameters.stopAtrMultiplier);
      }
      updateTrail(symbolState.holding, bar.close, parameters.trailAtrMultiplier);

      const spread = spreadPercent(symbolState, parameters.slowEmaBars);
      const stop = symbolState.holding.stopLevel;
      const reason =
        stop !== null && bar.close < stop
          ? 'STOP'
          : spread !== null && spread <= 0
            ? 'TREND_END'
            : holdLimitReached(symbolState.holding, parameters.maxHoldBars)
              ? 'TIME'
              : null;
      if (reason !== null) {
        orders.push({ symbol, side: 'SELL', quantity: position.quantity, reason });
        symbolState.holding.exitPending = true;
      }
    }

    // 4) 진입 — 그룹 확정 전에는 진입하지 않는다
    if (state.groupOf !== null) {
      const groupOf = state.groupOf;
      // 보유·진입 대기 중인 그룹 선점 — 같은 봉에서 역상관 짝이 둘 다 신호를 내도
      // 사전순 첫 종목만 통과한다
      const claimed = new Set<string>();
      for (const symbol of state.symbols) {
        const position = context.portfolio.positions.get(symbol);
        const holding = state.bySymbol.get(symbol)?.holding;
        if ((position && position.quantity > 0) || holding?.pendingEntry === true) {
          claimed.add(groupOf.get(symbol) ?? symbol);
        }
      }

      for (const symbol of barSymbols) {
        const bar = context.bars.get(symbol) as NonNullable<ReturnType<typeof context.bars.get>>;
        const symbolState = getSymbolState(state, symbol);
        const position = context.portfolio.positions.get(symbol);
        if (position && position.quantity > 0) continue;

        // 미체결 진입 주문이 있었으면 이번 봉은 재평가만 (hourly-breakout 관례)
        if (symbolState.holding.pendingEntry) {
          symbolState.holding.pendingEntry = false;
          continue;
        }

        const group = groupOf.get(symbol) ?? symbol;
        if (claimed.has(group)) continue;

        const spread = spreadPercent(symbolState, parameters.slowEmaBars);
        if (spread === null || spread < parameters.entryThresholdPercent) continue;
        if (symbolState.atr.atr === null || symbolState.atr.barsSeen <= parameters.atrPeriod) {
          continue;
        }

        const quantity = riskQuantity(
          context.portfolio.equity,
          parameters.riskPerTradePercent,
          parameters.stopAtrMultiplier * symbolState.atr.atr,
        );
        if (quantity < 1) continue;

        orders.push({ symbol, side: 'BUY', quantity, reason: 'TREND' });
        symbolState.holding = newHolding();
        symbolState.holding.pendingEntry = true;
        symbolState.holding.entryAtr = symbolState.atr.atr;
        claimed.add(group);
      }
    }

    return { orders };
  },
};
```

- [x] **Step 4: 레지스트리 등록**

`src/server/modules/strategy/application/strategy-registry.ts` 수정 — import 추가:

```ts
import { emaTrendSwitchStrategy } from '../strategies/ema-trend-switch.js';
```

`STRATEGIES` 배열에 추가:

```ts
const STRATEGIES: readonly AnyTradingStrategy[] = [
  hourlyBreakoutStrategy as AnyTradingStrategy,
  crossSectionalMomentumStrategy as AnyTradingStrategy,
  valueQualityRankStrategy as AnyTradingStrategy,
  emaTrendSwitchStrategy as AnyTradingStrategy,
];
```

- [x] **Step 5: 통과 확인**

Run: `npx vitest run tests/unit/ema-trend-switch.test.ts && npx tsc --noEmit -p tsconfig.json`
Expected: PASS. JSON 스키마 테스트가 실패하면 zod `.refine()` 이 `z.toJSONSchema` 를 깨는 것 — 그 경우 `.refine` 을 제거하고 `superRefine` 대신 **파라미터 검증을 스키마 밖으로 빼지 말고**, `z.toJSONSchema(schema, { unrepresentable: 'any' })` 옵션이 필요한지 `strategy-registry.ts` 의 `getParameterJsonSchema` 를 확인하라 (기존 전략 스키마 출력이 바뀌면 안 된다 — strategySourceHash 는 JSON 스키마 직렬화에 의존한다).

- [x] **Step 6: 전체 단위 테스트로 회귀 확인**

Run: `npx vitest run`
Expected: 전부 PASS — 특히 `strategy-source-hash.test.ts` (기존 해시 불변).

- [x] **Step 7: 커밋**

```bash
git add src/server/modules/strategy/strategies/ema-trend-switch.ts src/server/modules/strategy/application/strategy-registry.ts tests/unit/ema-trend-switch.test.ts
git commit -m "feat(strategy): EMA 추세 스위치 전략을 추가한다"
```

---

### Task 5: `rsi-reversion` 전략 + 레지스트리 등록

**Files:**
- Create: `src/server/modules/strategy/strategies/rsi-reversion.ts`
- Modify: `src/server/modules/strategy/application/strategy-registry.ts`
- Test: `tests/unit/rsi-reversion.test.ts`

**Interfaces:**
- Consumes: Task 1 `newRsi`/`updateRsi`/`rsiValue`/`newAtr`/`updateAtr`, Task 2 `buildCorrelationGroups`, Task 3 전체 (`updateTrail` 제외 — 고정 스톱)
- Produces: `rsiReversionParameters`, `rsiReversionStrategy` — id `'rsi-reversion'`, version `'1.0.0'`

- [x] **Step 1: 실패하는 테스트 작성**

`tests/unit/rsi-reversion.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { runBacktest } from '../../src/server/modules/backtest/domain/engine.js';
import type { ExecutionProfile } from '../../src/server/modules/backtest/domain/types.js';
import type { Candle } from '../../src/server/modules/market-data/domain/candle.js';
import { StrategyRegistry } from '../../src/server/modules/strategy/application/strategy-registry.js';
import {
  rsiReversionParameters,
  rsiReversionStrategy,
} from '../../src/server/modules/strategy/strategies/rsi-reversion.js';

const DAY = 86_400_000;
const START = Date.UTC(2025, 0, 2);

const ZERO_COST: ExecutionProfile = {
  cost: { id: 'zero', version: '1', buyCommissionRate: 0, sellCommissionRate: 0, sellTaxRate: 0 },
  slippage: { id: 'zero', version: '1', bps: 0, fixed: 0 },
  rules: { tickSize: 0, minOrderQty: 1 },
};

function candle(symbol: string, index: number, close: number): Candle {
  return {
    symbol,
    market: 'KR',
    timeframe: '1d',
    tsMs: START + index * DAY,
    open: close,
    high: close * 1.01,
    low: close * 0.99,
    close,
    volume: 1_000,
  };
}

const FAST_PARAMS = {
  rsiPeriod: 3,
  entryRsi: 30,
  exitRsi: 55,
  atrPeriod: 3,
  stopAtrMultiplier: 5, // 되돌림 전에 스톱에 걸리지 않게 넉넉히
  riskPerTradePercent: 1,
  correlationBars: 20,
  correlationThreshold: 0.5,
};

/** 워밍업 진동(25봉) → 연속 하락(RSI 과매도) → 반등(RSI 회복) */
function vShapeCandles(): Candle[] {
  const candles: Candle[] = [];
  let close = 1_000;
  for (let index = 0; index < 55; index += 1) {
    if (index < 25) close = 1_000 + (index % 2 === 0 ? 10 : -10);
    else if (index < 35) close -= 20; // 하락 — RSI 0 근처
    else close += 40; // 가파른 반등 — RSI 가 확실히 청산선 위로 회복
    candles.push(candle('AAA', index, close));
  }
  return candles;
}

describe('rsiReversionParameters', () => {
  it('기본값만으로 파싱된다', () => {
    const parsed = rsiReversionParameters.parse({});
    expect(parsed.rsiPeriod).toBe(14);
    expect(parsed.entryRsi).toBe(30);
    expect(parsed.exitRsi).toBe(55);
    expect(parsed.maxHoldBars).toBeUndefined();
  });

  it('entryRsi ≥ exitRsi 를 거부한다', () => {
    expect(rsiReversionParameters.safeParse({ entryRsi: 45, exitRsi: 50 }).success).toBe(true);
    expect(rsiReversionParameters.safeParse({ entryRsi: 45, exitRsi: 45 }).success).toBe(false);
  });
});

describe('레지스트리 등록', () => {
  it('목록에 노출되고 JSON 스키마에 한국어 라벨이 실린다', () => {
    const registry = new StrategyRegistry();
    expect(registry.list().map((s) => s.id)).toContain('rsi-reversion');
    const schema = registry.getParameterJsonSchema('rsi-reversion');
    const properties = (schema as { properties: Record<string, Record<string, unknown>> })
      .properties;
    expect(properties.entryRsi?.title).toBe('진입 RSI');
  });
});

describe('실행 동작', () => {
  it('과매도에 사서 RSI 회복에 판다', () => {
    const result = runBacktest(rsiReversionStrategy, {
      candles: vShapeCandles(),
      initialCash: 10_000_000,
      execution: ZERO_COST,
      parameters: FAST_PARAMS,
      randomSeed: 1,
      maxPositions: 5,
    });
    const buys = result.fills.filter((fill) => fill.side === 'BUY');
    const sells = result.fills.filter((fill) => fill.side === 'SELL');
    expect(buys.length).toBeGreaterThan(0);
    expect(buys[0]?.reason).toBe('REVERSION');
    expect(sells.length).toBeGreaterThan(0);
    expect(sells[0]?.reason).toBe('RSI_EXIT');
  });

  it('maxHoldBars 를 지정하면 그 봉 수 뒤 TIME 으로 판다', () => {
    // 하락이 계속되어 RSI 회복이 없는 경로 — 시간 상한만이 청산 경로다
    const candles: Candle[] = [];
    let close = 2_000;
    for (let index = 0; index < 50; index += 1) {
      if (index < 25) close = 2_000 + (index % 2 === 0 ? 10 : -10);
      else close -= 8; // 완만한 하락 지속 (스톱 넉넉해서 안 걸림)
      candles.push(candle('AAA', index, close));
    }
    const result = runBacktest(rsiReversionStrategy, {
      candles,
      initialCash: 10_000_000,
      execution: ZERO_COST,
      parameters: { ...FAST_PARAMS, stopAtrMultiplier: 20, maxHoldBars: 3 },
      randomSeed: 1,
      maxPositions: 5,
    });
    const sells = result.fills.filter((fill) => fill.side === 'SELL');
    expect(sells.length).toBeGreaterThan(0);
    expect(sells[0]?.reason).toBe('TIME');
    // 체결 봉에서 barsHeld 1 시작 → 3봉째에 TIME 신호 → 다음 봉 시가 체결.
    // 매수 체결 봉과 매도 체결 봉의 간격 = 3봉.
    const buyTs = result.fills.find((fill) => fill.side === 'BUY')?.tsMs as number;
    expect((sells[0]?.tsMs as number) - buyTs).toBe(3 * DAY);
  });
});
```

- [x] **Step 2: 실패 확인**

Run: `npx vitest run tests/unit/rsi-reversion.test.ts`
Expected: FAIL — 모듈 없음.

- [x] **Step 3: 전략 구현**

`src/server/modules/strategy/strategies/rsi-reversion.ts`:

```ts
import { z } from 'zod';
import type { OrderIntent } from '../../backtest/domain/types.js';
import type {
  StrategyBarContext,
  StrategyDecision,
  TradingStrategy,
  StrategyInitializeContext,
} from '../domain/strategy.js';
import {
  newAtr,
  newRsi,
  rsiValue,
  updateAtr,
  updateRsi,
  type AtrState,
  type RsiState,
} from './shared/indicators.js';
import { buildCorrelationGroups } from './shared/pair-groups.js';
import { riskQuantity } from './shared/position-sizing.js';
import {
  confirmEntry,
  holdLimitReached,
  newHolding,
  type HoldingState,
} from './shared/trailing-stop.js';

/**
 * RSI 되돌림 (설계 2026-07-30-swing-strategies-design.md §4).
 *
 * RSI 과매도에 사서 RSI 회복에 판다. 스톱은 고정(트레일링 아님) — 되돌림 전략은
 * 진입 후 흔들림을 어느 정도 견뎌야 한다. 상관 그룹·수량 산정·보유 상한은
 * ema-trend-switch 와 같은 부품을 쓴다.
 */
export const rsiReversionParameters = z
  .object({
    rsiPeriod: z.number().int().min(2).max(100).default(14).meta({
      title: 'RSI 계산 기간',
      description: '과매도·회복을 재는 RSI 의 봉 수입니다. 짧으면 민감하고 잦은 신호가 납니다.',
    }),
    entryRsi: z.number().min(5).max(45).default(30).meta({
      title: '진입 RSI',
      description: 'RSI 가 이 값 이하로 내려간 종목을 삽니다. 낮게 잡을수록 깊은 과매도만 잡습니다.',
    }),
    exitRsi: z.number().min(50).max(95).default(55).meta({
      title: '청산 RSI',
      description: '보유 중 RSI 가 이 값 이상으로 회복하면 팝니다.',
    }),
    atrPeriod: z.number().int().min(2).max(100).default(14).meta({
      title: '변동성(ATR) 계산 기간',
      description: '손절 폭과 주문 수량의 기준이 되는 변동성을 몇 개 봉으로 평균낼지 정합니다.',
    }),
    stopAtrMultiplier: z.number().positive().max(20).default(2).meta({
      title: '손절 폭 (변동성 배수)',
      description:
        '진입가에서 변동성 × 이 값만큼 내려가면 손절합니다. 고정 손절선이며 고점을 따라 움직이지 않습니다.',
    }),
    maxHoldBars: z.number().int().min(1).max(10_000).optional().meta({
      title: '최대 보유 봉 수 (선택)',
      description:
        '이 봉 수를 넘기면 신호와 무관하게 팝니다. 분봉이면 390이 약 하루, 일봉이면 20이 약 1달입니다. 비우면 제한이 없습니다.',
    }),
    riskPerTradePercent: z.number().positive().max(5).default(1).meta({
      title: '1회 거래 리스크 (%)',
      description: '한 번의 거래에서 감당할 자본 비율입니다. 주문 수량 = 자본 × 이 비율 ÷ 손절 폭.',
    }),
    correlationBars: z.number().int().min(20).max(500).default(60).meta({
      title: '상관 계산 봉 수',
      description:
        '이 봉 수가 쌓이면 종목간 상관을 한 번 계산해 반대로 움직이는 종목들을 한 묶음으로 봅니다. 이 구간에는 진입하지 않습니다.',
    }),
    correlationThreshold: z.number().min(0.1).max(0.95).default(0.5).meta({
      title: '역상관 판정 기준',
      description:
        '상관계수가 이 값보다 강하게 반대(-)면 같은 묶음으로 봅니다. 같은 묶음에서는 한 종목만 보유합니다.',
    }),
  })
  .refine((value) => value.entryRsi < value.exitRsi, {
    message: '진입 RSI 는 청산 RSI 보다 작아야 합니다',
    path: ['entryRsi'],
  });

export type RsiReversionParameters = z.infer<typeof rsiReversionParameters>;

interface SymbolState {
  rsi: RsiState;
  atr: AtrState;
  holding: HoldingState;
  closes: number[];
}

export interface RsiReversionState {
  readonly bySymbol: Map<string, SymbolState>;
  readonly symbols: readonly string[];
  groupOf: Map<string, string> | null;
}

function getSymbolState(state: RsiReversionState, symbol: string): SymbolState {
  let symbolState = state.bySymbol.get(symbol);
  if (!symbolState) {
    symbolState = { rsi: newRsi(), atr: newAtr(), holding: newHolding(), closes: [] };
    state.bySymbol.set(symbol, symbolState);
  }
  return symbolState;
}

export const rsiReversionStrategy: TradingStrategy<RsiReversionParameters, RsiReversionState> = {
  id: 'rsi-reversion',
  version: '1.0.0',
  name: 'RSI 되돌림',
  description:
    'RSI 과매도 종목을 사서 RSI 가 회복하면 팝니다. 반대로 움직이는 종목(예: 레버리지·인버스 쌍)을 ' +
    '함께 넣으면 같은 묶음에서 한 종목만 보유합니다.',
  parameterSchema: rsiReversionParameters,

  initialize(context: StrategyInitializeContext): RsiReversionState {
    return { bySymbol: new Map(), symbols: [...context.symbols].sort(), groupOf: null };
  },

  onBars(
    context: StrategyBarContext,
    state: RsiReversionState,
    parameters: RsiReversionParameters,
  ): StrategyDecision {
    const orders: OrderIntent[] = [];
    const barSymbols = [...context.bars.keys()].sort();

    // 1) 지표 갱신 + 상관 워밍업 누적
    for (const symbol of barSymbols) {
      const bar = context.bars.get(symbol) as NonNullable<ReturnType<typeof context.bars.get>>;
      const symbolState = getSymbolState(state, symbol);
      updateRsi(symbolState.rsi, bar.close, parameters.rsiPeriod);
      updateAtr(symbolState.atr, bar, parameters.atrPeriod);
      if (state.groupOf === null) symbolState.closes.push(bar.close);
    }

    // 2) 그룹 확정 (ema-trend-switch 와 동일한 규칙 — 전 종목 워밍업 충족 시 1회)
    if (
      state.groupOf === null &&
      state.symbols.every(
        (symbol) => (state.bySymbol.get(symbol)?.closes.length ?? 0) >= parameters.correlationBars,
      )
    ) {
      const closesBySymbol = new Map<string, readonly number[]>(
        state.symbols.map((symbol) => [symbol, state.bySymbol.get(symbol)?.closes ?? []]),
      );
      state.groupOf = buildCorrelationGroups(closesBySymbol, parameters.correlationThreshold);
      for (const symbol of state.symbols) {
        const symbolState = state.bySymbol.get(symbol);
        if (symbolState) symbolState.closes = [];
      }
    }

    // 3) 청산
    for (const symbol of barSymbols) {
      const bar = context.bars.get(symbol) as NonNullable<ReturnType<typeof context.bars.get>>;
      const symbolState = getSymbolState(state, symbol);
      const position = context.portfolio.positions.get(symbol);

      if (!position || position.quantity <= 0) {
        symbolState.holding.exitPending = false;
        continue;
      }

      symbolState.holding.pendingEntry = false;
      symbolState.holding.barsHeld += 1;
      if (symbolState.holding.exitPending) continue;

      if (symbolState.holding.stopLevel === null) {
        confirmEntry(symbolState.holding, position.avgEntryPrice, parameters.stopAtrMultiplier);
      }

      const rsi = rsiValue(symbolState.rsi);
      const stop = symbolState.holding.stopLevel;
      const reason =
        rsi !== null && rsi >= parameters.exitRsi
          ? 'RSI_EXIT'
          : stop !== null && bar.close < stop
            ? 'STOP'
            : holdLimitReached(symbolState.holding, parameters.maxHoldBars)
              ? 'TIME'
              : null;
      if (reason !== null) {
        orders.push({ symbol, side: 'SELL', quantity: position.quantity, reason });
        symbolState.holding.exitPending = true;
      }
    }

    // 4) 진입
    if (state.groupOf !== null) {
      const groupOf = state.groupOf;
      const claimed = new Set<string>();
      for (const symbol of state.symbols) {
        const position = context.portfolio.positions.get(symbol);
        const holding = state.bySymbol.get(symbol)?.holding;
        if ((position && position.quantity > 0) || holding?.pendingEntry === true) {
          claimed.add(groupOf.get(symbol) ?? symbol);
        }
      }

      for (const symbol of barSymbols) {
        const symbolState = getSymbolState(state, symbol);
        const position = context.portfolio.positions.get(symbol);
        if (position && position.quantity > 0) continue;

        if (symbolState.holding.pendingEntry) {
          symbolState.holding.pendingEntry = false;
          continue;
        }

        const group = groupOf.get(symbol) ?? symbol;
        if (claimed.has(group)) continue;

        const rsi = rsiValue(symbolState.rsi);
        if (rsi === null || rsi > parameters.entryRsi) continue;
        if (symbolState.atr.atr === null || symbolState.atr.barsSeen <= parameters.atrPeriod) {
          continue;
        }

        const quantity = riskQuantity(
          context.portfolio.equity,
          parameters.riskPerTradePercent,
          parameters.stopAtrMultiplier * symbolState.atr.atr,
        );
        if (quantity < 1) continue;

        orders.push({ symbol, side: 'BUY', quantity, reason: 'REVERSION' });
        symbolState.holding = newHolding();
        symbolState.holding.pendingEntry = true;
        symbolState.holding.entryAtr = symbolState.atr.atr;
        claimed.add(group);
      }
    }

    return { orders };
  },
};
```

- [x] **Step 4: 레지스트리 등록**

`strategy-registry.ts` 에 import 와 배열 항목 추가 (Task 4 와 같은 방식):

```ts
import { rsiReversionStrategy } from '../strategies/rsi-reversion.js';
// STRATEGIES 배열 마지막에:
  rsiReversionStrategy as AnyTradingStrategy,
```

- [x] **Step 5: 통과 확인**

Run: `npx vitest run tests/unit/rsi-reversion.test.ts && npx tsc --noEmit -p tsconfig.json`
Expected: PASS.

- [x] **Step 6: 커밋**

```bash
git add src/server/modules/strategy/strategies/rsi-reversion.ts src/server/modules/strategy/application/strategy-registry.ts tests/unit/rsi-reversion.test.ts
git commit -m "feat(strategy): RSI 되돌림 전략을 추가한다"
```

---

### Task 6: 교차 검증 테스트 — 방향 무지·봉 주기 무관·그룹 배타성

**Files:**
- Test: `tests/unit/swing-strategies.test.ts`

**Interfaces:**
- Consumes: Task 4 `emaTrendSwitchStrategy`, Task 5 `rsiReversionStrategy`, 엔진 `runBacktest`

- [x] **Step 1: 테스트 작성**

`tests/unit/swing-strategies.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { runBacktest } from '../../src/server/modules/backtest/domain/engine.js';
import type { ExecutionProfile, Fill } from '../../src/server/modules/backtest/domain/types.js';
import type { Candle, Timeframe } from '../../src/server/modules/market-data/domain/candle.js';
import { emaTrendSwitchStrategy } from '../../src/server/modules/strategy/strategies/ema-trend-switch.js';

const DAY = 86_400_000;
const MINUTE = 60_000;
const START = Date.UTC(2025, 0, 2);

const ZERO_COST: ExecutionProfile = {
  cost: { id: 'zero', version: '1', buyCommissionRate: 0, sellCommissionRate: 0, sellTaxRate: 0 },
  slippage: { id: 'zero', version: '1', bps: 0, fixed: 0 },
  rules: { tickSize: 0, minOrderQty: 1 },
};

const FAST_PARAMS = {
  fastEmaBars: 3,
  slowEmaBars: 6,
  entryThresholdPercent: 0.3,
  atrPeriod: 3,
  stopAtrMultiplier: 2,
  trailAtrMultiplier: 2,
  riskPerTradePercent: 1,
  correlationBars: 20,
  correlationThreshold: 0.5,
};

/** 워밍업 진동 후 상승 추세인 경로와 그 역수(완전 역상관) 경로 */
function levPath(bars: number, warmup: number): number[] {
  return Array.from({ length: bars }, (_, index) =>
    index < warmup ? 1_000 + (index % 2 === 0 ? 10 : -10) : 1_000 + (index - warmup + 1) * 15,
  );
}

function toCandles(
  closesBySymbol: ReadonlyMap<string, readonly number[]>,
  timeframe: Timeframe,
  stepMs: number,
): Candle[] {
  const candles: Candle[] = [];
  for (const [symbol, closes] of closesBySymbol) {
    closes.forEach((close, index) => {
      candles.push({
        symbol,
        market: 'KR',
        timeframe,
        tsMs: START + index * stepMs,
        open: close,
        high: close * 1.01,
        low: close * 0.99,
        close,
        volume: 1_000,
      });
    });
  }
  return candles.sort((a, b) => a.tsMs - b.tsMs || (a.symbol < b.symbol ? -1 : 1));
}

function fillSignature(fills: readonly Fill[]): string[] {
  return fills.map((fill) => `${fill.symbol}:${fill.side}:${fill.quantity}:${fill.reason ?? ''}`);
}

function run(closesBySymbol: ReadonlyMap<string, readonly number[]>, timeframe: Timeframe, stepMs: number) {
  return runBacktest(emaTrendSwitchStrategy, {
    candles: toCandles(closesBySymbol, timeframe, stepMs),
    initialCash: 10_000_000,
    execution: ZERO_COST,
    parameters: FAST_PARAMS,
    randomSeed: 1,
    maxPositions: 5,
  });
}

describe('방향 무지 — 전략은 어느 종목이 인버스인지 모른다', () => {
  it('심볼 이름을 서로 바꿔도 결과가 대칭이다', () => {
    const lev = levPath(60, 25);
    const inv = lev.map((value) => 1_000_000 / value);

    const original = run(new Map([['AAA', lev], ['BBB', inv]]), '1d', DAY);
    const swapped = run(new Map([['AAA', inv], ['BBB', lev]]), '1d', DAY);

    // 원본에서 AAA(상승 경로)가 산 것을, 교환본에서는 BBB 가 산다
    const relabel = (signature: string): string =>
      signature.startsWith('AAA:')
        ? signature.replace(/^AAA:/, 'BBB:')
        : signature.replace(/^BBB:/, 'AAA:');
    expect(fillSignature(swapped.fills)).toEqual(fillSignature(original.fills).map(relabel));
  });
});

describe('봉 주기 무관 — 같은 가격 경로면 같은 주문 시퀀스', () => {
  it('1m 과 1d 가 같은 체결 시퀀스를 낸다', () => {
    const lev = levPath(60, 25);
    const closes = new Map([['AAA', lev]]);
    const daily = run(closes, '1d', DAY);
    const minute = run(closes, '1m', MINUTE);
    expect(fillSignature(minute.fills)).toEqual(fillSignature(daily.fills));
    expect(minute.fills.length).toBeGreaterThan(0); // 공허 통과 방지
  });
});

describe('그룹 배타성', () => {
  it('같은 봉에서 역상관 짝이 둘 다 신호를 내면 사전순 첫 종목만 산다', () => {
    // 워밍업(25봉)은 완전 역상관 진동, 이후 **둘 다** 상승 — 그룹은 워밍업에서
    // 이미 고정됐으므로 동시 신호가 나도 한쪽만 통과해야 한다
    const both: number[] = [];
    const bothInv: number[] = [];
    for (let index = 0; index < 60; index += 1) {
      if (index < 25) {
        const value = 1_000 + (index % 2 === 0 ? 10 : -10);
        both.push(value);
        bothInv.push(1_000_000 / value);
      } else {
        both.push((both[index - 1] as number) + 15);
        bothInv.push((bothInv[index - 1] as number) + 15);
      }
    }
    const result = run(new Map([['AAA', both], ['BBB', bothInv]]), '1d', DAY);
    const buySymbols = new Set(
      result.fills.filter((fill) => fill.side === 'BUY').map((fill) => fill.symbol),
    );
    // 상승 추세가 뚜렷하므로 진입은 반드시 일어나고, 그룹 배타로 정확히 1종목 —
    // 같은 봉 동시 신호는 사전순 첫 종목(AAA)이 이긴다
    expect([...buySymbols]).toEqual(['AAA']);
  });
});
```

- [x] **Step 2: 통과 확인**

Run: `npx vitest run tests/unit/swing-strategies.test.ts`
Expected: PASS. 실패하면 전략 쪽 결함이다 — 테스트를 조정하기 전에 정렬·claimed 로직을 먼저 의심하라.

- [x] **Step 3: 커밋**

```bash
git add tests/unit/swing-strategies.test.ts
git commit -m "test(strategy): 방향 무지·봉 주기 무관·그룹 배타성을 교차 검증한다"
```

---

### Task 7: 전체 검증

**Files:** 없음 (검증만)

- [x] **Step 1: 전체 단위·통합 테스트**

Run: `npx vitest run`
Expected: 전부 PASS. 특히 `strategy-source-hash.test.ts`(기존 전략 해시 불변), `backtest-request.test.ts`, `job-queue.test.ts`.

- [x] **Step 2: 타입·린트·빌드**

Run: `npx tsc --noEmit -p tsconfig.json && npx eslint src tests && pnpm build`
Expected: 에러 없음.

- [x] **Step 3: e2e**

Run: `pnpm test:e2e`
Expected: 기존 7 passed 유지 — 위저드는 레지스트리에서 전략 목록을 읽으므로 새 전략이 목록에 늘어나도 기존 흐름(`시간봉 돌파` 지정 클릭)은 깨지지 않는다.

- [x] **Step 4: 위저드에서 눈 확인 (선택이지만 권장)**

`pnpm dev` 후 `/backtests/new` 에서 새 전략 2개가 한국어 라벨·기본값과 함께 렌더링되는지 확인. `fastEmaBars`/`slowEmaBars` 교차 규칙은 폼에 안 보이는 게 정상 — 제출 시 422 메시지로 전달된다.
