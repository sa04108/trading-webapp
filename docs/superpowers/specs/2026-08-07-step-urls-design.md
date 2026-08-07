# 화면 단계에 URL 을 붙인다 — 위저드 단계와 데이터 구획

작성 2026-08-07.

## 문제

화면 전체가 바뀌는데 URL 이 그대로인 곳이 두 군데다.

**백테스트 위저드** — 단계가 `useState(0)` 에만 있다. 전략에서 기간으로 넘어가도 URL 은
`/backtests/new` 다. 브라우저 뒤로가기를 누르면 직전 단계가 아니라 위저드에 들어오기 전
화면으로 나가 버린다. 단계를 가리키는 링크도 만들 수 없다.

**데이터 화면** — 탭이 `?tab=master|prices` 에 있긴 하지만 `setParams(next, { replace: true })`
로 이력을 덮어쓴다. 종목 마스터와 가격 데이터는 나란한 두 화면인데 왕복한 흔적이 남지
않아 뒤로가기가 구획을 기억하지 못한다.

두 곳 모두 "페이지 단위로 화면 전체가 바뀌는" 이동이다. 그런 이동은 이력에 한 칸을 차지해야
한다.

## 범위

**한다** — 위저드 6단계, 데이터 화면 2구획에 각자 URL 을 준다. 옛 링크는 리다이렉트로 잇는다.

**하지 않는다**

- `backtest-detail-page` — 탭이 없는 단일 스크롤 화면이라 쪼갤 단계가 없다. 나중에 탭을
  도입하면 그때 경로를 준다.
- `symbol-master-panel` 의 `?date=` 와 페이지네이션 — 한 화면 안의 부분 상태다. 타임라인
  슬라이더를 한 번 끌면 이력이 여러 칸 쌓여 뒤로가기가 화면을 못 벗어난다. `replace` 를
  유지한다.
- 폼 값 보존 — 아래 '알려진 한계' 참고.

## 라우트 트리

```tsx
{ path: 'backtests', element: <BacktestsPage /> },
{ path: 'backtests/new', element: <NewBacktestEntry /> },        // slug 없는 진입
{ path: 'backtests/new/:step', element: <NewBacktestWizard /> },
{ path: 'backtests/:id', element: <BacktestDetailPage /> },
{
  path: 'datasets',
  element: <DataPage />,                                          // 껍데기 + Outlet
  children: [
    { index: true, element: <DatasetsIndexRedirect /> },
    { path: 'master', element: <SymbolMasterPanel /> },
    { path: 'prices', element: <SymbolsPanel /> },
  ],
},
```

두 리다이렉트 컴포넌트(`NewBacktestEntry`, `DatasetsIndexRedirect`)는 `<Navigate replace>` 다.
push 로 하면 뒤로가기가 리다이렉트 원점으로 돌아가 즉시 다시 튕기는 루프가 된다.

둘 다 쿼리스트링에서 자기가 소비하는 키만 떼고 나머지를 그대로 넘긴다 — `NewBacktestEntry` 는
`?from=` 을, `DatasetsIndexRedirect` 는 `?tab=` 을 지우고 `?date=` 를 살린다.

## 단계 slug

`wizard-steps.ts` 에 URL 전용 이름을 상수로 둔다.

```ts
export const WIZARD_STEP_SLUGS = ['strategy','period','universe','capital','review','run'] as const;
export type WizardStepSlug = (typeof WIZARD_STEP_SLUGS)[number];

export function stepSlug(index: number): WizardStepSlug;                // 범위 밖이면 'strategy'
export function stepIndexOf(slug: string | undefined): number | null;   // 모르는 slug 는 null
```

`WIZARD_STEPS` 의 한글 라벨에서 slug 를 만들지 않는다. 라벨은 화면 문구라 언제든 바뀌는데,
바뀌면 공유된 옛 링크가 죽는다. 슬러그를 따로 고정하면 라벨만 자유롭게 고칠 수 있다.

두 배열의 길이가 같은지는 단위 테스트가 지킨다. 어긋나면 URL 이 다른 단계를 가리킨다.

데이터 구획도 같은 규칙이다 — `종목 마스터` → `master`, `가격 데이터` → `prices`.

## 위저드가 URL 에서 단계를 읽는다

`useState(step)` 을 없애고 URL 을 단일 출처로 삼는다.

