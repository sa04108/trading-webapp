# 테스트 독립성과 결과 import 종료 계약 구현 계획

- 작성일: 2026-09-16
- 조사 기준: `c36e570` (`feat: expose agent and preparation progress`)
- 상태: 핵심 종료 계약과 문제 시나리오의 test-scoped fixture 구현·검증 완료. 나머지 앱 테스트의 fixture 전환은 아래 진행 기록에 남겼다.
- 목적: 다음 구현 담당자가 기존 대화를 읽지 않아도 문제, 변경 범위, 구현 순서, 검증 기준을 이해할 수 있게 한다.

## 1. 사용자 목표와 범위

각 테스트는 자신의 데이터와 실행 자원을 소유하고, 성공·실패·취소 후에도 자기 teardown 안에서 작업을 정리해야 한다. 다른 테스트의 실행 순서나 종료 처리가 이전 테스트의 자원을 대신 회수해서는 안 된다. Vitest의 공식 fixture 관례를 사용하되, 실제 애플리케이션의 종료 계약부터 완성한다.

구현 범위는 다음 세 단계다.

1. 결과 import와 관련 HTTP·agent 작업의 종료 계약 및 회귀 테스트.
2. 공통 테스트 앱의 생성·정리 보강과 문제 테스트의 test-scoped fixture 전환.
3. 나머지 앱 사용 테스트의 단계적 전환 및 숨은 preparation 동작의 명시화.

계산 결과, 준비 완료 조건, lease 유효성 검사, artifact 검증 의미는 보존한다. DB schema 변경은 현재 계획에 필요하지 않다. 진행률 기능은 유지한다.

작업 시 저장소의 [AGENTS.md](../../AGENTS.md)를 따른다. 새 주석과 docstring은 한국어로 작성하고, 작업 브랜치와 기존 변경 상태를 확인한다. 단위별 검증이 끝난 변경만 커밋한다.

## 2. 조사 결과와 증거의 한계

### 2.1 보고된 오류

```text
TypeError: The database connection is not open
  Database.prepare
  JobQueue.updateLeaseActivity                     job-queue.ts:304
  ForkedBacktestResultCompleter.onProgress          container.ts:398
  ChildProcess.<anonymous>                         forked-backtest-result-completer.ts:81
```

Vitest가 마지막 테스트로 표시한 항목:

```text
tests/integration/backtest-universe-rule-run.test.ts
복제도 동일 hash 준비 완료 전에는 409이고 완료 뒤 unionSymbols 를 등록한다(Task 6)
```

해당 표시는 비동기 예외가 관측된 시점의 테스트 정보다. 그 테스트가 예외를 만든 작업의 소유자라는 증거는 아니다.

### 2.2 확인된 사실

