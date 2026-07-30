# 데이터셋 종목 그룹화 — 웹 단계 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 데이터셋 카드에 일봉/분봉 스위치와 자물쇠를 붙이고, 생성·CSV·검증 차트·백테스트 위저드를 슬라이스 모델로 옮긴 뒤 전환기 별칭을 제거한다.

**Architecture:** 스펙 `docs/superpowers/specs/2026-07-30-dataset-symbol-group-design.md` 의 2단계(웹). 서버 단계(커밋 8617942..a5f3b6f)가 이미 `DatasetSummary.defaultTimeframe`·`slices[{slice,hasData}]`, sync `slice` 파라미터, 중복 구성 409 를 제공한다. 서버 최종 리뷰가 지목한 **동시 배포 전제 갭 3건** — CSV 1h 옵션 400, 검증 드로어 레거시 1m 400, coverage 응답 slice 미노출 — 이 이 계획의 필수 항목이다.

**Tech Stack:** React 19 + TypeScript, @tanstack/react-query, shadcn/ui (Tabs·Checkbox 존재 확인), lucide-react (Lock), vitest.

## Global Constraints

- 슬라이스 표기: `'1d'` = 일봉, `'1m'` = 분봉. 화면 라벨은 정확히 `일봉` / `분봉`.
- 자물쇠 상태 문구: `동기화가 필요합니다` (분봉/일봉 데이터 없음). 자물쇠 아이콘은 lucide `Lock`, 크게 (`size-10` 이상).
- 카드 스위치는 shadcn `Tabs` 사용 (`@/components/ui/tabs`), 기본 탭 = `dataset.defaultTimeframe`.
- 순수 헬퍼·테스트 파일 `@/` 별칭 금지 (상대 + `.js`). 테스트 describe/it 한국어.
- 서버 계약 (변경 금지, 소비만): `DatasetSummary = { id, name, market, timeframe(전환기 별칭, Task 7 에서 제거), defaultTimeframe: '1d'|'1m', slices: Array<{ slice: '1d'|'1m'; hasData: boolean }>, symbols, latestVersion, runningSyncJobId, ... }`. `POST /datasets/sync` body `{ datasetId, slice?, includeFacts? }` — 동시성 가드는 데이터셋 단위 (한 슬라이스 동기화 중이면 다른 슬라이스도 불가). 중복 구성 409 메시지 `같은 종목 구성의 데이터셋이 이미 있습니다: <이름>`.
- 검증: `pnpm test && pnpm typecheck && pnpm lint`, 마지막에 `pnpm test:e2e`. 커밋: `type(scope): 한국어 서술형`.
- 서버·웹 동시 배포 전제 — 이 계획이 끝나기 전까지 배포하지 않는다.

---

### Task 1: 서버 보강 — coverage 응답에 slice 노출

**Files:**
- Modify: `src/server/modules/market-data/presentation/dataset-routes.ts` (GET `/datasets/:datasetId/coverage` 직렬화)
- Test: coverage 라우트를 다루는 기존 통합 테스트 파일에 케이스 추가 (`tests/integration/market-data.test.ts`)

**Interfaces:**
- Produces: coverage 응답의 각 행에 `slice: '1d' | '1m'` 필드 포함 (DB 행에 이미 있음 — 직렬화 누락만 보수). Task 3 카드가 슬라이스 필터에 사용.

- [ ] **Step 1: 실패하는 테스트** — 기존 coverage 라우트 테스트에: 1d CSV 를 넣은 데이터셋의 coverage 응답 행이 `slice: '1d'` 를 갖는다 (`expect(row.slice).toBe('1d')`).
- [ ] **Step 2: 실패 확인** — 해당 파일 vitest run, `slice` undefined 로 FAIL.
- [ ] **Step 3: 구현** — 직렬화 객체에 `slice: row.slice` 추가.
- [ ] **Step 4: 통과 확인** — 대상 파일 → `pnpm test && pnpm typecheck`.
- [ ] **Step 5: 커밋** — `feat(market-data): coverage 응답에 슬라이스를 노출한다`

