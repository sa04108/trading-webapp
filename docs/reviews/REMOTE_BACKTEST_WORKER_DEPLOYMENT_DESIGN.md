# 원격 백테스트 Worker Docker 부트스트랩·배포 설계

> 기준일: 2026-08-16
>
> 상태: 구현 완료
>
> 대상: Ubuntu/Debian amd64 Worker 호스트 한 대씩 배포
>
> 운영 절차: [원격 Worker 운영 가이드](../REMOTE_WORKER_OPERATIONS.md)

## 1. 결정

원격 백테스트 Worker는 **Docker Compose로만** 배포한다. 애플리케이션 전용 systemd
unit과 fallback 경로는 두지 않는다. 호스트의 Docker daemon은 OS 서비스 관리자가
관리하지만 Worker 수명주기, 재시작, 로그 회전과 격리는 Compose가 담당한다.

웹/API 서버는 기존 systemd 배포를 유지한다. 두 실행 환경의 차이 때문에 소스나
TypeScript를 각각 빌드하지는 않는다. `scripts/build-release.sh`가 검증한 공통 release
archive를 한 번 만들고, 웹 서버는 archive를 직접 설치하며 Worker는 같은 archive를
Docker image에 포장한다.

Worker는 백테스트 전용이다. 자동매매 실행기는 주문 권한과 장애 격리가 필요하므로 같은
image나 Compose service에 합치지 않는다.

## 2. 구성

```text
개발 PC
├── scripts/build-release.sh          검증 → 공통 archive + SHA-256
├── scripts/deploy-server.sh          공통 archive → 웹/API 서버
├── scripts/build-worker-image.sh     공통 archive → linux/amd64 image tar
├── scripts/bootstrap-worker.sh       Worker 호스트 1회 준비
└── scripts/deploy-worker.sh          image load → Compose 전환 → probe/rollback

Worker 호스트
├── Docker Engine + Compose plugin
├── /opt/quant-backtest-worker/
│   ├── compose.yaml
│   ├── compose.env                   현재 immutable release image 참조
│   └── managed-paths.json            호스트 경로·수명주기 manifest
├── /etc/quant-platform/worker.env    root:root 0600
└── /var/lib/quant-backtest-worker    uid:gid 10001:10001, 0700
```

Worker에는 Node.js, Caddy, 애플리케이션 DB, migration/backup 작업, 애플리케이션
systemd unit을 설치하지 않는다. 인바운드 애플리케이션 포트도 열지 않는다.

## 3. 공통 release와 Worker image

`scripts/build-release.sh`는 다음을 수행한다.

1. tracked/untracked 변경이 없는 작업 트리인지 확인한다.
2. frozen install, lint, typecheck, test, build를 모두 통과시킨다.
3. 전체 Git SHA와 빌드 시각을 `dist/build-info.json`에 기록한다.
4. `dist`, `migrations`, package/lock/workspace 파일을 하나의 archive로 만든다.
5. archive의 SHA-256 checksum을 만든다.

`scripts/deploy-server.sh`와 `scripts/deploy-worker.sh`는 `QP_RELEASE_ARCHIVE`와
`QP_RELEASE_CHECKSUM`으로 기존 산출물을 받을 수 있다. 입력하지 않으면 각각 builder를
호출한다. 웹과 Worker에 정확히 같은 빌드 바이트를 배포하려면 builder를 한 번 실행하고
그 두 값을 양쪽 deploy에 전달한다.

`scripts/build-worker-image.sh`는 archive를 별도로 다시 컴파일하지 않는다. Docker build
단계에서는 production dependency만 target Linux ABI로 설치하고 공통 `dist`를 그대로
복사한다. Node build/runtime base image는 version과 multi-platform digest를 함께 고정한다.
image에는 Git SHA, 빌드 시각, release 이름을 OCI label로 기록한다. v1 배포물은
`linux/amd64` 하나다.

registry는 요구하지 않는다. 로컬에서 만든 content-addressed image를 `docker save`로
내보내고 tar checksum과 함께 SSH로 전송한 뒤 원격에서 `docker load`한다.

