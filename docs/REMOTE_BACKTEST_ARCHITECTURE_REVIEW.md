# 원격 백테스트 Worker 분리 검토

> 기준일: 2026-07-29  
> 상태: 아키텍처 검토 및 권고안 — 구현 결정 전  
> 대상: AWS Lightsail $7 인스턴스에서 운영 중인 Quant Platform

## 1. 검토 목적

다음 확장 조건에서 현재 모듈러 모놀리스의 백테스트 계산을 별도 PC로 분리할 필요가
있는지 검토한다.

- OHLCV뿐 아니라 기업 재무제표, 손익계산서, 자본변동 및 거시지표를 함께 사용한다.
- 단일 백테스트가 약 500종목을 동시에 처리한다.
- 웹/API 서비스는 현재 AWS Lightsail $7 플랜에서 계속 운영한다.
- 계산은 별도 PC에서 수행하고 결과만 Lightsail로 가져오는 방안을 고려한다.
- 작업 완료 확인 방식으로 polling, message queue 및 제3의 방식을 비교한다.

## 2. 결론

현재 $7 Lightsail을 유지하면서 500종목 백테스트를 안정적으로 수행하려면
**백테스트 계산을 별도 PC로 분리하는 것이 타당하다.**

단, 이를 완전한 MSA 전환으로 볼 필요는 없다. 권장 구조는 다음과 같다.

> **모듈러 모놀리스 + 별도 배포되는 원격 Worker + lease 기반 long polling +
> Worker의 결과 push**

저장소, 도메인 모델, 전략 코드와 릴리스 버전은 하나로 유지한다. 배포 역할만
Lightsail의 `web/control plane`과 별도 PC의 `backtest worker`로 나눈다.

초기 단계에서는 message broker를 도입하지 않는다. SQLite의 기존 지속성 작업 큐를
작업 상태의 유일한 진실로 유지하고, 원격 Worker가 HTTPS API를 통해 작업을 가져가도록
한다.

## 3. 현재 호스트의 한계

2026-07 기준 Lightsail $7 Linux 플랜은 2 vCPU, 1GB RAM, 40GB SSD를 제공한다. 그러나
이 플랜의 지속 CPU 성능 baseline은 10%이므로 장시간 CPU-bound 작업인 백테스트에는
vCPU 개수보다 이 제약이 더 중요하다.

