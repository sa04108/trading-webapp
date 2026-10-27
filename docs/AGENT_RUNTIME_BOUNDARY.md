# Agent 실행 경계와 도메인 버전

## 기준

배포 Git SHA는 **어떤 커밋을 게시했는지 보여 주는 출처 정보**다. 데이터 캐시의 유효성,
agent 최신 여부, 백테스트 결과의 호환성, 기간 검증의 일관성은 별도 버전으로 판단한다.
공식 배포는 서버 코드와 GHCR Agent 이미지를 게시한다. standalone 서버 배포는 사용자용 native agent archive를 만들거나 게시하지 않는다.
웹 화면이나 인증 서비스만 바뀌면 기존 agent와 미리보기를 계속 사용할 수 있다.

## 물리적 경계

| 위치 | 책임 |
| --- | --- |
| `src/agent` | 컨테이너 연결, 자원 측정, worker 관리, 스냅샷 캐시, 결과 전송 |
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
fork되므로 import 그래프 외에 명시적으로 등록한다. `scripts/build-agent-client.mjs`는 Docker 내부 런타임 builder로 `dist/agent-runtime/quant-agent-runtime-linux-{x64|arm64}.tar.gz`와 manifest를 만든다. 이 archive는 서버 배포 archive나 사용자 다운로드로 전달하지 않는다. `scripts/lib/runtime-graph.mjs`는
타입 전용 import를 제거한 실행 그래프를 추적한다. builder는 전용 컴파일 결과에서
그 그래프에 속한 JS만 복사하고, 서버·웹 디렉터리가 들어오면 실패한다.
소스맵과 서버 전용 worker도 제외한다.

`packages/agent`는 Docker 이미지 안에서 실행하는 전용 의존성과 잠금 파일을 가진다. 직접 의존성은
`better-sqlite3`, `drizzle-orm`, `pino`, `ulid`, `ws`, `zod`다. Node 24와 네이티브
바이너리를 내부 런타임으로 구성한다. 서버에서 검증한 잠금 파일의 해당 전이 의존성만 추출하므로
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
`test:agent-package`는 내부 archive를 저장소 밖에 풀어 포함 파일·의존성·다섯 작업 테이블을
검사하고, 동봉 Node와 compiled agent로 준비→백테스트→서버 결과 저장을 실행한다. GHCR 이미지
게시 workflow의 버전 준비 단계에서 Docker build/push 전에 수행한다. standalone 서버 배포에는 포함하지 않는다.

## 독립 버전

`scripts/build-runtime-versions.mjs`가 `dist/runtime-versions.json`을 생성한다.
각 버전은 관련 실행 코드, 해당 잠금 의존성, Node·컴파일러와 코드 생성 설정을 정규화한
SHA-256이다. 이 SHA-256은 Git 커밋 SHA와 다른 값이다. 일반 TS 실행 소스의 주석과 타입
선언, 무관한 파일, 빌드 시각, 배포 커밋, archive 압축 결과는 도메인 버전 입력이 아니다.
버전 생성기와 패키징 규칙 자체도 추적하므로 이 빌드 규칙을 바꾸면 버전을 다시 생성한다.

| 버전 | 변경을 반영하는 범위 | 사용하는 곳 |
| --- | --- | --- |
| `agentVersion` | CLI·상주 프로세스·두 worker 전체 실행 그래프, 전용 패키지·작업 DB·빌드 규칙 | 컨테이너 연결과 서버 버전 일치 확인 |
| `collectionVersion` | 실제 KRX·DART 수집 factory와 수집·정규화·저장 코드, 계산 DB 마이그레이션 | 수집 실행 출처, 스냅샷 메타데이터; 원천 재사용·HTTP 허용 기준 아님 |
| `previewVersion` | 준비 worker의 실행 그래프 + `collectionVersion` | 미리보기 캐시의 재사용 |
| `executionVersion` | 백테스트 worker의 엔진·전략·입력 처리·결과 작성 그래프 | 작업 임대, 결과 파일 검증·저장, 기간 검증의 실행 일치 |
| `validationVersion` | 기간 검증 계획·진행 로직 + `previewVersion` + `executionVersion` | 진행 중인 기간 검증의 일관성 |

버전 간 전파는 공통 코드의 실제 의존 관계를 따른다. 예를 들어 전략 구현은 준비 단계의
입력·필요 데이터 판정에도 쓰이므로 실행과 미리보기를 모두 바꾼다. agent의 컨테이너 조립 방식만
바꾸면 백테스트 결과와 미리보기 버전은 그대로다. 수집 파서 변경만으로 정상 자료를 재해석하지 않으며 기존 agent 패키지를 계속 사용할 수 있다.

| 변경 예 | 바뀌는 버전 |
| --- | --- |
| 웹 화면·인증 서비스·사용자 테이블 | 없음 |
| agent 컨테이너 실행 로직 | agent |
| DART 파서 | 수집·미리보기·기간 검증 |
| 계산 엔진 | agent·백테스트 실행·기간 검증 |
| 전략 구현 | agent·미리보기·백테스트 실행·기간 검증 |
| 기간 검증 후보 선택·진행 로직 | 기간 검증 |

