# 원격 백테스트 Worker 부트스트랩·배포 설계

> 기준일: 2026-08-15
>
> 상태: 구현 전 설계안
>
> 대상: AWS Lightsail $7 요금제급의 단일 원격 백테스트 Worker와 이후 다중 호스트 확장
>
> 관련 문서: [원격 백테스트 Worker 분리 검토](./REMOTE_BACKTEST_ARCHITECTURE_REVIEW.md), [원격 Worker 운영 가이드](../REMOTE_WORKER_OPERATIONS.md)

## 1. 목적

현재 원격 백테스트 Worker 실행 코드와 systemd unit은 존재하지만, 새 서버를 준비하고 정확한 애플리케이션 릴리스를 배포하는 과정은 수동이다. 이 문서는 다음 작업을 반복 가능하고 검증 가능한 스크립트로 만드는 방안을 정의한다.

1. 빈 Worker 서버를 백테스트 전용 호스트로 초기화한다.
2. 웹 서버와 동일한 Git SHA의 릴리스 산출물을 Worker에 배포한다.
3. 토큰과 환경 파일을 로그나 명령행에 노출하지 않는다.
4. 시작 실패나 서버·Worker 버전 불일치 시 직전 릴리스로 복구한다.
5. 현재의 저사양 단일 호스트 운영을 단순하게 유지하면서, 이후 서버 수평 확장이 가능하도록 한다.

이 설계에서 Worker는 여전히 **백테스트 잡 전용 프로세스**다. 향후 자동매매 실행기를 추가할 때는 인증, lease, heartbeat 개념을 재사용할 수 있지만, 주문 권한과 장애 격리가 필요한 자동매매를 동일 프로세스에 합치지는 않는다.

## 2. 설계 원칙

- 웹 서버와 Worker의 부트스트랩·배포 진입점은 분리한다.
- SSH 연결, 릴리스 빌드처럼 동일한 부분만 작은 공통 모듈로 추출한다.
- 웹 서버와 Worker에는 한 번 빌드한 동일 산출물을 배포한다.
- Worker 서버에는 Caddy, 애플리케이션 DB, DB 마이그레이션 및 백업 작업을 설치하지 않는다.
- bootstrap 재실행은 기존 `/etc/quant-platform/worker.env`를 덮어쓰지 않는다.
- 배포 성공은 단순한 프로세스 실행 여부가 아니라 인증과 릴리스 호환성 확인까지 포함한다.
- Lightsail $7 요금제에서는 `BACKTEST_WORKER_CONCURRENCY=1`을 기본값으로 한다. 서버 사양을 올리기 전에는 Worker 한 대 안의 동시성을 높이기보다 Worker 호스트를 추가하는 방식을 우선한다.
- v1은 Ubuntu/Debian 계열 x86_64 호스트 한 대씩 배포하는 범위로 제한한다.

## 3. 목표 구조

```text
개발 PC
├── scripts/build-release.sh
│   └── 릴리스 archive + SHA-256 checksum
├── scripts/deploy.sh
│   └── 웹/API 서버 배포
└── scripts/deploy-worker.sh
    └── 백테스트 Worker 배포

새 Worker 서버
└── scripts/bootstrap-worker.sh
    └── infra/provision-worker.sh
        ├── Node.js 및 systemd 준비
        ├── quant-worker 계정과 전용 경로 생성
        └── worker.env 안전 설치
```

서비스별 서버 경로도 분리한다.

| 용도 | 경로 |
| --- | --- |
| Worker 릴리스 | `/opt/quant-backtest-worker/releases/<release>` |
| 현재 Worker 릴리스 | `/opt/quant-backtest-worker/current` |
| Worker 환경 파일 | `/etc/quant-platform/worker.env` |
| 잡 작업 디렉터리 | `/var/lib/quant-backtest-worker` |
| systemd unit | `/etc/systemd/system/quant-backtest-worker.service` |

웹 서버의 `/opt/quant-platform` 경로와 분리하면 같은 PC에서 두 서비스를 실행하더라도 릴리스 전환과 정리 작업이 서로 영향을 주지 않는다.