---

### Task 2: 웹 타입 정합 — defaultTimeframe·slices 소비 시작

**Files:**
- Modify: `src/web/features/datasets/datasets-page.tsx` (`DatasetSummary` 인터페이스), `src/web/features/backtests/new-backtest-wizard.tsx` (`DatasetSummary` 인터페이스)
- Create: `src/web/features/datasets/dataset-slices.ts` (순수 헬퍼)
- Test: `tests/unit/dataset-slices.test.ts`

**Interfaces:**
- Produces (Task 3~6 이 사용):
  - 웹 인터페이스 확장: `defaultTimeframe: '1d' | '1m'`, `slices: Array<{ slice: '1d' | '1m'; hasData: boolean }>` (기존 `timeframe: string` 은 Task 7 까지 유지).
  - `sliceHasData(slices, slice): boolean` — 해당 슬라이스 hasData.
  - `sliceLabel(slice): string` — `'1d' → '일봉'`, `'1m' → '분봉'`.
  - `wizardTimeframes(slices): Array<'1m'|'1h'|'1d'>` — 데이터 있는 슬라이스에서 도출: 1d→['1d'], 1m→['1h','1m'] (표시 순서: 소비 기본이 앞), 합집합. 둘 다 있으면 `['1d','1h','1m']`.

- [ ] **Step 1: 실패하는 테스트**

`tests/unit/dataset-slices.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  sliceHasData,
  sliceLabel,
  wizardTimeframes,
} from '../../src/web/features/datasets/dataset-slices.js';

const both = [
  { slice: '1d' as const, hasData: true },
  { slice: '1m' as const, hasData: true },
];

describe('sliceLabel / sliceHasData', () => {
  it('슬라이스 라벨은 일봉·분봉이고 hasData 를 그대로 읽는다', () => {
    expect(sliceLabel('1d')).toBe('일봉');
    expect(sliceLabel('1m')).toBe('분봉');
    expect(sliceHasData(both, '1m')).toBe(true);
    expect(sliceHasData([{ slice: '1d', hasData: false }], '1d')).toBe(false);
    expect(sliceHasData([], '1m')).toBe(false);
  });
});

describe('wizardTimeframes', () => {
  it('데이터 있는 슬라이스에서만 소비 봉을 도출한다', () => {
    expect(wizardTimeframes([{ slice: '1d', hasData: true }])).toEqual(['1d']);
    expect(wizardTimeframes([{ slice: '1m', hasData: true }])).toEqual(['1h', '1m']);
    expect(wizardTimeframes(both)).toEqual(['1d', '1h', '1m']);
    expect(wizardTimeframes([{ slice: '1m', hasData: false }])).toEqual([]);
  });
});
```

- [ ] **Step 2: 실패 확인** — 모듈 없음 FAIL.
- [ ] **Step 3: 구현**

`src/web/features/datasets/dataset-slices.ts`:

```ts
/** 데이터셋 봉 슬라이스 표시·판정 (설계 §3·§4). 서버 dataset-slice.ts 와 값 계약 동일 */
export type DatasetSlice = '1d' | '1m';
export interface SliceState {
  slice: DatasetSlice;
  hasData: boolean;
}

export function sliceLabel(slice: DatasetSlice): string {
  return slice === '1d' ? '일봉' : '분봉';
}

export function sliceHasData(slices: readonly SliceState[], slice: DatasetSlice): boolean {
  return slices.some((s) => s.slice === slice && s.hasData);
}

/** 백테스트 위저드 봉 주기 선택지 — 데이터 있는 슬라이스에서만. 소비 기본(1d, 1h)이 앞 */
export function wizardTimeframes(slices: readonly SliceState[]): Array<'1m' | '1h' | '1d'> {
  const result: Array<'1m' | '1h' | '1d'> = [];
  if (sliceHasData(slices, '1d')) result.push('1d');
  if (sliceHasData(slices, '1m')) result.push('1h', '1m');
  return result;
}
```

