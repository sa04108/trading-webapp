# GitHub Actions에서 운영 배포

`.github/workflows/deploy.yml`은 GitHub-hosted Ubuntu 24.04 x64에서 `main`을 운영 환경에 배포한다. 배포는 수동으로만 시작하며, 기존 `pnpm run deploy` 전체 검증·패키징·SSH 배포 경로를 실행한다. PR이나 push는 배포를 시작하지 않는다. 실행을 요청한 커밋 SHA를 체크아웃하므로 대기 중 `main`에 새 커밋이 생겨도 배포 대상을 바꾸지 않는다.

## 처음 한 번 설정하기

먼저 이 워크플로와 문서를 `main`에 병합한다. GitHub는 `workflow_dispatch` 워크플로가 기본 브랜치에 올라온 뒤 수동 실행을 허용한다. 저장소의 **Settings → Environments**에서 `production` 환경을 만들고 배포 허용 브랜치를 `main`으로 제한한 뒤 다음 값을 등록한다.

| 종류 | 이름 | 값 |
| --- | --- | --- |
| Variable | `DEPLOY_HOST` | 서버 hostname 또는 IPv4 주소만. 사용자명, 프로토콜, 포트는 넣지 않는다. |
| Variable | `DEPLOY_USER` | SSH 사용자명 |
| Variable | `DEPLOY_PORT` | SSH 포트. 비우면 22를 사용한다. |
| Secret | `DEPLOY_SSH_KEY` | 비대화형 SSH에 사용할 전용 개인 키 전체. 암호가 없는 키를 사용한다. |
| Secret | `DEPLOY_KNOWN_HOSTS` | 신뢰할 수 있는 관리 경로로 확인한 서버 host key가 포함된 `known_hosts` 행 |

서버에는 이 공개키를 `DEPLOY_USER`의 `authorized_keys`에 등록한다. 해당 사용자는 기존 운영 설치의 배포 명령에 대해 `sudo -n`을 수행할 수 있어야 한다. 서버의 `/etc/quant-platform/app.env`, systemd 서비스와 배포용 디렉터리는 기존 운영 설정대로 준비한다. 워크플로는 사용자·키·서버를 만들거나 서버를 프로비저닝하지 않는다.

`DEPLOY_KNOWN_HOSTS`에는 실제 host key 행을 저장한다. 기본 포트는 `host.example.com ssh-ed25519 ...` 형식이며, 다른 포트는 `[host.example.com]:2222 ssh-ed25519 ...` 형식이다. 지문과 키는 서버 관리자나 별도의 신뢰된 채널을 통해 검증한다. 워크플로는 `ssh-keyscan` 결과를 확인 없이 신뢰하지 않으며 SSH host key 검사를 끄지 않는다.

운영 서버는 GitHub-hosted runner에서 SSH로 접근 가능해야 한다. 첫 워크플로는 SSH jump host나 사설망 터널을 지원하지 않는다. 서버 방화벽이 고정 출발지 IP만 허용한다면 러너의 접속 경로를 먼저 준비한다. runner는 Ubuntu 24.04 x64, Node 24와 `package.json`의 `packageManager`에 지정된 pnpm을 사용한다. 따라서 게시하는 Agent도 Linux x64용이다. Agent 장치의 glibc는 패키지에 기록된 최소 버전과 호환되어야 한다.

개인키와 `known_hosts`는 러너 임시 디렉터리에 권한 `600`으로 만들고, 키 경로만 저장한 `deploy.env`는 기존 Git 제외 규칙을 따른다. 성공·실패 후 정리 단계에서 이 파일들을 삭제하며 artifact로 업로드하지 않는다.

## 배포 실행

GitHub의 **Actions → Deploy production → Run workflow**에서 브랜치를 `main`으로 선택하고 실행한다. 워크플로 job은 `refs/heads/main`에서만 배포 단계에 진입한다. 실행 로그는 Actions의 해당 run에서 확인한다. job의 실행 시간 제한은 60분이며, 초과하면 실행이 취소되므로 서버 상태를 확인해야 한다.

외부 자동화에서 시작하려면 `main`에 병합된 뒤 `workflow_dispatch` API를 호출한다.

```bash
curl --fail-with-body --request POST \
  --url https://api.github.com/repos/sa04108/trading-webapp/actions/workflows/deploy.yml/dispatches \
  --header 'Accept: application/vnd.github+json' \
  --header 'Content-Type: application/json' \
  --header "Authorization: Bearer $GH_TOKEN" \
  --header 'X-GitHub-Api-Version: 2022-11-28' \
  --data '{"ref":"main"}'
```

`GH_TOKEN`은 안전한 비밀 저장소에서 가져온 fine-grained PAT로 설정한다. 해당 저장소에만 한정하고 Actions read/write 권한을 부여한다. 클라우드 환경에서는 `api.github.com`을 허용 목적지로 하는 Secret에 등록해 이 HTTPS 호출에 사용한다. 토큰을 명령에 직접 적거나 문서·로그에 저장하지 않는다. 이 PAT는 API에서 실행을 요청하고 결과를 조회할 때만 필요하다. Actions 워크플로의 서버 접속은 `DEPLOY_SSH_KEY`로 인증하므로 PAT를 workflow secret으로 추가할 필요가 없다. API의 성공 응답은 실행 요청 접수이며, 실제 배포 성공 여부는 Actions run의 최종 결과와 로그로 확인한다.

## 배포와 복구

기존 `pnpm run deploy`가 의존성을 설치하고 lint, typecheck, 전체 Vitest, 서버·웹 빌드, Linux x64 Agent 패키징과 `test:agent-package`를 완료한 뒤 SSH로 배포한다. 패키지 검증은 loopback 테스트 서버와 fixture 데이터를 사용하므로 공급자 API 자격증명은 필요하지 않다. Agent 패키지의 의존성 설치는 앞선 frozen install이 채운 pnpm store를 사용해 오프라인으로 실행한다. E2E는 기존 배포 검증에 포함되지 않는다.

워크플로는 DB 파일이나 운영 `app.env`를 GitHub로 업로드하지 않는다. 기존 원격 배포 스크립트가 서버에서 운영 DB 세트를 백업하고 `db:prepare`, 서비스 재시작, readiness 확인을 수행하며 실패 경로의 복구를 관리한다. 성공한 배포는 기존 스크립트의 백업 보존·정리 정책을 따른다.

같은 `quant-platform-production` 동시성 그룹의 배포는 동시에 진행되지 않으며, 실행 중인 배포는 새 실행 때문에 취소되지 않는다. 대기 실행을 순서가 보장되는 큐로 취급하지 않는다. 실행을 강제로 취소하는 것은 서버에서 배포를 되돌리는 절차가 아니므로 진행 중인 run의 로그와 서버 상태를 먼저 확인한다. 정상 배포 후에는 [운영 readiness 확인](../README.md#36-정상-동작-확인과-첫-실행)을 수행한다.
