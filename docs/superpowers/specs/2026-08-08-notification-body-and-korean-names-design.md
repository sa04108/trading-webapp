# 알림 항목 설명에 수익률·제출 경고를 남기고 전략 이름을 한국어로 보인다

작성 2026-08-08.

## 문제

**하나. 제출 경고의 수명이 토스트 10초뿐이다.**

`POST /backtests` 와 clone 응답은 `warnings[]` 를 실어 보낸다. 자본변동 이력에 gap 이 있어
분할을 확인하지 못했다는 경고가 여기로 온다. 화면은 그걸 `toast.warning(..., { duration:
10_000 })` 로 띄우고 끝이다 (`new-backtest-wizard.tsx:348`, `backtest-detail-page.tsx:602`).

10초가 지나면 "수집했고 분할이 없었다" 와 "gap 이 나서 확인하지 못했다" 가 같아 보인다.
결과를 나중에 다시 열어도 구분할 근거가 없다.

**둘. 알림 항목 설명이 결과를 말하지 않는다.**

알림 페이지 항목의 설명은 `strategyId` 한 줄이다 (`notification-wiring.ts:42`). 백테스트가
완료됐다는 건 제목이 말하는데, 그 결과가 어땠는지는 항목을 눌러 상세 화면까지 들어가야
안다.

**셋. 화면에 kebab-case 영어 식별자가 그대로 보인다.**

전략은 이미 한국어 이름을 갖고 있다 — `cross-sectional-momentum.ts:99` 의
`name: '횡단면 모멘텀'`. `GET /strategies` 가 그걸 응답에 담는다. 그런데 알림 항목 설명과
대시보드 카드는 이름 대신 `strategyId` 를 그대로 찍는다.

## 범위

**한다**

- 제출·복제 시점의 `warnings[]` 를 job 에 저장한다.
- 알림 항목 설명을 `전략 한국어 이름 · 수익률` + 경고 줄로 바꾼다.
- 대시보드 두 카드(`실행 중 작업`, `최근 결과`)의 전략 표기를 한국어 이름으로 바꾼다.

**하지 않는다**

- **토스트 좌우 스와이프 닫기** — sonner 가 `position="top-center"` 에서 위로 밀기를 이미
  지원한다. 닫는 수단이 이미 있어 방향을 더할 이유가 없다.
- **엔진 실행 경고** (`backtestRuns.warningsJson`) — 상세 화면 `WarningsSection` 에 이미
  남는다. 알림 설명에 옮겨 적으면 같은 내용이 두 곳에 있게 된다.
- **수익률 외의 지표** — CAGR·MDD·Sharpe 는 상세 화면 지표 카드의 몫이다. 알림 설명은
  접히면 한 줄만 보이므로 지표를 늘리면 정작 전략 이름이 잘린다.
- **백테스트 결과 화면의 영어 지표명** — CAGR·MDD·Sharpe·`Drawdown` 은 그대로 둔다.
  이 작업이 겨누는 곳은 알림 페이지와 대시보드다.
- **재현성 메타의 영어 값** — 상세 화면의 전략 해시, 엔진 버전, Git 커밋, `feeModelVersion`
  은 식별자라 번역 대상이 아니다. 라벨은 이미 한국어다.
- `KOSPI`·`KOSDAQ` 는 고유명사, `Quant Platform` 은 제품명이라 그대로 둔다.

## 제출 경고 저장

`backtest_jobs` 에 컬럼 하나를 더한다. 경고가 없으면 `null` 이다 — 빈 배열 `'[]'` 을 넣으면
"경고가 없었다" 와 "이 컬럼이 생기기 전에 만들어진 job" 이 같아 보인다.

```sql
-- migrations/0011_*.sql
ALTER TABLE backtest_jobs ADD COLUMN submit_warnings_json text;
```