두 페이지의 `DatasetSummary` 인터페이스에 `defaultTimeframe`·`slices` 필드 추가 (타입만 — 사용은 다음 태스크).

- [ ] **Step 4: 통과 확인** — 대상 테스트 → `pnpm test && pnpm typecheck && pnpm lint`.
- [ ] **Step 5: 커밋** — `feat(web): 데이터셋 슬라이스 헬퍼와 타입을 더한다`

---

### Task 3: 데이터셋 카드 — 일봉/분봉 스위치 + 자물쇠 + 슬라이스 동기화

**Files:**
- Modify: `src/web/features/datasets/datasets-page.tsx` (`DatasetCard`)

**Interfaces:**
- Consumes: Task 1 coverage `slice` 필드, Task 2 헬퍼, shadcn `Tabs`(`@/components/ui/tabs`), lucide `Lock`.
- Produces: 없음 (화면).

- [ ] **Step 1: 스위치 상태 추가** — `DatasetCard` 에 `const [slice, setSlice] = useState<DatasetSlice>(dataset.defaultTimeframe);`. 카드 헤더 배지 줄의 `datasetTimeframeLabel(dataset.timeframe)` 배지를 `Tabs` 로 교체:

```tsx
<Tabs value={slice} onValueChange={(v) => setSlice(v as DatasetSlice)}>
  <TabsList className="h-8">
    <TabsTrigger value="1d" className="text-xs">일봉</TabsTrigger>
    <TabsTrigger value="1m" className="text-xs">분봉</TabsTrigger>
  </TabsList>
</Tabs>
```

- [ ] **Step 2: 자물쇠 본문** — `sliceHasData(dataset.slices, slice)` 가 false 면 카드 본문(커버리지 요약·종목 기간 줄) 대신:

```tsx
<div className="flex flex-col items-center gap-2 py-6 text-muted-foreground">
  <Lock className="size-10" aria-hidden />
  <p className="text-sm">{sliceLabel(slice)} 데이터가 없습니다 — 동기화가 필요합니다.</p>
</div>
```

hasData 면 기존 본문 유지하되, coverage 표시를 응답의 `slice` 필드로 필터한 행만 사용 (기존 `Map(row.symbol → row)` 구성 앞에 `.filter((row) => row.slice === slice)`).

- [ ] **Step 3: 동기화가 스위치를 따름** — sync mutation 의 POST body 에 `slice` 포함. 동기화 진행 중 표시는 기존 그대로 (데이터셋 단위 가드 — 스위치를 바꿔도 "동기화 취소" 버튼이 보이는 것이 올바른 동작임을 주석으로 명시).
- [ ] **Step 4: 검증** — `pnpm typecheck && pnpm lint && pnpm test`.
- [ ] **Step 5: 커밋** — `feat(web): 데이터셋 카드에 일봉·분봉 스위치와 자물쇠를 붙인다`

---

### Task 4: 생성 드로어·CSV 폼 — 수집 봉 유지 + 1h 제거 + 409 처리

**Files:**
- Modify: `src/web/features/datasets/datasets-page.tsx` (`BrokerDatasetDrawer`, CSV import 폼)

**Interfaces:**
- Consumes: POST `/datasets` body `collect: '1m'|'1d'` (서버 그대로), 409 응답.

