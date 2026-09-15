# Agent 실행 코드 경계 점검

## 결론

현재 `src/agent`는 상주 프로세스 역할로 나뉘어 있지만, 독립된 계산 패키지로 물리적으로
격리되어 있지는 않다. 백테스트와 유니버스 준비 worker가 `src/server`의 계산·DB 구현을
직접 가져온다. 서버 전체 Git SHA 대신 agent 실행 코드의 버전을 만들려면 이 공유 경계를
먼저 명시해야 한다.

## 현재 의존 관계

| 영역 | Agent가 사용하는 코드 | 현재 경계의 문제 |
| --- | --- | --- |
| 상주 프로세스 | `src/agent/client.ts`, 자원·캐시·설정·설치·업데이트 | DB와 빌드 정보를 서버 공용 디렉터리에서 참조한다. |
| 계산 진입점 | `backtest-child.ts`, `preparation-child.ts`, `preparation-runtime.ts`, `cancellation.ts` | `src/workers`에 서버 전용 결과 수신·스냅샷 게시 worker도 함께 있다. |
| 백테스트 | 엔진, 비용 모델, 전략, 입력 검증, 결과 파일 작성 | `src/server/modules/backtest`, `strategy` 등에 위치한다. |
| 유니버스 준비 | 준비 작업 조정, 유니버스 해석, 시장·재무 데이터 조회와 coverage | 서버용 코드와 같은 모듈에 있다. 수집 요청은 서버에 돌려보낸다. |
| 로컬 DB | `src/server/shared/db`, 작업 DB 스키마·운영 마이그레이션 | 작업 DB와 운영 서버 DB가 같은 스키마·초기화 코드를 쓴다. |
| 통신 규약 | `src/shared/agent-protocol.ts`, 요청·결과 스키마 | 공유 위치는 있지만 agent 전용 빌드나 패키지 경계 검증은 없다. |

`client.ts`는 경로로 두 계산 worker를 fork한다. 일반 import 그래프만 추적하면 이 진입점을
놓칠 수 있다. `database-layout.ts`의 상대 경로로 찾는 마이그레이션과 `dist/build-info.json`도
실행에 필요한 파일이다.

Agent는 `dataReadonly: true`로 게시된 계산 DB를 연다. 이 경로에서도 로컬 작업 DB를 위한
`migrations/operations`는 필요하지만, 게시 전 서버에서 적용한 `migrations/data`는 실행하지 않는다.
소스 그래프를 조사할 때는 `import type`으로만 쓰이는 서버 설정·수집 서비스도 실행 의존성으로
잘못 포함하지 않도록 주의해야 한다.

## 현재 패키지의 과도한 포함 범위

`scripts/build-agent-client.mjs`는 다음을 통째로 복사하거나 설치한다.

- `dist/server`, `dist/workers`, `dist/shared`, `dist/agent`와 소스맵
- `migrations` 전체
- 루트 `package.json`의 모든 운영 의존성

따라서 agent가 실행하지 않는 서버 bootstrap·HTTP 라우트·인증·주문 연동 코드,
`backtest-result-import-child`, `dataset-publish-child`도 패키지에 들어간다.
루트 의존성 때문에 Fastify와 React 등도 함께 설치된다. 계산 경로에서 실제로 사용하는
외부 패키지는 `better-sqlite3`, `drizzle-orm`, `pino`, `ulid`, `ws`, `zod`이며,
각 패키지의 하위 의존성과 네이티브 바이너리도 필요하다.

기존 `tests/architecture/module-boundaries.test.ts`는 계층 간 import 규칙을 검사한다.
다운로드 패키지에 서버 전용 코드가 들어가는지, agent 실행 의존성이 모두 포함되었는지는
검사하지 않는다.

이번 업데이트 명령은 `cli.ts`에서 처리하고 계산 연결은 `run`에서 지연 로드한다.
`--check`는 기존처럼 계산 런타임을 로드해 네이티브 모듈 로딩도 확인한다. 이 변경은 CLI 진입점을
분리한 것이며, 공유 계산 코드나 패키지 전체의 물리적 격리를 완료한 것은 아니다.

## 권장 분리 순서

1. Agent와 두 계산 worker를 명시적인 빌드 진입점으로 지정한다. 실행 import와 동적 worker,
   마이그레이션 등 필요한 파일만 패키지에 포함하고 별도 운영 의존성 목록을 둔다.
2. 서버와 agent 양쪽에서 쓰는 엔진·전략·유니버스 준비·데이터 조회·결과 작성 코드를
   공유 계산 디렉터리 또는 패키지로 옮긴다. 서버는 인증·수집·작업 배정·결과 수신을 맡는다.
3. Agent와 공유 계산 코드에서 서버 전용 구현을 가져오지 못하도록 경계 검사를 추가하고,
   생성된 패키지로 준비 작업과 백테스트를 실제 실행하는 검증을 둔다.
4. 그 실행 코드·의존성·필요한 스키마를 기준으로 독립 실행 버전을 생성한다.
   배포 SHA·게시 시각·압축 파일 해시는 추적과 무결성 정보로 따로 보관한다.

버전을 분리할 때는 연결 시 비교뿐 아니라 결과 파일의 실행 버전 검증,
기간 검증 실험의 버전 일치 검사, 미리보기 캐시의 Git SHA 기준도 함께 검토해야 한다.
실제 실행한 코드의 Git SHA는 재현성 기록으로 보존한다.
