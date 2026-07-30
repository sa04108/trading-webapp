# 백테스트 결과 표시 개선 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 백테스트 결과에 총 비용(수수료·세금·슬리피지)을 표시하고, 목록을 전략별로 그룹화(한국어 이름 + 설명 툴팁)하며, 소비 봉 주기를 명시하고, 데이터셋 봉 주기 라벨을 바로잡는다.

**Architecture:** 전부 프론트엔드 변경 (스펙 `docs/superpowers/specs/2026-07-30-backtest-result-display-design.md`). 서버·엔진·DB·API 무변경 — 필요한 데이터(`totalCommission`/`totalTax`/`totalSlippage`, `/strategies` 의 `name`·`description`, `request.timeframe`)는 이미 API 로 내려온다. 표시 로직은 순수 헬퍼 파일로 분리해 단위 테스트하고, 컴포넌트는 헬퍼를 그리기만 한다.

**Tech Stack:** React 19 + TypeScript, @tanstack/react-query, Tailwind, shadcn/ui (Radix Tooltip), vitest.

## Global Constraints

- 순수 헬퍼 파일은 `@/` 경로 별칭을 쓰지 않는다 — vitest 설정(`vitest.config.ts`)에 별칭이 없어 테스트가 깨진다. 상대 경로 + `.js` 확장자 (`prefill.ts` 관례: `import type { BacktestRequestBody } from './types.js'`).
- 화면 문자열은 한국어. 봉 주기 코드('1m')를 그대로 노출하지 않는다 (`format.ts:48` 관례).
- 검증 명령: `pnpm test` (vitest run), `pnpm typecheck`, `pnpm lint`.
- 커밋 메시지는 기존 관례를 따른다: `type(scope): 한국어 서술형` (예: `fix(web): 새 청산 사유를 거래 내역에 한국어로 표시한다`).
- 테스트 파일 위치: `tests/unit/*.test.ts`. describe/it 설명은 한국어 (`prefill.test.ts` 관례).

---

### Task 1: 데이터셋 봉 주기 라벨 수정

`datasetTimeframeLabel('1h')` 이 `'1시간봉 (1분봉 수집)'` 을 반환한다. `1h` 종류 데이터셋의 실체는 1분봉 데이터이므로 `'1분봉'` 으로 바꾼다.

**Files:**
- Modify: `src/web/lib/format.ts:56-62`
- Test: `tests/unit/format.test.ts` (새 파일)

**Interfaces:**
- Consumes: 없음
- Produces: `datasetTimeframeLabel(timeframe: string): string` — `'1h' → '1분봉'`, `'1m' → '1분봉'`, `'1d' → '일봉'`. `timeframeLabel` 은 변경 없음 (`'1h' → '1시간봉'` 유지 — 소비 봉 주기 표기용).

- [ ] **Step 1: 실패하는 테스트 작성**

`tests/unit/format.test.ts` 생성:

```ts
import { describe, expect, it } from 'vitest';
import { datasetTimeframeLabel, timeframeLabel } from '../../src/web/lib/format.js';

describe('timeframeLabel', () => {
  it('봉 주기 코드를 한국어로 표기한다', () => {
    expect(timeframeLabel('1m')).toBe('1분봉');
    expect(timeframeLabel('1h')).toBe('1시간봉');
    expect(timeframeLabel('1d')).toBe('일봉');
  });

  it('모르는 코드는 그대로 돌려준다', () => {
    expect(timeframeLabel('5m')).toBe('5m');
  });
});

describe('datasetTimeframeLabel', () => {
  it('1h 종류 데이터셋은 실체가 1분봉이므로 1분봉으로 표기한다', () => {
    expect(datasetTimeframeLabel('1h')).toBe('1분봉');
  });

  it('나머지는 timeframeLabel 과 같다', () => {
    expect(datasetTimeframeLabel('1m')).toBe('1분봉');
    expect(datasetTimeframeLabel('1d')).toBe('일봉');
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `pnpm exec vitest run tests/unit/format.test.ts`
Expected: FAIL — `datasetTimeframeLabel('1h')` 가 `'1시간봉 (1분봉 수집)'` 을 반환.

- [ ] **Step 3: 구현**

`src/web/lib/format.ts` 의 `datasetTimeframeLabel` 을 교체:

```ts
/**
 * 데이터셋의 봉 주기 표기 — 보관 실체 기준. 1h 종류 데이터셋은 1분봉을 수집해
 * 보관하는 것이므로(시간봉은 파생 집계) '1분봉' 으로 말한다. 시간봉 소비 여부는
 * 백테스트 위저드의 봉 주기 선택지가 답한다.
 */
