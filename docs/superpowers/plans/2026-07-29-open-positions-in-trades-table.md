# 거래 내역 테이블에 미청산 포지션 통합 — 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 백테스트 결과의 거래 내역 테이블 첫 페이지 상단에 미청산 포지션 행을 고정 표시하고, 별도 "미청산 포지션" 카드를 제거한다.

**Architecture:** 프론트 전용 변경. 상세 페이지가 이미 가진 `run.openPositionsJson` 을 순수 함수(`open-position-rows.ts`)로 테이블 행 모델로 변환하고, `TradesSection` 이 청산 거래 위에 렌더링한다. 서버·DB·엔진·export 무변경 (ENGINE_VERSION 유지).

**Tech Stack:** React 19 + TypeScript, shadcn/ui (Badge·Table), Vitest (유닛), Playwright (e2e)

**Spec:** `docs/superpowers/specs/2026-07-29-open-positions-in-trades-table-design.md`

## Global Constraints

- 서버·DB·엔진·full export 스키마를 변경하지 않는다. ENGINE_VERSION 유지.
- 미청산 행은 첫 페이지(page 0)에서만 표시하고 페이지네이션 계산(limit/offset, 다음 버튼)에 영향을 주지 않는다.
- 지표 카드의 "승률 (청산 기준)"·"청산 거래 수" 표기는 유지.
- UI 문구는 한국어, 기존 포맷 유틸(`formatKrw`, `formatSignedKrw`, `formatSignedPct`, `formatDateTime`, `formatDuration`) 사용.
- 커밋 메시지는 저장소 관례(한국어 conventional commits) 따름.

---

### Task 1: 미청산 행 변환 순수 함수 `openPositionRows`

**Files:**
- Create: `src/web/features/backtests/open-position-rows.ts`
- Test: `tests/unit/open-position-rows.test.ts`

**Interfaces:**
- Consumes: `OpenPositionSnapshot` (기존 `src/web/features/backtests/types.ts:129`)
- Produces: Task 2 가 사용하는 함수와 타입 —
  `openPositionRows(openPositionsJson: string | null, symbolFilter: string, periodTo: string): OpenPositionRow[]`
  `OpenPositionRow = { symbol; quantity; entryTsMs; entryPrice; lastPrice; unrealizedPnl; returnPct; holdingTimeMs }` (전부 number, symbol 만 string)

- [ ] **Step 1: 실패하는 테스트 작성**

`tests/unit/open-position-rows.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { openPositionRows } from '../../src/web/features/backtests/open-position-rows.js';

const ENTRY_1 = Date.parse('2026-03-30T10:00:00+09:00');
const ENTRY_2 = Date.parse('2026-03-31T14:00:00+09:00');

const snapshotJson = JSON.stringify([
  {
    symbol: '005930',
    quantity: 10,
    avgEntryPrice: 70_000,
    entryTsMs: ENTRY_1,
    lastPrice: 71_000,
    unrealizedPnl: 10_000,
    returnPct: 1.43,
  },
  {
    symbol: '000660',
    quantity: 5,
    avgEntryPrice: 200_000,
    entryTsMs: ENTRY_2,
    lastPrice: 190_000,
    unrealizedPnl: -50_000,
    returnPct: -5,
  },
]);

describe('openPositionRows', () => {
  it('JSON 이 null 이면 빈 배열을 반환한다', () => {
    expect(openPositionRows(null, 'ALL', '2026-03-31')).toEqual([]);
  });

  it('JSON 이 깨져 있으면 빈 배열을 반환한다', () => {
    expect(openPositionRows('{not json', 'ALL', '2026-03-31')).toEqual([]);
  });

  it('전체 심볼: 스냅샷을 행으로 변환하고 보유 시간은 기간 종료(당일 23:59:59 KST) 기준으로 계산한다', () => {
    const rows = openPositionRows(snapshotJson, 'ALL', '2026-03-31');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      symbol: '005930',
      quantity: 10,
      entryTsMs: ENTRY_1,
      entryPrice: 70_000,
      lastPrice: 71_000,
      unrealizedPnl: 10_000,
      returnPct: 1.43,
      holdingTimeMs: Date.parse('2026-03-31T23:59:59+09:00') - ENTRY_1,
    });
  });

  it('심볼 필터가 ALL 이 아니면 해당 심볼만 남긴다', () => {
    const rows = openPositionRows(snapshotJson, '000660', '2026-03-31');
    expect(rows.map((r) => r.symbol)).toEqual(['000660']);
  });

  it('진입 시각이 기간 종료 이후여도 보유 시간은 0 미만이 되지 않는다', () => {
    const rows = openPositionRows(snapshotJson, '005930', '2026-03-29');
    expect(rows[0].holdingTimeMs).toBe(0);
  });
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `pnpm vitest run tests/unit/open-position-rows.test.ts`
Expected: FAIL — `Cannot find module .../open-position-rows.js`

- [ ] **Step 3: 최소 구현**

`src/web/features/backtests/open-position-rows.ts`:

```ts
import type { OpenPositionSnapshot } from './types.js';

