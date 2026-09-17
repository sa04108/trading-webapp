# 단일 서버 배포

`pnpm run deploy`는 `bash scripts/deploy.sh`를 실행한다. `./scripts/deploy.sh`도 같은 동작이다. `deploy.mjs`, Node 조정 블록, 대상별 배포 스크립트 없이 이 파일이 직접 배포한다. Node는 기존 빌드 도구와 서버의 DB CLI를 실행할 때만 필요하다.

## 입력과 로그

저장소 루트의 `deploy.env`에서 `HOST`·`SSH_*`를 읽는다. 이름과 예시는 [deploy.env.example](../deploy.env.example)을 따른다. 파일을 셸 코드로 실행하지 않으며, 부모 환경변수로 접속 설정을 덮어쓰지 않는다. 한 줄 `KEY=value`, 바깥 작은따옴표/큰따옴표, 주석, `export` 접두사와 CRLF를 지원한다. 여러 줄 값·변수 확장·명령 치환은 사용하지 않는다. `SSH_OPTS`의 인용된 공백은 인자 하나로 보존한다.

과거 배포 스크립트와 같이 stdout·stderr를 `tee`로 화면과 `.logs/deploy-UTC시각.log`에 함께 남긴다. 환경변수 `LOG`로 위치를 바꿀 수 있다. 종료 시 임시파일을 정리하고 실패 코드와 로그 위치를 출력하며, `tee`가 마지막 출력까지 기록한 뒤 종료한다. 원격 서비스의 상태·종료 코드·journal도 실패 로그에 포함된다.

## 실행 순서

1. SSH 접속·필수 도구·운영 설정을 확인한다.
2. 기존 `build-release.sh`로 설치·lint·typecheck·전체 Vitest·서버/웹 빌드·에이전트 패키지 검증을 수행한다.
3. 릴리스·체크섬·`deploy.sh`를 임시 디렉터리에 업로드한다.
4. 한 번의 원격 Bash 실행이 잠금을 잡고 체크섬 확인 → staging 설치 → 서비스 중지 → 두 DB 백업 → 코드 전환 → `db:prepare` → 기동·readiness 확인을 수행한다.
5. 성공을 확정하고 정상 이력을 정리한다. 현재 코드와 복구 마커가 있는 자료는 보존한다.

`--remote`는 업로드된 스크립트의 내부 호출이며 배포 대상 선택이나 수동 단계 조정 인터페이스가 아니다. 잠금은 전체 원격 배포가 끝날 때까지 유지한다. 단계마다 SSH로 `prepare/verify/commit/finalize`를 지시하거나 새 transaction 상태 파일을 쓰지 않는다.

## 실패와 복구

전환 전 실패는 이전 서비스를 유지하거나 재기동한다. 전환 후 성공 확정 전 실패는 `db:restore`로 **운영 DB·계산 DB·백업 명세**를 검증해 코드와 함께 되돌린다. 최초 배포 실패는 새 코드 링크와 생성된 DB를 제거하고 서비스를 중지 상태로 둔다. 복원·검증·정리가 실패하면 대응 코드와 백업 세트를 보존한다. 성공 확정 후 이력 정리 실패만으로 정상 서비스를 롤백하지 않는다.

이전 배포 방식의 미완료 `deploy-transactions/*.state` 또는 현재 릴리스의 복구 마커가 있으면 새 배포는 중단한다. 기존 로그와 백업을 확인해 수동 복구한 뒤 재시도한다. 마커를 지우는 것만으로 복구가 완료된 것은 아니다. 운영 서비스명·`app.env`·두 DB의 경로는 그대로다.

## 회귀 검증

```bash
bash -n scripts/deploy.sh
node --test tests/deployment/deploy.test.mjs
pnpm exec vitest run tests/unit/deploy-script.test.ts tests/unit/deployment-entrypoints.test.ts
```

Node 내장 테스트는 프로젝트 패키지 없이도 실행할 수 있으며 Vitest 배포 게이트에서도 같은 검증을 호출한다. Bash·체크섬·압축·파일 조작·잠금은 실제로 실행하고, 운영 경로·SSH/SCP·sudo·서비스·DB CLI는 임시 환경으로 대체한다. 실제 서버 배포나 운영 DB 검증을 대신하지 않는다.

## 참고한 이력

`f537ee9eb497309615d60655d18ba13ed51a8124`에서 삭제되기 직전인 [`55170562`의 deploy-server.sh](https://github.com/sa04108/trading-webapp/blob/55170562bc4ca09591eef9ebc03a02184a060b79/scripts/deploy-server.sh)의 직접 Bash 배포·파일 로깅 구조를 참고했다. 당시의 단일 SQLite 파일 복사는 복원하지 않고 현재의 두 DB 백업·복원 계약을 유지한다.