export function datasetTimeframeLabel(timeframe: string): string {
  return timeframe === '1h' ? '1분봉' : timeframeLabel(timeframe);
}
```

- [ ] **Step 4: 통과 확인**

Run: `pnpm exec vitest run tests/unit/format.test.ts`
Expected: PASS

- [ ] **Step 5: 전체 검증 후 커밋**

Run: `pnpm test && pnpm typecheck`
Expected: 전부 PASS

```bash
git add src/web/lib/format.ts tests/unit/format.test.ts
git commit -m "fix(web): 1h 데이터셋 봉 주기를 보관 실체인 1분봉으로 표기한다"
```

---

### Task 2: 비용 요약 헬퍼

수수료·세금·슬리피지 합계와 서브 라인 문자열을 만드는 순수 헬퍼.

**Files:**
- Create: `src/web/features/backtests/cost-summary.ts`
- Test: `tests/unit/cost-summary.test.ts`

**Interfaces:**
- Consumes: `BacktestMetrics` (`./types.js` — `totalCommission`/`totalTax`/`totalSlippage`/`initialCash` 필드), `formatKrw` (`../../lib/format.js`)
- Produces: `costSummary(metrics: BacktestMetrics): { totalText: string; detailText: string }` — Task 3 의 MetricCards 가 사용.

- [ ] **Step 1: 실패하는 테스트 작성**

`tests/unit/cost-summary.test.ts` 생성:

```ts
import { describe, expect, it } from 'vitest';
import { costSummary } from '../../src/web/features/backtests/cost-summary.js';
import type { BacktestMetrics } from '../../src/web/features/backtests/types.js';

function metricsWith(costs: {
  totalCommission: number;
  totalTax: number;
  totalSlippage: number;
  initialCash: number;
}): BacktestMetrics {
  return {
    initialCash: costs.initialCash,
    finalEquity: costs.initialCash,
    totalReturnPct: 0,
    cagrPct: null,
    maxDrawdownPct: 0,
    maxDrawdownDurationMs: 0,
    volatilityPct: null,
    sharpe: null,
    sortino: null,
    calmar: null,
    winRate: null,
    profitFactor: null,
    avgWin: null,
    avgLoss: null,
    maxConsecutiveWins: 0,
    maxConsecutiveLosses: 0,
    tradeCount: 0,
    avgHoldingTimeMs: null,
    maxConcurrentPositions: 0,
    totalCommission: costs.totalCommission,
    totalTax: costs.totalTax,
    totalSlippage: costs.totalSlippage,
  };
}