- `c36e570`에서 [backtest-result-import-child.ts](../../src/workers/backtest-result-import-child.ts)의 `VALIDATING_RESULT` 전송(조사 당시 73행)과 `IMPORTING_RESULT` 전송이 추가됐다.
- 같은 커밋에서 부모 completer의 progress 수신과 container의 `updateLeaseActivity()` 호출이 추가됐다. 보고된 stack과 일치한다.
- [test-app.ts](../../tests/helpers/test-app.ts)의 `createTestApp()`는 호출마다 `mkdtempSync()`로 별도 디렉터리와 DB를 만든다.
- 위 clone 테스트는 `startAgent()`를 호출하지 않는다. 같은 파일의 worker 실행 테스트들은 호출한다.
- [job-queue.ts](../../src/server/modules/backtest/application/job-queue.ts)의 `completeLeasedResult()`는 자식 프로세스의 transaction 안에서 DB 상태를 `COMPLETED`로 바꾼다. 부모 IPC 처리 및 HTTP 응답 완료와는 다른 경계다.
- [forked-backtest-result-completer.ts](../../src/server/modules/backtest/infrastructure/forked-backtest-result-completer.ts)는 `tail`로 import를 직렬화하지만 종료 API는 없다. 현재 completion Promise는 child의 `exit`에서 완료된다.
- progress listener는 `onProgress`를 직접 호출한다. 그 안의 예외는 completion Promise의 rejection으로 자동 변환되지 않는다.
- [backtest-lease-service.ts](../../src/server/modules/backtest/application/backtest-lease-service.ts)의 `complete()`는 child 완료 뒤에도 감사 기록과 이벤트 발행을 수행한다. 현재 `stop()`은 lease sweep timer만 해제한다.
- [agent-routes.ts](../../src/server/modules/agents/presentation/agent-routes.ts)의 결과 업로드는 별도 lease 갱신 timer를 만들고 `finally`에서 timer 및 임시 artifact를 정리한다.
- [agent-coordinator.ts](../../src/server/modules/agents/application/agent-coordinator.ts)의 WebSocket 메시지 `tail`은 지역 변수여서 `stop()`이 직접 기다리지 않는다.
- [container.ts](../../src/server/bootstrap/container.ts)의 `close()`는 coordinator와 preparation 종료를 기다린 뒤 DB를 닫는다. result-import child와 전체 결과 수신 작업에 대한 명시적인 대기는 없다.
- [client.ts](../../src/agent/client.ts)의 `stop()`은 원격 업로드 fetch를 abort한다. 클라이언트 fetch 종료 자체를 서버 측 import 및 후속 처리 완료로 간주할 수 없다.
- [vitest.config.ts](../../vitest.config.ts)는 `pool: 'forks'`, `testTimeout: 30_000`, `hookTimeout: 30_000`이다. 문제 파일은 concurrent 테스트를 사용하지 않는다.

### 2.3 아직 확정하지 않은 내용

테스트 간 데이터 의존성이 존재한다고 단정하지 않는다. 현재 확인된 것은 비동기 자원의 종료 추적 누락이며, 전체 테스트의 독립성 감사는 아직 하지 않았다.

이전 실행 테스트에서 남은 IPC가 clone 테스트 실행 중 관측됐을 가능성이 높지만, 어떤 이벤트 순서로 원래 오류가 발생했는지는 결정적으로 재현하지 못했다. child 시작 시점, DB commit, HTTP 연결 중단, 부모 IPC 수신 순서를 고정하는 회귀 테스트로 확인해야 한다.

조사 중 다음 명령은 `2 passed / 16 skipped`, 종료 코드 0으로 끝났다. 오류를 항상 재현하는 명령은 아니다.

```bash
pnpm exec vitest run tests/integration/backtest-universe-rule-run.test.ts -t '재무 fact가 없고 KRX 일봉만|복제도 동일 hash' --reporter=verbose
```

이 결과를 전체 파일·전체 suite 통과 또는 race 해결의 근거로 사용하지 않는다.

## 3. 완료 상태와 자원 종료를 구분하는 계약

정상적인 teardown의 최종 계약은 다음과 같다.

```text
await ctx.close() 성공
  → 이 앱이 소유한 결과 처리·메시지 처리 Promise가 모두 정리됨
  → 소유한 child가 종료되고 IPC·stream listener 및 timer가 정리됨
  → 결과 처리 후속 작업이 더 이상 DB에 접근하지 않음
  → DB가 닫힘
  → 테스트 임시 디렉터리가 삭제됨
```

- `job.status === 'COMPLETED'`는 업무 결과 확인에 사용한다. 이를 자원 종료의 증거로 사용하지 않는다.
- 작업을 큐에 넣는 것만 검증하는 테스트는 모든 job을 실행할 필요가 없다. 실행하지 않은 job 행과 실제 실행 중인 비동기 자원을 구분한다.
- 자식 프로세스가 종료된 것만으로는 부족하다. 부모의 감사 기록·이벤트와 업로드 handler의 `finally`까지 포함한다.
- `stop()`과 `close()`는 중복 호출에 안전해야 하며, 최초 호출에서 새 작업 수락을 동기적으로 막아야 한다.
- 자원 종료 실패를 성공으로 삼키지 않는다. 실패 시 남은 job/attempt, PID, 작업 종류를 보고하고, 살아 있는 작업이 쓰는 DB나 디렉터리를 먼저 제거하지 않는다. lease token 원문은 로그에 남기지 않는다.
- 독립된 정리 작업은 가능한 한 끝까지 시도하되, DB와 임시 파일을 닫거나 삭제하는 의존 순서를 지킨다. 정리 오류는 호출자에게 전달한다.