```ts
const step = stepIndexOf(useParams().step) ?? 0;
```

출처가 둘이면(state + URL) 뒤로가기가 URL 만 바꾸고 state 는 낡은 값으로 남는 경합이 생긴다.

### 갈 수 없는 단계로 들어온 URL

기존 게이트(`stepBlocker`·`navigableStepLimit`)를 그대로 쓸 수 없다. `navigableStepLimit` 은
`Math.max(currentStep, forward)` 로 **현재 단계를 항상 통과시킨다** — 뒤로 갈 길을 막지 않으려는
설계다. 그런데 딥링크로 도착한 단계는 "이미 지나온 곳" 이 아니어서 근거가 되지 못한다.

규칙 파일에 하나 더한다.

```ts
/** URL 이 가리켜도 되는 최대 단계 — 딥링크는 현재 단계를 근거로 삼을 수 없다 */
export function reachableStepFromUrl(state: StepGateState, reviewPassed: boolean): number;
```

`step` 이 이 값보다 크면 `navigate(stepSlug(reachable), { replace: true })` 로 되돌린다. replace
라서 튕겨 나온 단계가 이력에 남지 않는다. 안내 배너는 띄우지 않는다.

`reviewPassed` 가 필요한 이유는 `실행` 단계다. 기존 규칙은 "제출 버튼이 있는 화면에는 검토를
눈으로 거쳐서만 들어온다" 이고 그래서 forward 상한이 `REVIEW_STEP` 이다. 이것만으로 클램프하면
검토에서 '다음' 을 눌러 정당하게 도착한 `/run` 도 매번 검토로 튕긴다. `goNext()` 가
`REVIEW_STEP` 에서 호출될 때 세우는 `useState` 플래그로 그 사실만 기억한다. 새로고침하면 false
로 돌아가므로 `/run` 직접 열기는 여전히 막힌다.

상단 단계 버튼은 지금처럼 `navigableStepLimit(step, gate)` 와 `stepJumpBlockReason(index, step, gate)`
를 쓴다. 현재 단계 버튼이 잠긴 것으로 보여선 안 되기 때문이다. 클램프만 `reachableStepFromUrl`
을 쓴다. 두 함수가 같은 게이트를 다르게 보는 이유는 주석으로 남긴다.

### 프리필 중에는 클램프를 보류한다

`?from=<jobId>` 복제 진입은 초안이 도착한 뒤에야 폼이 채워진다. 그 전에 게이트가 비었다고
전략 단계로 되돌리면, 곧 채워질 폼을 근거 없이 버린다. 기존 `prefilling` 플래그가 참인 동안
클램프를 건너뛴다.

## 단계 이동

```ts
navigate({ pathname: `/backtests/new/${stepSlug(target)}`, search: location.search });
```

'다음', '이전', 상단 단계 버튼 모두 push 다. `?from=` 은 매 이동에 이어붙인다 — 빠지면 복제
맥락이 중간에 사라진다.

'이전' 도 push 인 결과로, 브라우저 뒤로가기는 "직전 단계" 가 아니라 "직전 이동의 취소" 가 된다.
유니버스에서 '이전' 을 눌러 기간에 왔다면 이력은 `[전략, 기간, 유니버스, 기간]` 이고 뒤로가기는
유니버스로 간다. 브라우저 뒤로가기의 원래 의미가 그것이므로 맞춰 둔다.

`stepError` 는 `step` 이 바뀔 때 지운다. 지금 `goToStep` 이 하던 일을 URL 변화에 옮긴다.

## 데이터 화면

`DataPage` 는 껍데기만 남긴다 — 제목, 구획 nav, `<Outlet />`.

```tsx
<nav aria-label="데이터 구획">
  <Link to="/datasets/master" aria-current={isMaster ? 'page' : undefined}>종목 마스터</Link>
  <Link to="/datasets/prices" aria-current={isMaster ? undefined : 'page'}>가격 데이터</Link>
</nav>
<Outlet />
```

`Tabs` 를 걷어내는 이유: 자식 라우트는 활성 패널 하나만 마운트하므로 `TabsContent` 가 없는
`TabsTrigger` 의 `aria-controls` 가 허공을 가리킨다. 위저드 단계 nav 가 이미 `nav` + `aria-current`
패턴이라 화면 안에서 일관되기도 하다.