## 4. Worker 호스트 부트스트랩

환경 파일은 저장소 밖에 두고 mode 600 또는 400으로 제한한다.

```bash
QP_WORKER_HOST=ubuntu@203.0.113.20 \
SSH_KEY="$HOME/.ssh/worker.pem" \
QP_WORKER_ENV_FILE="$HOME/.config/quant-platform/worker-1.env" \
./scripts/bootstrap-worker.sh
```

필수 Worker 환경은 다음과 같다.

```dotenv
NODE_ENV=production
BACKTEST_SERVER_URL=https://quant.example.com
BACKTEST_WORKER_TOKEN=<server와 같은 32자 이상 token>
BACKTEST_WORKER_ID=worker-pc-1
BACKTEST_WORKER_CONCURRENCY=1
BACKTEST_WORK_ROOT=/var/lib/quant-backtest-worker
BACKTEST_CLAIM_WAIT_SECONDS=25
BACKTEST_HEARTBEAT_SECONDS=5
LOG_LEVEL=info
```

bootstrap은 SSH와 비대화형 sudo를 확인하고 provision/Compose/env 파일을 임시 원격
디렉터리에 올린다. 성공·실패와 관계없이 임시 디렉터리를 제거한다. 토큰 값은 명령행이나
로그에 출력하지 않는다. `infra/worker-host-manifest.json`도 함께 올려 root 소유 0644로
설치한다. manifest는 Worker 소유 영구 경로, 비정상 종료 때 남을 수 있는 임시 경로,
이전 형식의 경로 패턴, 공유 Docker 패키지·APT 설정을 서로 다른 수명주기로 기록한다.

`infra/provision-worker.sh`는 지원 OS/amd64를 확인하고 Docker 공식 apt repository에서
Engine, Buildx, Compose plugin을 설치한다. 전용 경로와 권한을 만든 뒤 Compose와 env를
설치하지만 image가 없으므로 서비스를 시작하지 않는다. 기존 env가 같으면 멱등하게
통과하고 다르면 보존한 채 실패한다. 명시적으로 교체할 때만 다음을 사용하며 기존 파일은
`/etc/quant-platform/worker.env.bak` 하나로 원자적으로 갱신한다. 처음 교체할 때 기존
타임스탬프 형식의 백업도 제거한다.

```bash
QP_REPLACE_WORKER_ENV=1 ... ./scripts/bootstrap-worker.sh
```

## 5. Compose 실행 경계

Compose service는 다음을 강제한다.

- 고정 container name과 replica 1
- `restart: unless-stopped`
- uid/gid 10001 non-root 실행
- read-only root filesystem, `/tmp` 제한 tmpfs
- work-root 하나만 writable bind mount
- 모든 Linux capability 제거와 `no-new-privileges`
- PID 상한 512, 로그 파일 10MB × 5 회전
- 인바운드 port mapping 없음
- `init: true`로 고아 child 회수
- `stop_grace_period: 30s`

30초 종료 유예는 supervisor가 child에 취소 IPC를 보낸 뒤 5초 SIGTERM, 10초 SIGKILL로
단계적으로 정리할 시간을 보장한다. 기본 10초를 사용하면 마지막 정리와 Docker의 강제
종료가 경합한다.

CPU·메모리 hard limit은 호스트마다 telemetry 근거가 달라 공통 Compose에 임의의 숫자로
고정하지 않는다. 기본 동시성은 1이다. 필요하면 대표 입력의 p95 RSS와 CPU slot을 확인해
호스트별 override로 제한하고 동시성을 올린다.

## 6. work-root 잠금과 정리

`/var/lib/quant-backtest-worker`는 임시 입력/결과를 담지만 디스크 용량 때문에 tmpfs로
두지 않는다. 컨테이너 entrypoint는 `.supervisor.lock` file descriptor에 non-blocking
`flock`을 잡은 뒤 Node를 `exec`한다. 같은 work-root를 두 supervisor가 공유하면 두 번째는
즉시 실패한다.

