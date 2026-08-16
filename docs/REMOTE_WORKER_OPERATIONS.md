# 원격 백테스트 Docker Worker 운영

웹/API·큐·최종 DB는 Lightsail control plane에 남기고 계산만 별도 Linux PC의 Docker
container로 보낸다. 기본값은 계속 local 동시성 1이다. 아래 전환을 하지 않으면 기존
배포 동작은 바뀌지 않는다.

## 실행 계약

- Worker 운영 경로는 Docker Compose 하나다. 애플리케이션 systemd unit은 없다.
- Server와 Worker에는 한 번 만든 같은 release archive의 `dist`를 배포한다.
- Worker는 인바운드 port와 server DB 권한이 필요 없다. Server HTTPS outbound만 쓴다.
- 공유 token은 server `/etc/quant-platform/app.env`와 worker
  `/etc/quant-platform/worker.env`에만 두며 두 파일 모두 `root:root 0600`이다.
- Remote 병렬도는 모든 Worker의 `BACKTEST_WORKER_CONCURRENCY` 합이다. 처음에는 호스트당
  1로 시작한다.
- Worker host v1은 Ubuntu/Debian amd64다. 개발 PC에는 linux/amd64 image를 만들 수 있는
  Docker Engine/Buildx가 필요하다.

## 1. Worker 환경 파일 준비

저장소 밖에 다음 파일을 만들고 `chmod 600`을 적용한다.

```dotenv
NODE_ENV=production
BACKTEST_SERVER_URL=https://quant.example.com
BACKTEST_WORKER_TOKEN=<server app.env와 같은 32자 이상 난수>
BACKTEST_WORKER_ID=worker-pc-1
BACKTEST_WORKER_CONCURRENCY=1
BACKTEST_WORK_ROOT=/var/lib/quant-backtest-worker
BACKTEST_CLAIM_WAIT_SECONDS=25
BACKTEST_HEARTBEAT_SECONDS=5
LOG_LEVEL=info
```

server가 아직 local이어도 배포 probe를 받으려면 server `app.env`에 같은
`BACKTEST_WORKER_TOKEN`을 넣고 server를 재시작한다. local에서는 probe만 `STANDBY`로
응답하며 Worker가 잡을 가져가는 API는 열리지 않는다.

## 2. Worker 호스트 부트스트랩

```bash
QP_WORKER_HOST=ubuntu@203.0.113.20 \
SSH_KEY="$HOME/.ssh/worker.pem" \
QP_WORKER_ENV_FILE="$HOME/.config/quant-platform/worker-1.env" \
./scripts/bootstrap-worker.sh
```

이 명령은 Docker Engine과 Compose plugin, 전용 경로, Compose 파일, env를 설치한다.
Node.js·Caddy·DB·Worker systemd unit은 호스트에 설치하지 않으며 첫 image 배포 전에는
container를 시작하지 않는다.

기존 env와 내용이 다르면 bootstrap은 덮어쓰지 않고 실패한다. 의도한 교체만 다음처럼
허용한다. 이전 파일은 `/etc/quant-platform/worker.env.bak` 하나로 원자적으로 갱신하며,
처음 교체할 때 기존 타임스탬프 형식의 백업도 제거한다.

```bash
QP_REPLACE_WORKER_ENV=1 \
QP_WORKER_HOST=ubuntu@203.0.113.20 \
QP_WORKER_ENV_FILE="$HOME/.config/quant-platform/worker-1.env" \
./scripts/bootstrap-worker.sh
```

## 3. 동일 release를 server와 Worker에 배포

한 번만 검증·빌드한 archive를 양쪽 deploy에 전달한다.

```bash
artifact_dir="$(mktemp -d)"
source scripts/build-release.sh
build_release "$artifact_dir"

QP_HOST=ubuntu@server.example.com \
QP_RELEASE_ARCHIVE="$RELEASE_ARCHIVE" \
QP_RELEASE_CHECKSUM="$RELEASE_CHECKSUM" \
./scripts/deploy.sh

QP_WORKER_HOST=ubuntu@203.0.113.20 \
QP_RELEASE_ARCHIVE="$RELEASE_ARCHIVE" \
QP_RELEASE_CHECKSUM="$RELEASE_CHECKSUM" \
./scripts/deploy-worker.sh
```

