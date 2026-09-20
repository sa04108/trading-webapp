# Agent 실행 경계와 도메인 버전

## 기준

배포 Git SHA는 **어떤 커밋을 게시했는지 보여 주는 출처 정보**다. 데이터 캐시의 유효성,
agent 최신 여부, 백테스트 결과의 호환성, 기간 검증의 일관성은 별도 버전으로 판단한다.
공식 서버 배포 때 agent 압축 파일도 게시하지만 게시 시각과 agent 버전은 독립적이다.
웹 화면이나 인증 서비스만 바뀌면 기존 agent와 미리보기를 계속 사용할 수 있다.

## 물리적 경계

| 위치 | 책임 |
| --- | --- |
| `src/agent` | 연결, 자원 측정, worker 관리, 스냅샷 캐시, 결과 전송, 설치·업데이트 |
| `src/runtime/modules` | 엔진·전략, 유니버스 준비, 데이터 조회·coverage 검사, 결과 파일 작성 |
| `src/runtime/workers` | `preparation-child`, `preparation-runtime`, `backtest-child`, 취소 처리 |
| `src/runtime/shared/db` | 계산 데이터 조회 스키마, agent에 필요한 작업 스키마와 DB 연결 |
| `src/server` | HTTP·인증·수집 API, 작업 배정, 사용자별 미리보기 소유권, 결과 수신·저장 |
| `src/workers` | 서버 전용 스냅샷 게시와 결과 import |
| `src/shared` | 요청·결과 스키마와 통신 계약 |

준비 orchestrator는 수집과 미리보기 소유권 처리를 좁은 인터페이스로 받는다.
서버는 실제 수집 서비스와 사용자 소유권 서비스를 넣고, agent는 서버에 데이터 요청을
되돌려 주는 구현을 넣는다. 기간 검증의 미리보기 정리도 서버에서 주입한다.
따라서 사용자 테이블의 변경이 계산 코드의 의존성으로 전파되지 않는다.

서버 운영 스키마는 인증·알림·수집·결과·기간 검증 등 도메인별 파일로 나눈다.
실행 코드는 필요한 스키마 파일을 직접 가져오며, 전체 스키마 재수출은 마이그레이션과
테스트 편의용이다. agent 작업 DB는 다음 다섯 테이블과 별도 마이그레이션 이력만 갖는다.

- `audit_logs`
- `backtest_preparation_jobs`
- `preparation_preview_cache`
- `backtest_jobs`
- `operational_database_state`

agent는 `migrations/agent`로 작업 DB를 만들고 서버가 게시한 계산 DB를 읽기 전용으로
연결한다. 서버의 `migrations/operations`, `migrations/data`는 agent 패키지에 넣지 않는다.
계산 DB 스키마가 바뀌면 서버에서 먼저 마이그레이션하고 호환되는 새 스냅샷을 게시한다.

## 전용 빌드와 패키지

권장 분리 순서에 따라 전용 진입점, 공유 코드 이동, 경계 검사, 내용 기반 버전을 적용했다.

`tsconfig.agent.json`의 진입점은 agent CLI와 두 계산 worker다. worker는 파일 경로로
fork되므로 import 그래프 외에 명시적으로 등록한다. `scripts/lib/runtime-graph.mjs`는
타입 전용 import를 제거한 실행 그래프를 추적한다. builder는 전용 컴파일 결과에서
그 그래프에 속한 JS만 복사하고, 서버·웹 디렉터리가 들어오면 실패한다.
소스맵과 서버 전용 worker도 제외한다.

`packages/agent`는 독립된 운영 의존성과 잠금 파일을 가진다. 직접 의존성은
`better-sqlite3`, `drizzle-orm`, `pino`, `ulid`, `ws`, `zod`다. Node 24와 네이티브
바이너리를 함께 게시한다. 서버에서 검증한 잠금 파일의 해당 전이 의존성만 추출하므로
Fastify·React·인증 패키지를 설치하지 않는다. 서버와 agent의 의존성 해석이 달라지면
버전 생성 단계가 실패한다.

```bash
# 관련 의존성을 변경했을 때 서버의 잠금 결과를 전용 패키지에 반영한다.
node scripts/sync-agent-dependencies.mjs
pnpm build:server
pnpm build:agent
pnpm test:agent-package
```