/** 거래 내역 테이블 상단에 고정 표시할 미청산 행 모델 */
export interface OpenPositionRow {
  symbol: string;
  quantity: number;
  entryTsMs: number;
  entryPrice: number;
  lastPrice: number;
  unrealizedPnl: number;
  returnPct: number;
  holdingTimeMs: number;
}

/**
 * 미청산 스냅샷 JSON → 테이블 행. 보유 시간은 기간 종료일의 장 마감 이후
 * 시각(당일 23:59:59 KST)을 기준으로 계산한다 — 스냅샷에는 기말 타임스탬프가 없다.
 */
export function openPositionRows(
  openPositionsJson: string | null,
  symbolFilter: string,
  periodTo: string,
): OpenPositionRow[] {
  if (!openPositionsJson) return [];
  let positions: OpenPositionSnapshot[];
  try {
    positions = JSON.parse(openPositionsJson) as OpenPositionSnapshot[];
  } catch {
    return [];
  }
  const periodEndMs = Date.parse(`${periodTo}T23:59:59+09:00`);
  return positions
    .filter((p) => symbolFilter === 'ALL' || p.symbol === symbolFilter)
    .map((p) => ({
      symbol: p.symbol,
      quantity: p.quantity,
      entryTsMs: p.entryTsMs,
      entryPrice: p.avgEntryPrice,
      lastPrice: p.lastPrice,
      unrealizedPnl: p.unrealizedPnl,
      returnPct: p.returnPct,
      holdingTimeMs: Math.max(0, periodEndMs - p.entryTsMs),
    }));
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `pnpm vitest run tests/unit/open-position-rows.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: 커밋**

```bash
git add src/web/features/backtests/open-position-rows.ts tests/unit/open-position-rows.test.ts
git commit -m "feat(web): 미청산 스냅샷 → 거래 내역 행 변환 헬퍼"
```

---

### Task 2: TradesSection 통합 렌더링 + 미청산 카드 제거 + e2e 갱신

**Files:**
- Modify: `src/web/features/backtests/backtest-detail-page.tsx` (OpenPositionsSection 제거: 91-150행, TradesSection: 152-270행, 호출부: 502·564행)
- Modify: `tests/e2e/mvp-flow.spec.ts:41-49`

**Interfaces:**
- Consumes: Task 1 의 `openPositionRows(openPositionsJson, symbolFilter, periodTo)` / `OpenPositionRow`
- Produces: 없음 (말단 UI)

- [ ] **Step 1: e2e 기대치를 먼저 갱신 (실패하는 테스트)**

`tests/e2e/mvp-flow.spec.ts` 41-49행의 결과 조회 블록을 다음으로 교체:

```ts
  // 5. 결과 조회: 지표 카드 + 차트 + 거래 내역 (미청산 포지션은 거래 내역 상단 배지 행)
  await expect(page.getByText('누적 수익률', { exact: true })).toBeVisible();
  await expect(page.getByText('자산 곡선', { exact: true })).toBeVisible();
  await expect(page.getByText('월별 수익률')).toBeVisible();
  await expect(page.getByText('거래 내역', { exact: true })).toBeVisible();
  await expect(page.getByText('재현 정보')).toBeVisible();
  // 별도 "미청산 포지션" 카드는 제거되고 거래 내역 테이블에 통합됐다
  await expect(page.getByText('미청산 포지션', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('row').filter({ hasText: '미청산' }).first()).toBeVisible();
  const tradeRows = page.getByRole('row').filter({ hasText: '005930' });
  await expect(tradeRows.first()).toBeVisible();
```

- [ ] **Step 2: 구현 — backtest-detail-page.tsx**

2-a. import 추가 (기존 import 블록에):

```ts
import { Badge } from '@/components/ui/badge';
import { openPositionRows } from './open-position-rows';
```

2-b. `OpenPositionsSection` 함수 전체(91-150행)와 호출부 `{run ? <OpenPositionsSection run={run} /> : null}`(502행) 삭제. 이 삭제로 `OpenPositionSnapshot` import 가 미사용이 되면 함께 정리 (`open-position-rows.ts` 내부에서만 사용).

2-c. `TradesSection` 시그니처 변경:

```tsx
function TradesSection({
  jobId,
  symbols,
  run,
  periodTo,
}: {
  jobId: string;
  symbols: string[];
  run: RunMetadata | null;
  periodTo: string;
}) {
```

호출부(564행):

```tsx
<TradesSection
  jobId={id}
  symbols={job.request.universe.symbols}
  run={run ?? null}
  periodTo={job.request.period.to}
/>
```

2-d. `TradesSection` 본문에서 `const trades = data?.trades ?? [];` 아래에:

```tsx
const openRows = page === 0 ? openPositionRows(run?.openPositionsJson ?? null, symbol, periodTo) : [];
```

2-e. 빈 상태 조건을 `trades.length === 0` → `trades.length === 0 && openRows.length === 0` 으로 변경.

2-f. `<TableBody>` 안에서 청산 거래 map **위에** 미청산 행 렌더링:

```tsx
{openRows.map((row) => (
  <TableRow key={`open-${row.symbol}`} className="bg-muted/40">
    <TableCell className="font-medium">{row.symbol}</TableCell>
    <TableCell className="text-right tabular-nums">{row.quantity}</TableCell>
    <TableCell className="whitespace-nowrap text-xs">
      {formatDateTime(row.entryTsMs)}
      <br />
      <span className="text-muted-foreground">{formatKrw(row.entryPrice)}</span>
    </TableCell>
    <TableCell className="whitespace-nowrap text-xs">
      <Badge variant="outline">미청산</Badge>
      <br />
      <span className="text-muted-foreground">{formatKrw(row.lastPrice)}</span>
    </TableCell>
    <TableCell className={cn('text-right tabular-nums', pnlClass(row.unrealizedPnl))}>
      {formatSignedKrw(row.unrealizedPnl)}
    </TableCell>
    <TableCell className={cn('text-right tabular-nums', pnlClass(row.returnPct))}>
      {formatSignedPct(row.returnPct)}
    </TableCell>
    <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
      {formatDuration(row.holdingTimeMs)}
    </TableCell>
    <TableCell className="text-xs text-muted-foreground">미청산</TableCell>
  </TableRow>
))}
```

2-g. 테이블 아래(페이지네이션 div 위)에 각주 — 미청산 행이 보일 때만:

```tsx
{openRows.length > 0 ? (
  <p className="mt-2 text-xs text-muted-foreground">
    미청산 행의 손익은 기간 종료 시점 종가 기준 평가치입니다 (매도 비용 미반영). 누적
    수익률·자산 곡선에는 포함되지만 승률·profit factor·거래 수에는 포함되지 않습니다.
  </p>
) : null}
```

- [ ] **Step 3: 정적 검증**

Run: `pnpm typecheck && pnpm lint`
Expected: PASS (미사용 import 남기면 여기서 걸린다)

- [ ] **Step 4: 유닛 전체 + e2e 실행**

Run: `pnpm test`
Expected: PASS

Run: `pnpm test:e2e`
Expected: PASS — full MVP flow 가 거래 내역 상단 미청산 배지 행을 확인하고, 별도 카드 부재를 확인

- [ ] **Step 5: 커밋**

```bash
git add src/web/features/backtests/backtest-detail-page.tsx tests/e2e/mvp-flow.spec.ts
git commit -m "feat(web): 미청산 포지션을 거래 내역 테이블에 통합 — 별도 카드 제거"
```

---

## Self-Review 결과

- 스펙 커버리지: 첫 페이지 고정·심볼 필터·빈 상태·컬럼 매핑·각주 이동·카드 제거·e2e 갱신 모두 Task 1-2 에 매핑됨. "청산 기준" 표기 유지는 무변경 항목.
- 타입 일관성: Task 2 가 쓰는 `openPositionRows` 시그니처·`OpenPositionRow` 필드는 Task 1 정의와 일치.
- 플레이스홀더 없음.