배포된 JS는 자신의 `dist/runtime-versions.json`만 읽으며 누락·잘못된 형식이면 실패한다.
현재 작업 디렉터리나 환경변수의 버전으로 대체하지 않는다. 개발용 TS 실행은 같은 생성기를
사용한다. 테스트는 실행 시작 시 한 번 생성한 소스 버전을 자식 프로세스에 전달하며,
검증 도중 소스나 빌드 메타데이터를 교체하지 않는다.

## 컨테이너 배포와 버전 일치

Windows Docker Desktop용 이미지도 동일한 agent 실행 그래프·의존성·내용 버전을 사용한다.
CI와 이미지 빌드의 Node 버전은 `.node-version`으로 맞추고, 빌드된 이미지의 agentVersion이
서버 빌드에서 산출한 값과 다르면 게시하지 않는다. 이미지 digest는 배포 산출물 식별자이고
agentVersion은 서버와의 실행 호환성 기준이다.

컨테이너는 환경변수의 서버 주소·토큰으로 직접 `run`하며 systemd 설치나 실행 파일의
자체 교체를 수행하지 않는다. UPDATE_REQUIRED를 받으면 기존 리스를 정리하고 최신 이미지
설치를 기다린다. Windows CMD 설치기는 latest를 새로 pull한 뒤 컨테이너를 재생성한다. 토큰을 발급해야 설치 파일을 받을 수 있으며, 사용자는 같은 파일을 다시 실행해 업데이트한다. latest와 previous
두 이미지 릴리스를 보존하되 복구 시 서버도 같은 agentVersion으로 맞춰야 한다.

## 수집 계약과 실제 데이터

미리보기는 `previewVersion`뿐 아니라 실제 데이터 revision도 확인한다.
스냅샷에는 dataset ID, source revision, 게시 버전, DB 스키마 버전, 파일 checksum과
`collectionVersion`을 별도로 기록한다. 수집 버전이 바뀌면 데이터 revision이 같아도
새 스냅샷 명세를 게시한다. 이전 임대가 참조하는 스냅샷은 유지한다.

D-096·D-098에 따라 NULL·이전 실행 해시 coverage도 완료 근거로 재사용한다. KRX 구간은
겹침·인접 구간만 합치고 실제 미수집 날짜는 남긴다. DART는 구조가 호환되는 프로토콜을
버전 번호와 무관하게 읽고 기존 manifest의 fact count/content hash·gap 검사를 유지한다.
manifest가 없는 legacy 재무 coverage는 해당 연도의 실제 재무 fact가 있어야 재사용한다.
D-109의 재무 프로토콜 3은 blocking gap의 계정·공시 시점·종류와 해시를 추가한다.
이 상세 정보가 없는 이전 blocking 연도만 저장 원문에서 한 번 재생하고 정상 manifest는
재사용한다. 정상 결측은 전략·PER/ROE 선정의 사용 시점에 후보에서 건너뛰며, 수집 미완료·
실제 무결성 오류와 분할 보정 오류의 검사는 유지한다.
자본변동 legacy coverage는 기록된 완료 연도와 gap을 보존한다. 서버 수집 큐의 중복 제거 키는 실행 해시를 제외한 정규화 요청 범위다.
D-099에 따라 필요한 원문 결손·손상·정정은 요청 키와 근거 fingerprint별로 자동 수집한다. 물리
시도 이력은 보존한다. 연결 실패·HTTP 5xx는 5회 전까지 지수 지연으로 자동 예약하며, 5회 뒤에는
`WAITING_RETRY`와 `retry_after_ms`로 15분 후 다음 5회를 자동 예약한다. 목록과 본문의
접수번호 차이로 `PENDING_PUBLICATION`을 만들지 않는다(D-102). 정체성 불일치·해석 불가
공시는 범위를 차단하고 호출 한도·네트워크 오류의 재시도 정책은 유지한다.

기존 agent 패키지와 임대의 `collectionVersion`이 달라도 그 사실만으로 수집하지 않는다.
완료 결과의 dataset source revision이 현재 계산 DB revision과 다르면 실패 횟수 소모 없이
다시 배정한다. 같은 revision이면 결과 데이터 버전·일정 해시를 검증해 수락한다.

KRX·DART 원문, 공시 목록 checkpoint, 요청 계획·시도 원장은 운영 DB에 남긴다.
agent에는 공급자 키나 원문을 전달하지 않는다. 계산 DB의 `provider_input_issues`에는
확인된 문제의 종목·연도·보고서 범위와 근거를 싣고 스냅샷에 포함한다. 이 테이블 변경은
데이터 revision을 올려 이미 완료된 미리보기도 재검증 대상으로 만든다. 공시 목록 확인이
미완료인 상태와 구체적인 입력 문제는 구분하며, 최신성 경고만으로 기존 검증 자료를 막지 않는다.