## 4. 구현 단위 A: 결과 처리 lifecycle

### A1. 먼저 결정적인 회귀 테스트 작성

신규 `tests/unit/forked-backtest-result-completer.test.ts`와 기존 [container-lifecycle.test.ts](../../tests/unit/container-lifecycle.test.ts)를 사용한다.

테스트가 제어할 경계:

1. completion 등록 후 child 시작 전.
2. `VALIDATING_RESULT` 또는 `IMPORTING_RESULT` 수신 전후.
3. DB terminal 상태 확인 후 부모 completion 완료 전.
4. child `exit` 후 `close` 및 listener 정리 전.
5. completer 완료 후 lease service의 후속 처리 완료 전.

deferred Promise와 제어 가능한 child factory 또는 테스트용 child를 사용한다. 기존 의존성 주입으로 부족한 부분에만 좁은 테스트 경계를 추가한다. 제품 child에 테스트 전용 환경변수나 sleep 분기를 넣지 않는다.

고정 시간 sleep, 임의의 microtask 횟수, 여러 번 실행해서 가끔 실패하는 것만으로 race를 검증하지 않는다. 각 테스트는 assertion이 실패해도 자신이 잠근 gate를 풀고 자신이 생성한 child를 정리해야 한다.

### A2. completer의 자원 소유권

대상:

- [forked-backtest-result-completer.ts](../../src/server/modules/backtest/infrastructure/forked-backtest-result-completer.ts)
- [backtest-result-artifact.ts](../../src/runtime/modules/backtest/application/backtest-result-artifact.ts)

구현 요구사항:

- `BacktestResultCompleter`에 기다릴 수 있는 `stop(): Promise<void>` 계약을 추가한다. 기존 port의 구현체와 테스트 대역도 함께 갱신한다.
- 수락 중·종료 중·종료 완료 상태, 등록된 요청, 실행 중 child 및 그 정리 Promise를 추적한다.
- 종료 시작 뒤 새 completion은 즉시 거부한다. 등록됐지만 아직 fork되지 않은 요청도 재시도 가능한 종료 오류로 정리하며, 종료 뒤 새 child를 만들지 않는다.
- 현재 실행 중 import는 제한시간 내 정상 완료를 우선 기다린다.
- 정상 completion의 최종 처리 경계를 `exit`에서 `close`로 옮기고, 소유한 IPC/stream listener를 정리한다. `exit`와 `close`의 차이만으로 IPC 처리까지 자동 보장된다고 가정하지 말고 늦은 callback의 무효화도 검증한다.
- spawn 실패, child `error`, 비정상 종료, 종료 신호 경합에서도 caller Promise와 자원 정리가 각각 한 번만 완료되게 한다. `error`가 항상 프로세스 종료를 뜻하지 않는다는 점을 고려한다.
- 종료 중에는 progress DB 갱신을 중단하되 완료·오류 메시지는 결과를 판정할 때까지 처리한다.
- progress callback 예외가 EventEmitter 바깥으로 그대로 던져지지 않게 한다. 보조 진행률 저장 실패는 구조화 로그로 드러내고, 결과 artifact의 성공·실패 판정과 구분한다. 광범위한 예외 무시로 누수를 감추지 않는다.

종료 정책 제안값은 `정상 종료 유예 10초 → SIGTERM 후 2초 → SIGKILL`이다. SIGKILL 전송만으로 성공 처리하지 않고 실제 종료를 확인한다. 종료 확인에도 별도 상한을 두어 실패를 보고한다. 이 값은 측정 완료된 운영 요구사항이 아니므로 구현 시작 시 서비스 관리자 종료 제한시간과 30초 test hook budget을 대조한다. 기본값·시험용 주입값·최종 종료 확인 상한을 한 정책으로 명시하고 무한 대기를 남기지 않는다.