## 4. 부트스트랩 설계

### 4.1 실행 인터페이스

비대화형 실행 예시는 다음과 같다.

```bash
QP_WORKER_HOST=ubuntu@203.0.113.20 \
SSH_KEY="$HOME/.ssh/worker.pem" \
QP_WORKER_ENV_FILE="$HOME/.config/quant-platform/worker-1.env" \
./scripts/bootstrap-worker.sh
```

환경 파일은 저장소 밖에 두며 최소한 다음 값을 포함한다.

```dotenv
NODE_ENV=production
BACKTEST_SERVER_URL=https://example.com
BACKTEST_WORKER_TOKEN=<server와 같은 token>
BACKTEST_WORKER_ID=lightsail-worker-1
BACKTEST_WORKER_CONCURRENCY=1
BACKTEST_WORK_ROOT=/var/lib/quant-backtest-worker
BACKTEST_CLAIM_WAIT_MS=1000
BACKTEST_HEARTBEAT_MS=15000
LOG_LEVEL=info
```

`REMOTE_BACKTEST_LEASE_SECONDS`와 `REMOTE_BACKTEST_MAX_ATTEMPTS`는 Worker가 아니라 잡을 소유하고 재할당하는 웹/API 서버 설정이므로 `app.env`에 유지한다.

### 4.2 로컬 bootstrap의 책임

`scripts/bootstrap-worker.sh`는 다음 순서로 동작한다.

1. `QP_WORKER_HOST`, SSH 키, 로컬 환경 파일의 존재와 권한을 검사한다.
2. 대상 호스트에 SSH 연결과 비대화형 `sudo`가 가능한지 확인한다.
3. provision 스크립트, systemd unit, 임시 환경 파일을 업로드한다.
4. 원격 `infra/provision-worker.sh`를 실행한다.
5. systemd unit이 설치되고 환경 파일 권한이 `root:root 0600`인지 검증한다.
6. 릴리스가 아직 없다면 서비스를 enable만 하고 시작하지 않는다.
7. 임시 로컬·원격 환경 파일을 성공 여부와 관계없이 제거한다.

토큰은 명령행 인수로 전달하거나 로그에 출력하지 않는다. 로컬 임시 파일은 `mktemp`로 만들고 `0600` 권한을 적용한 뒤 `scp`와 원격 `install`을 사용한다.

### 4.3 원격 provision의 책임

`infra/provision-worker.sh`는 기존 웹 서버 provision과 분리하고 다음 작업만 수행한다.

- 지원 OS와 CPU 아키텍처 검사
- 필수 패키지 및 고정 버전 Node.js 설치와 checksum 검증
- 로그인할 수 없는 `quant-worker` 시스템 계정 생성
- Worker 전용 release, current, work-root 경로 생성
- work-root를 `quant-worker:quant-worker 0700`으로 설정
- systemd unit 설치 및 daemon reload
- 신규 환경 파일을 `root:root 0600`으로 설치
- 이미 환경 파일이 있으면 보존하고 명시적인 교체 옵션 없이는 실패 처리
- 필요 시 방화벽의 인바운드를 SSH로 제한하되, HTTPS 아웃바운드는 허용

다음 작업은 하지 않는다.

- Caddy 설치 또는 인증서 설정
- SQLite DB 생성, snapshot 또는 migration
- 웹 서비스 포트 개방
- 애플리케이션 릴리스 빌드
- Worker 토큰 자동 생성

## 5. 릴리스 산출물 설계

`scripts/build-release.sh`가 웹 서버와 Worker의 공통 산출물을 한 번 생성한다.

1. tracked 및 untracked 소스 변경이 없는지 확인한다.
2. `pnpm install --frozen-lockfile`과 lint, typecheck, test, build 검증을 실행한다.
3. 현재 Git SHA와 빌드 시각을 `dist/build-info.json`에 기록한다.
4. `dist`, `migrations`, `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`을 archive로 만든다.
5. archive의 SHA-256 checksum을 함께 출력한다.