PID 파일은 사용하지 않는다. 서로 다른 PID namespace의 프로세스가 모두 PID 1일 수 있고,
SIGKILL 뒤 남은 PID 값은 새 컨테이너의 PID와 충돌할 수 있기 때문이다. `flock`은 프로세스가
어떤 방식으로 종료돼도 커널이 열린 descriptor와 함께 해제한다.

애플리케이션의 `.quant-backtest-worker-root` marker는 별도 목적이다. 지정 경로가 Worker
소유임을 확인한 뒤에만 시작 시 남은 `jobs/`를 재귀 삭제하게 해 잘못된 경로 설정을 막는다.

## 7. 배포, readiness, rollback

```bash
QP_WORKER_HOST=ubuntu@203.0.113.20 \
SSH_KEY="$HOME/.ssh/worker.pem" \
./scripts/deploy-worker.sh
```

배포 순서는 다음과 같다.

1. SSH/sudo, Docker/Compose, env/Compose 설치 상태를 확인한다.
2. 실행 중 Worker가 같은 Git SHA이면 인증된 one-shot probe까지 통과한 경우 no-op한다.
3. 공통 archive를 만들거나 전달받고 로컬 checksum을 검증한다.
4. `linux/amd64` Worker image를 만들고 image tar/checksum을 업로드한다.
5. 원격 checksum을 검증한 뒤에만 `docker load`한다.
6. image OCI revision label과 release Git SHA가 같은지 확인한다.
7. 이전 Compose와 image 참조를 보관하고 새 image로 container를 재생성한다.
8. 실행 중 container 안에서 supervisor `--check`를 최대 5회 실행한다.
9. 실패하면 이전 Compose/image로 재생성하고 이전 probe도 확인한다.
10. 성공하면 이 저장소의 Worker release tag만 최근 3개 보존한다.

강제 재배포는 `QP_FORCE_WORKER_DEPLOY=1`로만 허용한다. 정리 과정은 다른 repository의
image나 Docker build cache에 손대지 않는다.

readiness endpoint는 잡을 claim하지 않는다.

```http
POST /api/internal/workers/probe
Authorization: Bearer <BACKTEST_WORKER_TOKEN>
Content-Type: application/json

{
  "workerId": "worker-pc-1",
  "runnerVersion": "<full-git-sha>",
  "protocolVersion": 1
}
```

token, runner SHA, protocol이 모두 맞고 서버가 remote면 `READY`, local이면 `STANDBY`다.
local에서 probe를 사용하려면 server `app.env`에 같은 token을 미리 설정하고 서버를
재시작해야 한다. local 모드에서는 probe 외 claim/heartbeat/artifact route는 등록하지
않는다. 401/403, SHA/protocol mismatch, timeout은 배포 실패다.

## 8. 실행 중 잡과 후속 범위

v1에는 drain protocol이 없다. 배포로 container가 종료되면 실행 중 계산은 유실되고 서버가
lease 만료 뒤 같은 잡을 기존 정책대로 재할당한다. 결과 정확성은 유지되지만 계산량은
낭비될 수 있으므로 배포 전 실행 중 잡 여부를 운영자가 확인한다.

다중 호스트 inventory, fleet 순차 배포, `DRAINING`/graceful drain, 자동 확장은 후속 범위다.
Docker 외 실행 방식과 systemd Worker fallback은 후속 범위가 아니라 의도적으로 제거한
경로다.

## 9. 검증

- shell syntax: 신규 Bash/POSIX sh 전체
- release builder: clean identity, 모든 gate, build-info, archive checksum
- bootstrap: env mode/필수값, token 비노출, Docker-only 파일 업로드
- entrypoint: 동시 실행 거부와 SIGKILL 뒤 kernel lock 회수
- probe: 인증, local standby, remote ready, SHA/protocol mismatch, no-claim
- deploy: checksum-before-load, 동일 SHA no-op, probe, rollback, 보존 범위
- Docker: 실제 image build, non-root/read-only 실행, `--check`, signal 종료
- 전체 lint, typecheck, unit/integration test, production build