유예시간은 종료 요청 전체에 적용한다. 대기 중인 요청마다 시간을 새로 부여해 총 종료 시간이 요청 수에 비례하게 만들지 않는다.

### A3. lease service의 전체 completion 대기

대상: [backtest-lease-service.ts](../../src/server/modules/backtest/application/backtest-lease-service.ts).

- `stop()`을 비동기 종료 계약으로 확장하고 모든 호출부에서 기다린다.
- `complete()`의 등록부터 child 결과, 감사 기록, job 이벤트 발행까지 전체 Promise를 추적한다.
- 종료 시작 시 새로운 completion을 거부하고 completer의 종료를 시작한다.
- completer 정리와 이미 시작한 service 후속 처리가 끝난 뒤에만 `stop()`을 완료한다.
- 작업 자체의 실패와 자원 정리 실패를 구분한다. 실패한 작업의 caller에는 원래 오류를 전달하되, 그 작업이 실패했다는 이유만으로 다른 자원 정리를 건너뛰지 않는다.
- 종료 중단은 artifact 불량이나 계산 실패로 처리하지 않는다. 별도의 재시도 가능한 종료 오류를 transport에서 503으로 매핑한다. 기존 오류 타입을 재사용할 때는 의미와 retry 계약이 맞는지 확인한다.
- 이미 commit된 결과의 재전송은 기존 checksum/attempt 계약으로 중복 저장을 막는다. 종료만을 이유로 성공한 결과를 FAILED로 덮어쓰지 않는다.

## 5. 구현 단위 B: HTTP·agent·container 연결

### B1. 전체 결과 수신 작업을 추적

대상:

- [agent-coordinator.ts](../../src/server/modules/agents/application/agent-coordinator.ts)
- [agent-routes.ts](../../src/server/modules/agents/presentation/agent-routes.ts)
- [remote-result-upload-manager.ts](../../src/server/modules/backtest/infrastructure/remote-result-upload-manager.ts)

coordinator에 결과 처리 작업을 등록하고 기다리는 경계(예: `runResultOperation`)를 둔다. 원격 HTTP와 로컬 agent의 결과 경로가 함께 사용한다. 등록은 첫 비동기 중단 전에 완료하고, 종료 시작 뒤 새 등록을 막는다.

추적 대상은 `complete()` 호출만이 아니라 업로드 수신, progress callback, lease 갱신 timer, 결과 import, handler의 `finally`와 artifact cleanup까지다. HTTP 연결이 끊겨도 작업의 정리 Promise는 registry에 남아 있어야 한다.

`RemoteResultUploadManager.receive()`는 종료용 `AbortSignal`을 받아 pipeline을 중단하고 생성한 파일을 정리할 수 있게 한다. shutdown signal은 전송 중인 stream을 회수하는 데 사용하고, 이미 시작한 import는 completer의 유예 정책으로 처리한다. 클라이언트 연결 중단을 이유로 이미 commit 가능한 import를 무조건 강제 종료하는 정책을 새로 만들지 않는다.

종료가 거부한 요청은 가능한 경우 503을 반환한다. 연결이 이미 닫힌 경우에도 cleanup은 완료한다. agent의 기존 2xx/409 ACK 및 retry 동작을 확인하고, 종료 중 503 때문에 outbox가 지워지지 않게 한다.

### B2. 메시지 처리와 종료 순서

- 원격 WebSocket과 로컬 transport의 실행 중 메시지 Promise를 추적한다.
- 연결 제거·교체 시에도 이미 실행 중인 handler의 추적을 잃지 않는다. 종료 시작 후 아직 실행하지 않은 메시지는 DB를 건드리지 않게 한다.
- coordinator 종료 시 신규 배정·메시지 수락·결과 수락을 먼저 중단한다.
- lease service/completer의 종료를 시작한 뒤 `localClient.stop()`을 기다린다. 로컬 client가 import를 기다리는데 import 종료 시작을 client 종료 뒤로 미루는 순환 대기를 만들지 않는다.
- 소유 child와 로컬 결과 처리가 정리된 뒤 로컬 lease 반환을 수행한다. 원격 lease는 기존 정책을 보존한다.
- 이미 시작된 dispatch, data queue, snapshot 작업과 메시지 handler의 의존 순서를 확인하고 정리한다.

