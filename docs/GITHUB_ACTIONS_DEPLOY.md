# GitHub Actions 이미지 게시와 배포

`.github/workflows/deploy.yml`의 **Publish images**는 `main` push와 수동 실행에서 해당 커밋을 검증하고 서버와 Agent 이미지를 GHCR에 게시한다. `devel` push와 PR은 게시하지 않는다. 일반 `main` push는 SSH로 서버에 접속하거나 서버를 배포하지 않는다.

Windows 설치기 시나리오, lint, typecheck, `pnpm test:all`, 빌드와 Agent 패키지 검사를 수행한다. amd64·arm64 Agent 이미지 `ghcr.io/sa04108/quant-agent:v-<agentVersion>`을 게시하고 실행을 확인한 뒤, 그 digest를 기본 Agent 이미지로 포함한 amd64 서버 이미지 `ghcr.io/sa04108/quant-platform:sha-<커밋 SHA>`를 게시하고 실행을 확인한다. 두 확인이 성공하면 각 이미지의 `latest` 별칭을 갱신한다. 서버 이미지는 같은 커밋의 Agent digest를 가리키며 이전 서버가 참조하는 이미지는 자동 삭제하지 않는다. 패키지를 로그인 없이 내려받으려면 GitHub Packages에서 두 패키지의 visibility를 Public으로 설정하고 저장소 Actions에 패키지 쓰기 권한을 부여한다.

## Docker 서버 업데이트

서버에서 저장소의 `scripts/server.sh`를 사용한다. 초기 설정은 `config.env`에서 관리한다. 설정과 운영 절차는 [Docker 서버 운영](DOCKER_SERVER.md)을 따른다.

```bash
bash scripts/server.sh init
bash scripts/server.sh validate                 # config.env 검증
bash scripts/server.sh up
bash scripts/server.sh update                    # 기본 이미지로 업데이트
bash scripts/server.sh update <서버 이미지>      # 명시한 이미지로 업데이트
bash scripts/server.sh status
bash scripts/server.sh logs
bash scripts/server.sh stop
bash scripts/server.sh cli <명령>
```

`pnpm run deploy`도 로컬 서버의 `server.sh update`를 실행한다. Compose의 기본 제한은 메모리 10 GiB와 CPU 3개다. Docker 업데이트는 DB 백업·복원이나 다운그레이드를 자동화하지 않는다. 업데이트가 중단되어 pending-update marker가 남으면 `up`과 CLI가 차단된다. 같은 후보로 업데이트를 재시도하거나 상태와 데이터를 확인해 운영자가 복구한다.

동시 실행은 `quant-platform-production` 그룹으로 제한되며 실행 중인 작업은 새 실행 때문에 취소되지 않는다. 대기 실행의 순서는 보장되지 않는다. 실행을 강제로 취소한 경우 로그와 이미지 게시 상태를 확인한다.