Worker가 `public`이나 DB migration을 사용하지 않더라도, v1에서는 서비스별 산출물을 따로 만드는 대신 동일 archive를 사용한다. 이 방식은 서버와 Worker의 코드 SHA가 달라지는 실수를 줄이고 빌드 경로를 단순하게 한다. 산출물 크기가 실제 운영 병목이 되는 경우에만 Worker 전용 archive를 후속 검토한다.

`scripts/deploy.sh`와 `scripts/deploy-worker.sh`는 다음 입력을 지원한다.

- 직접 전달된 기존 archive와 checksum
- 입력이 없을 때 `scripts/build-release.sh`가 새로 만든 archive와 checksum

## 6. Worker 배포 설계

### 6.1 배포 순서

`scripts/deploy-worker.sh`는 v1에서 한 번에 호스트 한 대를 처리한다.

1. SSH, `sudo`, 환경 파일, systemd unit을 사전 검사한다.
2. 대상 호스트의 현재 `dist/build-info.json`을 읽는다.
3. 동일 Git SHA가 이미 실행 중이면 기본적으로 no-op 처리한다. 재배포는 명시적인 force 옵션으로만 허용한다.
4. archive와 checksum을 업로드하고 원격에서 checksum을 검증한다.
5. `/opt/quant-backtest-worker/releases/<release>`에 압축을 해제한다.
6. production dependency를 frozen lockfile로 설치한다.
7. 현재 symlink 대상을 이전 릴리스로 기록한다.
8. Worker를 중지하고 `current` symlink를 원자적으로 새 릴리스로 전환한다.
9. Worker를 시작한 뒤 systemd 상태와 원격 연결 probe를 확인한다.
10. 실패하면 이전 symlink로 되돌리고 서비스를 재시작한다.
11. 성공하면 최근 3개 릴리스만 보존하고 업로드 archive를 제거한다.

웹 서버 배포와 달리 DB snapshot, migration, Caddy 상태 확인은 실행하지 않는다.

### 6.2 readiness와 버전 확인

`systemctl is-active`만으로는 정상 배포를 판정할 수 없다. 현재 supervisor는 다음 오류가 있어도 프로세스를 종료하지 않고 재시도할 수 있기 때문이다.

- 잘못된 `BACKTEST_WORKER_TOKEN`
- 서버와 Worker의 Git SHA 불일치
- protocol version 불일치
- 잘못된 서버 URL

따라서 웹/API 서버에 잡을 claim하지 않는 인증된 probe를 추가한다.

```http
POST /api/internal/workers/probe
Authorization: Bearer <BACKTEST_WORKER_TOKEN>
Content-Type: application/json

{
  "workerId": "lightsail-worker-1",
  "runnerVersion": "<git-sha>",
  "protocolVersion": 1
}
```

probe는 토큰, 원격 Worker 모드, 서버가 기대하는 Git SHA 및 protocol version을 확인한다. 배포 스크립트는 systemd의 환경 파일을 읽는 Worker supervisor의 one-shot `--check` 모드를 실행해 이 endpoint를 호출한다. 토큰을 curl 인수나 배포 로그에 노출하지 않는다.

판정 기준은 다음과 같다.

| 결과 | 배포 판정 |
| --- | --- |
| 인증·SHA·protocol 일치 | 성공 |
| 서버가 local 모드 | `STANDBY`로 보고하고 배포 성공, Worker 서비스는 대기 상태 유지 |
| HTTP 401/403 | 실패 및 롤백 |
| SHA 또는 protocol 불일치 | 실패 및 롤백 |
| 연결 시간 초과 | 제한 횟수 재시도 후 실패 및 롤백 |

### 6.3 실행 중인 잡 처리

v1에서는 배포 전에 새 claim을 차단하는 drain protocol을 추가하지 않는다. 서비스가 종료되면 실행 중 잡은 heartbeat가 멈추고 lease 만료 뒤 기존 재시도 정책에 따라 다시 배정된다. 결과 유실은 막지만 진행 중 계산량은 낭비될 수 있으므로 배포 스크립트가 실행 중 잡 가능성을 경고하고 로그에 남긴다.

