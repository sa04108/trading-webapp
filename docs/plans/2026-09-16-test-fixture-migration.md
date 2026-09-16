# 테스트 fixture 전환 구현·검증 인계서

- 작성일: 2026-09-16
- 기준 코드: `7d7720c` (`test: bind backtest apps to scoped fixtures`)
- 선행 변경: `b9c55f5`의 결과 처리 종료 계약, `7d7720c`의 테스트 앱 helper와 초기 fixture
- 상태: 구현 완료. 아래 체크리스트와 제10절에 2026-09-16 검증 결과를 기록했다.
- 대상: 이전 대화를 보지 않은 구현 담당 모델. 아래 단계와 파일 목록을 모두 처리하고 검증 증거를 남긴다.
- 관련 문서: [결과 import 종료 계약 계획 및 이전 구현 기록](2026-09-16-test-isolation-and-result-shutdown.md)

## 1. 목표와 완료 범위

앱을 사용하는 테스트가 앱·DB·agent·가변 seed·fake HTTP 서버의 소유권을 테스트 한 개 안에서 완결하도록 전환한다. 로그인, seed, assertion, timeout 중 어디에서 실패하더라도 이미 획득한 자원을 회수해야 한다. 제출이나 미리보기의 실제 응답을 숨기는 `app.inject` 교체도 제거한다.

이번 완료 범위는 제8절에 나열한 41개 전환 대상 파일과 공통 helper다. 일반 테스트 40개 파일과 별도 설정으로 실행하는 패키지 검사 1개 파일을 포함한다. `tests/unit/test-app-helper.test.ts`는 앱 생성·종료 자체를 검증하므로 직접 생성 API를 사용하는 의도적인 예외다. 이 예외까지 합친 현재 직접 호출 파일 수가 42개다.

`beforeEach`/`afterEach` 사용 자체는 결함이 아니다. 여기서는 반복되는 자원 소유권과 의존 순서를 fixture로 통일한다. 테스트 이름·검증 대상·의도적인 데이터 결손·실제 worker 실행 경계는 보존한다. 일부 파일을 옮긴 상태를 전체 전환 완료로 보고하지 않는다.

기본 변경 범위는 `tests/`와 이 문서의 진행표다. 결과 import 종료 API, DB schema, 제품의 준비·계산 정책을 다시 설계하지 않는다. 전환 중 별도 제품 lifecycle 결함이 확인되면 재현과 필요한 수정 범위를 기록하고 독립 변경으로 다룬다. fixture에서 예외를 삼켜 통과시키지 않는다.

## 2. 시작 상태와 반드시 알아야 할 차이

### 2.1 이미 존재하는 기반

- [test-app.ts](../../tests/helpers/test-app.ts)의 `createTestApp(env, configure, agentPreparation)`는 호출마다 별도 임시 디렉터리를 만들고, 설정·서버 생성 실패를 정리하며, 중복 `close()`를 같은 Promise로 처리한다.
- [test-fixtures.ts](../../tests/helpers/test-fixtures.ts)의 `test`는 기본 옵션 앱만 제공하는 test-scoped `ctx` fixture다. 기존 파일을 확장하며 새로운 대체 fixture 체계를 병설하지 않는다.
- [backtest-universe-rule-run.test.ts](../../tests/integration/backtest-universe-rule-run.test.ts)의 worker/clone 시나리오 두 개만 fixture를 사용한다. 나머지 describe는 전역 `ctx`와 hook을 쓴다.
- 위 파일의 worker 테스트는 명시적 `prepareSubmission()`도 호출하지만, 여전히 `installPreparedSubmissionFixture()`가 `app.inject`를 교체한다. 이 두 사례도 자동 wrapper 제거 대상이다.
- 선행 작업에서 전체 `185 files / 2076 tests`, lint/typecheck, 문제 파일의 shuffle seed `20260916`, `20260917`가 통과했다고 기록되어 있다. 이는 이전 변경의 검증 기록이며 이번 전환의 검증을 대신하지 않는다.

### 2.2 실제로 발견된 정리 취약 패턴

| 패턴 | 확인한 사례 | 전환 시 처리 |
| --- | --- | --- |
| assertion 뒤에서만 `close`/`teardown` | `symbol-master-service.test.ts`, `symbol-master-market-caps.test.ts` 등 | fixture `finally`로 옮겨 assertion 실패에도 실행 |
| 여러 자원을 얻은 뒤에야 정리 목록에 등록 | `symbol-master-routes.test.ts`의 `openCtxs` | fake 서버·앱을 각각 획득한 시점부터 소유; 전역 배열 제거 |
| 파일 전역 변수를 helper가 암묵 참조 | `local-agent-fallback.test.ts`의 `connect`/`finished`, `native-agent-preparation.test.ts`의 `seed` | `ctx` 및 필요한 상태를 매개변수로 전달 |
| 앱 생성 후 login/seed 실패 시 취약 | 여러 `beforeEach` 또는 `setup()` | `ctx → 로그인 → seed` 의존 fixture로 분리 |
| `afterEach`에서 전역 mock 복원 | `agent-coordinator.test.ts`, `local-agent-fallback.test.ts` | 앱 정리 이후 복원하도록 명시적 의존 관계로 이동 |
| 테스트 도중 앱 교체 | preparation SSE 종료 테스트 | 해당 사례의 설정 fixture 또는 별도 앱 소유 fixture 사용 |
| 파일 전체가 child·앱을 공유 | `packaged-agent-runtime.check.ts` | 실행 자원은 테스트별로 생성·종료; 패키지 읽기 데이터만 공유 가능 |

