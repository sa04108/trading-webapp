# 원격 백테스트 worker 운영

이 기능은 $7 Lightsail을 웹/API·큐·최종 DB의 control plane으로 남기고, CPU·메모리를 많이
쓰는 계산만 별도 Linux PC로 보낸다. 기본 설정은 계속 local 1개이므로 이 문서의 전환을
하지 않으면 현재 배포 동작은 바뀌지 않는다.

## 실행 계약

- Server와 worker에는 반드시 같은 Git SHA의 릴리스 아티팩트를 배포한다.
- Worker는 인바운드 포트나 server DB 접근 권한이 필요 없다. Server HTTPS 443 outbound만
  가능하면 된다.
- 공유 worker token은 server `/etc/quant-platform/app.env`와 worker
  `/etc/quant-platform/worker.env`에만 둔다. 두 파일 모두 `root:root`, mode `600`이다.
- `MAX_CONCURRENT_BACKTESTS`는 local 모드 전용이다. Remote 실제 동시 실행 수는 모든
  worker의 `BACKTEST_WORKER_CONCURRENCY` 합이다.
- Worker PC도 먼저 concurrency 1로 시작한다. 대표 입력 표본을 모은 뒤
  `backtest:telemetry-report`의 p95 RSS와 CPU 슬롯을 기준으로 올린다.

## 1. Worker 호스트 준비

Node 24와 동일 릴리스의 `dist/`, `migrations/`, `package.json`, lockfile 및 production
dependency를 `/opt/quant-platform/releases/<release>`에 설치한다. Server 배포물과 별도로
빌드하면 SHA가 엇갈릴 수 있으므로 server에 올린 배포 archive를 worker에도 복사하는 방식을
권장한다. 별도로 빌드해야 한다면 정확히 같은 commit에서 `pnpm build:server`를 실행하고,
`scripts/deploy.sh`와 같은 방식으로 그 commit SHA를 `dist/build-info.json`에 기록해야 한다.
이 파일이 없거나 `unknown`이면 production remote worker와 remote server는 기동을 거부한다.
`deploy.sh`는 같은 SHA에 서로 다른 dirty build가 생기지 않도록 깨끗한 작업 트리만 허용한다.

```bash
sudo useradd --system --home /nonexistent --shell /usr/sbin/nologin quant-worker
sudo install -d -o quant-worker -g quant-worker -m 700 /var/lib/quant-backtest-worker
sudo install -d -o root -g root -m 755 /etc/quant-platform
sudo install -o root -g root -m 600 infra/worker.env.example /etc/quant-platform/worker.env
sudo install -o root -g root -m 644 infra/systemd/quant-backtest-worker.service \
  /etc/systemd/system/quant-backtest-worker.service
```

`BACKTEST_WORK_ROOT`는 worker 전용 디렉터리여야 한다. Worker는 소유권 marker를 만들고,
marker가 없는데 `jobs` 외의 파일이 있거나 파일시스템 루트가 지정되면 정리 대신 기동을
거부한다.

`worker.env`의 URL·token·ID를 실제 값으로 바꾼다. Production URL은 HTTPS만 허용한다.
서버 app.env에는 아직 `BACKTEST_EXECUTION_MODE=local`을 유지한다.

## 2. 배포와 무중단에 가까운 전환

1. 실행 중인 local 백테스트가 모두 끝난 것을 확인한다.
2. 동일 릴리스를 server와 worker에 배포한다.
3. Worker service를 먼저 enable해도 된다. Server가 아직 local이면 내부 worker endpoint가
   404라서 작업을 가져가지 못하고 재시도한다.
4. Server app.env에 같은 token과 다음 값을 넣고 server를 재시작한다.

```dotenv
BACKTEST_EXECUTION_MODE=remote
BACKTEST_WORKER_TOKEN=<worker.env와 같은 값>
REMOTE_BACKTEST_LEASE_SECONDS=60
REMOTE_BACKTEST_MAX_ATTEMPTS=3
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now quant-backtest-worker
sudo systemctl restart quant-platform
```

Worker journal에서 `remote-worker.started`, server journal에서 claim/완료 감사 기록을 확인한다.

```bash
sudo systemctl status quant-backtest-worker --no-pager
sudo journalctl -u quant-backtest-worker -n 100 --no-pager
sudo journalctl -u quant-platform -n 100 --no-pager
```

## 3. 병렬도 변경

Worker PC의 `/etc/quant-platform/worker.env`에서 아래 값만 바꾸고 worker를 재시작한다.

```dotenv
BACKTEST_WORKER_CONCURRENCY=2
```

각 slot은 계산 child 하나를 만든다. 값 2는 worker 한 대에서 두 job을 동시에 실행한다는
뜻이다. 난수 실험 batch도 기존 queue 승격 규칙을 거친 뒤 빈 slot들이 병렬로 가져간다.
메모리 여유 없이 값을 올리면 OS 전체가 불안정해질 수 있으므로 server의 1GB 제약과 별개로
worker 전용 메모리 예산을 잡는다.

## 4. 장애·업데이트·되돌리기

- Worker가 죽거나 네트워크가 끊기면 lease 만료 뒤 같은 job이 최대 attempt까지 재시도된다.
  이전 attempt가 늦게 결과를 보내도 server가 거부한다.
- Server만 재시작하면 아직 유효한 remote lease는 보존되고 worker heartbeat가 이어받는다.
- 릴리스 업데이트는 worker를 먼저 멈추고 server·worker에 같은 아티팩트를 배포한 뒤 둘을
  시작한다. SHA가 다른 동안에는 claim이 409로 거부되므로 다른 엔진 결과가 섞이지 않는다.
- Local로 되돌리려면 worker를 멈춘 뒤 server app.env를 `local`로 바꾸고 재시작한다. 그때
  남아 있던 활성 remote lease는 `INTERRUPTED`가 되며 자동 재실행하지 않는다. 필요한 job은
  UI에서 복제한다.
- Token을 바꾸려면 server와 모든 worker env에 새 값을 배포하고 재시작한다. 전환 중 token이
  다른 worker는 401을 받고 작업을 확보하지 못한다.

Server input snapshot과 upload 임시 파일은 `TEMP_ROOT/remote-backtests` 아래에만 생긴다.
정상 완료·실패·취소에서 지우며, 재시도 claim 시 이전 attempt snapshot도 정리한다. Worker
job 디렉터리도 attempt 종료 시 지운다. 전원 장애나 강제 종료로 정리가 실행되지 않은
조각은 server와 worker가 다음에 시작할 때 제거한다. Server의 snapshot 생성과 결과
import는 각각 한 번에 하나만 별도 child에서 처리해 여러 worker slot이 Lightsail 웹 이벤트
루프를 동시에 압박하지 않게 한다.
