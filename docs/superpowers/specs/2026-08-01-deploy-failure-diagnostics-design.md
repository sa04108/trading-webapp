# 배포 실패 원인을 배포 로그에 남긴다

## 문제

`quant-platform.service` 는 애플리케이션의 stdout·stderr를 systemd journal에 보낸다.
반면 `scripts/deploy.sh`가 로컬에 보존하는 배포 로그에는 SSH 명령의 출력만 들어간다.
`Type=simple` 서비스는 프로세스 생성 직후 `systemctl restart`가 성공할 수 있으므로,
애플리케이션이 마이그레이션 중 종료되어도 배포 스크립트가 직접 받는 오류는 없다.

현재 실패 경로는 readiness 확인을 열 번 반복한 뒤 바로 롤백한다. 따라서 배포 로그에는
`curl: (7)`만 반복되고, journal에 기록된 실제 원인(예: `audit_logs already exists`)은
남지 않는다. 롤백도 재시작 직후 readiness를 확인하지 않고 성공했다고 출력한다.

## 목표

- 기동 또는 readiness 실패의 실제 애플리케이션 오류를 기존 배포 로그 하나에서 확인한다.
- 실패한 새 릴리스의 진단을 **롤백 전에** 수집한다.
- readiness 재시도 중 같은 `curl` 오류를 반복 출력하지 않는다.
- 롤백한 서비스도 readiness를 통과해야만 롤백 성공으로 기록한다.
- 진단 명령 자체의 실패가 원래 배포 실패나 롤백을 가리지 않게 한다.

## 범위 밖

- systemd 서비스 파일과 애플리케이션 로깅 방식은 바꾸지 않는다.
- 별도 로그 수집 서비스나 새 원격 배포 스크립트를 만들지 않는다.
- journal 전체를 내보내지 않고 이번 기동 시도 이후 기록만 수집한다.
- 마이그레이션을 사전 실행하거나 운영 DB를 별도로 변경하지 않는다.

## 검토한 접근

### 1. `deploy.sh` 실패 경로에서 journal 수집 — 채택

기존 SSH heredoc 안에 readiness와 진단 함수를 둔다. 현재 배포 구조를 유지하면서 원인이
사라지는 경계만 직접 연결한다. 변경 범위가 작고 로컬 `tee` 로그에도 자동으로 포함된다.

### 2. `journalctl -f`를 배포 내내 스트리밍

실시간성은 좋지만 종료 조건과 백그라운드 프로세스 정리가 복잡하다. 정상 배포에도 모든
요청 로그가 섞이고, SSH 종료가 journal follower에 매달릴 위험이 있어 채택하지 않는다.

### 3. 별도 원격 진단·배포 스크립트

테스트와 재사용은 쉬워지지만 파일 업로드·버전 정합성·권한 관리 대상이 하나 더 생긴다.
현재 필요한 것은 실패 경로 몇 줄의 관측성 보강이므로 과도하다.

## 설계

### Readiness 확인

`wait_for_ready` 함수가 기존과 같은 간격으로 내부 readiness 엔드포인트를 확인한다.
개별 시도의 `curl` stdout·stderr는 숨기고, 성공 여부만 반환한다. 모든 시도가 실패했을 때
호출부가 대상 릴리스와 함께 한 번만 실패 메시지를 출력한다.

### 실패 진단

새 릴리스를 재시작하기 직전에 UTC 시각을 기록한다. `print_service_diagnostics` 함수는
다음을 순서대로 출력한다.

1. 진단 단계(새 릴리스 실패 또는 롤백 실패)와 수집 시작 시각
2. `/opt/quant-platform/current`의 실제 대상과 `dist/build-info.json`
3. `systemctl show`의 `ActiveState`, `SubState`, `Result`, `ExecMainCode`,
   `ExecMainStatus`, `NRestarts`
4. `systemctl status --no-pager -l`
5. `journalctl -u quant-platform --since <기동 직전 시각> --no-pager -o short-iso`

각 진단 명령은 `|| true`로 감싸 원래 제어 흐름을 바꾸지 않는다. 비밀 환경변수나
`app.env` 내용은 출력하지 않는다.

### 실패와 롤백 순서

새 릴리스의 `systemctl restart` 또는 readiness가 실패하면 먼저 진단을 수집하고 그다음
기존 DB 스냅샷·심볼릭 링크를 복원한다. 롤백 재시작 직전에도 별도 시각을 기록하고 같은
`wait_for_ready`를 실행한다.

롤백 readiness가 성공하면 그때만 `rolled back`을 출력한다. 실패하면 롤백 진단도
수집하고 `rollback failed`를 명시한 뒤 비정상 종료한다. 원래 배포는 어느 경우든 실패로
끝나며, 성공한 롤백은 서비스 복구 상태만 설명한다.

## 테스트

- `deploy.sh`의 실패 진단 계약을 검사하는 Vitest 회귀 테스트를 추가한다.
  - journal 수집이 롤백보다 앞에 있는지
  - readiness 폴링이 반복 `curl` 오류를 숨기는지
  - 롤백 뒤에도 readiness를 다시 확인하는지
- 테스트를 먼저 실행해 현재 스크립트에서 기대한 이유로 실패하는 것을 확인한다.
- 구현 후 해당 테스트, `bash -n scripts/deploy.sh`, 전체 테스트·lint·typecheck를 실행한다.
- 운영 서비스를 고의로 실패시키는 검증은 하지 않는다.