Vitest 4.1.10의 설치된 runner는 일반 `afterEach` 실행 후 fixture 정리를 수행한다. 기존 `afterEach(() => vi.restoreAllMocks())`를 남겨두고 `ctx.close()`만 fixture로 옮기면 종료 중 사용하는 mock이 먼저 복원될 수 있다. fixture 전환에서 반드시 검토할 순서다.

### 2.3 세 가지 자동 inject wrapper는 서로 다르다

| 구현 위치 | 숨은 동작 | 추출할 역할 |
| --- | --- | --- |
| `tests/helpers/test-app.ts`의 `installPreparedSubmissionFixture` | 제출·clone의 409 뒤 준비/재요청; clone-draft 조회; master coverage 삽입; AsyncLocalStorage로 요청 기간을 한정한 봉 coverage 보정; DART 대체 | 외부 sync 대체, 명시적 sparse coverage fixture, 명시적 준비, 원래 제출·clone 요청 |
| `backtest-universe-rule-run.test.ts` 내부 동명 함수 | 제출 409 뒤 준비/재요청; DART 대체; 공통 helper의 sparse coverage 보정은 없음 | DART 대체와 명시적 준비; 기존 실제 봉 검증 유지 |
| `backtest-universe-preview.test.ts`의 `installPreparedPreviewFixture` | strategy/parameters 기본값 삽입; 202 완료 대기 후 재요청; 시장 sync no-op; 모든 종목이 빈 경우 날짜 coverage 가정 | 요청 builder, preview 준비, 명시적 preview 전용 외부/coverage fixture |

두 submission 함수의 이름이 같다는 이유로 합치지 않는다. preview wrapper도 이번 제거 범위다. 공통 helper의 기존 호출 파일은 `job-queue`, `backtest-facts-worker`, `backtest-split-alignment`, `preparation-reference-lifecycle` 네 개다.

## 3. 고정할 구현 규칙

1. 앱·DB·agent·fake HTTP 서버·가변 clock·가변 seed는 test scope다. 앱을 file/worker scope로 캐시하지 않는다.
2. 첫 자원 획득 직후부터 cleanup을 보장한다. 뒤이어 login/seed/두 번째 앱 생성이 실패해도 앞선 자원은 정리한다.
3. 정상 앱 정리는 `await ctx.close()`를 사용한다. DB를 직접 닫거나 임시 디렉터리를 먼저 삭제하지 않는다.
4. 모든 시작한 비동기 작업을 기다리거나 취소하고 정리한다. DB의 `COMPLETED` 행만 보고 자원 정리가 끝났다고 판단하지 않는다.
5. fixture callback의 첫 매개변수는 객체 구조 분해다. 의존성이 없어도 `async ({}, use)`를 사용한다. `_fixtures` 같은 식별자 매개변수는 이 버전에서 `FixtureParseError`를 만든다. 기존의 한 줄 `no-empty-pattern` 예외를 유지할 수 있다.
6. `test.extend` 객체 문법을 유지한다. 이번 전환에 Vitest 업그레이드나 builder 문법 재전환을 섞지 않는다. Playwright의 `test.use`나 `{ option: true }`를 그대로 가져오지 않는다.
7. 앱 사용자/로그인/seed는 필요할 때만 생성한다. 인증·TOTP·미인증 API를 검증하는 파일에 기본 로그인 fixture를 강제하지 않는다.
8. 가변 데이터는 fixture 안에서 factory로 만든다. 파일 상수 request를 테스트가 변경해야 한다면 각 테스트에서 새 객체를 생성한다.
9. cleanup 실패도 테스트 실패다. 여러 cleanup 결과를 `allSettled`로 모았다면 rejection을 확인해 보고한다. 원래 테스트 오류를 단순 cleanup 오류로 가리지 않도록 `cause`/`AggregateError`로 함께 남긴다.
10. 파일별 병렬 실행과 기존 `forks` pool을 유지한다. 전역 순차화, timeout 일괄 확대, 무조건 retry, unhandled error 무시, 전체 `.concurrent` 전환을 완료 수단으로 쓰지 않는다.

## 4. 공통 fixture와 helper의 목표 API

아래 이름과 책임을 기준으로 구현한다. 타입의 세부 표현은 설치된 Vitest 4.1.10과 `pnpm typecheck`에 맞춘다. 공통 fixture에는 업무별 seed를 넣지 않는다.

### 4.1 앱 설정과 `ctx`

`tests/helpers/test-fixtures.ts`에서 다음 타입과 fixture를 제공한다.

```ts
interface TestAppOptions {
  readonly env?: Readonly<Record<string, string>>;
  readonly configure?: (app: FastifyInstance) => void;
  readonly agentPreparation?: boolean;
}

interface AppFixtures {
  appOptions: TestAppOptions;
  ctx: TestApp;
}
```

- `appOptions` 기본값은 빈 객체, `ctx`는 해당 옵션으로 `createTestApp({...env}, configure, agentPreparation ?? false)`를 호출한다.
- 기본 fixture는 지금처럼 `try { await use(ctx) } finally { await ctx.close() }`로 소유권을 가진다.
- `appOptions`는 fixture 확장으로 바꾼다. 예: `test.extend({ appOptions: { agentPreparation: true } })`, `MAX_QUEUED_BACKTESTS: '3'`, `configure`를 통한 ready 이전 라우트 등록.
- 동적인 fake 서버 URL은 `appOptions: async ({ krx }, use) => { await use({ env: { KRX_BASE_URL: krx.baseUrl, ... } }); }`처럼 fixture 의존성으로 전달한다. 파일 전역 변수로 우회하지 않는다.
- 환경 옵션에 공용 `DATABASE_PATH`, `DATA_ROOT`, `TEMP_ROOT` 등을 지정해 서로 같은 경로를 쓰게 하지 않는다. 경로 변경 검증이 필요하면 해당 테스트의 임시 루트 아래에 둔다.
- `createTestApp`의 기존 positional API를 지금 당장 깨지 않는다. 호출부를 fixture로 옮긴 뒤에도 helper 자체 검증은 이 API를 쓴다.