- [AWS Lightsail 인스턴스 플랜](https://docs.aws.amazon.com/lightsail/latest/userguide/amazon-lightsail-bundles.html)
- [AWS Lightsail CPU baseline](https://docs.aws.amazon.com/lightsail/latest/userguide/baseline-cpu-performance.html)

프로젝트 내부에도 1GB 서버에서 DuckDB 동기화 작업으로 서버 전체가 마비된 운영 기록이
있다. 현재 systemd는 웹 프로세스와 그 자식 프로세스를 합쳐 `MemoryHigh=512M`,
`MemoryMax=640M`으로 제한한다.

- [운영 장애 기록](DECISIONS.md#d-023-2026-07-28-운영-장애--동기화-쓰기-증폭이-무스왑-1gb-박스를-질식시켰다)
- [systemd 리소스 제한](../infra/systemd/quant-platform.service)

현재 `child_process.fork()`는 Fastify 이벤트 루프와 계산 실패를 격리하지만, 같은
호스트의 CPU, 메모리, 디스크 I/O와 systemd cgroup은 그대로 공유한다. 따라서 별도
프로세스라는 이유만으로 웹 서비스의 가용성이 보호되지는 않는다.

## 4. 현재 구현에서 확인된 확장 제약

### 4.1 요청 종목 수와 봉 수 제한

현재 백테스트 요청은 최대 50종목이고, 최대 봉 수는 200만 개다.

- [백테스트 요청 스키마](../src/shared/schemas/backtest-request.ts)
- [봉 수 상한](../src/server/modules/backtest/domain/bar-estimate.ts)

500종목을 처리하려면 요청 스키마 확장뿐 아니라 실제 메모리 사용량을 기준으로 봉 수
상한을 다시 결정해야 한다.

### 4.2 전량 메모리 적재

현재 Worker는 DuckDB에서 조회한 모든 캔들을 `candles` 배열에 적재한다. 엔진은 이를
다시 정렬한 배열, 시점별 `Map`, 종목별 전체 이력 배열로 구성한다.

- [백테스트 자식의 캔들 로드](../src/workers/backtest-child.ts)
- [엔진의 정렬·인덱스 구성](../src/server/modules/backtest/domain/engine.ts)

대략적인 봉 수는 다음과 같다. 실제 거래일과 세션 수에 따라 달라지는 추정치다.

| 조건 | 추정 봉 수 | 현재 200만 봉 상한 |
|---|---:|---|
| 500종목 × 일봉 5년 | 약 63만 | 이내 |
| 500종목 × 일봉 10년 | 약 126만 | 이내 |
| 500종목 × 일봉 20년 | 약 252만 | 초과 |
| 500종목 × 시간봉 5년 | 약 440만 | 초과 |
| 500종목 × 1분봉 1년 | 약 4,900만 | 크게 초과 |

따라서 일봉 장기 백테스트는 고사양 PC에서 현재 구조로도 실행 가능할 수 있지만,
시간봉·분봉으로 확장하려면 원격 실행과 별개로 스트리밍 또는 제한된 rolling history
구조가 필요하다.

### 4.3 재무·거시 팩트의 영향

500종목 × 40분기 × 12개 계정은 약 24만 행이다. 거시지표는 이보다 훨씬 작다.
팩트를 long format Parquet으로 저장하고 PIT 커서로 읽는 현재 설계에서는 재무·거시
데이터가 주 메모리 병목이 되지는 않는다.

주 병목은 다음과 같다.

1. OHLCV 봉 수
2. JS 객체와 정렬·Map·이력 배열
3. 장시간 지속되는 단일 스레드 전략 계산
4. DuckDB와 웹 프로세스가 공유하는 호스트 메모리 및 I/O

재무 데이터 수집은 백테스트마다 수행하지 않고 데이터셋 생성·갱신 시 미리 수행하여
캐시해야 한다.

## 5. 분리가 반드시 필요한 조건

500종목이라는 숫자만으로 MSA 전환이 반드시 필요한 것은 아니다. 다음과 같이 판단한다.

### 분리를 미룰 수 있는 경우

- 일봉 위주로 5~10년 정도만 실행한다.
- 백테스트 실행 빈도가 낮다.
- Lightsail을 4GB 이상의 플랜으로 증액할 수 있다.
- 백테스트 중 웹 응답 지연을 어느 정도 허용할 수 있다.
- 엔진을 스트리밍·rolling history 방식으로 먼저 최적화할 계획이다.

### 분리가 필요한 경우

- $7 플랜을 유지해야 한다.
- 백테스트 중에도 웹/API와 향후 실거래 프로세스의 가용성을 보장해야 한다.
- 500종목 장기 백테스트를 반복적으로 실행한다.
- 시간봉 또는 분봉을 사용한다.
- 파라미터 sweep이나 여러 전략 실행으로 계산량이 더 증가할 예정이다.

현재 프로젝트의 비용 목표와 운영 안정성 조건을 함께 적용하면 계산 분리가 더 적절하다.

## 6. 통신 방식 비교

### 6.1 Lightsail이 Worker PC를 polling

Lightsail이 주기적으로 Worker PC에 요청하여 완료 여부를 확인하고, 완료되면 결과를
다운로드하는 방식이다.

장점:

- 개념과 초기 구현이 단순하다.
- 별도 message broker가 필요 없다.

단점:

- Worker PC가 NAT 또는 공유기 뒤에 있으면 Lightsail에서 직접 접근하기 어렵다.
- Worker PC에 인바운드 포트, TLS, 인증과 방화벽 설정이 필요하다.
- PC가 꺼지거나 IP가 바뀌면 접근할 수 없다.
- polling 주기만큼 완료 반영이 늦어진다.
- Lightsail이 신뢰하지 않는 외부 PC에서 결과를 pull해야 한다.

**비추천한다.** 특히 가정용 또는 개발용 PC를 Worker로 사용할 때 네트워크 방향이
부적절하다.

### 6.2 Message queue로 완료 이벤트 수신 후 결과 pull

Worker가 완료 메시지를 발행하고 Lightsail이 이를 소비한 뒤 Worker PC에 결과를
요청하는 방식이다.

장점:

- 완료 이벤트 전달이 빠르다.
- 여러 Worker와 작업 종류를 확장하기 좋다.
- broker가 ack, 재전달, DLQ 등을 제공할 수 있다.

단점:

- MQ는 완료 알림만 해결하고 Worker PC에서 결과를 가져오는 문제는 해결하지 않는다.
- SQLite 작업 상태와 MQ 메시지 상태가 이중화된다.
- DB enqueue 성공 후 MQ 발행 실패 같은 dual-write 문제가 생긴다.
- ack, visibility timeout, 중복 소비, DLQ, 재처리 및 인증을 설계해야 한다.
- Worker 1대인 현재 규모에서는 운영 구성요소가 과도하게 늘어난다.

MQ를 사용하더라도 결과 본문을 메시지에 넣지 않고 `resultUri`, `checksum`, `size` 같은
포인터만 전달해야 한다.

### 6.3 Lease 기반 Worker pull + 결과 push

원격 Worker가 Lightsail에 outbound HTTPS로 연결하여 작업을 가져간다. 실행 중에는
heartbeat를 보내고, 완료되면 결과를 Lightsail에 직접 업로드한다.

장점:

- Worker PC에 인바운드 포트를 열 필요가 없다.
- NAT, 동적 IP 환경에서 동작한다.
- 기존 SQLite JobQueue를 그대로 작업 상태의 기준으로 사용할 수 있다.
- long polling을 사용하면 짧은 polling보다 요청 수와 지연이 모두 작다.
- 결과 데이터도 Worker가 신뢰된 Lightsail 엔드포인트로 push한다.
- 향후 내부 구현을 MQ로 교체해도 Worker 계약을 유지할 수 있다.

단점:

- lease, heartbeat, 중복 완료와 idempotency를 직접 구현해야 한다.
- 현재 child가 SQLite를 직접 여는 구조를 결과 artifact 방식으로 바꿔야 한다.
- Worker와 서버의 실행 코드 버전 호환성을 관리해야 한다.

**현재 규모의 권장안이다.**

## 7. 권장 목표 구조

```text
Browser
   │
   │ POST /backtests
   ▼
Lightsail
├─ Fastify API
├─ SQLite JobQueue / Result DB
├─ Dataset manifest / artifact endpoint
└─ SSE → Browser
       ▲
       │ progress / terminal status
       │
Remote Worker Supervisor
├─ long-poll claim
├─ lease heartbeat
├─ dataset cache
├─ child process 실행·취소
└─ result artifact upload
       │
       └─ Backtest Child
          ├─ DuckDB
          ├─ Parquet reader
          ├─ strategy engine
          └─ result artifact writer
```

### 역할

#### Lightsail control plane

- 사용자 인증과 백테스트 요청 검증
- 작업 enqueue
- Worker lease 발급
- heartbeat와 진행률 반영
- 입력 manifest 제공
- 결과 artifact 수신·검증·import
- 작업 상태와 결과 조회
- 기존 SSE를 통한 브라우저 상태 전달

#### Remote Worker supervisor

- Lightsail에서 작업을 long polling
- 로컬 dataset cache 확인 및 누락 artifact 다운로드
- 계산 child process 기동
- child IPC 진행률을 Lightsail로 전송
- 주기적 lease 갱신
- 취소 요청 전달
- 결과 artifact 업로드

#### Backtest child

- 네트워크와 서버 SQLite를 모른다.
- 로컬 입력 경로와 versioned job manifest만 읽는다.
- 계산 결과를 versioned artifact로 쓴다.
- 진행률과 취소만 supervisor IPC로 주고받는다.

## 8. 작업 lease 프로토콜

### Claim

```http
POST /api/internal/workers/jobs/claim?waitSeconds=25
Authorization: Bearer <worker-token>
```

예시 응답:

```json
{
  "jobId": "bt_...",
  "attempt": 1,
  "leaseToken": "...",
  "leaseExpiresAtMs": 1785300000000,
  "runnerVersion": "1.3.0",
  "request": {},
  "inputManifest": {
    "datasetId": "ds_...",
    "datasetVersion": 7,
    "contentHash": "...",
    "artifacts": []
  }
}
```

Worker가 처리할 작업이 없으면 서버는 long polling 대기 후 `204 No Content`를 반환한다.

### Heartbeat

```http
POST /api/internal/workers/jobs/{jobId}/heartbeat
```

heartbeat에는 다음을 포함한다.

- `attempt`
- `leaseToken`
- `processedBars`
- `totalBars`
- `progressLabel`

응답에는 `cancelRequested`를 포함한다. Worker supervisor는 취소가 확인되면 child에 IPC
취소를 보내고, 필요하면 기존과 같이 `SIGTERM` 및 `SIGKILL`로 승격한다.

### Result upload

```http
PUT /api/internal/workers/jobs/{jobId}/result
Content-Type: application/gzip
```

업로드 메타데이터:

- `attempt`
- `leaseToken`
- `resultSchemaVersion`
- `runnerVersion`
- `sha256`
- `uncompressedSize`

서버는 임시 파일로 받은 뒤 크기·checksum·schema를 검증한다. 결과 테이블 import가
트랜잭션으로 성공한 뒤에만 작업을 `COMPLETED`로 바꾼다.

## 9. 작업 상태

권장 상태 흐름은 다음과 같다.

```text
QUEUED
  → LEASED
  → RUNNING
  → UPLOADING
  → FINALIZING
  → COMPLETED
```

예외 상태:

```text
CANCEL_REQUESTED → CANCELLED
RUNNING → FAILED
lease 만료 → INTERRUPTED 또는 QUEUED 재시도
```

초기 구현에서는 기존 `STARTING`, `RUNNING`, `CANCELLING`을 유지하고 lease 관련 컬럼만
추가하여 변경 범위를 줄일 수 있다.

필수 메타데이터:

- `attempt`
- `workerId`
- `leaseExpiresAtMs`
- `runnerVersion`
- `inputManifestHash`
- `resultSchemaVersion`
- `resultChecksum`

모든 heartbeat와 결과 업로드는 `jobId + attempt + leaseToken`이 일치할 때만 허용한다.
이전 attempt의 늦은 완료가 새 attempt 결과를 덮어쓰면 안 된다.

## 10. 데이터 전달과 재현성

### 10.1 현재 데이터셋 version의 한계

현재 job은 제출 시점의 `datasetVersion`과 `datasetHash`를 기록하지만, 물리 Parquet은
파티션 재작성 방식이다. 대기 중 데이터가 바뀌면 실행 시점의 실제 파일이 제출 시점과
달라질 수 있으며, 현재 Worker도 이를 경고로만 처리한다.

원격 실행에서는 Lightsail과 Worker가 같은 입력을 사용했다는 사실을 보장해야 하므로
단순한 version 숫자만으로는 부족하다.

### 10.2 권장 입력 manifest

```json
{
  "datasetId": "ds_...",
  "datasetVersion": 7,
  "contentHash": "...",
  "artifacts": [
    {
      "logicalPath": "market=KR/timeframe=1d/symbol=005930/year=2025/data.parquet",
      "sha256": "...",
      "size": 123456,
      "downloadUrl": "..."
    }
  ]
}
```

Worker는 `contentHash` 기준으로 dataset을 로컬 캐시한다. 같은 버전의 후속 백테스트는
데이터를 다시 받지 않는다. 새 버전에서는 checksum이 바뀐 파티션만 받는다.

초기 구현에서 immutable artifact 저장이 부담스럽다면 다음 중 하나를 택한다.

1. 활성 백테스트가 있는 동안 해당 dataset 변경을 금지한다.
2. 제출 시 필요한 파티션을 실행 전용 snapshot 디렉터리에 복사한다.
3. version별 immutable object storage를 사용한다.

장기적으로는 세 번째 방식이 재현성과 Worker 확장에 가장 유리하다.

## 11. 결과 artifact

초기에는 `result.v1.json.gz` 형식으로 충분하다.

포함 항목:

- 실행·재현성 메타데이터
- 집계 성과지표
- equity points
- drawdown points
- trades
- monthly returns
- symbol metrics
- warnings
- open positions

결과는 현재처럼 SQLite 테이블로 최종 저장하되, Worker는 SQLite를 직접 쓰지 않는다.
Lightsail의 importer가 artifact를 검증한 뒤 기존 결과 테이블에 기록한다.

결과가 수십~수백 MB 이상으로 증가하거나 보관량이 커지면 object storage에 artifact를
보관하고 SQLite에는 조회용 요약과 artifact 위치만 저장한다.

## 12. 보안

- Worker는 Lightsail의 공개 HTTPS 443 포트로만 outbound 연결한다.
- Worker PC에는 외부 인바운드 포트를 열지 않는다.
- 관리자 세션과 별도의 Worker 전용 자격 증명을 사용한다.
- Worker token은 `claim`, `heartbeat`, `input download`, `result upload` 권한만 가진다.
- Worker에는 증권사 API key, TOTP secret, 관리자 session secret을 전달하지 않는다.
- job 입력에서 임의 파일 경로나 임의 명령을 허용하지 않는다.
- 결과 업로드에는 최대 압축·해제 크기와 행 수 제한을 둔다.
- token 회전과 Worker 폐기 시 즉시 revoke가 가능해야 한다.
- 필요해지면 bearer token을 mTLS로 강화할 수 있다.

## 13. 코드 경계

권장 애플리케이션 경계:

```ts
interface BacktestExecutor {
  submit(job: ExecutableBacktestJob): Promise<void>;
  cancel(jobId: string): Promise<void>;
}
```

구현:

```text
BacktestExecutor
├─ LocalChildExecutor
└─ RemoteLeaseExecutor
```

계산 코어:

```ts
interface BacktestRunner {
  run(
    input: BacktestInputManifest,
    hooks: BacktestHooks,
  ): Promise<BacktestResultArtifact>;
}
```

이 경계를 두면 전략·엔진은 네트워크와 배포 위치를 모른다. 로컬 child 실행과 원격 Worker
실행이 같은 계산 코어와 결과 schema를 사용한다. 이것이 message broker 도입보다 먼저
확보해야 할 아키텍처 경계다.

## 14. 단계별 전환안

### 1단계 — 대표 부하 측정

- 실제 500종목 일봉 5년·10년 데이터로 peak RSS, CPU time, wall time을 측정한다.
- 시간봉 대표 구간도 별도로 측정한다.
- 입력 다운로드 크기, 결과 artifact 크기와 SQLite import 시간을 측정한다.
- 원격 Worker PC의 적정 RAM과 동시 실행 수를 결정한다.

### 2단계 — 계산 코어와 저장 책임 분리

- 현재 `backtest-child.ts`에서 계산 준비·실행 로직을 `BacktestRunner`로 추출한다.
- child의 SQLite 직접 결과 기록을 result artifact 생성으로 바꾼다.
- Lightsail 내부 실행은 기존 `LocalChildExecutor`로 유지하여 동작 회귀를 막는다.

### 3단계 — 입력 snapshot과 결과 importer

- versioned input manifest를 정의한다.
- dataset cache와 checksum 검증을 구현한다.
- result artifact schema와 Lightsail importer를 구현한다.
- 같은 artifact를 여러 번 제출해도 결과가 중복되지 않게 한다.

### 4단계 — 원격 Worker API

- claim long polling
- lease와 heartbeat
- 진행률
- 취소
- 결과 업로드
- Worker 인증과 revoke

### 5단계 — Worker supervisor 배포

- 별도 PC에서 서비스로 자동 시작한다.
- supervisor가 child process를 실행하고 네트워크 heartbeat를 담당한다.
- Worker 재시작 시 고아 child와 만료 lease를 정리한다.
- 서버와 Worker의 `runnerVersion`이 다르면 작업을 claim하지 않는다.

### 6단계 — 선택적 라우팅

- 작은 일봉 작업은 Lightsail 로컬 실행을 선택적으로 유지한다.
- 500종목 또는 예상 봉 수가 일정 기준을 넘으면 원격 Worker로 보낸다.
- 안정화 후 Lightsail의 로컬 백테스트 실행을 완전히 끌 수 있다.

### 7단계 — 필요할 때 MQ 도입

다음 조건이 실제로 생길 때 `RemoteLeaseExecutor` 내부를 message queue adapter로
교체한다.

- Worker가 여러 대이고 경쟁 claim이 빈번하다.
- Worker 자동 확장이 필요하다.
- 백테스트 외의 독립적인 계산 작업도 같은 인프라를 사용한다.
- DLQ와 자동 재처리가 운영상 필수다.
- 여러 애플리케이션이 작업을 생산한다.

## 15. 엔진 자체의 후속 최적화

원격 PC로 옮겨도 전량 메모리 로드는 장기적으로 병목이다. 다음 개선을 별도 과제로
검토한다.

- DuckDB 결과를 `ORDER BY ts_ms, symbol`로 스트리밍한다.
- 전략별 최대 lookback을 명시하고 종목별 rolling buffer만 유지한다.
- `getHistory()`가 전체 과거 배열을 노출하지 않도록 bounded history API로 변경한다.
- equity와 drawdown 같은 결과도 필요하면 배치 단위로 artifact에 기록한다.
- 파라미터 sweep은 프로세스 단위로 분리하되 메모리 예산에 따라 동시 실행 수를 제한한다.
- 전략 특성상 전체 유니버스 횡단면이 필요한 시점만 500종목 snapshot을 구성한다.

이 최적화가 완료되면 같은 Worker PC에서 더 긴 기간과 더 많은 동시 작업을 처리할 수
있지만, Lightsail에서 계산을 분리해야 한다는 운영상의 결론은 바뀌지 않는다.

## 16. 최종 권고

1. $7 Lightsail은 인증, API, 큐, 결과 조회와 향후 실거래 control plane에 집중한다.
2. 계산은 동일 저장소·동일 버전의 별도 Worker 역할로 분리한다.
3. 초기 통신은 message queue가 아니라 lease 기반 long polling을 사용한다.
4. Worker가 결과를 Lightsail로 push하고 Lightsail이 검증·import한다.
5. 브라우저 알림은 현재 SSE + polling fallback을 그대로 유지한다.
6. Worker는 서버 SQLite 또는 네트워크 공유 파일을 직접 열지 않는다.
7. 원격 실행 전에 데이터 snapshot과 runner version 계약을 확정한다.
8. 실제 다중 Worker 운영이 필요해질 때 message broker를 도입한다.

이 구조는 현재 모듈러 모놀리스의 장점을 유지하면서 계산 자원만 독립적으로 확장한다.
MSA의 운영 복잡도를 미리 부담하지 않으면서도 향후 MQ 또는 다중 Worker로 전환할 수 있는
명확한 경계를 제공한다.