- [ ] **Step 1: 생성 드로어** — `수집 봉` 셀렉터 유지하되 라벨·값 정리: 옵션 `일봉`(`'1d'`, 기본)·`분봉`(`'1m'`). state 초깃값 `'1d'`. 드로어 설명 문구를 새 모델로: `기본은 일봉입니다. 분봉을 고르면 1분봉을 수집해 시간봉으로 자동 집계합니다. 생성 후 카드의 일봉/분봉 스위치로 어느 쪽이든 동기화할 수 있습니다.`
- [ ] **Step 2: 409 표시** — 생성·종목 편집 mutation 의 onError 가 409 메시지(`같은 종목 구성의 데이터셋이 이미 있습니다: <이름>`)를 toast 로 그대로 노출하는지 확인, 아니면 errorMessage 헬퍼가 서버 메시지를 살리도록 수정.
- [ ] **Step 3: CSV 폼** — 봉 주기 옵션을 `1분봉`(`'1m'`)·`일봉`(`'1d'`) 으로 교체 (기존 `1h` 옵션 삭제 — 서버가 400 낸다, 서버 최종 리뷰 Important 2 해소).
- [ ] **Step 4: 검증** — `pnpm typecheck && pnpm lint && pnpm test`.
- [ ] **Step 5: 커밋** — `fix(web): 생성·CSV 폼을 슬라이스 계약에 맞춘다`

---

### Task 5: 검증 드로어 — slices 기반 timeframe (레거시 400 회귀 해소)

**Files:**
- Modify: `src/web/features/datasets/candle-inspect-drawer.tsx`, `src/web/features/datasets/datasets-page.tsx` (드로어 호출부 props)

**Interfaces:**
- Consumes: `dataset.slices`, Task 2 헬퍼. 드로어 props 를 `datasetTimeframe: string` 에서 `slices: SliceState[]` (+ 카드의 현재 `slice`) 로 교체.

- [ ] **Step 1: 조회 가능 timeframe 도출 교체** — 드로어의 하드코딩 `datasetTimeframe === '1h' ? ['1m','1h'] : [datasetTimeframe]` 를 제거하고: 카드에서 넘어온 현재 슬라이스 기준 `slice === '1m' ? ['1h','1m'] : ['1d']` 중 **hasData 인 슬라이스만**. 초기 선택 = 첫 항목. 기존 "1m 빈 응답 → 1h 폴백" useEffect 는 삭제 (서버가 이제 없는 timeframe 을 400 내므로 애초에 요청하지 않는 것이 해법 — 서버 최종 리뷰 Important 3 해소).
- [ ] **Step 2: 검증** — `pnpm typecheck && pnpm lint && pnpm test`.
- [ ] **Step 3: 커밋** — `fix(web): 검증 차트가 보유 슬라이스에서만 봉을 고른다`

---

### Task 6: 백테스트 위저드·표시 — slices 기반 봉 주기

**Files:**
- Modify: `src/web/features/backtests/new-backtest-wizard.tsx`, `src/web/features/backtests/job-timeframe.ts`, `src/web/features/backtests/prefill.ts`
- Test: `tests/unit/job-timeframe.test.ts`, `tests/unit/prefill.test.ts` (기존 파일 갱신)

**Interfaces:**
- Consumes: `wizardTimeframes(slices)` (Task 2).
- Produces: `resolveJobTimeframe(job, datasets)` 의 datasets 항목 타입이 `{ id, defaultTimeframe }` 로 바뀜 — 폴백 = `defaultTimeframe === '1m' ? '1h' : '1d'` (서버 legacyConsumeDefault 와 동일 규칙, 주석 명시).

