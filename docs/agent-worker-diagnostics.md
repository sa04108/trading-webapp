# 에이전트 계산 종료 진단

## 목적과 범위

작업 상태(`FAILED`, `CANCELLED`, `COMPLETED`)와 별도로 프로세스·작업 DB·결과 파일·출력의 관측값을 보존한다. 오류 문자열이 없다는 이유만으로 모든 실패를 같은 메시지로 합치지 않는다. 원격 에이전트와 서버 내부 에이전트는 동일한 진단 코드를 사용한다.

백테스트 성공은 종전대로 `result.sqlite`의 해시를 계산하여 결과 업로드 API/로컬 어댑터로 전달한다. `FINISH COMPLETED`만으로 성공을 승인하지 않는다. 원격 우선 배정, 자원이 있는 서버 내부 에이전트의 실행, 취소 및 리스 소유권 정책은 변경하지 않는다.

---

## 수집 정보

`schemaVersion: 1` 진단에는 다음 관측값이 포함된다.

| 범주 | 필드 |
| --- | --- |
| 프로세스 | `spawned`, `pid`, `startedAtMs`, `finishedAtMs`, `exitCode`, `signal` |
| 진행 | `lastPhase`, `lastMessageAtMs` |
| 출력 | `stderr`, `stdout`: 마지막 32 KiB, 총 바이트 수, 잘림 여부 |
| 오류 | 최초 `workerError`, 최대 4개의 `processErrors`, 결과 전송의 `deliveryError` |
| 작업 DB | 파일·열기·쿼리·행 존재 상태, 작업 상태와 오류 문자열, 별도 조사 오류 |
| 결과 파일 | 존재·읽기 실패 상태, 파일 크기, 접근 오류 |
| 중단·자원 | `cancellationReason`, `cancelPath`, 관측 최대 RSS, 메모리 예산 |

로컬 기록에는 작업 종류, 작업 ID, 시도 번호, 데이터셋 버전, 실행 모드, 런너 버전, Node 버전, OS 및 아키텍처도 포함된다. 전체 환경변수·작업 payload는 기록하지 않는다. 진단 문자열에서 부모가 알고 있는 인증/리스 토큰과 Bearer 자격증명을 제거한다. 운영용 outbox와 lease 파일에는 재전송에 필요한 리스 토큰이 있으므로 진단 파일과 구분하여 취급한다.

`exit`에서는 종료 코드·시그널과 타이머를 정리하고, 표준 입출력이 닫힌 `close`에서 최종 진단을 확정한다. 따라서 시작 실패로 `exit`가 없거나 종료 직전 출력이 늦게 도착하는 경우도 처리한다. 자식은 DB 상태 갱신보다 먼저 최초 오류와 stack을 보고하며, IPC 송신을 마치고 자연 종료하여 임의의 sleep이나 강제 `process.exit()`에 출력 전달을 의존하지 않는다.

## 진단 코드

| 코드 | 의미 |
| --- | --- |
| `JOB_SETUP_FAILED` | 작업 디렉터리·리스·작업 DB·입력 준비 실패 |
| `WORKER_SPAWN_FAILED` | 계산 자식 프로세스 시작 실패 |
| `WORKER_PROCESS_ERROR` | 시작 이후 IPC 또는 프로세스 제어 오류 |
| `WORKER_SIGNAL_EXIT` | 요청한 취소 이외의 시그널 종료 |
| `WORKER_NONZERO_EXIT` | 구체적 실패 보고 없이 0 이외 코드로 종료 |
| `WORKER_REPORTED_FAILED` | 워커 또는 작업 DB에 명시적 실패가 기록됨 |
| `JOB_DB_MISSING` / `JOB_DB_READ_FAILED` / `JOB_ROW_MISSING` | 작업 DB 누락 / 조사 실패 / 행 누락 |
| `RESULT_ARTIFACT_MISSING` / `RESULT_ARTIFACT_READ_FAILED` | 완료 기록에 대응하는 결과 누락·빈 파일 / 접근·해시 읽기 실패 |
| `WORKER_EXIT_WITHOUT_TERMINAL_STATE` | 종료 상태나 필요한 준비 결과 IPC가 확인되지 않음 |
| `TERMINAL_STATE_CONFLICT` | 완료 보고와 비정상 종료 등이 모순됨 |
| `RESOURCE_BUDGET_EXCEEDED` | 부모가 관측한 메모리 예산 초과로 중단 |
| `RESULT_UPLOAD_REJECTED` | 결과 업로드가 영구 거부 상태로 응답됨 |
| `FINALIZATION_FAILED` | 최종 처리 자체에서 예상하지 못한 오류 발생 |
| `AGENT_INTERRUPTED` | 에이전트 종료·업데이트 또는 outbox 없는 이전 작업 흔적 |
| `CANCELLED` / `NEEDS_DATA` / `COMPLETED` | 취소 / 준비 단계의 데이터 요청 / 기존 성공 계약 확인 |