```ts
// schema.ts, backtestJobs 안 error 근처
/**
 * 제출·복제 응답이 실어 보낸 경고 원문(string[]). 화면 토스트는 10초 뒤 사라지므로,
 * 자본변동 gap 경고 같은 "확인하지 못했다" 를 남길 곳이 여기밖에 없다.
 * null 은 이 컬럼이 생기기 전 job 이거나 경고가 없었던 job 이다.
 */
submitWarningsJson: text('submit_warnings_json'),
```

`JobQueue.enqueue` 에 파라미터를 더한다. 기본값 `[]` 는 기존 인자 순서를 지키면서 단위
테스트가 매번 채우지 않아도 되게 한다 — `schedule` 파라미터와 같은 관례다.

```ts
enqueue(
  request: BacktestRequest,
  schedule: readonly UniverseScheduleEntry[] = [],
  pinnedUniverse?: { entries: readonly unknown[]; hash: string },
  provenancePin?: ProvenancePin | null,
  /** 제출 검증이 만든 경고 — 응답으로만 나가면 토스트와 함께 사라진다 */
  submitWarnings: readonly string[] = [],
): BacktestJobRow
```

호출 두 곳:

| 위치 | 넘기는 값 |
|---|---|
| `backtest-routes.ts:801` (신규 제출) | `validated.warnings` |
| `backtest-routes.ts:910` (복제) | `[...rebased.warnings, ...validated.warnings]` |

복제 응답이 이미 두 배열을 합쳐 내보내므로(`backtest-routes.ts:923`) 저장도 같은 합집합이다.

개수 상한은 두지 않는다. 제출 경고는 자본변동 gap 과 최근 기간 안내로 최대 두 건이고,
복제의 rebase 경고도 유한하다. `engine.ts:161` 이 경계한 "봉마다 같은 사유가 반복돼
warningsJson 이 부푸는" 증식과 성격이 다르다.

## 알림 항목 설명 조립

`notification-wiring.ts` 가 조립한다. 이 파일은 이미 `queue.getJob` 으로 row 를 들고 있어
추가 조회가 없다.

| 종료 상태 | 설명 |
|---|---|
| COMPLETED | `횡단면 모멘텀 · 수익률 +12.34%` |
| FAILED | `횡단면 모멘텀 — <실패 사유>` |
| CANCELLED · INTERRUPTED | `횡단면 모멘텀` |

경고가 있으면 그 아래에 한 줄씩 `경고: <원문>` 으로 붙는다.

```
횡단면 모멘텀 · 수익률 +12.34%
경고: 005930 자본변동 이력에 gap 이 있어 분할을 확인하지 못했습니다
경고: 선택한 기간이 최근이라 아직 DART 에 공시되지 않은 자본변동이 있을 수 있습니다. …
```

첫 줄이 이름과 수익률을 함께 지는 이유: 접힌 행은 `truncate` 라 한 줄만 보이고, `+` 를 눌러
펼치면 `whitespace-pre-wrap` 으로 경고까지 나온다 (`notifications-page.tsx:43`). 화면은 고치지
않는다 — 지금 구조가 여러 줄 설명을 이미 제대로 렌더한다.

COMPLETED 인데 수익률을 못 읽으면 이름만 남긴다. 그런 상태는 결과 기록 없이 완료로 표시된
job 이라는 뜻이고, `수익률 -` 이라고 쓰면 "0에 가깝다" 로 읽힐 수 있다.

### 리스너가 받는 의존

```ts
export function createBacktestNotificationListener(deps: {
  queue: Pick<JobQueue, 'getJob'>;
  /** 전략 한국어 이름. 등록이 풀린 전략은 null — 그때는 strategyId 로 적는다 */
  strategyName: (strategyId: string) => string | null;
  /** backtest_metrics.total_return_pct. 결과가 없으면 null */
  totalReturnPct: (jobId: string) => number | null;
  notify: (input: NotificationInput) => void;
  logger: Logger;
}): (event: JobEvent) => void
```