### 4.2 로그인과 시나리오 상태

기본 앱 fixture에서 파생한 `authenticatedTest`를 같은 파일에 제공하고, `admin`과 `cookie`를 `ctx`에 의존시킨다. `createTestAdmin`의 기본 계정 생성과 실제 `/api/v1/auth/login` 호출을 사용한다. 로그인 상태와 session cookie 누락은 원인을 명확히 보고한다.

인증 자체를 검증하는 파일은 기본 `test`를 사용하고 테스트 본문에서 계정을 만든다. 별도 계정·TOTP가 필요한 사례에 일반 `cookie`를 먼저 생성하지 않는다.

각 파일의 기존 beforeEach seed는 `scenario` fixture로 옮긴다. 예를 들어 `{ ctx, cookie } → scenario: { dailyCandles, request }`처럼 실제 필요한 값을 반환한다. 기존 `ctx`, `cookie`, `dailyCandles` 파일 전역 `let`은 삭제한다. 테스트 본문은 `async ({ ctx, cookie, scenario, signal })`로 필요한 값만 받는다.

fixture를 사용하는 테스트는 확장된 `test`를 import한다. `it` 이름을 유지한다면 `import { test as it } from '../helpers/test-fixtures.js'`처럼 같은 API를 별칭으로 사용한다. Vitest 기본 `it`에 fixture context만 추가해서는 fixture가 등록되지 않는다. `.each` 등 파라미터화 사례는 데이터 인자와 context 전달 규칙을 설치 버전에서 확인하고, 기존 사례 수와 이름을 보존한다.

### 4.3 추가 앱과 테스트 도중 종료

대부분의 사례는 `appOptions`만 바꾸면 된다. `job-queue.test.ts`의 대기열 상한 검사는 작은 앱 전용 파생 fixture로 바꿔, 사용하지 않는 기본 앱까지 생성하지 않는다.

한 테스트 안에서 정말 두 앱이 필요한 경우에는 별도 `apps` fixture가 앱 factory와 그 테스트에서 만든 앱 목록을 소유하게 한다. 반환된 앱은 login/seed 전에 즉시 목록에 등록한다. fixture 종료 중에는 새 생성을 거부하고, 이미 시작한 생성 Promise도 정리한 후 모든 앱의 close 결과를 검사한다. 이 factory는 일반 `ctx`와 소유권을 겹치게 하지 않는다.

종료 동작을 검증하는 테스트는 본문에서 `await ctx.close()` 또는 `await ctx.app.close()`를 호출할 수 있다. 마지막 fixture cleanup은 idempotent close를 재호출한다. 정리 gate와 socket은 본문의 `try/finally`에서 풀어 fixture close가 영원히 기다리지 않게 한다.

### 4.4 KRX 서버·mock·별도 runner의 종료 순서

필요한 파일에서 재사용할 `tests/helpers/krx-test-fixtures.ts`를 추가한다. 다음 의존 관계를 유지한다.

```text
krx fake 서버 → appOptions → ctx → 서비스/seed/시나리오
정리 순서: 실행 작업 → ctx.close → krx.close
```

fake 서버 생성 중 실패하면 생성 함수 내부에서 이미 만든 서버를 정리한다. `startKrxFakeServer()`도 이 부분을 점검한다. fake 서버의 응답 테이블·요청 기록은 테스트마다 새로 만든다.

모듈 mock을 앱보다 먼저 설치해야 하면 그 mock fixture가 `appOptions`의 의존성이 되도록 만든다. 그러면 역순 정리에서 앱이 먼저 닫힌다. 특정 `ctx` 메서드를 바꾸는 시나리오 fixture는 자신의 `finally`에서 `ctx.close()` 완료 후 개별 spy를 복원해도 된다. 기본 ctx의 두 번째 close는 안전하다. 의존 관계를 막연한 전역 `restoreAllMocks`에 맡기지 않는다.

`symbol-master-backfill.test.ts`가 직접 만드는 `SymbolMasterBackfill`은 앱 container 소유가 아니다. 현재 `stop()`은 동기적인 중단 요청일 뿐이다. 테스트 fixture가 생성한 runner를 모두 추적하고 gate를 해제한 뒤 `stop()`과 제한시간 있는 `state !== 'RUNNING'` 확인을 수행한 다음 DB와 fake 서버를 닫는다. 종료 대기 실패를 무시하지 않는다. 실제 완료를 보장할 수 없는 경우 파일을 완료 처리하지 말고 필요한 lifecycle 수정 근거를 남긴다.

### 4.5 취소 가능한 대기

`tests/helpers/wait-for-condition.ts`에 다음 계약의 작은 helper를 추가하고, 전환 대상의 DB polling loop에 적용한다.

```ts
interface WaitOptions<T> {
  readonly signal: AbortSignal;
  readonly timeoutMs: number;
  readonly intervalMs?: number;
  readonly label: string;
  readonly describe?: (lastValue: T) => unknown;
}

declare function waitForCondition<T>(
  read: () => T,
  done: (value: T) => boolean,
  options: WaitOptions<T>,
): Promise<T>;
```