describe('costSummary', () => {
  it('세 비용의 합계와 항목별 내역을 만든다', () => {
    const result = costSummary(
      metricsWith({
        totalCommission: 152_300,
        totalTax: 121_800,
        totalSlippage: 113_320,
        initialCash: 10_000_000,
      }),
    );
    expect(result.totalText).toBe('387,420원');
    expect(result.detailText).toBe(
      '수수료 152,300원 · 세금 121,800원 · 슬리피지 113,320원 (초기자본의 1.13%)',
    );
  });

  it('zero-cost 프로파일이면 0원과 0.00% 를 그대로 보여준다', () => {
    const result = costSummary(
      metricsWith({ totalCommission: 0, totalTax: 0, totalSlippage: 0, initialCash: 10_000_000 }),
    );
    expect(result.totalText).toBe('0원');
    expect(result.detailText).toBe('수수료 0원 · 세금 0원 · 슬리피지 0원 (초기자본의 0.00%)');
  });

  it('슬리피지 퍼센트는 소수 둘째 자리로 반올림한다', () => {
    const result = costSummary(
      metricsWith({ totalCommission: 0, totalTax: 0, totalSlippage: 12_345, initialCash: 10_000_000 }),
    );
    expect(result.detailText).toContain('(초기자본의 0.12%)');
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `pnpm exec vitest run tests/unit/cost-summary.test.ts`
Expected: FAIL — `cost-summary.js` 모듈 없음.

- [ ] **Step 3: 구현**

`src/web/features/backtests/cost-summary.ts` 생성:

```ts
import { formatKrw } from '../../lib/format.js';
import type { BacktestMetrics } from './types.js';

/**
 * 총 비용 카드 문자열 (설계 2026-07-30-backtest-result-display-design.md §1).
 * 슬리피지 분모가 초기자본인 이유: totalReturnPct 와 같은 분모라
 * "수익률에서 몇 %p 깎였나" 를 직접 비교할 수 있다.
 */
export function costSummary(metrics: BacktestMetrics): {
  totalText: string;
  detailText: string;
} {
  const total = metrics.totalCommission + metrics.totalTax + metrics.totalSlippage;
  const slippagePct =
    metrics.initialCash > 0 ? (metrics.totalSlippage / metrics.initialCash) * 100 : 0;
  return {
    totalText: formatKrw(total),
    detailText:
      `수수료 ${formatKrw(metrics.totalCommission)} · 세금 ${formatKrw(metrics.totalTax)}` +
      ` · 슬리피지 ${formatKrw(metrics.totalSlippage)} (초기자본의 ${slippagePct.toFixed(2)}%)`,
  };
}
```

- [ ] **Step 4: 통과 확인**

Run: `pnpm exec vitest run tests/unit/cost-summary.test.ts`
Expected: PASS

- [ ] **Step 5: 커밋**

```bash
git add src/web/features/backtests/cost-summary.ts tests/unit/cost-summary.test.ts
git commit -m "feat(web): 백테스트 비용 요약 문자열 헬퍼를 만든다"
```

---

### Task 3: 총 비용 카드 (결과 상세)

`MetricCards` 에 7번째 카드 "총 비용" 추가. 서브 라인(detail) 지원.

**Files:**
- Modify: `src/web/features/backtests/backtest-detail-page.tsx:57-90` (`MetricCards`)

**Interfaces:**
- Consumes: `costSummary` (Task 2)
- Produces: 없음 (표시 전용)

- [ ] **Step 1: MetricCards 수정**

`backtest-detail-page.tsx` 상단 import 에 추가:

```ts
import { costSummary } from './cost-summary';
```

`MetricCards` 를 다음으로 교체 (카드 배열에 `detail`·`cardClassName` 선택 필드 추가, 총 비용 카드는 줄 전체 폭):

```tsx
function MetricCards({ metrics }: { metrics: BacktestMetrics }) {
  const cost = costSummary(metrics);
  const cards = [
    {
      label: '누적 수익률',
      value: formatSignedPct(metrics.totalReturnPct),
      className: pnlClass(metrics.totalReturnPct),
    },
    { label: 'CAGR', value: formatSignedPct(metrics.cagrPct), className: pnlClass(metrics.cagrPct) },
    {
      label: 'MDD',
      value: formatSignedPct(metrics.maxDrawdownPct),
      className: pnlClass(metrics.maxDrawdownPct),
    },
    { label: 'Sharpe', value: formatNumber(metrics.sharpe), className: '' },
    {
      label: '승률 (청산 기준)',
      value: metrics.winRate === null ? '-' : `${metrics.winRate.toFixed(1)}%`,
      className: '',
    },
    { label: '청산 거래 수', value: `${metrics.tradeCount}건`, className: '' },
    {
      label: '총 비용',
      value: cost.totalText,
      className: '',
      detail: cost.detailText,
      cardClassName: 'col-span-full',
    },
  ];
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
      {cards.map((card) => (
        <Card key={card.label} className={'cardClassName' in card ? card.cardClassName : undefined}>
          <CardContent className="px-4 py-3">
            <p className="text-xs text-muted-foreground">{card.label}</p>
            <p className={cn('text-lg font-semibold tabular-nums', card.className)}>{card.value}</p>
            {'detail' in card && card.detail ? (
              <p className="mt-1 text-xs text-muted-foreground tabular-nums">{card.detail}</p>
            ) : null}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
```

- [ ] **Step 2: 검증**

Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: 전부 PASS

- [ ] **Step 3: 수동 확인**

`pnpm dev` (서버) + `pnpm dev:web` 실행, 완료된 백테스트 상세 진입.
Expected: 지표 카드 아래 줄 전체 폭 "총 비용" 카드 — 합계 금액 + `수수료 … · 세금 … · 슬리피지 … (초기자본의 N.NN%)`.

- [ ] **Step 4: 커밋**

```bash
git add src/web/features/backtests/backtest-detail-page.tsx
git commit -m "feat(web): 백테스트 상세에 총 비용 카드를 보여준다"
```

---

### Task 4: 소비 봉 주기 결정 헬퍼

`request.timeframe` 우선, 없으면 데이터셋 timeframe 폴백 — "미지정 = 데이터셋 timeframe" 이 엔진 규칙이므로 이 폴백이 실제 소비 봉이다.

**Files:**
- Create: `src/web/features/backtests/job-timeframe.ts`
- Test: `tests/unit/job-timeframe.test.ts`

**Interfaces:**
- Consumes: `JobSummary` 의 `request.timeframe?: '1m' | '1h' | '1d'` 와 `datasetId: string`
- Produces: `resolveJobTimeframe(job: { datasetId: string; request: { timeframe?: string } }, datasets: readonly { id: string; timeframe: string }[] | undefined): string | null` — Task 5(목록)·Task 7(상세)이 사용. 반환값은 `timeframeLabel` 에 넣을 코드, 못 찾으면 `null`.

- [ ] **Step 1: 실패하는 테스트 작성**

`tests/unit/job-timeframe.test.ts` 생성:

```ts
import { describe, expect, it } from 'vitest';
import { resolveJobTimeframe } from '../../src/web/features/backtests/job-timeframe.js';

const datasets = [
  { id: 'ds_1h', timeframe: '1h' },
  { id: 'ds_1d', timeframe: '1d' },
];

describe('resolveJobTimeframe', () => {
  it('요청에 timeframe 이 있으면 그것을 쓴다', () => {
    const job = { datasetId: 'ds_1h', request: { timeframe: '1m' } };
    expect(resolveJobTimeframe(job, datasets)).toBe('1m');
  });

  it('요청에 없으면 데이터셋 timeframe 으로 폴백한다 — 엔진의 미지정 규칙과 같다', () => {
    const job = { datasetId: 'ds_1h', request: {} };
    expect(resolveJobTimeframe(job, datasets)).toBe('1h');
  });

  it('데이터셋도 못 찾으면 null', () => {
    const job = { datasetId: 'ds_deleted', request: {} };
    expect(resolveJobTimeframe(job, datasets)).toBeNull();
    expect(resolveJobTimeframe(job, undefined)).toBeNull();
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `pnpm exec vitest run tests/unit/job-timeframe.test.ts`
Expected: FAIL — 모듈 없음.

- [ ] **Step 3: 구현**

`src/web/features/backtests/job-timeframe.ts` 생성:

```ts
/**
 * 백테스트가 실제 소비한 봉 주기 (설계 2026-07-30-backtest-result-display-design.md §3).
 * request.timeframe 이 없는 잡(이 필드가 없던 시절)은 엔진이 데이터셋 timeframe 을
 * 썼으므로 같은 규칙으로 폴백한다. 데이터셋이 삭제됐으면 null.
 */
export function resolveJobTimeframe(
  job: { datasetId: string; request: { timeframe?: string } },
  datasets: readonly { id: string; timeframe: string }[] | undefined,
): string | null {
  if (job.request.timeframe) return job.request.timeframe;
  return datasets?.find((d) => d.id === job.datasetId)?.timeframe ?? null;
}
```

- [ ] **Step 4: 통과 확인**

Run: `pnpm exec vitest run tests/unit/job-timeframe.test.ts`
Expected: PASS

- [ ] **Step 5: 커밋**

```bash
git add src/web/features/backtests/job-timeframe.ts tests/unit/job-timeframe.test.ts
git commit -m "feat(web): 백테스트 소비 봉 주기 결정 헬퍼를 만든다"
```

---

### Task 5: 전략 그룹핑 헬퍼

목록의 잡을 전략별로 묶고 정렬하는 순수 함수.

**Files:**
- Create: `src/web/features/backtests/job-groups.ts`
- Test: `tests/unit/job-groups.test.ts`

**Interfaces:**
- Consumes: `JobSummary` (`./types.js` — `strategyId`, `createdAtMs` 만 사용)
- Produces: `groupJobsByStrategy<T extends { strategyId: string; createdAtMs: number }>(jobs: readonly T[]): Array<{ strategyId: string; jobs: T[] }>` — 그룹 내부 최신순, 그룹은 최신 잡 기준 내림차순. Task 6 의 목록 페이지가 사용.

- [ ] **Step 1: 실패하는 테스트 작성**

`tests/unit/job-groups.test.ts` 생성:

```ts
import { describe, expect, it } from 'vitest';
import { groupJobsByStrategy } from '../../src/web/features/backtests/job-groups.js';

function job(strategyId: string, createdAtMs: number): { strategyId: string; createdAtMs: number } {
  return { strategyId, createdAtMs };
}

describe('groupJobsByStrategy', () => {
  it('전략별로 묶고, 그룹 내부는 최신순으로 정렬한다', () => {
    const groups = groupJobsByStrategy([
      job('rsi-reversion', 100),
      job('ema-trend-switch', 200),
      job('rsi-reversion', 300),
    ]);
    expect(groups.map((g) => g.strategyId)).toEqual(['rsi-reversion', 'ema-trend-switch']);
    expect(groups[0]?.jobs.map((j) => j.createdAtMs)).toEqual([300, 100]);
  });

  it('그룹 순서는 그룹 내 최신 잡의 생성 시각 내림차순이다', () => {
    const groups = groupJobsByStrategy([
      job('a', 500),
      job('b', 900),
      job('a', 100),
    ]);
    expect(groups.map((g) => g.strategyId)).toEqual(['b', 'a']);
  });

  it('빈 목록이면 빈 배열', () => {
    expect(groupJobsByStrategy([])).toEqual([]);
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `pnpm exec vitest run tests/unit/job-groups.test.ts`
Expected: FAIL — 모듈 없음.

- [ ] **Step 3: 구현**

`src/web/features/backtests/job-groups.ts` 생성:

```ts
/**
 * 백테스트 목록의 전략별 그룹화 (설계 2026-07-30-backtest-result-display-design.md §2).
 * API 정렬 순서에 기대지 않고 여기서 명시적으로 정렬한다 —
 * 그룹 내부는 최신순, 그룹끼리는 그룹 내 최신 잡 기준 내림차순.
 */
export function groupJobsByStrategy<T extends { strategyId: string; createdAtMs: number }>(
  jobs: readonly T[],
): Array<{ strategyId: string; jobs: T[] }> {
  const byStrategy = new Map<string, T[]>();
  for (const job of jobs) {
    const list = byStrategy.get(job.strategyId) ?? [];
    list.push(job);
    byStrategy.set(job.strategyId, list);
  }
  return [...byStrategy.entries()]
    .map(([strategyId, grouped]) => ({
      strategyId,
      jobs: [...grouped].sort((a, b) => b.createdAtMs - a.createdAtMs),
    }))
    .sort((a, b) => (b.jobs[0]?.createdAtMs ?? 0) - (a.jobs[0]?.createdAtMs ?? 0));
}
```

- [ ] **Step 4: 통과 확인**

Run: `pnpm exec vitest run tests/unit/job-groups.test.ts`
Expected: PASS

- [ ] **Step 5: 커밋**

```bash
git add src/web/features/backtests/job-groups.ts tests/unit/job-groups.test.ts
git commit -m "feat(web): 백테스트 잡의 전략별 그룹핑 헬퍼를 만든다"
```

---

### Task 6: InfoHint 공용 툴팁 + 목록 그룹화 화면

클릭형 ⓘ 툴팁을 `ParamHint` 에서 추출해 공용 컴포넌트로 만들고, 목록 페이지를 전략별 그룹 + 한국어 이름 + 설명 툴팁 + 봉 주기 표시로 바꾼다.

**Files:**
- Create: `src/web/components/info-hint.tsx`
- Modify: `src/web/features/backtests/param-hint.tsx` (InfoHint 사용으로 리팩터)
- Modify: `src/web/features/backtests/backtests-page.tsx`

**Interfaces:**
- Consumes: `groupJobsByStrategy` (Task 5), `resolveJobTimeframe` (Task 4), `timeframeLabel` (`@/lib/format`), `/strategies` 응답 `{ strategies: Array<{ id, version, name, description }> }` (queryKey `['strategies']` — 위저드와 캐시 공유), `/datasets` 응답 `{ datasets: Array<{ id, timeframe, ... }> }` (queryKey `['datasets']`)
- Produces: `InfoHint({ label, children }: { label: string; children: ReactNode })` — 클릭(터치 탭)으로 여닫는 ⓘ 툴팁. Task 7 은 사용하지 않지만 이후 화면들이 재사용 가능.

- [ ] **Step 1: InfoHint 생성**

`src/web/components/info-hint.tsx` 생성 — 열고 닫는 로직은 기존 `param-hint.tsx:14-48` 그대로 옮긴다:

```tsx
import { Info } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

/**
 * 설명 툴팁 (ⓘ 아이콘).
 *
 * 마우스오버가 아니라 클릭(터치 탭)으로만 연다 — 모바일에는 hover 가 없고,
 * Radix 기본 동작은 클릭하면 툴팁을 닫아버려 터치로는 열 방법이 없다.
 * 그래서 open 을 직접 들고 Radix 의 자동 개폐를 쓰지 않는다. 대신 닫는 경로를
 * 직접 챙긴다 — 다시 탭, Escape, 포커스 이탈, 바깥 영역 탭.
 */
export function InfoHint({ label, children }: { label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent): void => {
      // 트리거 자신은 onClick 토글이 처리한다 — 여기서 닫으면 다시 열려 깜빡인다
      if (triggerRef.current?.contains(event.target as Node)) return;
      setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

  return (
    <Tooltip open={open}>
      <TooltipTrigger asChild>
        <button
          ref={triggerRef}
          type="button"
          aria-label={label}
          aria-expanded={open}
          className="rounded-full text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onClick={() => setOpen((prev) => !prev)}
          onBlur={() => setOpen(false)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setOpen(false);
          }}
        >
          <Info className="size-3.5" aria-hidden />
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" align="start" className="max-w-xs flex-col items-start gap-1">
        {children}
      </TooltipContent>
    </Tooltip>
  );
}
```

- [ ] **Step 2: ParamHint 를 InfoHint 로 리팩터**

`src/web/features/backtests/param-hint.tsx` 전체를 교체:

```tsx
import { InfoHint } from '@/components/info-hint';
import { paramLabel, paramMetaLine, type NumberParamSpec } from './param-specs';

/** 파라미터 설명 툴팁 — 여닫는 동작은 InfoHint 가 책임진다 */
export function ParamHint({ spec }: { spec: NumberParamSpec }) {
  if (!spec.help) return null;

  return (
    <InfoHint label={`${paramLabel(spec)} 설명`}>
      <p className="leading-relaxed">{spec.help}</p>
      <p className="font-mono text-[10px] opacity-70">{paramMetaLine(spec)}</p>
    </InfoHint>
  );
}
```

- [ ] **Step 3: 목록 페이지 그룹화**

`src/web/features/backtests/backtests-page.tsx` 수정.

import 추가:

```tsx
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api-client';
import { InfoHint } from '@/components/info-hint';
import { timeframeLabel } from '@/lib/format';
import { groupJobsByStrategy } from './job-groups';
import { resolveJobTimeframe } from './job-timeframe';
```

(기존 import 문의 `formatDateTime, formatSignedPct, pnlClass` 는 그대로 두고 `timeframeLabel` 만 추가하면 된다.)

`JobCard` 변경 2가지:
1. 카드 첫 줄의 `<span className="font-medium">{job.strategyId}</span>` 를 제거한다 — 그룹 헤더와 중복. `StatusBadge` 가 첫 요소가 된다.
2. props 에 `timeframe: string | null` 추가, 정보 라인에 봉 주기를 붙인다:

```tsx
<div className="text-xs text-muted-foreground">
  {formatSymbolSummary(job.request.universe.symbols, nameOf)} · {job.request.period.from}{' '}
  ~ {job.request.period.to}
  {timeframe ? ` · ${timeframeLabel(timeframe)}` : ''}
</div>
```

`BacktestsPage` 본문 변경:

```tsx
interface StrategySummary {
  id: string;
  version: string;
  name: string;
  description: string;
}

export function BacktestsPage() {
  const { data, isLoading } = useBacktests(5_000);
  const strategies = useQuery({
    queryKey: ['strategies'],
    queryFn: () => api<{ strategies: StrategySummary[] }>('/strategies'),
  });
  const datasets = useQuery({
    queryKey: ['datasets'],
    queryFn: () => api<{ datasets: Array<{ id: string; timeframe: string }> }>('/datasets'),
  });
  const strategyById = new Map((strategies.data?.strategies ?? []).map((s) => [s.id, s]));
  // ... previewSymbols·stockNames·nameOf 기존 코드 유지 ...
```

잡 목록 렌더링(현재 `data.jobs.map(...)`)을 그룹 렌더링으로 교체:

```tsx
<div className="space-y-6">
  {groupJobsByStrategy(data.jobs).map((group) => {
    const strategy = strategyById.get(group.strategyId);
    return (
      <section key={group.strategyId} className="space-y-3">
        <div className="flex items-center gap-1.5">
          <h3 className="text-sm font-semibold">{strategy?.name ?? group.strategyId}</h3>
          {strategy?.description ? (
            <InfoHint label={`${strategy.name} 전략 설명`}>
              <p className="leading-relaxed">{strategy.description}</p>
            </InfoHint>
          ) : null}
        </div>
        {group.jobs.map((job) => (
          <JobCard
            key={job.id}
            job={job}
            nameOf={nameOf}
            timeframe={resolveJobTimeframe(job, datasets.data?.datasets)}
          />
        ))}
      </section>
    );
  })}
</div>
```

- [ ] **Step 4: 검증**

Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: 전부 PASS

- [ ] **Step 5: 수동 확인**

`pnpm dev` + `pnpm dev:web`, `/backtests` 진입.
Expected: 전략 한국어 이름 헤더로 그룹화, 이름 옆 ⓘ 클릭 시 전략 설명 툴팁, 카드 정보 라인에 `· 1시간봉` 류 표기. 위저드 파라미터 ⓘ 툴팁(ParamHint)도 기존과 동일하게 동작.

- [ ] **Step 6: 커밋**

```bash
git add src/web/components/info-hint.tsx src/web/features/backtests/param-hint.tsx src/web/features/backtests/backtests-page.tsx
git commit -m "feat(web): 백테스트 목록을 전략별로 묶고 이름과 설명 툴팁을 보여준다"
```

---

### Task 7: 상세 페이지 — 한국어 이름 + 봉 주기 행

상세 페이지 제목을 전략 한국어 이름으로, 재현성 카드에 전략 이름 병기와 `봉 주기` 행 추가.

**Files:**
- Modify: `src/web/features/backtests/backtest-detail-page.tsx` (제목 `:416`, `RunMetadataCard` `:271-293`)

**Interfaces:**
- Consumes: `resolveJobTimeframe` (Task 4), `timeframeLabel` (`@/lib/format`), `['strategies']`·`['datasets']` 쿼리 (Task 6 과 같은 키 — 캐시 공유)
- Produces: 없음 (표시 전용)

- [ ] **Step 1: 상세 페이지 수정**

import 추가 (`backtest-detail-page.tsx`):

```ts
import { timeframeLabel } from '@/lib/format'; // 기존 format import 문에 항목만 추가
import { resolveJobTimeframe } from './job-timeframe';
```

`BacktestDetailPage` 컴포넌트(제목 렌더 전, `:407` 부근)에 쿼리·조회 추가:

```tsx
const strategies = useQuery({
  queryKey: ['strategies'],
  queryFn: () =>
    api<{ strategies: Array<{ id: string; name: string; description: string }> }>('/strategies'),
});
const datasets = useQuery({
  queryKey: ['datasets'],
  queryFn: () => api<{ datasets: Array<{ id: string; timeframe: string }> }>('/datasets'),
});
const strategyName = strategies.data?.strategies.find((s) => s.id === job.strategyId)?.name;
const resolvedTimeframe = resolveJobTimeframe(job, datasets.data?.datasets);
```

주의: `job` 은 `:398` 의 `if (isLoading || !job)` 가드 뒤에서만 확정된다. React 훅은 조건부 return 앞에 있어야 하므로 `useQuery` 두 개는 가드 **앞**에 두고, `strategyName`·`resolvedTimeframe` 계산은 가드 **뒤**에 둔다.

제목 (`:416`):

```tsx
<h2 className="text-lg font-semibold">{strategyName ?? job.strategyId}</h2>
```

`RunMetadataCard` 에 props 추가 및 rows 수정:

```tsx
function RunMetadataCard({
  run,
  job,
  strategyName,
  timeframe,
}: {
  run: RunMetadata;
  job: JobSummary;
  strategyName: string | undefined;
  timeframe: string | null;
}) {
```

rows 배열 (`:282-293`)에서 전략 행을 바꾸고 봉 주기 행을 데이터셋 행 다음에 넣는다:

```ts
const rows: Array<[string, string]> = [
  [
    '전략',
    strategyName
      ? `${strategyName} (${run.strategyId} v${run.strategyVersion})`
      : `${run.strategyId} v${run.strategyVersion}`,
  ],
  ['전략 해시', run.strategySourceHash.slice(0, 16)],
  ['데이터셋', `${run.datasetId} (v${run.datasetVersion})`],
  ['봉 주기', timeframe ? timeframeLabel(timeframe) : '-'],
  ['데이터 해시', run.datasetHash.slice(0, 16)],
  ['엔진 버전', run.engineVersion],
  ['수수료 모델', run.feeModelVersion],
  ['슬리피지 모델', run.slippageModelVersion],
  ['난수 시드', String(run.randomSeed)],
  ['Git 커밋', run.gitCommitSha.slice(0, 12)],
  ['실행 시각', `${formatDateTime(run.startedAtMs)} ~ ${formatDateTime(run.completedAtMs)}`],
];
```

호출부 (`:593`):

```tsx
{run ? (
  <RunMetadataCard
    run={run}
    job={job}
    strategyName={strategyName}
    timeframe={resolvedTimeframe}
  />
) : null}
```

- [ ] **Step 2: 검증**

Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: 전부 PASS

- [ ] **Step 3: 수동 확인**

상세 페이지 진입.
Expected: 제목이 `RSI 되돌림` 같은 한국어 이름, 재현성 카드에 `전략: RSI 되돌림 (rsi-reversion v1.0.0)`, `봉 주기: 1시간봉` 행.

- [ ] **Step 4: 커밋**

```bash
git add src/web/features/backtests/backtest-detail-page.tsx
git commit -m "feat(web): 백테스트 상세에 전략 이름과 소비 봉 주기를 보여준다"
```

---

### Task 8: 최종 검증

- [ ] **Step 1: 전체 테스트·린트·타입체크**

Run: `pnpm test && pnpm typecheck && pnpm lint`
Expected: 전부 PASS

- [ ] **Step 2: E2E (존재하는 경우 회귀 확인)**

Run: `pnpm test:e2e`
Expected: PASS — 목록·상세 화면 구조 변경으로 깨지는 셀렉터가 있으면 해당 테스트를 새 구조에 맞게 고친다 (기능 회귀가 아니라 표시 구조 변경이므로 테스트 쪽을 수정).

- [ ] **Step 3: 수동 시나리오 일괄 확인**

1. `/datasets` — `1h` 종류 데이터셋 배지가 `1분봉`
2. `/backtests` — 전략별 그룹, 한국어 이름 + ⓘ 툴팁, 카드에 봉 주기
3. 상세 — 총 비용 카드, 한국어 제목, 재현성 카드 봉 주기 행
4. 위저드 — 데이터셋 선택 카드 라벨 `1분봉`, 봉 주기 선택지는 기존대로 `1시간봉`/`1분봉`