`try/catch` 로 감싼 지금 구조를 유지한다 — 알림 실패가 orchestrator 의 emit 경로를 끊으면
안 된다. 새 의존 두 개가 던져도 같은 catch 가 삼킨다.

부호 서식(`+12.34%`)은 이 파일 안에 두 줄로 둔다. 웹 `formatSignedPct` 와 규칙이 같지만,
공유하려면 `src/shared` 에 서식 모듈을 새로 만들고 웹을 그쪽으로 돌려야 해 이 작업 범위를
넘는다.

### 수익률 읽기

`ResultsService` 에 메서드를 더한다.

```ts
/** 알림 설명용 — getMetrics 는 metricsJson 을 통째로 파싱하니 값 하나엔 과하다 */
getTotalReturnPct(jobId: string): number | null
```

타이밍은 안전하다. 자식 프로세스가 `insertResults()` 트랜잭션으로 metrics 를 커밋한 뒤
`finish('COMPLETED')` 를 부르고(`backtest-child.ts:416,427`), 알림은 그 프로세스가 죽은 뒤
부모 exit 핸들러의 `events.emit('job')` 에서 뜬다(`job-orchestrator.ts:262`). 알림이 읽을
시점에 metrics 는 이미 있다.

### container 배선 순서

`container.ts:281` 이 리스너를 등록하는데, `ResultsService` 는 283 줄에서, `StrategyRegistry`
는 311 줄 return 문 안에서 만들어진다. 둘 다 등록보다 앞으로 옮긴다. `StrategyRegistry` 는
return 문에서 새로 만들지 말고 옮긴 인스턴스를 쓴다 — 두 개를 만들면 레지스트리가 갈라진다.

## 대시보드 전략 이름

`dashboard-page.tsx` 의 두 카드가 `{job.strategyId}` 를 찍는다 — `실행 중 작업`(77줄)과
`최근 결과`(105줄). 둘 다 한국어 이름으로 바꾼다. 한 화면에서 한 카드만 바꾸면 나란한 두
카드의 표기가 어긋난다.

이름을 못 찾으면 `strategyId` 로 떨어진다. 등록이 풀린 전략의 지난 결과가 이름 없이 빈칸으로
보이면 안 된다 — `backtests-page.tsx:108` 이 이미 같은 fallback 을 쓴다.

`queryKey: ['strategies']` useQuery 가 세 곳에 복사돼 있다 (`backtest-detail-page.tsx:620`,
`backtests-page.tsx:79`, `new-backtest-wizard.tsx:141`). 대시보드가 네 번째를 만들지 않게
`backtests/api.ts` 에 `useStrategies()` 를 뽑고 네 화면이 공유한다. 응답은 전략 목록이라
자주 바뀌지 않으므로 `staleTime` 을 길게 둔다.

## 테스트

**`tests/unit/notification-wiring.test.ts`** (기존 파일)

- COMPLETED — 이름과 수익률이 첫 줄에 함께 온다
- COMPLETED 인데 `totalReturnPct` 가 null — 이름만 남고 `수익률` 문구가 없다
- FAILED — `이름 — 실패 사유` 뒤에 경고가 붙는다
- 경고가 없으면 설명이 한 줄이다
- `strategyName` 이 null — `strategyId` 로 적는다
- `totalReturnPct` 가 던져도 알림 실패가 emit 을 끊지 않는다

**`tests/integration/`** — 제출과 복제가 `submit_warnings_json` 을 저장하고, 경고가 없으면
`null` 로 남긴다.

**대시보드** — 전략 이름이 렌더되고, 목록에 없는 `strategyId` 는 그대로 보인다.

## 알려진 한계

이 변경 전에 만들어진 job 은 `submit_warnings_json` 이 `null` 이다. 백필할 원본이 없다 —
제출 시점 경고는 응답에만 있었고 어디에도 저장되지 않았다. 지난 결과의 알림 설명에는 이름과
수익률만 남는다.