- 처음과 매 polling 시점의 DB 읽기 전에 signal을 확인한다. signal이 이미 취소됐다면 DB를 읽지 않는다.
- 대기는 abort 가능한 timer를 사용하고 listener/timer를 항상 해제한다. signal이 취소돼도 기존 loop가 남아 다시 DB를 읽어서는 안 된다.
- timeout에는 label, 마지막 상태, 실제 경과시간을 포함한다. 준비 작업에는 id/status/phase/progress/error를 넣고 token 원문은 남기지 않는다.
- `read`는 동기 조회로 제한한다. 비동기 I/O 취소는 해당 작업의 AbortSignal 계약으로 처리한다.
- cleanup에는 이미 취소된 테스트 signal을 재사용하지 않는다. cleanup은 별도 제한시간으로 실행한다.
- 기존 preparation 기본 5초와 `job-queue`의 명시적 15초 예산, worker별 긴 실행 예산을 보존한다. 통합 테스트는 real timer를 유지한다.
- `waitForPreparationFixture`를 옮기거나 래핑하되 모든 호출을 함께 갱신하고, 현재 timeout 진단 정보를 잃지 않는다.

## 5. 자동 preparation wrapper 제거

신규 `tests/helpers/backtest-preparation.ts`에 명시적 준비 helper를 둔다. 외부 sync/coverage 대역은 별도 `tests/helpers/backtest-preparation-stubs.ts`에 둬서 호출자가 의도를 선택하게 한다.

### 5.1 준비 helper 계약

```ts
declare function prepareSubmission(
  ctx: TestApp,
  cookie: string,
  input: PreparationInput,
  options: { signal: AbortSignal; timeoutMs?: number },
): Promise<{ preparationJobId: string; preview: BacktestUniversePreview }>;
```

1. 원래 `app.inject`로 `/api/v1/backtests/universe-preview`를 호출한다.
2. 200이면 준비 결과를 검증해 반환한다. 202이면 job id를 얻고 완료·실패·취소를 기다린다. 그 외 응답은 status/body를 포함해 즉시 실패한다.
3. FAILED/CANCELLED는 성공으로 삼키지 않는다. job 진단을 넣어 실패시킨다.
4. 완료 뒤 동일 사용자 cookie로 preview를 한 번 더 호출해 200과 준비 결과 참조를 확인한다. 이 호출이 wizard 참조 연결을 보장한다.
5. helper는 제출·clone을 실행하거나 재시도하지 않는다. DB coverage 삽입, fact 수정, 입력 strategy 기본값 삽입도 하지 않는다.

사용 패턴은 `await prepareSubmission(...) → 필요하면 고의적 데이터 훼손 → 원래 app.inject 제출/clone → 실제 응답 assertion`이다. 훼손 이후 helper를 다시 불러 복구하지 않는다.

### 5.2 fixture 의미를 보존하는 세 가지 준비 프로필

대체 동작은 다음처럼 이름과 사용처를 명시한다. 정확한 함수 이름은 이 의도가 드러나도록 유지한다.

- `installEmptyDartSyncStub(ctx)`: 요청한 연도를 실제 coverage store에 기록하는 기존 금융·자본변동 sync 대체. 자체 fact 생성이나 봉 coverage 보정은 하지 않는다. 앱을 닫은 뒤 실행할 복원 함수를 반환한다.
- `withSparseQueuePreparation(ctx, input, operation)`: queue 이후 검증에 쓰던 공통 helper의 기간 한정 봉 coverage 가정과 master coverage seed를 명시적으로 재현한다. 전체 테스트 앱에 상시 적용하지 않는다. 준비와 READY preview 재조회가 끝나는 범위에만 기존 AsyncLocalStorage 또는 동등한 요청 기간 격리를 적용한다. 다음 실제 제출/worker 검사는 원래 coverage로 돌아가야 한다.
- `installPreviewShapeStubs(ctx)`: preview 모양 검증에만 쓰는 시장 sync no-op 및 모든 종목이 빈 경우의 coverage 가정. 하나라도 실제 봉이 있으면 기존 실제 조회 결과를 유지한다. 가격 결손·실제 수집·준비 gate 검증에는 설치하지 않는다.

이번 전환에서 sparse coverage 가정을 완전히 없애기 위해 수십 년 일봉을 추가하는 작업까지 섞지 않는다. 기존 가정을 명시적으로 격리하고 테스트로 보호한다. 그 가정을 strict coverage 시나리오에 확산시키지 않는 것이 중요하다.

전용 요청 builder에서 기존 preview의 `strategyId: 'range-breakout'`, `parameters: {}` 기본값을 만든다. 유효성 검사 테스트에는 이 builder가 잘못된 입력을 자동 보정하지 않게 한다.

### 5.3 호출부 판정표

| 테스트의 관측 대상 | 전환 방법 |
| --- | --- |
| 정상 제출·worker 실행 | seed/stub → 명시적 준비 → 원래 제출 201 → 필요할 때만 agent 시작 |
| 준비 전 409 | 준비 helper 없이 요청하고 `PREPARATION_REQUIRED` 및 무변경 확인 |
| 미인증·잘못된 요청·없는 job | 준비 없이 원래 401/400/404 검증 |
| clone의 준비 전후 | 원래 clone 409 → clone-draft 또는 원본에서 얻은 동일 요청으로 명시적 준비 → 원래 clone 201 |
| 정상 clone 결과만 검증 | clone-draft 요청을 본문에서 명시하고 같은 입력을 준비한 뒤 clone |
| coverage drift·identity mismatch | 정상 준비 → 데이터 삭제/교체 → 원래 요청; 재준비 금지 |
| preview 내용만 검증 | 명시적 `prepareSubmission` 결과 또는 준비 후 원래 preview 응답 검증 |
| preview의 최초 202·재사용·오류 | 각 API 요청과 상태 전환을 본문에서 직접 검증; 완료를 가리는 helper 금지 |
| 큐 상한·취소·재전송 | 필요한 준비만 사전에 한 번 완료; enqueue 개수·attempt·checksum 계약 유지 |