### B3. container와 서버 종료 경계

대상:

- [container.ts](../../src/server/bootstrap/container.ts)
- [server.ts](../../src/server/bootstrap/server.ts)
- [main.ts](../../src/server/bootstrap/main.ts)

```text
신규 요청·배정·결과 수락 중단
  → 업로드·agent·import 종료 시작
  → IPC·메시지·service 후속 처리·업로드 finally 대기
  → preparation 등 기존 background 작업 종료 확인
  → DB close
  → 테스트인 경우 임시 디렉터리 삭제
```

현재 Fastify `preClose`는 coordinator를 정리하고, 외부 호출자가 `app.close()` 후 `container.close()`를 호출한다. 이 책임 분리는 유지할 수 있지만 `preClose` 시점에 DB를 닫지 않는다. 소켓 종료나 Fastify close 반환만으로 모든 애플리케이션 Promise가 종료됐다고 가정하지 않는다.

CLI처럼 container만 만드는 경로에서도 `container.close()`가 자신이 소유한 작업을 회수해야 한다. 테스트 전용 DB-open guard만 추가해서 운영 SIGTERM 경로를 남겨두지 않는다.

## 6. 구현 단위 C: test-scoped fixture와 생성 실패 정리

### C1. 공통 앱 helper 보강

대상: [test-app.ts](../../tests/helpers/test-app.ts), [test-app-helper.test.ts](../../tests/unit/test-app-helper.test.ts).

- `createTestApp()` 중 config/container/server 생성 또는 `ready()`가 실패하면 그 시점까지 획득한 자원을 의존 순서에 맞게 정리한다.
- `ctx.close()`는 중복 호출에 안전하게 한다. 성공 시에만 자원 정리 완료를 보장한다.
- 정리 실패 시 다른 독립 자원 정리도 시도하되, 살아 있는 DB 소비자를 둔 채 DB·디렉터리를 먼저 삭제하지 않는다. 필요하면 원래 setup 오류와 cleanup 오류를 함께 보고한다.
- 종료 중 `startAgent()` 재호출 등으로 자원이 다시 생성되지 않게 한다.
- helper가 실패한 테스트의 오류를 조용히 삼키지 않게 한다.

### C2. Vitest fixture 도입

신규 파일: `tests/helpers/test-fixtures.ts`.

```ts
import { test as base } from 'vitest';
import { createTestApp, type TestApp } from './test-app.js';

export const test = base.extend<{ ctx: TestApp }>({
  ctx: async ({}, use) => {
    const ctx = await createTestApp();
    try {
      await use(ctx);
    } finally {
      await ctx.close();
    }
  },
});
```

이는 기본 소유권 예시다. 환경 설정과 `agentPreparation` 등 기존 테스트별 옵션은 fixture 옵션 또는 명시적인 전용 fixture로 보존한다.

- 앱, 로그인 사용자, seed를 의존하는 fixture로 조합한다. 로그인·seed가 실패해도 앱 teardown이 실행돼야 한다.
- 파일 전역 `let ctx`를 테스트 context로 옮긴다. 공유 가능한 것은 불변 입력·factory이고, 앱·DB·agent·가변 seed 객체는 공유하지 않는다.
- `beforeEach`/`afterEach` 자체는 유효한 Vitest 관례다. fixture 문법만 바꾸면 background 작업이 자동 정리된다고 설명하지 않는다.
- DB terminal 상태를 확인하는 polling helper에는 timeout과 테스트 `signal`을 전달한다. Vitest timeout이 실행 중인 JavaScript Promise를 자동 취소한다고 가정하지 않는다.
- native child·실제 HTTP 통합 검증은 실제 timer를 사용한다. fake timer는 격리된 종료 정책 단위 테스트에 한정한다.
- 각 테스트는 별도 운영 DB와 계산 DB, temp 디렉터리, 임의 포트를 사용한다. child의 별도 연결까지 부모 transaction rollback으로 격리하려고 하지 않는다.

