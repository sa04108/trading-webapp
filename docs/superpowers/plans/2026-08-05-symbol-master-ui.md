# 종목 마스터 UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 타임머신 뷰(종목 마스터 화면)를 만들고 데이터 탭을 재구성한다.

**Architecture:** `src/web/features/symbol-master/` 에 신규 feature 디렉터리. tanstack query 훅이 core 계획의 API 를 소비한다. DataPage 탭을 [종목 마스터(기본) | 가격 데이터] 로 교체한다.

**Tech Stack:** React, react-router, tanstack query, shadcn/ui (+ radix slider 신규), tailwind.

**선행:** `2026-08-05-symbol-master-core.md` 완료 (API 존재). 참조 스펙: `2026-08-05-symbol-master-design.md` §UI.

## Global Constraints

- 한국어 카피는 합쇼체가 아닌 명사형·간결체 UI 문구 — 기존 화면 문구 톤을 따른다.
- `pnpm typecheck && pnpm lint` 커밋 전 통과. UI 동작 검증은 e2e(backtest 계획)에서 하고, 이 계획에서는 로직 유닛(정렬·필터·타임라인 구간 계산)만 vitest 로 검증한다.
- api 호출은 `src/web/lib/api-client.ts` 의 `api`/`postJson` 만 사용.
- 쿼리 키 규칙: `['symbol-master', ...]`.
- 자동 동기화 체크박스 상태는 `localStorage` 키 `symbolMaster.autoSync` (기본 false — KRX 호출은 명시적 동의가 기본).

---

### Task 1: slider 컴포넌트 추가

**Files:**
- Create: `src/web/components/ui/slider.tsx`
- Modify: `package.json` (의존성)

**Interfaces:**
- Produces: `<Slider value={number[]} min max step onValueChange />` — shadcn 표준 slider.

- [ ] **Step 1: 의존성 설치**

Run: `pnpm add @radix-ui/react-slider`

- [ ] **Step 2: 컴포넌트 작성** — shadcn slider 표준 구현(Root/Track/Range/Thumb, `cn` 유틸)을 기존 `checkbox.tsx` 와 같은 스타일 관례로 작성한다.

- [ ] **Step 3: 검증** — Run: `pnpm typecheck` → PASS

- [ ] **Step 4: 커밋**

```bash
git add src/web/components/ui/slider.tsx package.json pnpm-lock.yaml
git commit -m "feat(ui): slider 컴포넌트를 추가한다"
```

---

### Task 2: 쿼리 훅과 타임라인 도메인

**Files:**
- Create: `src/web/features/symbol-master/use-symbol-master.ts`
- Create: `src/web/features/symbol-master/timeline-model.ts`
- Test: `tests/unit/symbol-master-timeline-model.test.ts`

**Interfaces:**
- Produces (훅):

```typescript
export function useSymbolMasterCoverage(): {
  coverage: SymbolMasterCoverageDto | null; isLoading: boolean; refetch: () => void };
// GET /symbol-master/coverage, staleTime 10_000 (백필 진행 반영)

export function useSymbolMasterUniverse(date: string | null): {
  universe: SymbolMasterUniverseDto | null; isLoading: boolean };
// GET /symbol-master/universe?date=, enabled: date !== null

export function useSymbolMasterEvents(from: string, to: string): { events, isLoading };

export function useSymbolMasterSync(): UseMutationResult; // POST /symbol-master/sync
// 성공 시 queryClient.invalidateQueries({ queryKey: ['symbol-master'] })
```

- Produces (타임라인 순수 모델 — 렌더와 분리해 테스트 가능):

```typescript
export interface TimelineSegment {
  readonly startPct: number; readonly endPct: number; readonly covered: boolean;
}
/** [rangeStart, rangeEnd] 전체 구간 대비 coverage 를 % 세그먼트로 바꾼다 */
export function buildTimelineSegments(
  rangeStart: string, rangeEnd: string,
  covered: readonly { startDate: string; endDate: string }[],
): TimelineSegment[];
/** 슬라이더 % 값 ↔ ISO 날짜 변환 */
export function pctToDate(rangeStart: string, rangeEnd: string, pct: number): string;
export function dateToPct(rangeStart: string, rangeEnd: string, date: string): number;
```

- [ ] **Step 1: 실패하는 테스트 작성** — `buildTimelineSegments`: 빈 coverage → covered:false 한 구간, 가운데 coverage → 3 세그먼트, 경계 밀착. `pctToDate`/`dateToPct` 왕복. 전체 코드로 작성.

- [ ] **Step 2: 실패 확인** → **Step 3: 구현** (날짜↔퍼센트는 `Date.UTC` 밀리초 선형 보간, 결과는 일 단위로 내림) → **Step 4: PASS**

- [ ] **Step 5: 커밋**

```bash
git add src/web/features/symbol-master tests/unit/symbol-master-timeline-model.test.ts
git commit -m "feat(symbol-master): 쿼리 훅과 타임라인 모델을 추가한다"
```

---

### Task 3: 타임머신 패널

**Files:**
- Create: `src/web/features/symbol-master/symbol-master-panel.tsx`
- Create: `src/web/features/symbol-master/universe-table.tsx`
- Create: `src/web/features/symbol-master/events-sidebar.tsx`
- Create: `src/web/features/symbol-master/coverage-timeline.tsx`