- [ ] **Step 1: 실패하는 테스트** — `job-timeframe.test.ts` 의 데이터셋 픽스처를 `{ id, defaultTimeframe }` 로 바꾸고: `defaultTimeframe '1m'` 폴백 → `'1h'`, `'1d'` → `'1d'` 단언. 실행해 FAIL 확인.
- [ ] **Step 2: 구현** — `resolveJobTimeframe` 폴백 로직 교체. 호출부(backtests-page, detail page)는 datasets 쿼리 응답이 이미 defaultTimeframe 을 포함하므로 전달 객체만 조정.
- [ ] **Step 3: 위저드 봉 주기 선택** — 기존 `selectedDataset?.timeframe === '1h'` 조건의 봉 주기 카드 를 `wizardTimeframes(selectedDataset.slices)` 기반으로 교체: 선택지 2개 이상일 때만 카드 노출, 옵션 = 도출 목록 (`timeframeLabel` 표기), 기본 = 첫 항목. 제출 시 timeframe = 선택값 (항상 명시 — 기존 동작 유지). 1분봉 경고 문구는 '1m' 옵션이 있을 때만.
- [ ] **Step 4: prefill 정합** — `requestToFormState` 의 데이터셋 검증이 새 필드와 어긋나지 않는지 테스트로 확인, 필요한 픽스처만 보수.
- [ ] **Step 5: 검증** — 대상 테스트 → `pnpm test && pnpm typecheck && pnpm lint`.
- [ ] **Step 6: 커밋** — `feat(web): 위저드 봉 주기를 보유 슬라이스에서 도출한다`

---

### Task 7: 전환기 별칭 제거 + 사어 정리

**Files:**
- Modify: `src/server/modules/market-data/application/dataset-service.ts` (`DatasetSummary.timeframe` 제거), `src/web/features/datasets/datasets-page.tsx`·`new-backtest-wizard.tsx` (인터페이스에서 `timeframe` 제거), `src/web/lib/format.ts` (`datasetTimeframeLabel` 삭제), `src/server/modules/market-data/application/broker-sync-service.ts` (`SyncUnsupportedDatasetError` 삭제 + 참조 테스트 정리)
- Test: `tests/unit/format.test.ts` (datasetTimeframeLabel 케이스 삭제)

- [ ] **Step 1: 서버 별칭 제거** — `toSummary` 의 `timeframe` 필드 삭제. `pnpm typecheck` 로 웹 잔존 참조 전부 색출 (grep `\.timeframe` in src/web — dataset 문맥만; request.timeframe 은 유지).
- [ ] **Step 2: 웹 잔존 참조 정리** — 인터페이스·표시 전부 defaultTimeframe/slices 기반으로. `datasetTimeframeLabel` 삭제 + format.test 해당 describe 삭제 (`timeframeLabel` 은 유지).
- [ ] **Step 3: 사어 삭제** — `SyncUnsupportedDatasetError` 클래스와 이를 참조하는 테스트 정리 (서버 최종 리뷰 deferred).
- [ ] **Step 4: 검증** — `pnpm test && pnpm typecheck && pnpm lint`.
- [ ] **Step 5: 커밋** — `refactor: 데이터셋 timeframe 전환기 별칭을 걷어낸다`

---

### Task 8: E2E·수동 확인·최종 검증

**Files:**
- Modify: `tests/e2e/mvp-flow.spec.ts` (필요 시 — 카드 스위치·배지 변화로 깨지는 셀렉터)

- [ ] **Step 1: E2E** — `pnpm test:e2e`. 깨지면 새 UI 구조에 맞게 셀렉터 갱신 + 스위치·자물쇠 상호작용 단언 추가: 분봉 탭 클릭 → (픽스처는 1m 데이터 있음) 정상 표시; 반대 슬라이스(일봉) 탭 → 자물쇠 문구 노출.
- [ ] **Step 2: 전체 게이트** — `pnpm test && pnpm typecheck && pnpm lint && pnpm test:e2e` 전부 PASS.
- [ ] **Step 3: 수동 시나리오** — e2e 픽스처 서버 + 스크린샷: ① 카드 스위치·자물쇠 ② 생성 드로어 수집 봉(일봉 기본) ③ CSV 폼 1분봉/일봉 ④ 위저드 봉 주기 도출 ⑤ 검증 드로어.
- [ ] **Step 4: 커밋** — `test(e2e): 카드 스위치와 자물쇠 흐름을 검증한다`