다음 단계에서는 `DRAINING` 상태, 현재 실행 수 확인, grace timeout을 protocol에 추가한다. 서버가 여러 대가 되기 전에는 강제 종료의 운영 복잡도보다 현재 lease 복구 방식을 우선한다.

## 7. 보안 및 장애 대응

- `/etc/quant-platform/worker.env`는 `root:root 0600`으로 유지한다.
- bootstrap과 deploy는 `set -x`를 사용하지 않으며 토큰 값 자체를 출력하지 않는다.
- Worker는 외부 인바운드 애플리케이션 포트를 열지 않고 웹/API 서버로 HTTPS outbound 연결만 한다.
- archive는 전송 후 원격 SHA-256 검증을 통과해야만 압축을 해제한다.
- 새 릴리스 probe가 실패하면 이전 릴리스 symlink와 서비스를 자동 복구한다.
- bootstrap 재실행 시 기존 환경 파일을 보존한다. 토큰 교체는 명시적인 replace 옵션과 별도 백업을 거친다.
- systemd sandboxing의 쓰기 허용 경로는 `/var/lib/quant-backtest-worker`로 한정한다.
- Worker 호스트 장애 시 웹/API 서버가 lease 만료 후 잡을 재시도하며, 자동 local fallback은 이 배포 설계에 포함하지 않는다.

## 8. 파일 변경 계획

아래 표는 **이번 문서 추가**와 **후속 구현 시 필요한 코드 변경**을 함께 나타낸다. 구현 단계에서는 각 항목을 다시 코드 흐름과 대조하며, 불필요해진 파일은 만들지 않는다.

### 8.1 추가

| 파일 | 시점 | 목적 |
| --- | --- | --- |
| `docs/reviews/REMOTE_BACKTEST_WORKER_DEPLOYMENT_DESIGN.md` | 이번 작업 | 본 부트스트랩·배포 설계 기록 |
| `scripts/bootstrap-worker.sh` | 후속 구현 | 로컬에서 신규 Worker 호스트 초기화 orchestration |
| `infra/provision-worker.sh` | 후속 구현 | Worker 전용 OS 패키지, 계정, 경로, systemd 준비 |
| `scripts/deploy-worker.sh` | 후속 구현 | Worker release 전환, probe, rollback, 정리 |
| `scripts/build-release.sh` | 후속 구현 | 웹/API 서버와 Worker가 공유하는 검증된 release archive 생성 |
| `scripts/lib/remote-host.sh` | 후속 구현 | SSH 옵션, 연결 확인, 업로드 등 공통 shell 함수 |
| `tests/unit/worker-bootstrap-script.test.ts` | 후속 구현 | bootstrap 멱등성, 환경 파일 보존, 비밀값 비노출 검증 |
| `tests/unit/worker-deploy-script.test.ts` | 후속 구현 | checksum, no-op, 전환, probe 실패 rollback 검증 |
| `tests/unit/release-artifact-script.test.ts` | 후속 구현 | clean tree, build-info, archive 및 checksum 검증 |

### 8.2 변경

| 파일 | 변경 내용 |
| --- | --- |
| `scripts/bootstrap.sh` | 중복 SSH 처리를 공통 helper로 이동하되 기존 웹 서버 bootstrap 동작은 유지 |
| `scripts/deploy.sh` | 빌드·archive 생성을 공통 스크립트로 이동하고 기존 DB migration·rollback 흐름은 유지 |
| `infra/systemd/quant-backtest-worker.service` | 실행 및 읽기 전용 경로를 `/opt/quant-backtest-worker/current`로 분리 |
| `infra/worker.env.example` | 자동 bootstrap 사용법, 저장소 밖 원본 환경 파일, 기본 동시성 1을 명시 |
| `src/server/modules/backtest/presentation/remote-worker-routes.ts` | claim 없는 인증·릴리스 호환성 probe endpoint 추가 |
| `src/workers/remote-backtest-supervisor.ts` | systemd 환경을 사용하는 one-shot `--check` 모드 추가 |
| `tests/integration/remote-worker.test.ts` | probe 인증, 모드, SHA 및 protocol 판정 통합 테스트 추가 |
| `tests/unit/deploy-script.test.ts` | 공통 release builder 추출 뒤 기존 웹 배포 회귀 테스트 보강 |
| `docs/REMOTE_WORKER_OPERATIONS.md` | 수동 설치 절차를 bootstrap/deploy 중심 운영 절차로 교체하고 복구법 기록 |
| `README.md` | Worker 서버 초기화·배포 명령과 관련 운영 문서 링크 추가 |
| `docs/IMPLEMENTATION_STATUS.md` | 구현 완료 시 자동화 범위와 남은 drain/fleet 과제를 갱신 |