준비 API가 실패해야 하는 사례를 성공 준비 helper로 감싸지 않는다. helper 도입 때문에 assertion을 삭제하거나 기존 409/422를 201/200으로 바꾸지 않는다.

모든 호출부가 바뀐 뒤 세 wrapper와 불필요한 import를 삭제한다. 완료 시 `app.inject = ...`가 전환 대상에 없어야 한다.

## 6. 구현 순서와 모델별 작업 단위

한 단위는 아래 종료 조건까지 구현·검증한 뒤 커밋한다. 다음 단위는 이전 단위의 API를 사용한다. 여러 모델에 배분하더라도 공통 helper를 동시에 수정하지 않는다. 별도 작업을 배분할 때는 이 문서와 합의된 기준 커밋, 담당 파일, 검증 명령을 같이 전달한다.

### P0. 기준선과 대상 고정

- 저장소 `AGENTS.md`, 현재 status/worktree/log를 확인한다. 새 독립 작업은 최신 main을 기준으로 하되 선행 커밋 두 개가 포함됐는지 확인한다. main에 아직 없으면 `7d7720c` 또는 이를 포함한 관련 브랜치를 기준으로 후속 브랜치를 만든다.
- 제8절 42개 목록과 실제 `rg` 결과를 비교한다. 새 파일이 있으면 유형과 검증을 진행표에 추가한다.
- 대상별 테스트 이름/수, timeout, fake 서버, agentPreparation 옵션, 수동 종료 검증을 기록한다.
- 기준 검증에 실패하면 명령과 오류를 기록하고 전환 때문에 생긴 실패와 구분한다.

### P1. 공통 fixture·대기·준비 API

- 제4·5절 helper를 구현하고 작은 파일 두 개(`security-headers`, `compression`)를 pilot로 전환한다.
- 테스트별 옵션, configure-before-ready, 선택적 로그인, setup 실패 cleanup, signal 취소를 검증한다.
- 기존 wrapper 호출 파일은 아직 그대로 동작하게 한다. 새 helper의 사용 예를 pilot 또는 전용 테스트에 남긴다.
- 종료 조건: fixture helper 검증, pilot 두 파일, lint/typecheck 통과. 사용하지 않는 추상화만 추가한 상태로 끝내지 않는다.

### P2. 제출·미리보기·worker 파일 6개

- 제8절 A 묶음을 전환한다. 우선 문제 파일의 나머지 describe와 이미 옮긴 두 사례의 wrapper 의존을 제거한다.
- `job-queue`의 15초 준비 예산, 작은 큐 옵션 앱, clone-draft, coverage drift 사례를 각각 보존한다.
- `preparation-reference-lifecycle`의 참조 교체·삭제·강제 enqueue 실패를 준비 helper가 복구하지 않도록 순서를 확인한다.
- `backtest-universe-preview`의 세부 profile을 유지하고 원래 202/200을 명시한다.
- 종료 조건: 각 파일 전체 통과, 제5절 준비 프로필 회귀 통과, 세 wrapper 제거, 문제 파일 shuffle 두 seed 통과.

### P3. 실제 agent·coordinator 파일 3개

- 제8절 B 묶음의 `agentPreparation: true`를 보존한다. 로컬 fallback/원격 worker를 inline 준비로 바꿔 통과시키지 않는다.
- `connect(ctx, ...)`, `finished(ctx, jobId, options)`, `seed(ctx)` 등으로 암묵 전역 참조를 제거한다.
- `localAvailable` 등 변경 가능한 mock 상태도 테스트마다 생성한다. 앱 stop이 끝난 후에 mock을 복원한다.
- native child를 직접 만드는 helper는 close Promise, timeout timer, listener, signal을 소유한다. 테스트 실패·취소 시 child 종료를 확인하고 그 뒤 child가 쓰는 파일을 지운다.
- deferred gate를 사용하는 종료 테스트는 assertion 실패 시에도 `finally`에서 gate를 해제한다.
- 종료 조건: B 묶음과 기존 result lifecycle 회귀 통과, 정상/실패/취소 때 외부 작업이 남지 않음.

### P4. fake KRX 조합 파일 11개

- 제8절 C 묶음을 전환한다. `setup()`/`teardown()`과 `openCtxs`를 자원별 fixture로 바꾼다.
- `MutableClock`, 서비스 대역, fake 요청 기록은 test scope로 만든다. clock 값을 바꾸는 기존 assertion을 보존한다.
- 직접 시작한 backfill runner의 종료를 fake 서버와 DB보다 먼저 기다린다.
- 종료 조건: 모든 C 파일 통과, fake 서버 이후 앱 생성 실패와 login/seed 실패 cleanup 검증 통과.

### P5. 일반 앱 테스트 파일 20개

- 제8절 D 묶음을 전환한다. pilot 두 파일은 이미 완료된 상태이므로 다시 작성하지 않는다.
- `auth`는 기본 앱 fixture만 사용한다. 세션·TOTP 의미를 보존한다.
- `backtest-preparation`의 SSE 테스트는 HTTP stream/구독/gate를 모두 소유하고, configure가 필요한 사례에 전용 옵션을 준다.
- 나머지 DB 테스트는 본문 마지막 close를 fixture로 옮기고 helper 함수가 ctx를 명시적으로 받게 한다.
- 종료 조건: D 파일 전체 통과, 테스트 scope 밖 가변 앱·DB 참조 없음.