## 7. 구현 단위 D: 명시적인 테스트 준비와 단계적 전환

현재 [test-app.ts](../../tests/helpers/test-app.ts)와 [backtest-universe-rule-run.test.ts](../../tests/integration/backtest-universe-rule-run.test.ts)의 `installPreparedSubmissionFixture()`는 `app.inject`를 교체해 409 이후 preparation과 재요청을 자동 수행한다. 이 패턴은 준비 과정과 실제 관측 API 응답을 숨긴다.

다음 역할을 분리한다.

- 외부 KRX/DART 호출 대체: 테스트별로 명시적으로 설치하고 정리.
- DB seed: 입력을 받아 필요한 데이터만 생성.
- `prepareSubmission(ctx, request)` 등 명시적 helper: 해당 요청의 준비 완료와 필요한 wizard 참조 연결을 보장.
- 실제 제출·clone 요청: 원래 `app.inject`로 호출하고 실제 응답을 assertion.

전환 시 다음 의미를 유지한다.

- `PREPARATION_REQUIRED` 테스트는 자동 준비·재시도를 사용하지 않는다.
- worker 실행 테스트는 실행 전제인 preparation을 명시적으로 준비한다.
- coverage drift, identity mismatch, clone 등록 검증을 helper가 복구하거나 가려서는 안 된다.
- 기존 공통 fixture와 문제 파일 내부 fixture의 세부 차이를 먼저 비교한다. 동일한 이름이라는 이유로 서로 대체하지 않는다.
- local/remote worker 경계를 검증하는 테스트는 실제 child 실행을 유지한다.

조사 당시 `createTestApp()` 사용 파일은 unit/integration 합계 41개였다. 구현 시 다음 명령으로 대상 목록을 갱신한다.

```bash
rg -l 'createTestApp\(' tests/unit tests/integration
```

전환 순서:

1. 문제 파일, container lifecycle, result artifact 테스트.
2. job queue, worker/facts, local agent fallback, native agent preparation 테스트.
3. 나머지 앱 사용 테스트와 숨은 inject wrapper 호출부.

파일별 전환 후 잔여 목록과 합리적인 예외를 기록한다. 문제가 없던 모든 순수 단위 테스트를 새 fixture로 바꾸거나 테스트를 전부 concurrent로 바꾸는 작업은 포함하지 않는다.

## 8. 검증 시나리오와 실행 순서

### 8.1 필수 시나리오

| 시나리오 | 통과 조건 |
| --- | --- |
| 늦은 progress와 close 경합 | DB close 이후 갱신 시도 및 unhandled error가 없음 |
| DB terminal 상태 후 부모 처리가 남음 | 후속 처리 완료 전까지 close가 반환되지 않음 |
| 종료 중 대기 import 및 신규 요청 | 새 child를 만들지 않고 caller Promise가 정리됨 |
| child 정상·비정상·spawn 실패 | 결과 판정과 자원 회수가 한 번씩 완료됨 |
| 유예시간 초과 및 강제 종료 | 실제 child 종료를 확인하며 종료 확인 실패를 숨기지 않음 |
| HTTP 연결 중단 후 서버 import | 연결 수명과 무관하게 service·handler finally를 추적함 |
| 전송 중 서버 종료 | pipeline, 갱신 timer, 임시 artifact가 정리됨 |
| 로컬 agent 결과 처리 중 종료 | local stop과 completer stop 간 순환 대기가 없음 |
| WebSocket 연결 교체·종료 | 이미 실행 중인 메시지 처리를 추적에서 잃지 않음 |
| DB commit 후 응답 유실 및 재전송 | 결과 중복 저장 없이 기존 idempotency 계약을 유지함 |
| setup/login/seed 실패 또는 테스트 취소 | 획득한 자원이 해당 테스트 안에서 정리됨 |
| close 중복 호출 | 자원 중복 종료·삭제 및 새로운 작업 시작이 없음 |
| 두 앱의 격리 | 서로 다른 DB·디렉터리를 쓰며 한 앱 종료가 다른 앱에 영향을 주지 않음 |