각 deploy를 따로 실행해도 입력이 없으면 builder를 호출하지만, 같은 archive를 명시해야
빌드 바이트까지 하나임이 보장된다. Worker deploy는 로컬에서 linux/amd64 image를 만든
뒤 tar/checksum으로 전송한다. registry 계정은 필요 없다.

같은 Git SHA가 이미 실행 중이고 probe도 성공하면 no-op한다. 같은 SHA를 명시적으로 다시
배포할 때만 `QP_FORCE_WORKER_DEPLOY=1`을 쓴다.

새 container 시작 또는 인증·SHA·protocol probe가 실패하면 이전 image와 Compose 설정으로
자동 롤백한다. 실행 중 잡은 drain하지 않으므로 가능하면 배포 전에 완료를 기다린다. 중간에
종료된 잡은 heartbeat lease 만료 뒤 서버가 재시도한다.

## 4. remote 모드 전환과 확인

server `app.env`를 다음처럼 바꾸고 server를 재시작한다.

```dotenv
BACKTEST_EXECUTION_MODE=remote
BACKTEST_WORKER_TOKEN=<worker.env와 같은 값>
REMOTE_BACKTEST_LEASE_SECONDS=60
REMOTE_BACKTEST_MAX_ATTEMPTS=3
```

```bash
sudo systemctl restart quant-platform
sudo docker ps --filter name=quant-backtest-worker
sudo docker logs --tail 100 quant-backtest-worker
```

Worker 로그의 `remote-worker.started`와 server journal의 claim/완료 감사 기록을 확인한다.
Worker container에는 port mapping이 없어 `docker ps`의 PORTS가 비어 있어야 한다.

## 5. 병렬도·token·URL 변경

저장소 밖 원본 `worker.env`를 수정하고 `QP_REPLACE_WORKER_ENV=1`로 bootstrap을 다시 실행한
뒤 container를 **재생성**한다. 단순 `docker restart`는 바뀐 env file을 다시 주입하지 않는다.

```bash
sudo docker compose \
  --project-directory /opt/quant-backtest-worker \
  --env-file /opt/quant-backtest-worker/compose.env \
  --file /opt/quant-backtest-worker/compose.yaml \
  up -d --no-build --force-recreate worker
```

병렬도 2는 계산 child 두 개를 뜻한다. 대표 입력의 telemetry p95 RSS에 25% 여유를 더한
메모리와 CPU slot을 확인하기 전에는 1을 유지한다. token 회전은 server와 모든 Worker
env를 함께 갱신하며 전환 중 값이 다른 Worker는 401로 claim하지 못한다.

## 6. 장애와 수동 롤백

- Worker나 네트워크가 끊기면 lease 만료 뒤 같은 잡이 attempt 상한까지 재시도된다.
- 늦게 도착한 이전 attempt 결과는 서버가 거부한다.
- server만 재시작해도 유효한 remote lease는 보존된다.
- local로 돌아갈 때는 server를 local로 바꾸기 전에 Worker container를 중지한다. 활성 remote
  lease는 `INTERRUPTED`가 되며 필요한 잡은 UI에서 복제한다.

보존된 image는 다음으로 확인한다.

```bash
sudo docker image ls quant-platform-backtest-worker
```

수동 롤백은 원하는 tag를 `/opt/quant-backtest-worker/compose.env`의
`QP_WORKER_IMAGE=`에 기록하고 위 Compose 재생성 명령을 실행한 뒤 probe한다.

```bash
sudo docker exec quant-backtest-worker \
  node /app/dist/workers/remote-backtest-supervisor.js --check
```

`READY` 또는 local 전환 중 `STANDBY`가 성공이다. image 정리는 이 repository의 timestamp
release tag 최근 3개만 대상으로 하며 다른 image와 build cache는 건드리지 않는다.