### P6. 패키지 검사 1개

- 제8절 E 파일은 기본 `pnpm test`에 포함되지 않는다. 별도 실행·검증한다.
- 앱·실행 child·state 디렉터리·output·childExited는 test scope다. 패키지 archive metadata처럼 읽기 전용인 값만 file scope로 남길 수 있다.
- `packageFiles(packageRoot)`처럼 경로를 명시적으로 전달한다. 읽기 검사와 실행 검사 각각 단독으로 실행 가능해야 한다.
- 압축 해제 디렉터리를 file scope로 공유하면 불변임을 보장하고 생성 도중 실패 cleanup도 제공한다. mutable state/bootstrap은 별도 테스트별 디렉터리에 둔다.
- bundled Node, compiled agent, 격리된 PATH/cwd/env, 패키지 내용 검사는 유지한다.
- 종료 조건: 현재 소스의 패키지를 빌드하고 전용 config로 두 사례 전체와 각 단독 실행 통과. 산출물이 없어서 실행하지 못했으면 P6는 미완료로 남긴다.

### P7. 전체 검증과 인계

- 제9절 최종 게이트와 정적 감사를 수행한다. 제8절을 빠짐없이 완료/예외/미완료로 갱신한다.
- 남은 직접 생성은 helper 구현 및 helper lifecycle 테스트 등 설명된 예외만 허용한다.
- 검사 결과·미해결 사항·커밋/푸시를 제10절 양식으로 기록한다. 단위 일부만 완료한 경우 전체 완료라고 쓰지 않는다.

## 7. 추가할 검증 시나리오

helper의 실제 자원 소유권을 검증한다. fixture 내부 함수가 호출됐다는 mock assertion만으로 충분하다고 보지 않는다. 가능하면 좁은 helper를 직접 실행해 setup/body 실패를 주입하고, 모든 자원 관측을 같은 테스트 안에서 마친다. 실패 테스트가 남긴 파일을 다음 테스트가 확인·삭제하게 만들지 않는다.

| 시나리오 | 필수 증거 |
| --- | --- |
| login/seed가 throw | 이미 만든 앱의 DB close와 임시 디렉터리 정리 확인; 원래 오류 보존 |
| fake 서버 다음 앱 setup 실패 | 실제 listening 서버 종료 및 임시 앱 디렉터리 정리 |
| 두 번째 앱 생성 실패 | 첫 앱도 정리; 자원 등록이 login/seed보다 먼저 이루어짐 |
| 앱 두 개의 독립성 | 서로 다른 운영/계산 DB 경로·디렉터리; A 종료 뒤 B 쿼리 정상 |
| signal 선취소/대기 중 취소 | 취소 뒤 DB read 없음; 대기 Promise reject; timer/listener 회수 |
| cleanup 실패 | 실패가 상위로 전달되고 독립 자원 cleanup도 시도; 살아 있는 소비자의 파일은 보존 |
| mock 유지 순서 | 종료 callback이 필요한 대역을 여전히 사용하고, close 후 복원됨 |
| preparation 실패·취소 | 성공 preview나 제출로 자동 복구하지 않음; 진단 포함 |
| sparse queue profile | 미래 봉이 과거의 빈 기간을 covered로 만들지 않음; 범위 종료 뒤 실제 coverage 복원 |
| preview shape profile | 전부 빈 fixture의 기존 가정 보존; 실제 봉이 하나라도 있으면 실제 결손 검증 유지 |
| 준비 후 coverage/identity 훼손 | 기존 거부와 무변경 assertion 유지; helper가 다시 준비하지 않음 |
| 실제 child 실행 중 실패/취소 | gate 해제와 child close를 확인한 뒤 앱/파일 정리 |

권장 신규 파일은 `tests/unit/test-fixtures.test.ts`, `tests/unit/wait-for-condition.test.ts`, `tests/unit/backtest-preparation-fixtures.test.ts`다. 기존 helper/lifecycle 테스트와 중복되는 증거는 재사용한다. 강제 실패를 검증하려고 정상 suite에 실제 failing test를 남기지 않는다.

## 8. 파일별 전환 체크리스트

기준 커밋의 `rg -l 'createTestApp\(' tests/unit tests/integration` 결과 전체다. 아래 파일은 확장자까지 실제 경로이며, 해당 단위 검증 명령의 인자로 그대로 사용할 수 있다.

### A. P2 — 준비 wrapper와 실행 회귀 (6개)

- [x] `tests/integration/backtest-universe-rule-run.test.ts`
- [x] `tests/integration/job-queue.test.ts`
- [x] `tests/integration/backtest-facts-worker.test.ts`
- [x] `tests/integration/backtest-split-alignment.test.ts`
- [x] `tests/integration/preparation-reference-lifecycle.test.ts`
- [x] `tests/integration/backtest-universe-preview.test.ts`

### B. P3 — 실제 agent와 종료 (3개)

- [x] `tests/unit/agent-coordinator.test.ts`
- [x] `tests/integration/local-agent-fallback.test.ts`
- [x] `tests/integration/native-agent-preparation.test.ts`

### C. P4 — fake KRX와 조합 자원 (11개)