두 앱 격리를 검증할 때 한 테스트 안에서 앱 A와 B를 소유하고 모두 정리한다. 앞선 테스트가 자원을 남기고 다음 테스트가 회수해야 통과하는 순서 의존 테스트를 만들지 않는다.

전역 uncaught exception handler로 오류를 삼키거나, `process._getActiveHandles()`의 전체 개수를 0으로 맞추는 방법을 완료 기준으로 삼지 않는다. Vitest 자체 자원과 구분해 실제 소유한 child·task·timer의 회수를 관찰한다.

### 8.2 권장 명령

아래 신규 파일 이름은 구현 계획의 제안이다. 실제 생성한 이름에 맞춰 명령을 갱신한다.

```bash
# 종료 정책과 생성·정리 helper 검증
pnpm exec vitest run tests/unit/forked-backtest-result-completer.test.ts tests/unit/container-lifecycle.test.ts tests/unit/test-app-helper.test.ts tests/unit/agent-coordinator.test.ts

# 결과 원자성·버전·재전송·실제 실행 경계 검증
pnpm exec vitest run tests/unit/backtest-result-lease.test.ts tests/unit/agent-outbox.test.ts tests/integration/backtest-result-artifact-versions.test.ts tests/integration/local-agent-fallback.test.ts tests/integration/backtest-universe-rule-run.test.ts

# 원래 보고된 테스트 단독 실행
pnpm exec vitest run tests/integration/backtest-universe-rule-run.test.ts -t '복제도 동일 hash'

# 문제 파일의 순서 의존성 확인: seed를 보고서에 남긴다
pnpm exec vitest run tests/integration/backtest-universe-rule-run.test.ts --sequence.shuffle --sequence.seed=20260916
pnpm exec vitest run tests/integration/backtest-universe-rule-run.test.ts --sequence.shuffle --sequence.seed=20260917

# 공통 helper 변경을 포함한 최종 게이트
pnpm test
pnpm typecheck
pnpm lint
```

추가한 실제 HTTP 중단 통합 테스트와 전환한 다른 파일도 해당 단계의 검증에 포함한다. GUI 변경이 없는 이번 작업에서 E2E 전체 실행을 기본 요구로 추가하지 않는다.

파일별 병렬 실행과 격리는 유지한다. 진단 목적으로 병렬 실행을 끌 수는 있지만, 그 결과만으로 수정을 완료 처리하지 않는다. timeout 확대, 무조건 retry, unhandled error 무시, progress 기능 삭제로 통과시키지 않는다.

## 9. 인계 및 완료 보고

권장 변경 묶음:

1. A+B: 운영 종료 계약과 결정적인 회귀 테스트. 테스트 helper 대규모 전환과 분리하되, lifecycle 관련 변경은 안전한 한 단위로 검증한다.
2. C 및 D의 첫 묶음: 공통 fixture와 문제 파일 전환.
3. D의 나머지 묶음: 앱 사용 테스트의 명시적 준비·정리 전환.

최종 보고에는 다음을 포함한다.

- 실제 재현한 이벤트 순서와 수정 전 실패/수정 후 통과 증거. 원래 간헐 실패가 재현되지 않았다면 그 한계도 구분.
- 확정한 자원 소유권, 종료 API, 제한시간과 강제 종료 정책.
- 변경 파일과 아직 전환하지 않은 fixture·테스트 및 이유.
- 검증 명령, 결과, shuffle seed, unhandled error 유무.
- commit/push 상태와 남은 운영·검증 제한.

위 진행 기록과 검증 결과를 실제 상태의 기준으로 사용한다.

## 10. 2026-09-16 구현 결과

완료한 범위:

- 결과 completer에 중복 호출 가능한 비동기 `stop()`을 추가하고, 대기 요청 거부와 실행 중 child의 `close` 확인, `SIGTERM`/`SIGKILL` 상한을 구현했다.
- progress callback 오류를 artifact 결과와 분리해 기록하며, 종료 시작 뒤 늦은 progress는 DB에 전달하지 않는다.
- lease service가 child 뒤의 감사 기록과 이벤트 발행까지 추적하고 종료 시 기다리게 했다.
- 원격 업로드, 로컬 결과 처리, WebSocket·로컬 메시지 처리를 coordinator가 추적한다. 종료 시 업로드 stream을 abort하고 handler `finally`와 결과 service 종료를 기다린 뒤 DB 종료가 가능하다.
- 테스트 앱 생성 실패와 중복 `close()`를 보강했다. 정리 실패 시 임시 디렉터리를 지우지 않아 증거와 살아 있는 소비자를 숨기지 않는다.
- `tests/helpers/test-fixtures.ts`에 Vitest `test.extend` 기반 앱 fixture를 추가했다. 보고된 worker/clone 두 시나리오는 fixture로 전환했고, worker 시나리오는 preparation을 명시적으로 완료한 뒤 제출한다.
- 두 앱의 DB·임시 디렉터리 격리, child 오류/close 경합, 강제 종료, service 후속 작업, HTTP 업로드 abort와 cleanup, container DB close 순서를 결정적인 테스트로 고정했다.

검증 결과:

```text
관련 lifecycle 단위 테스트: 6 files, 35 tests passed
결과 lease/outbox/artifact/local-agent 회귀: 4 files, 20 tests passed
문제의 두 테스트 단독 실행: 2 passed, 16 skipped
shuffle seed 20260916: 18 passed
shuffle seed 20260917: 18 passed
pnpm lint: passed
pnpm typecheck: passed
pnpm test: 185 files, 2076 tests passed
```

원래 간헐 오류는 수정 전 집중 실행에서 항상 재현되지는 않았다. 따라서 완료 근거는 재현 횟수가 아니라 child `error`/`exit`/`close`, 늦은 progress, service 후속 처리, 업로드 abort 경계를 제어한 회귀 테스트와 전체 suite에서 unhandled SQLite 오류가 없었다는 결과다.

단계적 전환의 남은 범위:

- 현재 `rg -l 'createTestApp\(' tests/unit tests/integration` 기준 42개 파일이 직접 helper를 사용한다. 각 호출은 이미 별도 DB·디렉터리를 소유하고 보강된 `close()`를 사용하지만, `test.extend` 문법으로는 아직 옮기지 않았다.
- 문제 파일 안에서도 이번 원인과 직접 관련된 worker/clone 시나리오 외 describe는 기존 `beforeEach`/`afterEach`를 유지한다.
- 기존 `installPreparedSubmissionFixture()`의 자동 inject 재시도는 아직 사용하는 이전 시나리오가 있어 제거하지 않았다. 전환한 worker 시나리오는 새 명시적 `prepareSubmission()`을 사용하며 clone 시나리오는 원래처럼 409→준비→재요청을 직접 검증한다.
- 이 잔여 작업은 계산·검증 의미를 바꾸지 않는 파일별 후속 변경으로 진행한다. 이번 종료 race 수정의 완료 조건이나 DB 안전성을 막는 항목은 아니다.

## 11. 공식 참고 자료

- [Vitest Test Context / test.extend](https://vitest.dev/guide/test-context.html): 테스트별 fixture와 setup/teardown 소유권.
- [Vitest Hooks](https://vitest.dev/api/hooks.html): Promise를 반환하는 hook과 테스트 종료 정리.
- [Vitest Parallelism](https://vitest.dev/guide/parallelism): 파일별 격리·병렬 실행과 파일 내부 기본 순차 실행의 구분.
- [Node.js ChildProcess close](https://nodejs.org/api/child_process.html#event-close): `exit`와 프로세스·stdio 정리 완료 경계의 차이.
- [Fastify Server close](https://fastify.dev/docs/latest/Reference/Server/#close): `preClose`, 연결 종료, `onClose`의 순서.

설치된 Vitest 조사 버전은 4.1.10이다. 최신 웹 문서의 새 API를 무조건 도입하지 말고 설치된 버전에서 지원되는 fixture·signal API를 사용한다.