코드는 대표 분류이며 다른 증거를 지우지 않는다. 예를 들어 비정상 종료와 DB 누락이 동시에 발생하면 코드뿐 아니라 `jobDb.state`도 확인한다. `stderr` 출력 자체는 실패 조건이 아니다. `SIGKILL`만으로 OOM이라고 확정하지 않는다. 커널/cgroup OOM 증거 수집이나 계산 정체 자동 중단은 이 진단의 범위가 아니다.

오류 요약은 기존 프로토콜의 2,000자 제한을 유지하며 코드, 종료 정보, 마지막 단계, DB와 결과 상태, stderr 크기를 포함한다.

---

## 기록 위치와 보존

에이전트 상태 디렉터리를 `<state>`라고 할 때:

```text
<state>/jobs/<jobId>-<attempt>/execution.json   # 최근 단계 또는 종료 스냅샷
<state>/jobs/<jobId>-<attempt>/outbox.json      # 기존 재전송 기록 + 진단
<state>/diagnostics/<jobId>-<attempt>.json      # ACK 뒤에도 남는 종료 요약
```

`diagnostics`는 최신 100개, 총 16 MiB, 7일을 상한으로 정리한다. 시작 시, 종료 요약 저장 시, 실행 중 매시간 정리한다. 유휴 상태의 시간 기준 삭제에는 최대 약 1시간의 점검 간격이 있다. 실패한 원자 쓰기의 소유 임시 파일도 정리한다. 성공 기록도 이 상한에 포함된다. 디렉터리는 0700, 기록 파일은 0600으로 생성한다.

진단 저장 또는 DB 조사 실패가 `FINISH` 전송을 막지 않는다. outbox 디스크 쓰기에 실패하면 살아 있는 프로세스의 메모리에서 보고/재전송을 유지하고 heartbeat에서 영속화를 재시도한다. 디스크 저장에 성공하기 전에 에이전트 자체가 종료되면 해당 메모리 정보의 복구는 보장하지 않는다.

재시작 시 outbox가 없는 작업 폴더는 가능한 마지막 단계와 `AGENT_INTERRUPTED`를 별도 보존한 후 정리한다. 만료 여부가 불명확한 과거 리스의 `FINISH`를 새로 전송하지 않는다.

## 운영 서버에서 조회

서버는 수락된 `FINISH.result.diagnostics`를 허용 필드·형식·크기로 검증하여 구조화 로그와 `agent.worker.diagnostics` 감사 이벤트로 저장한다. 진단 불량이나 감사 DB 저장 오류는 이미 처리된 종료 상태나 ACK를 뒤집지 않는다. 거부된 과거 리스의 진단은 감사 이벤트로 저장하지 않는다.

```sql
SELECT
    created_at_ms,
    json_extract(detail_json, '$.jobId') AS job_id,
    json_extract(detail_json, '$.attempt') AS attempt,
    json_extract(detail_json, '$.clientId') AS agent_id,
    json_extract(detail_json, '$.diagnostics.code') AS diagnostic_code,
    detail_json
FROM audit_logs
WHERE event = 'agent.worker.diagnostics'
ORDER BY id DESC
LIMIT 20;
```

`clientId`는 인증된 연결에서 결정하며 `server-local`이면 서버 내부 실행이다. `reportedOutcome`은 에이전트 보고값이다. 취소 경합 등으로 중앙 DB의 실제 상태가 달라질 수 있으므로 최종 상태는 작업 행 또는 `backtest.finished` 감사 기록으로 확인한다.

성공한 백테스트는 FINISH가 아닌 파일 업로드를 사용하므로 성공 실행의 상세 프로세스 진단은 에이전트의 로컬 보존 기록에 남는다. 기존 성공 감사/telemetry 경로는 유지된다. 준비 작업의 완료·실패 및 백테스트 실패 진단은 FINISH로 중앙에 전달된다.

## 회귀 검증

```sh
pnpm exec vitest run tests/unit/agent-worker-diagnostics.test.ts tests/integration/agent-worker-diagnostics.test.ts tests/integration/agent-client-diagnostics.test.ts tests/unit/agent-outbox.test.ts tests/integration/local-agent-fallback.test.ts
pnpm exec tsc --noEmit -p tsconfig.server.json
```

새 테스트는 상태 분류, 출력 크기 제한, 실제 자식 프로세스 종료/IPC 배출, DB·파일 조사, 서버 진단 검증, ACK 이후 보존, outbox 디스크 실패 재시도, 성공 파일 업로드 유지를 나누어 검증한다. 최종 처리 테스트의 결과 파일은 전송 분기 확인용 fixture이며 실제 결과 스키마 검증을 대신하지 않는다. 후자는 기존 로컬 에이전트/결과 업로드 통합 테스트가 담당한다.