- [x] `tests/integration/symbol-master-routes.test.ts`
- [x] `tests/unit/symbol-master-backfill.test.ts`
- [x] `tests/unit/symbol-master-daily-bars.test.ts`
- [x] `tests/unit/symbol-master-ensure-trading-day.test.ts`
- [x] `tests/unit/symbol-master-ingest.test.ts`
- [x] `tests/unit/symbol-master-market-caps.test.ts`
- [x] `tests/unit/symbol-master-non-trading.test.ts`
- [x] `tests/unit/symbol-master-shares-changes.test.ts`
- [x] `tests/unit/symbol-master-trading-days.test.ts`
- [x] `tests/unit/symbol-master-version-ingest.test.ts`
- [x] `tests/unit/universe-rule-resolver.test.ts`

### D. P1 pilot 및 P5 — 일반 앱·인증·DB (20개)

- [x] `tests/unit/security-headers.test.ts` — P1 pilot
- [x] `tests/unit/compression.test.ts` — P1 pilot, configure 보존
- [x] `tests/integration/auth.test.ts`
- [x] `tests/integration/backtest-preparation.test.ts` — SSE/gate/중간 close
- [x] `tests/integration/backtest-wizard-drafts.test.ts`
- [x] `tests/integration/maintenance.test.ts`
- [x] `tests/integration/notification-routes.test.ts`
- [x] `tests/integration/notification-service.test.ts`
- [x] `tests/integration/route-surface.test.ts`
- [x] `tests/integration/symbol-info-fallback.test.ts`
- [x] `tests/unit/backtest-results-service.test.ts`
- [x] `tests/unit/candle-coverage-service.test.ts`
- [x] `tests/unit/corporate-action-coverage.test.ts`
- [x] `tests/unit/krx-daily-bars-schema.test.ts`
- [x] `tests/unit/krx-daily-candle-repository.test.ts`
- [x] `tests/unit/preparation-reference-seed-batch.test.ts`
- [x] `tests/unit/selection-metric-repository.test.ts`
- [x] `tests/unit/symbol-identity-lifetime.test.ts`
- [x] `tests/unit/symbol-master-schema.test.ts`
- [x] `tests/unit/symbol-master-service.test.ts`

### E. P6 — 전용 config (1개)

- [x] `tests/integration/packaged-agent-runtime.check.ts`

### F. 의도적인 직접 생성 예외 (1개)

- [x] `tests/unit/test-app-helper.test.ts` — factory/close 자체 검증이므로 직접 호출을 유지했고 생성 실패 cleanup 회귀를 확인했다.

`container-lifecycle`, `backtest-result-artifact-versions`처럼 `createContainer`나 DB를 직접 만들고 그 수명을 검증하는 테스트는 위 42개 전환 집계에 포함되지 않는다. fixture 문법 변경을 강제하지 않고 기존 회귀 검증으로 유지한다. 이번에 추가하는 fixture factory의 lifecycle 테스트도 필요한 직접 호출 예외를 구체적으로 기록한다.

## 9. 검증 명령과 합격 기준

### 9.1 각 작업 단위

```bash
# P1 공통 helper와 pilot
pnpm exec vitest run tests/unit/test-app-helper.test.ts tests/unit/test-fixtures.test.ts tests/unit/wait-for-condition.test.ts tests/unit/backtest-preparation-fixtures.test.ts tests/unit/security-headers.test.ts tests/unit/compression.test.ts

# P2 전체: 일부 테스트명 필터만 통과시켜 끝내지 않는다
pnpm exec vitest run tests/integration/backtest-universe-rule-run.test.ts tests/integration/job-queue.test.ts tests/integration/backtest-facts-worker.test.ts tests/integration/backtest-split-alignment.test.ts tests/integration/preparation-reference-lifecycle.test.ts tests/integration/backtest-universe-preview.test.ts

# P3 실제 agent 및 기존 종료 계약
pnpm exec vitest run tests/unit/agent-coordinator.test.ts tests/integration/local-agent-fallback.test.ts tests/integration/native-agent-preparation.test.ts tests/unit/forked-backtest-result-completer.test.ts tests/unit/backtest-lease-service-lifecycle.test.ts tests/unit/container-lifecycle.test.ts tests/unit/remote-result-upload-manager.test.ts

# 결과 저장·중복 처리 계약
pnpm exec vitest run tests/unit/backtest-result-lease.test.ts tests/unit/agent-outbox.test.ts tests/integration/backtest-result-artifact-versions.test.ts

# P4/P5: 제8절 C/D 파일을 각 묶음의 명시적 경로 목록으로 전달한다
# 모든 단위에서 수정한 파일 lint와 typecheck도 실행한다
pnpm typecheck
pnpm lint
```

파일별 변환 직후 해당 파일 전체를 단독 실행한다. 새 테스트 파일 이름을 바꿨으면 이 문서의 명령도 갱신한다. 존재하지 않는 파일을 명령에서 조용히 빼고 해당 검증이 끝났다고 쓰지 않는다.

### 9.2 순서 독립성 및 전체 게이트

```bash
# 원래 오류에 표시됐던 clone의 단독 검증
pnpm exec vitest run tests/integration/backtest-universe-rule-run.test.ts -t '복제도 동일 hash'

# 파일 내부와 파일 간 순서를 함께 바꿔 확인
pnpm exec vitest run tests/integration/backtest-universe-rule-run.test.ts tests/integration/job-queue.test.ts tests/integration/backtest-universe-preview.test.ts --sequence.shuffle --sequence.seed=20260916
pnpm exec vitest run tests/integration/backtest-universe-rule-run.test.ts tests/integration/job-queue.test.ts tests/integration/backtest-universe-preview.test.ts --sequence.shuffle --sequence.seed=20260917

# 기본 suite 최종 게이트
pnpm test
pnpm typecheck
pnpm lint
git diff --check

# 별도 패키지 검증: 기본 suite 통과가 이 검사 통과를 뜻하지 않는다
pnpm build:agent
pnpm test:agent-package
pnpm exec vitest run --config vitest.agent-package.config.ts -t '게시 checksum'
pnpm exec vitest run --config vitest.agent-package.config.ts -t '동봉 Node'
```