아키텍처 검사는 agent/runtime에서 server·web·서버 전용 worker로 향하는 import를 금지한다.
`test:agent-package`는 실제 archive를 저장소 밖에 풀어 포함 파일·의존성·다섯 작업 테이블을
검사하고, 동봉 Node와 compiled agent로 준비→백테스트→서버 결과 저장을 실행한다.
`--check`의 모듈 로딩 검사와 함께 공식 release 검증에 포함한다.

## 독립 버전

`scripts/build-runtime-versions.mjs`가 `dist/runtime-versions.json`을 생성한다.
각 버전은 관련 실행 코드, 해당 잠금 의존성, Node·컴파일러와 코드 생성 설정을 정규화한
SHA-256이다. 이 SHA-256은 Git 커밋 SHA와 다른 값이다. 일반 TS 실행 소스의 주석과 타입
선언, 무관한 파일, 빌드 시각, 배포 커밋, archive 압축 결과는 도메인 버전 입력이 아니다.
버전 생성기와 패키징 규칙 자체도 추적하므로 이 빌드 규칙을 바꾸면 버전을 다시 생성한다.

| 버전 | 변경을 반영하는 범위 | 사용하는 곳 |
| --- | --- | --- |
| `agentVersion` | CLI·상주 프로세스·두 worker 전체 실행 그래프, 전용 패키지·작업 DB·빌드 규칙 | 연결, 자동·수동 업데이트, 설치 패키지 검증 |
| `collectionVersion` | 실제 KRX·DART 수집 factory와 수집·정규화·저장 코드, 계산 DB 마이그레이션 | 수집 실행 출처, 스냅샷 메타데이터; 원천 재사용·HTTP 허용 기준 아님 |
| `previewVersion` | 준비 worker의 실행 그래프 + `collectionVersion` | 미리보기 캐시의 재사용 |
| `executionVersion` | 백테스트 worker의 엔진·전략·입력 처리·결과 작성 그래프 | 작업 임대, 결과 파일 검증·저장, 기간 검증의 실행 일치 |
| `validationVersion` | 기간 검증 계획·진행 로직 + `previewVersion` + `executionVersion` | 진행 중인 기간 검증의 일관성 |

버전 간 전파는 공통 코드의 실제 의존 관계를 따른다. 예를 들어 전략 구현은 준비 단계의
입력·필요 데이터 판정에도 쓰이므로 실행과 미리보기를 모두 바꾼다. agent의 설치 명령만
바꾸면 백테스트 결과와 미리보기 버전은 그대로다. 수집 파서만 바꾸면 서버는 저장 원문을 우선 재해석하고 기존 agent 패키지를 계속 사용할 수 있다.

| 변경 예 | 바뀌는 버전 |
| --- | --- |
| 웹 화면·인증 서비스·사용자 테이블 | 없음 |
| agent 설치·업데이트 로직 | agent |
| DART 파서 | 수집·미리보기·기간 검증 |
| 계산 엔진 | agent·백테스트 실행·기간 검증 |
| 전략 구현 | agent·미리보기·백테스트 실행·기간 검증 |
| 기간 검증 후보 선택·진행 로직 | 기간 검증 |

배포된 JS는 자신의 `dist/runtime-versions.json`만 읽으며 누락·잘못된 형식이면 실패한다.
현재 작업 디렉터리나 환경변수의 버전으로 대체하지 않는다. 개발용 TS 실행은 같은 생성기를
사용한다. 테스트는 실행 시작 시 한 번 생성한 소스 버전을 자식 프로세스에 전달하며,
검증 도중 소스나 빌드 메타데이터를 교체하지 않는다.

## 수집 계약과 실제 데이터

미리보기는 `previewVersion`뿐 아니라 실제 데이터 revision도 확인한다.
스냅샷에는 dataset ID, source revision, 게시 버전, DB 스키마 버전, 파일 checksum과
`collectionVersion`을 별도로 기록한다. 수집 버전이 바뀌면 데이터 revision이 같아도
새 스냅샷 명세를 게시한다. 이전 임대가 참조하는 스냅샷은 유지한다.

D-096에 따라 NULL·이전 실행 해시 coverage도 완료 근거로 재사용한다. KRX 구간은
겹침·인접 구간만 합치고 실제 미수집 날짜는 남긴다. DART의 의미 프로토콜·manifest·gap
검사는 유지한다. 서버 수집 큐의 중복 제거 키는 실행 해시를 제외한 정규화 요청 범위다.
승인 필요 오류는 `BLOCKED`로 남겨 자동 재시도하지 않는다.