**Interfaces:**
- Consumes: Task 1 Slider, Task 2 훅·모델, 기존 `Checkbox`/`Button`/`Card`/`Table`/`Input`/`Select`/`Badge`/`Skeleton`
- Produces: `<SymbolMasterPanel />` — DataPage 가 그대로 삽입.

레이아웃(승인된 A안 v3):

```
[◀ 2023-06-15 ▶]  [타임라인 슬라이더+coverage 띠]  [☐ 자동 동기화(KRX)] [지금 동기화]
┌──────────────────────────────┬──────────────┐
│ 유니버스 표 (검색·시장 필터)     │ 근처 변경 목록  │
│ 코드·이름·시장·상장주식수·상장일 │              │
└──────────────────────────────┴──────────────┘
```

동작 규약:
- 날짜 상태는 쿼리스트링 `?date=` (DataPage 의 `?tab=` 선례) — 새로고침·뒤로가기 보존.
- 슬라이더 이동: 드래그 중에는 날짜 라벨만 갱신, `onValueCommit` 에서 확정 — 유니버스 재조회.
- 확정 날짜가 미커버이고 자동 동기화 ON → `useSymbolMasterSync` 호출 후 재조회. OFF → 빈 상태 카드:

```
2019-03-22 데이터 미수집
[이 날짜 동기화]  [가장 가까운 수집일(2019-04-01)로 이동]
```

  가까운 수집일은 coverage ranges 에서 계산(양방향 최근접, 동률이면 과거).
- `covered:true` 응답: 표 렌더. 헤더에 `{date} 기준 {n}종목 · 마지막 수집 {lastSyncedAtMs} · 체크포인트 {최근 checkpointDate} {verified ? '✓' : '⚠'}`.
- 표 필터: 이름/코드 부분일치 검색, 시장 Select(전체|KOSPI|KOSDAQ), 유형 Select(전체|보통주|그 외). instrumentType `COMMON_STOCK` → '보통주', 그 외 사유는 그대로 뱃지.
- 사이드바: `useSymbolMasterEvents(date-14일, date+14일)` — eventType 한글 라벨(신규상장·상장폐지·시장이전·주식수 변경·종목명 변경·유형 변경), observedSpanStart ≠ effectiveDate-1영업일이면 '근사' 뱃지 대신 span 표기 `({observedSpanStart} 이후)`.
- coverage-timeline: Slider 아래 절대배치 띠 — covered 세그먼트 `bg-primary/60`, 미커버 `bg-muted`, 체크포인트는 삼각 마커 + Tooltip(검증 상태).
- 백필 상태 배너: coverage.backfill.state 가 RUNNING → progress 표시(cursorDate), FAILED → Alert(error), BUDGET_EXHAUSTED → '오늘 호출 예산 소진 — 내일 자동 재개'.

- [ ] **Step 1: 컴포넌트 구현** — 위 규약 전부. 파일 4개로 분리(패널이 조립만 담당).

- [ ] **Step 2: 검증** — Run: `pnpm typecheck && pnpm lint` → PASS. `pnpm dev` 로 화면 수동 확인(미커버 빈 상태·동기화 버튼 동작).

- [ ] **Step 3: 커밋**

```bash
git add src/web/features/symbol-master
git commit -m "feat(symbol-master): 타임머신 패널을 추가한다"
```

---

### Task 4: DataPage 탭 재구성

**Files:**
- Modify: `src/web/features/datasets/data-page.tsx`

**Interfaces:**
- Consumes: `<SymbolMasterPanel />`
- Produces: 데이터 화면 탭 [종목 마스터(기본) | 가격 데이터]. `DatasetsPanel` import 제거(파일 삭제는 backtest 계획).

- [ ] **Step 1: 수정**

```typescript
// tab 파라미터: 'master'(기본) | 'prices' ('symbols' 는 'prices' 로 리다이렉트 해석)
const raw = params.get('tab');
const tab = raw === 'prices' || raw === 'symbols' ? 'prices' : 'master';
```

TabsTrigger: `종목 마스터` / `가격 데이터`. TabsContent 는 `<SymbolMasterPanel />` / `<SymbolsPanel />`. 파일 상단 주석의 설계 근거도 갱신한다(데이터셋 → 종목 마스터, 스펙 2026-08-05).

- [ ] **Step 2: 검증** — Run: `pnpm typecheck && pnpm lint` → PASS. 기존 `?tab=symbols` 링크가 가격 데이터 탭으로 열리는지 수동 확인.

- [ ] **Step 3: 커밋**

```bash
git add src/web/features/datasets/data-page.tsx
git commit -m "feat(data): 데이터 탭을 종목 마스터·가격 데이터로 재구성한다"
```

---

## 완료 기준

- 데이터 화면 기본 탭이 종목 마스터 타임머신 뷰다.
- 미수집 날짜 빈 상태·온디맨드 동기화·타임라인 coverage 표시가 동작한다.
- `pnpm test && pnpm lint && pnpm typecheck` 통과. 데이터셋 탭은 더 이상 노출되지 않는다(코드 제거는 다음 계획).