패키지 빌드는 생성 산출물을 만든다. 현재 build script의 환경 요구사항을 먼저 확인하고, 산출물을 소스 커밋에 포함하지 않는다. 네트워크나 플랫폼 문제로 빌드/실행이 막히면 이유와 미검증 범위를 기록한다.

합격 기준은 실행 종료 코드 0, 기존 assertion 의미 보존, 예상 밖 skip 증가/테스트 누락 없음, unhandled rejection/닫힌 SQLite 접근/남은 소유 child 없음이다. 테스트 수 변화가 있으면 새 테스트 추가와 파라미터화 변경으로 설명한다. seed와 수행한 명령을 기록한다.

### 9.3 최종 정적 감사

```bash
rg -n 'createTestApp\(' tests
rg -n 'installPreparedSubmissionFixture|installPreparedPreviewFixture' tests
rg -n 'app\.inject\s*=' tests
rg -n 'openCtxs|let\s+(ctx|testApp)\s*:' tests/unit tests/integration
rg -n 'beforeAll|afterAll|useFakeTimers|restoreAllMocks' tests/helpers tests/unit tests/integration
```

처음 네 검색의 잔여 항목은 실제 코드와 예외 목록을 대조한다. 주석 또는 다른 목적의 유효한 사례는 이유를 기록한다. 마지막 검색은 자동 실패 조건이 아니라 공유 자원·timer·복원 순서 검토 목록이다. `const context = await setup()` 같은 간접 생성도 파일별 diff 검토에서 놓치지 않는다.

## 10. 구현·검증 결과

- 기준 커밋은 `dc00df5`, 구현 브랜치는 `refactor/test-scoped-fixtures`다. 구현 단위는
  `f4e5469`, `b912c49`, `3a89a73`, `10db6db`, `d930229`, `c529960`에 나눠 기록했다.
- P1~P6과 제8절의 전환 대상 41개를 완료했다. 직접 생성 예외
  `tests/unit/test-app-helper.test.ts`도 factory/close 자체 검증임을 다시 확인했다.
- 직접 `createTestApp` 호출은 앱 fixture 구현 두 파일과 위 helper lifecycle 테스트에만
  남는다. 패키지 archive 해제 결과는 읽기 전용 file scope로 유지하고, 앱·child·state·
  output은 테스트 scope로 옮겼다.
- `installPreparedSubmissionFixture` 두 구현과 `installPreparedPreviewFixture`를 제거했다.
  `app.inject` 대입도 남지 않는다. 제출·clone·preview의 409/202/200 전이는 테스트가
  명시적으로 준비하고 원래 요청을 다시 보내도록 바뀌었다.
- queue/worker 시나리오의 sparse candle 가정은 `withSparseQueuePreparation`, preview
  모양 가정은 `installPreviewShapeStubs`로 이름과 적용 범위를 드러냈다. 실제 결손과
  준비 후 coverage/identity drift 테스트에서는 재준비하지 않는다.
- P2 전체는 6파일 131개, P3 lifecycle 묶음은 7파일 36개, P4는 11파일 133개,
  P5는 18파일 137개가 통과했다. 공통 helper/pilot 묶음도 21개가 통과했다.
- 원래 오류의 clone 단독 실행은 1개 통과(17개 필터 제외)했다. shuffle seed
  `20260916`, `20260917`은 각각 3파일 110개가 통과했다.
- 기본 전체 suite는 188파일 2086개가 통과했다. `pnpm typecheck`, `pnpm lint`,
  `git diff --check`도 종료 코드 0이었다.
- `pnpm build:agent`로 `linux-x64` 패키지를 현재 소스에서 만들었다.
  `pnpm test:agent-package`는 2개 모두 통과했고, `게시 checksum`, `동봉 Node` 필터는
  각각 1개 통과·1개 필터 제외로 단독 실행됐다.
- 예상 밖 skip, unhandled rejection, 닫힌 SQLite 접근, 종료 뒤 남은 소유 child는
  관측되지 않았다. preparation 실패, 강제 enqueue 실패, 종료 중 503 로그는 해당
  오류 경로를 검증하는 기존 테스트의 예상 로그였다.
- 정적 감사에서 wrapper 이름, `app.inject` 대입, `openCtxs`, 파일 전역 가변 `ctx`는
  남지 않았다. push 결과는 최종 인계 메시지에 기록한다.

## 11. API 근거

- [Vitest Test Context](https://vitest.dev/guide/test-context.html): `test.extend`, test-scoped fixture, test context의 `signal` 공식 설명. 최신 문서에는 더 새 버전 내용도 있으므로 설치 버전 확인이 우선이다.
- 기준 저장소 설치 버전: `vitest@4.1.10`, `@vitest/runner@4.1.10`.
- 로컬 확인 위치: `node_modules/.pnpm/@vitest+runner@4.1.10/node_modules/@vitest/runner/dist/tasks.d-DEYaIMIu.d.ts`의 `FixtureOptions`, `Fixtures`, `TestContext.signal` 및 같은 디렉터리 `chunk-artifact.js`의 fixture cleanup 순서. 재설치로 파일명이 달라지면 `rg`로 해당 심볼을 찾는다.
- 실행 범위: [기본 Vitest 설정](../../vitest.config.ts), [패키지 검사 설정](../../vitest.agent-package.config.ts). 기본 timeout/hookTimeout은 각각 30초이고 패키지 검사 testTimeout은 120초다.