모양은 `tabs.tsx` 의 default variant 를 자체 클래스로 다시 만들어 맞춘다. 그 파일의 클래스
문자열을 그대로 옮겨 오지는 않는다 — `group-data-[variant=…]/tabs-list` 선택자들이
`Tabs.Root`·`TabsList` 가 붙이는 data 속성에 매달려 있어 `nav` 안에서는 절반이 죽는다.

`SymbolMasterPanel` 의 `?date=` 처리는 손대지 않는다 — 경로만 바뀌고 쿼리는 그대로 읽는다.

## 링크 갱신

- `dashboard-page.tsx` 2곳, `universe-rule-step.tsx` 1곳: `/datasets?tab=prices` → `/datasets/prices`
- 서버 알림 링크 `/datasets` 는 그대로 둔다 — 인덱스 리다이렉트가 받는다

## 옛 URL 호환

| 옛 URL | 새 위치 |
|---|---|
| `/datasets` | `/datasets/master` |
| `/datasets?tab=master&date=X` | `/datasets/master?date=X` |
| `/datasets?tab=prices` | `/datasets/prices` |
| `/datasets?tab=symbols` (더 옛 링크) | `/datasets/prices` |
| `/backtests/new` | `/backtests/new/strategy` |
| `/backtests/new?from=job_1` | `/backtests/new/strategy?from=job_1` |
| `/backtests/new/<모르는 slug>` | `/backtests/new/strategy` |

## 알려진 한계 — 위저드를 벗어나면 폼이 비워진다

같은 라우트(`backtests/new/:step`)에서 param 만 바뀌는 이동은 컴포넌트를 재마운트하지 않으므로
전략·파라미터·기간·유니버스 규칙·미리보기 결과(`lastPreview`)·자본·비용이 전부 살아 있다.
위저드 안에서 움직이는 한 뒤로·앞으로가 값을 지우지 않는다.

두 경우는 예외다.

1. **새로고침** — 페이지가 다시 뜨니 `useState` 가 전멸한다. 클램프가 전략 단계로 되돌린다.
2. **위저드를 벗어난 뒤 뒤로가기로 복귀** — 사이드바로 다른 화면에 가면 위저드가 언마운트되고,
   돌아올 때는 새 인스턴스다. 빈 폼이라 클램프가 전략 단계로 되돌린다.

둘 다 폼 값을 `sessionStorage` 에 보존해야 없앨 수 있고, 그건 상태 동기화·만료 정직 정책을
새로 설계해야 하는 별건이다. 이번 범위에서 뺀다. 유니버스 구성은 어차피 제출 시점에 서버가
규칙으로 재구성하므로 완전 복원은 원래 불가능하다.

## 검증

### 단위 (`tests/unit/wizard-steps.test.ts` 확장)

- `WIZARD_STEP_SLUGS.length === WIZARD_STEPS.length`
- `stepIndexOf(stepSlug(i)) === i` 왕복, 모르는 slug·`undefined` 는 `null`
- `reachableStepFromUrl`
  - 빈 폼 → `0`
  - 전 단계 통과 + `reviewPassed: false` → `REVIEW_STEP`
  - 전 단계 통과 + `reviewPassed: true` → `RUN_STEP`

### e2e

- **위저드 뒤로가기가 값을 지키는지** — 전략 선택 → '다음' → 기간 → 브라우저 뒤로 → URL 이
  `/backtests/new/strategy` 이고 전략 선택이 남아 있다. 앞으로 → `/backtests/new/period`.
  param 변경이 재마운트를 일으키지 않는다는 전제를 못박는 테스트다.
- **딥링크 클램프** — `/backtests/new/review` 로 바로 들어가면 `/backtests/new/strategy` 가 되고,
  뒤로가기가 review 로 돌아가지 않는다(replace 확인).
- **데이터 구획 왕복** — `/datasets/master` → 가격 데이터 클릭 → `/datasets/prices` → 뒤로 →
  `/datasets/master`.
- **옛 링크** — `/datasets?tab=master&date=X` → `/datasets/master?date=X`(날짜 유지),
  `?tab=symbols` → `/datasets/prices`. 기존 `symbol-master.spec.ts` 의 구 링크 테스트를 갱신한다.
- 기존 `page.goto('/datasets?tab=prices')` 호출들은 리다이렉트로 그대로 통과한다. 반응형 화면
  목록(`mvp-flow.spec.ts`)의 경로만 새 형태로 바꾼다.