자본변동 요청은 주식총수·증자감자 원문만 반영한다. 두 endpoint의 응답 확인과
팩트·coverage 저장까지 끝나면 `PENDING_FILING`을 `PENDING_FINANCIAL_FILING`으로 좁힌다.
이 상태는 재무 coverage만 다시 열며 자본변동의 완료·실제 gap은 그대로 사용한다.
agent는 계산 DB의 이 사유만 읽고 운영 DB의 공시·endpoint 체크포인트에는 접근하지 않는다.
재무를 포함한 전체 정상화가 끝나야 공시 전체를 완료하고 남은 문제를 지운다.
각 본문 API는 자기 저장 원문의 접수번호 집합과 응답의 접수번호 집합만 비교한다. 같으면
원문·수집 시각을 유지하고, 다르면 더 작은 번호도 교체한다. 동일한 정규화 팩트도 다시
쓰지 않는다. `013`은 빈 결과이며, 회사·연도·보고서 정체성과 원문 손상 검사는 유지한다.
목록은 필요한 본문 재조회의 계기이고 본문이 따라야 할 접수번호의 기준이 아니다.
기존 endpoint `APPLIED` 체크포인트는 재조회 완료를 뜻하며 실제 본문 접수번호는 원문에
보존한다. 실행 도중 새로 발견한 공시는 진행 중인 조회의 완료 범위에 포함하지 않는다.
서버 시작 시 이전 접수번호 비교로 생긴 대기는 요청 종목·연도와 일치하는 경우 재평가한다.
`UNLISTED`·`UNLISTED_PARTIAL`은 본문 재조회 대상으로 복구하고 폐기한 `verify:` 목록 작업과
게시 대기 체크포인트를 제거한다. 실제 해석 오류·호출 한도·네트워크 재시도는 유지한다.

공시 목록 확인은 사용자의 미리보기 시작에서 `list.json` 최대 2회(실제 HTTP 시도 기준),
총 5초로 제한한다(D-098). 서버는 먼저 `WAITING_DATA/FILING_DISCOVERY` 작업을 반환하고
목록 확인 종료 뒤 `QUEUED`로 옮긴다. 실패·시간 초과·남은 페이지는 경고와 checkpoint로
남기고 기존 DB로 계산한다. 이 단계는 저장 원문·기업코드 XML을 읽거나 재파싱하지 않는다.
이번 목록의 종목·연도·보고서에 해당하는 접수번호와 수집 시각 메타데이터만 대조한다.
새 접수번호 메타데이터는 이후 실제 수집에서 저장하며 기존 원문을 전수 역산하지 않는다.

완료 작업 ID를 전달하는 결과 읽기는 현재 사용자 참조와 데이터 revision만 검증한다.
미확인 페이지는 짧은 확인 후 내부에서 최대 100회·30초씩 자동 처리한다. 잔여 목록·오류는
15분 뒤 다시 처리하며, 본문 수집은 기존 데이터 요구·자동 수집 큐가 담당한다. 목록 수집 중 새 미리보기는 그 작업을 기다리지 않는다.
서버 종료 시 내부 타이머와 조회를 중단한다. 서버 시작만으로 새 외부 조회를 만들지는 않으며,
다음 미리보기에서 저장된 미완료 목록도 다시 이어받는다. 별도 카드·수동 조작 없이 기존 진행률만 노출한다.

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
결과 파일 저장 ABI는 경고 요약과 전체 원문을 분리하면서 3으로 올렸다.
manifest의 경고 요약은 최대 1,000개·항목당 4,000자를 유지한다. 이 한도를 넘으면
앞쪽 준비 경고와 뒤쪽 실행 경고를 남기고 생략·축약 사실을 안내한다. `warning_details`는
원문의 순서·중복·전체 문자열을 보존하며, importer는 같은 요약 규칙으로 두 값을 대조한다.
원문 행도 기존 artifact 256 MiB·전체 500만 행 제한에 포함한다. 중앙 운영 DB의 별도
원문 테이블에 transaction으로 저장하고, 로그인한 사용자는 결과 화면에서 전체 원문 JSON을
다운로드한다. 과거 결과는 기존 `warnings_json`을 원문으로 제공한다.
기존 결과·기간 검증의 새 컬럼은 NULL로 두어 출처를 만들어 내지 않는다. 과거 이력 조회는
가능하지만 새 기간 검증은 현재 실행 버전으로 만든 원본에서 시작해야 한다.

## 설치 기준

외부 에이전트는 Windows Docker Desktop에서 GHCR의 Linux 컨테이너로 실행한다. 연결 토큰을
발급한 사용자는 해당 토큰이 포함된 Windows CMD 설치 파일을 다운로드할 수 있다. 설치 파일은
`QUANT_AGENT_SERVER_URL`·`QUANT_AGENT_TOKEN`을 컨테이너 환경변수로 전달하고 named volume을
상태 경로로 연결한다. 사용자가 Linux/WSL2에 직접 설치·설정·업데이트하는 경로는 제공하지 않는다.

이미지 안의 `agentVersion`은 서버와 통신할 실행 호환성 기준이며 이미지 digest는 배포 산출물의
식별자다. 서버와 버전이 다르면 작업을 중단하고 최신 Windows CMD 설치 파일을 다시 실행하도록
안내한다. 기존 native 패키지나 임대의 `collectionVersion`이 달라도 그 사실만으로 수집하지 않는다.
