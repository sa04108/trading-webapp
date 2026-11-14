# GitHub Actions 이미지 게시와 배포

`.github/workflows/deploy.yml`의 **Publish images**는 `main` push와 수동 실행에서 해당 커밋을 검증하고 서버와 Agent 이미지를 GHCR에 게시한다. `devel` push와 PR은 게시하지 않는다. 일반 `main` push는 SSH로 서버에 접속하거나 서버를 배포하지 않는다.

Windows 설치기 시나리오, lint, typecheck, `pnpm test:all`, 빌드와 Agent 패키지 검사를 수행한다. amd64·arm64 Agent 이미지 `ghcr.io/sa04108/quant-agent:v-<agentVersion>`을 게시하고 실행을 확인한 뒤, 그 digest를 기본 Agent 이미지로 포함한 amd64 서버 이미지 `ghcr.io/sa04108/quant-platform:sha-<커밋 SHA>`를 게시하고 실행을 확인한다. 두 확인이 성공하면 각 이미지의 `latest` 별칭을 갱신한다. 서버 이미지는 같은 커밋의 Agent digest를 가리키며 이전 서버가 참조하는 이미지는 자동 삭제하지 않는다. 패키지를 로그인 없이 내려받으려면 GitHub Packages에서 두 패키지의 visibility를 Public으로 설정하고 저장소 Actions에 패키지 쓰기 권한을 부여한다.

## Docker 서버 업데이트

서버에서 저장소의 `scripts/server.sh`를 사용한다. 초기 설정과 운영 절차는 [Docker 서버 운영](DOCKER_SERVER.md)을 따른다.

```bash
bash scripts/server.sh init
bash scripts/server.sh up
bash scripts/server.sh update                    # 기본 이미지로 업데이트
bash scripts/server.sh update <서버 이미지>      # 명시한 이미지로 업데이트
bash scripts/server.sh status
bash scripts/server.sh logs
bash scripts/server.sh cli <명령>
bash scripts/server.sh stop
```

`pnpm run deploy`도 로컬 서버의 `server.sh update`를 실행한다. Compose의 기본 제한은 메모리 10 GiB와 CPU 3개다. Docker 업데이트는 DB 백업·복원이나 다운그레이드를 자동화하지 않는다. 업데이트가 중단되어 pending-update marker가 남으면 `up`과 CLI가 차단된다. 같은 후보로 업데이트를 재시도하거나 상태와 데이터를 확인해 운영자가 복구한다.

## 수동 systemd 배포

기존 systemd 서버에만 GitHub의 **Actions → Publish images → Run workflow**에서 `main`과 `runtime=systemd`를 선택한다. 기본 선택 `docker`는 이미지만 게시한다. systemd 선택 시 게시 검증 후 SSH 배포를 실행하며, `pnpm run deploy:systemd`는 같은 기존 SSH 배포 스크립트의 직접 실행 경로다. 두 job은 `main`에서만 실행된다. 실행 로그와 최종 결과를 Actions에서 확인한다.

SSH 배포를 사용할 때만 **Settings → Environments**에 `env-for-deploy` 환경을 만들고 허용 브랜치를 `main`으로 제한한 뒤 다음 값을 설정한다.

| 종류 | 이름 | 값 |
| --- | --- | --- |
| Variable | `DEPLOY_HOST` | 서버 hostname 또는 IPv4 주소 |
| Variable | `DEPLOY_USER` | SSH 사용자명 |
| Variable | `DEPLOY_PORT` | SSH 포트. 기본값 22 |
| Secret | `DEPLOY_SSH_KEY` | 암호 없는 전용 개인 키 전체 |
| Secret | `DEPLOY_KNOWN_HOSTS` | 신뢰할 수 있는 경로로 확인한 서버 host key 행 |

공개키를 서버의 `authorized_keys`에 등록하고 배포 계정에 기존 설치의 `sudo -n` 권한을 준비한다. 서버의 `/etc/quant-platform/app.env`, `network.env`, systemd 서비스와 배포 디렉터리는 [README의 초기 설정](../README.md#32-프로비저닝)으로 준비한다. 기존 Traefik 3.7.16의 file provider를 `/etc/traefik/dynamic`에 연결해야 한다. 기본 포트의 known_hosts 행은 `host.example.com ssh-ed25519 ...`, 다른 포트는 `[host.example.com]:2222 ssh-ed25519 ...` 형식이다. GitHub-hosted runner에서 SSH로 접근할 수 있어야 한다. 임시 키와 `deploy.env`는 실행 후 정리한다.

기존 systemd 배포 스크립트는 운영 서버의 DB 세트를 백업하고 `db:prepare`, 서비스 재시작과 readiness 확인을 수행하며 실패 시 복구를 관리한다. 이 백업 정책은 Docker 업데이트에 적용되지 않는다. `deploy.env`에는 SSH 접속 설정만 두고 서비스 비밀은 서버의 `app.env`에 둔다. 기존 systemd 서버의 Node 버전은 일반 앱 배포가 교체하지 않으므로 `.node-version`과 맞도록 별도로 관리한다.

동시 실행은 `quant-platform-production` 그룹으로 제한되며 실행 중인 작업은 새 실행 때문에 취소되지 않는다. 대기 실행의 순서는 보장되지 않는다. 실행을 강제로 취소한 경우 로그와 서버 상태를 확인한다.