기존 agent 패키지와 임대의 `collectionVersion`이 달라도 그 사실만으로 수집하지 않는다.
완료 결과의 dataset source revision이 현재 계산 DB revision과 다르면 실패 횟수 소모 없이
다시 배정한다. 같은 revision이면 결과 데이터 버전·일정 해시를 검증해 수락한다.

KRX·DART 원문, 공시 목록 checkpoint, 요청 승인·시도 원장은 운영 DB에 남긴다.
agent에는 공급자 키나 원문을 전달하지 않는다. 계산 DB의 `provider_input_issues`에는
확인된 문제의 종목·연도·보고서 범위와 근거를 싣고 스냅샷에 포함한다. 이 테이블 변경은
데이터 revision을 올려 이미 완료된 미리보기도 재검증 대상으로 만든다. 공시 목록 확인이
미완료인 상태와 구체적인 입력 문제는 구분하며, 최신성 경고만으로 기존 검증 자료를 막지 않는다.

공시 목록 확인은 사용자의 미리보기 시작에서만 실행한다(D-097). 서버는 먼저
`WAITING_DATA/FILING_DISCOVERY` 작업을 반환하고 확인·대조가 끝난 뒤 `QUEUED`로 옮긴다.
로컬·원격 계산은 이 대기 작업을 임대하지 않는다. 같은 날의 새 시작도 당일까지 확인하지만
완료 작업 ID를 전달하는 결과 읽기는 현재 사용자 참조와 데이터 revision만 검증한다.
서버 재시작으로 남은 공시 확인 작업은 실패로 닫고 자동 외부 조회를 재개하지 않는다.

## Git SHA 사용처 전수 점검 결과

| 이전 사용처 | 현재 기준 |
| --- | --- |
| agent HELLO와 서버 요구 버전 비교 | 프로토콜 3의 `agentVersion` |
| 최신 명세·설치 디렉터리·패키지 내부 버전 | `agentVersion` |
| 백테스트 임대 및 결과 import의 SHA 일치 검사 | `executionVersion` |
| 미리보기 `2:<git sha>` 캐시 표식 | `previewVersion` + 데이터 revision |
| 기간 검증 생성·재개·하위 결과의 SHA 일치 검사 | `executionVersion`, `validationVersion` |
| health·운영 화면의 배포 커밋 표시 | Git SHA 유지 |
| 실행 결과·실험의 출처 기록 | 실제 실행 패키지의 Git SHA 유지 |
| 서버 release 이름·배포 메타데이터 | Git SHA 유지 |
| archive·데이터 무결성, 임대 토큰의 SHA-256 | 원래 목적 유지; Git 버전과 무관 |

`ENGINE_VERSION`, 전략의 명시적 버전, 데이터셋 ID/revision, DB 스키마 버전, 통신 규약 버전은
각자의 의미를 유지한다. 실행 코드 해시는 명시적 버전을 올리지 않은 구현 변경도 감지한다.
결과 파일 저장 ABI는 `executionVersion` 필드 도입과 함께 2로 올렸다.
기존 결과·기간 검증의 새 컬럼은 NULL로 두어 출처를 만들어 내지 않는다. 과거 이력 조회는
가능하지만 새 기간 검증은 현재 실행 버전으로 만든 원본에서 시작해야 한다.

## 설치 기준

서버와 agent는 프로토콜 3과 내용 버전만 사용한다. `HELLO`는 64자리 `agentVersion`을
전달하고 `/api/agents/client/latest`는 같은 버전의 패키지 명세를 반환한다.
버전 체계 선택·SHA 설치·구형 서버 롤백·미전송 작업 이관 경로는 두지 않는다.

기존 agent는 제거한 뒤 새 패키지로 다시 설치한다. 구형 작업 DB·미전송 결과·데이터
캐시는 재사용하지 않는다. 서버의 `datasets/` 게시 캐시도 새 명세 형식만 읽으므로,
이전 형식의 게시 캐시는 서버 시작 전에 비우고 원본 계산 DB에서 새로 게시한다.
서버 내부 agent의 상태 경로인 DB 디렉터리 아래 `server-agent/`에도 같은 기준을 적용한다.
서버 운영 DB와 계산 DB에는 스키마 마이그레이션을 적용한다.