### 8.3 삭제

| 파일 | 사유 |
| --- | --- |
| 없음 | 기존 수동 운영 문서는 삭제하지 않고 자동화된 절차와 장애 복구 가이드로 갱신한다. |

## 9. 검증 계획

### 9.1 정적 검증

- `bash -n scripts/bootstrap-worker.sh scripts/deploy-worker.sh scripts/build-release.sh`
- `sh -n infra/provision-worker.sh`
- shellcheck 적용이 가능한 환경에서는 신규 shell 파일 전체 검사
- `pnpm lint`, `pnpm typecheck`

### 9.2 자동 테스트

기존 `tests/unit/deploy-script.test.ts`처럼 외부 명령을 mock해 다음을 검증한다.

- 기존 환경 파일이 bootstrap 재실행으로 변경되지 않는다.
- 임시 환경 파일이 성공·실패 경로 모두에서 제거된다.
- 로그와 오류 메시지에 `BACKTEST_WORKER_TOKEN` 값이 포함되지 않는다.
- checksum 불일치 archive는 release 디렉터리에 설치되지 않는다.
- 동일 Git SHA는 no-op이고 force 옵션에서만 재배포된다.
- 새 릴리스 시작 또는 probe 실패 시 이전 symlink가 복구된다.
- 성공 후 최근 3개 릴리스만 유지한다.
- probe가 잘못된 토큰, SHA, protocol을 거부하고 local 모드는 `STANDBY`로 반환한다.
- 웹 서버 deploy의 DB snapshot, migration, rollback 동작이 공통 코드 추출 뒤에도 유지된다.

### 9.3 실제 호스트 수용 기준

- 깨끗한 Ubuntu/Debian x86_64 호스트에서 bootstrap을 두 번 실행해도 결과가 동일하다.
- `/etc/quant-platform/worker.env`가 `root:root 0600`이고 두 번째 실행에서 덮어써지지 않는다.
- 배포된 `dist/build-info.json`의 Git SHA가 웹/API 서버와 같다.
- 전송 archive checksum이 로컬과 원격에서 같다.
- `quant-backtest-worker.service`가 active이고 인증된 probe가 성공한다.
- 의도적으로 잘못된 release를 배포하면 직전 release로 자동 복구된다.
- Worker 호스트에 Caddy, 애플리케이션 DB, migration 작업이 추가되지 않는다.
- 기본 동시성이 1이며 CPU·메모리 압박 없이 난수 실험 잡을 순차 claim한다.

## 10. 단계별 구현 순서

1. 공통 release builder와 회귀 테스트를 추가한다.
2. Worker 전용 provision 및 bootstrap과 테스트를 추가한다.
3. systemd 경로를 Worker 전용 release 경로로 전환한다.
4. 서버 probe와 supervisor `--check` 모드 및 통합 테스트를 추가한다.
5. Worker deploy, checksum, rollback 테스트를 추가한다.
6. 실제 Lightsail 테스트 호스트에서 수용 기준을 검증한다.
7. 운영 문서와 README를 자동화된 명령 기준으로 갱신한다.

v1 완료 뒤에만 다중 호스트 inventory, 순차/병렬 fleet 배포, drain protocol, 자동 확장 및 이미지 기반 프로비저닝을 후속 설계한다.
