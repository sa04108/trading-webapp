# Quant Platform — 아키텍처 및 운영 원칙

> **목적:** 사람과 AI가 프로젝트의 의도, 책임 경계, 변경 시 지켜야 할 원칙을 파악하는 기준 문서.
> **검토일:** 2026-11-14

구조·보안 경계·데이터 계약을 바꿀 때 코드와 함께 갱신한다. 구현과 충돌하면 설계 변경인지 구현 결함인지 확인하고 정합성을 맞춘다. 기능 목록과 작업 이력은 담지 않는다.

개발 시작은 [README.md](../README.md), 서버 배포는 [DOCKER_SERVER.md](DOCKER_SERVER.md), 계산 장치 운영·버전 계약은 [AGENT_OPERATIONS.md](AGENT_OPERATIONS.md)·[AGENT_RUNTIME_BOUNDARY.md](AGENT_RUNTIME_BOUNDARY.md)를 참조한다. 상세 필드·기본값·실행 순서는 해당 스키마와 스크립트를 기준으로 한다.

---

## 1. 프로젝트 목표

**단일 관리자가 모바일·데스크톱 브라우저에서 퀀트 백테스트를 준비·실행하고 결과를 비교·검증하는 개인용 플랫폼**이다. 데이터의 시점 정합성, 계산의 재현성, 제한된 서버 자원에서의 안정적인 운영을 우선한다. 공개 회원가입이나 다중 사용자 서비스를 전제로 하지 않는다.

하나의 저장소와 제품으로 운영하는 **모듈러 모놀리스**다. 운영 서버가 인증·수집·작업·최종 결과의 기준점이며, Windows Docker Desktop의 외부 계산 장치는 계산 용량만 확장한다. GitHub Actions는 서버·웹을 포함한 서버 이미지와 Agent 이미지를 GHCR에 게시하고, 운영자는 서버에서 이미지를 적용한다. 계산 코드의 호환성은 배포 커밋과 별도로 관리한다.

## 2. 절대 원칙

- **외부 구현을 핵심 로직과 분리한다.** DB·외부 API 접근은 포트와 어댑터로 연결하고 실행 설정은 조립부에서 주입한다. 클라우드·퍼블릭 도메인·프록시 정책을 도메인·유스케이스에 넣지 않는다.
- **사용자 입력은 코드가 아니다.** 웹은 검증된 파라미터만 전달한다. `eval`, `new Function`, 입력의 셸 실행, 임의 코드·패키지 업로드와 동적 설치를 금지한다. 실행 로직은 검토·테스트·배포로 변경한다.
- **백테스트는 당시 알 수 있었던 데이터만 사용한다.** 미래 가격·공시·종목 구성의 선반영을 금지한다. 신호에 따른 체결은 다음 봉 시가를 기준으로 하며, 비용·슬리피지·기업행동·데이터 결손의 영향을 숨기지 않는다. 동일 입력·데이터·계산 버전·seed로 성과 결과를 재현할 수 있어야 한다.
- **계산 장치에 운영 권한을 주지 않는다.** 공급자 API 키, 관리자 인증 정보, 운영 DB는 서버에 둔다. 계산 자식에는 필요한 설정만 명시적으로 전달하며 부모 환경변수 전체를 상속하지 않는다. 무거운 준비·백테스트 계산과 결과 파일 검증은 HTTP 요청 처리 루프에서 직접 수행하지 않는다.

## 3. 기술 스택

| 영역 | 구성 |
| --- | --- |
| 실행·언어 | Node.js 24 (`>=24 <25`), TypeScript strict, ESM, pnpm |
| 서버 | Fastify, Zod, Pino, REST·SSE·WebSocket |
| 영속성 | SQLite, better-sqlite3, Drizzle 스키마·마이그레이션 |
| 웹 | React·Vite, React Router, shadcn/ui·Tailwind CSS, TanStack Query·Table, React Hook Form, Recharts |
| 인증·검증 | Argon2id, TOTP, Vitest, Playwright, dependency-cruiser |
| 운영 | Linux, Docker Compose·기존 Traefik, 컨테이너 이미지 배포 |

정확한 패키지 버전은 [package.json](../package.json)과 잠금 파일을 따른다. 웹 빌드 결과는 Fastify가 제공하며 별도의 퍼블릭 프론트엔드 서비스로 분리하지 않는다.

---

## 4. 런타임과 데이터 흐름

### 실행 구조

```text
브라우저 ── HTTPS ──> Traefik ── Docker 내부 :3000 ──> Fastify
                                                   ├─ 인증·REST·SSE·정적 웹
                                                   ├─ 작업·참조·결과 관리 ── 운영 DB
                                                   ├─ 외부 데이터 수집 ──── 계산 데이터 DB
                                                   ├─ 서버 전용 자식: 스냅샷 게시·결과 반영
                                                   └─ 계산 배정
                                                       ├─ 원격 에이전트 → 계산 자식
                                                       └─ 내부 에이전트 → 계산 자식
```

두 경로는 같은 `src/runtime`의 준비·백테스트 자식을 실행한다. Windows Docker Desktop에서 실행하는 Linux 컨테이너가 서버로 **WSS(TLS 기반 WebSocket) 연결을 먼저 만들고** 제어 메시지를 교환하며, 파일은 인증된 HTTPS로 전송한다. Linux/WSL2 네이티브 설치는 제공하지 않는다. 내부 에이전트는 네트워크 재접속 없이 내부 메시지와 로컬 스냅샷을 사용한다.

**작업 흐름:** 요청 검증 → 준비·미리보기 → 부족 데이터 수집·스냅샷 게시 → 실행 가능한 작업 배정 → 계산 → 결과 검증·저장 → 상태·결과 조회.

원격 장치에 우선 배정하고 남은 작업은 서버 자원이 허용하면 내부 실행기에 배정한다. 양쪽 모두 여유가 없으면 영속 큐에서 기다린다. 병렬도는 고정값이 아니라 CPU·메모리·슬롯·작업 크기로 제한한다.

데이터 부족 작업은 서버 수집 큐에 요구를 전달하고 계산 슬롯을 반환한다. 중복 요구는 합치며 호출 한도 소진은 다음 허용 시각까지 대기한다. 수집·새 스냅샷 게시 후 재개하고, API 사용량과 대기 상태는 재시작 후에도 유지한다.

### 저장소 소유권

| 저장소 | 보관 내용·접근 주체 |
| --- | --- |
| 운영 DB `app.sqlite` | 계정·세션, API 사용량·수집 큐, 준비·작업·결과·알림. 서버가 조회·변경한다. |
| 계산 데이터 DB `app.data.sqlite` | 가격·종목 이력, 재무·자본변동 facts, 벤치마크·coverage·확인된 입력 문제. 서버가 수집·갱신한다. |
| 계산 스냅샷 | 계산 데이터 DB에서 게시한 버전별 읽기 전용 파일. 운영 인증 정보와 원본 API 응답 캐시는 포함하지 않는다. |
| 에이전트 작업 DB·결과 파일 | 계산에 필요한 최소 작업 상태와 전송 대기 결과. 서버 운영 DB의 복제본이 아니며 최종 결과의 기준점도 아니다. |

운영 경로는 `DATABASE_PATH`, 계산 경로는 여기서 파생한다. 서버는 계산 DB를 `data`로 연결해 조회한다. 서버 DB는 WAL·외래 키·busy timeout을 사용하고 계산 동안 긴 쓰기 트랜잭션을 유지하지 않는다. `operations`·`data`·`agent`의 스키마와 마이그레이션 이력은 분리한다.

KRX는 가격·과거 종목 구성, DART는 재무·자본변동, FRED는 추가 벤치마크를 공급한다. 증권사 REST는 표시용 종목 정보에 사용한다. 절대 시각은 UTC로 보존하고 거래일·호출 한도 등의 KST 기준은 명시한다. 정정 공시와 종목 식별 이력을 보존한다.

### 상태·재현성 계약

큐 선점은 원자적이다. 장치·작업·attempt·임대 토큰으로 오래된 결과를 거부하고, 유효한 임대를 연결 단절만으로 중복 실행하지 않는다. 결과 재전송은 중복 저장하지 않으며 **검증된 결과 저장과 완료 전이를 같은 운영 DB 트랜잭션으로 확정**한다.

취소·임대 만료·재시작은 명시적인 상태 전이로 처리한다. 종료 시 결과 수신·검증·반영과 자식을 정리한 뒤 DB를 닫는다. 완료 행의 존재와 자원 정리 완료를 구분한다.

실행 중인 스냅샷과 작업·미리보기가 참조하는 준비 결과는 보존한다. 참조 없는 종료 작업·캐시만 정리하며 **캐시 무효화와 과거 실행 근거 삭제를 구분**한다.

Git SHA는 출처를 기록한다. `agentVersion`·`collectionVersion`·`previewVersion`·`executionVersion`·`validationVersion`은 배포 클라이언트·수집 실행 출처·미리보기·실행·기간 검증을 구분한다. 수집 실행 해시는 원천 재사용이나 외부 요청 허용 기준이 아니다. 데이터셋 ID·데이터 revision·게시 버전·스키마 버전·파일 해시는 이 코드 버전과 구분한다.

준비 단계에서 수집 완료 후에도 특정 종목의 입력 결손이 확인되면 해당 종목을 전 기간 제외하고 같은 규칙으로 재선정하며 사유를 경고로 남긴다. 수집 미완료는 먼저 수집·재시도로 처리하고, 전체 응답 오류·종목 식별 충돌·빈 유니버스는 준비를 중단한다. 제출 후에는 고정된 유니버스 일정을 계산 중 임의로 바꾸지 않으며 데이터 불일치를 차단한다. 완료 실행의 규칙·일정 해시·진단·계산 출처는 이후 설정 변경으로 다시 쓰지 않는다.

### 현재 백테스트의 지원 범위와 한계

가격·재무 입력은 봉 시각·공시 접수일로 사용 시점을 제한한다. 자본변동은 KRX 주식수 변경에 정렬한 효력일로 적용하며 최초 공개시각까지 보장하지 않는다. 과거 지수 구성원 이력을 복원하는 기능은 없고, 지원하는 규칙과 당시 종목 이력·지표로 유니버스를 구성한다.

일봉 전략의 손절은 종가 신호와 다음 봉 체결 모델을 따른다. 장중 스톱 주문의 체결을 재현하지 않는다.

기간 검증은 홀드아웃·최적화 홀드아웃·워크포워드를 지원한다. 최적화 후보는 학습 구간 성과로만 선택하며 평가 구간 성과를 선택 함수에 전달하지 않는다. 여러 실험 중 좋은 결과를 고르는 선택 편향의 통계적 보정과 성과 신뢰구간은 제공하지 않는다. 계약과 구간·후보 제한은 [period-validation.ts](../src/shared/schemas/period-validation.ts)를 따른다.

구현: [container.ts](../src/server/bootstrap/container.ts), [agent-coordinator.ts](../src/server/modules/agents/application/agent-coordinator.ts), [database.ts](../src/runtime/shared/db/database.ts).

## 5. 저장소 구조와 의존 방향

```text
src/
├─ server/
│  ├─ bootstrap/     설정 검증·의존성 조립·HTTP 기동
│  ├─ modules/       인증·수집·작업 배정·결과·장치 관리
│  └─ shared/        서버 DB 정의·로깅·HTTP 보안 등
├─ runtime/
│  ├─ modules/       준비·계산 엔진·데이터 조회 등 공유 로직
│  ├─ workers/       준비·백테스트 계산 자식
│  └─ shared/        계산·작업 DB 연결과 공통 실행 기반
├─ agent/            컨테이너 내 클라이언트·자원 관리·캐시
├─ workers/          서버 전용 스냅샷 게시·결과 반영 자식
├─ shared/           웹·서버·에이전트 사이의 스키마·통신 계약
└─ web/              앱 셸·기능별 화면·공통 UI
migrations/          operations/ · data/ · agent/
packages/agent/      컨테이너 런타임 전용 의존성·잠금 파일
infra/ · scripts/    컨테이너 이미지·빌드·배포·운영 도구
tests/ · docs/       검증 코드·설계 및 운영 문서
```

모듈의 기본 의존 방향은 **`presentation / infrastructure → application → domain`**이다. 도메인은 프레임워크·DB·파일 시스템·네트워크·환경변수를 직접 사용하지 않는다. 모듈 간 연동은 공개 계약과 조립부를 통해 연결한다.

`agent`·`runtime`은 `server`·`web`·서버 전용 `workers`에 의존하지 않는다. 웹은 서버·계산 내부 구현을 가져오지 않고 `shared` 계약을 사용한다. 서버는 웹 구현에 의존하지 않는다. 구체적인 금지 관계는 [.dependency-cruiser.cjs](../.dependency-cruiser.cjs)와 아키텍처 테스트에서 확인한다.

---

## 6. API 경계

| 인터페이스 | 경로·계약 |
| --- | --- |
| 브라우저 업무 API | `/api/v1` 아래 인증, 백테스트 준비·실행·결과·검증, 데이터 상태·동기화, 알림, 장치 관리. 인증 진입점과 공개 상태 확인을 제외한 업무 API는 관리자 세션을 요구한다. |
| 상태 확인 | `/api/v1/health/live`·`/api/v1/health/ready`는 공개 상태만 반환한다. `/api/v1/system/info`는 인증 후 조회한다. |
| 브라우저 진행 상태 | SSE로 작업·알림 변화를 전달하고 폴링으로 복구한다. 브라우저 연결의 수명과 영속 작업의 수명을 분리한다. |
| 에이전트 제어 | `/api/agents/connect`의 WSS. 장치 Bearer 토큰으로 인증하고 임대·진행률·데이터 요구·취소를 교환한다. |
| 에이전트 파일 전송 | `/api/agents/datasets/:version`, `/api/agents/jobs/:jobId/result`. 장치 인증을 요구하며 결과 수신은 파일·실행 버전·현재 임대를 검증한다. Windows 설치 파일은 연결 토큰 발급 후 웹에서 내려받는다. |

상세 필드·제한은 [공유 스키마](../src/shared/schemas/)·[에이전트 프로토콜](../src/shared/agent-protocol.ts)·각 `presentation`에서 관리한다. 라우트 등록과 인증 경계는 [server.ts](../src/server/bootstrap/server.ts)를 따른다.

준비·백테스트의 배정 전 진행은 운영 서버와 원격 실행기의 실제 상태를 함께 반영한다.
스냅샷 게시·동기화, 작업 메모리 산정, 메모리·계산 슬롯·입력 용량 대기와 프로세스 시작을
구분하고, 메모리 산정에는 확인한 종목 수와 필요·가용 예산을 표시한다. 입력 분할 크기는
워커가 결정한 뒤 표시한다. GET과 SSE는 같은 관측값을 사용하며, 분모가 없는 단계에는
퍼센트를 만들거나 이전 계산 진행률을 재사용하지 않는다. 진행 알림 자체는 재배정을
유발하지 않으며, 자원 제한과 계산 순서는 표시 기능과 독립적으로 유지한다.

## 7. 보안과 권한

**웹은 인증된 업무 조작 인터페이스**다. 백테스트·데이터 관리와 장치 토큰 발급·해제를 제공한다. 관리자 생성과 TOTP 등록·재설정은 서버 CLI 전용이며, 브라우저 세션과 장치 토큰의 권한을 구분한다.

비밀번호는 Argon2id로 저장한다. TOTP 등록 계정은 2단계 검증 전 업무 API 접근을 차단하고 성공 시 세션을 회전한다. 실패 잠금·TOTP 재사용 방지·일회용 복구 코드를 유지한다.

> **운영 전제:** 공개 전에 TOTP를 등록한다. 현재 코드는 미등록 계정의 비밀번호 로그인도 허용하므로, 이를 코드의 전 계정 강제 정책으로 오해하지 않는다.

운영 쿠키는 `HttpOnly`·`Secure`·`SameSite=Strict`를 사용한다. 변경 요청의 `Origin`이 있으면 `Host`와 대조한다. 보안 헤더·입력 및 파일 검증·로그 비밀값 가림을 적용하고 내부 stack trace는 노출하지 않는다.

장치 해제는 이후 접근 권한을 끊을 뿐 이미 다운로드한 데이터를 회수하지 않는다. 데이터 보관을 허용한 장치만 연결한다.

구현: [auth-service.ts](../src/server/modules/auth/application/auth-service.ts), [security.ts](../src/server/shared/security.ts), [agent-routes.ts](../src/server/modules/agents/presentation/agent-routes.ts).

## 8. 프론트엔드 디자인

**모바일 우선의 절제된 데이터 운영 도구**다. 중립색·공통 디자인 토큰과 라이트·다크 테마를 사용한다. 모바일은 상단 바·본문·하단 탐색, 데스크톱은 사이드바·헤더·본문으로 구성한다.

입력은 단계별 검증과 실행 전 검토를 제공한다. 작업 단계·실패 이유·데이터 결손을 명확히 표시하고 서버 상태는 TanStack Query로 관리한다. 손익은 `gain`·`loss` 토큰과 **부호·텍스트를 함께 사용**한다. 장식보다 터치·키보드 접근성과 표·차트의 가독성을 우선한다.

구현: [shell.tsx](../src/web/app/shell.tsx), [index.css](../src/web/index.css).

---

## 9. 클라우드와 퍼블릭 네트워크

운영 대상은 **Ubuntu 26.04 LTS·GMKtec NucBox G3(N100, RAM 16GB, NVMe 256GB)의 Docker Compose 서버**다. 서버 전체(API·계산 자식 포함) 기본 상한은 CPU 3개·메모리 10GiB다.

| 항목 | 운영 구성 |
| --- | --- |
| 퍼블릭 도메인 | `config.env`의 `DOMAIN`을 사용한다. 공인 IP·DNS·포트 전달은 별도 운영 범위다. |
| HTTPS·프록시 | 기존 Traefik 3.7.19의 `infra-proxy`·`websecure`·`letsencrypt`를 재사용한다. 앱 Compose는 서버 서비스 하나이며 내부 3000번 포트를 호스트에 게시하지 않는다. |
| 호스트 | Docker Engine과 Compose를 사전에 준비한다. 앱 도구는 Traefik·네트워크를 새로 설치하거나 호스트 SSH·방화벽을 변경하지 않는다. |
| 계산 장치 | 서버로 아웃바운드 연결한다. 장치별 SSH 배포와 인바운드 포트 개방이 필요하지 않다. |
| 프로세스·파일 | 비 root UID 1000·읽기 전용 이미지와 `/var/lib/quant-platform` named volume을 사용한다. 가변 데이터는 이미지와 분리한다. |

구성 기준은 [Docker 서버 운영](DOCKER_SERVER.md)·[compose.yaml](../compose.yaml)이다.

## 10. 환경변수와 설정

**운영자가 편집하는 원본은 `config.env` 하나**다. Git에서 제외하고 권한 600으로 관리한다. Docker와 앱의 설정 전달 범위는 도구 내부에서 구분한다. 형식은 줄 단위의 원문 `KEY=value`이며 source/eval·변수 확장을 하지 않는다. 중복·알 수 없는 키를 거부하며 외부 셸과 개발 `.env`의 같은 이름 값은 운영 원본을 덮어쓰지 않는다.

| 구분 | 주요 설정 |
| --- | --- |
| Compose | `DOMAIN`, `SERVER_IMAGE`, `SERVER_CPUS`, `SERVER_MEMORY`, `TRAEFIK_*` |
| 인증 | `SESSION_SECRET`, 세션 유휴·절대 만료 설정 |
| 데이터 공급자 | `KRX_API_KEY`·`KRX_APPROVAL_EXPIRY`, `DART_API_KEY`, `FRED_API_KEY`, `TOSS_CLIENT_ID`·`TOSS_CLIENT_SECRET` 및 공급자별 base URL |
| 앱 운영 | `MAX_QUEUED_BACKTESTS`, `SYNC_MIN_FREE_DISK_MB`, `KRX_DAILY_CALL_BUDGET`, 로그 수준·보존 기간, 선택적 `AGENT_CONTAINER_IMAGE` |
| 자동 관리 | production 모드, `0.0.0.0:3000`, 이미지의 `/var/lib/quant-platform` 경로와 명시적 프록시 신뢰 설정 |

[config.env.example](../config.env.example)이 운영 설정의 단일 예시다. [server-config.sh](../scripts/lib/server-config.sh)는 허용 키·기본값·파일 문법과 Compose 값을 검사한다. 앱 값과 조합은 선택된 이미지의 기존 [config.ts](../src/server/bootstrap/config.ts)로 검증한다. 선택적 키는 미사용 시 생략한다. API 키는 Compose label·명령 인자에 넣지 않으며 권한이 제한된 임시 앱 환경 파일에만 쓴다. 임시 파일은 종료 시 정리하고 사용자가 수정하지 않는다. 앱은 config.env를 직접 읽지 않으므로 다른 컨테이너 실행 환경에서도 같은 환경변수 계약을 사용한다.

## 11. 빌드·배포·복구

저장소가 지정한 Node·pnpm으로 개발·검증하고 서버·웹은 `pnpm build`로 빌드한다. 서버 배포 산출물은 컨테이너 이미지다. Agent용 Linux archive는 `dist/agent-runtime/`에서 Agent 이미지와 hermetic workload 검증에만 사용한다.

운영 명령은 `bash scripts/server.sh init`·`validate`·`up`·`update`·`stop`·`status`·`logs`·`cli`다. 호스트 Node는 필요 없다. `pnpm deploy`는 같은 Docker 업데이트의 별칭이다. 서버 이전 중 main 자동 게시 트리거는 일시 중지하고, main에서 수동 실행한 workflow로 서버/Agent 이미지를 검증·게시한다. 서버 적용은 운영자가 수행한다.

원본 설정 변경은 검증 후 `up`으로 현재 고정 이미지에 적용한다. `update`는 후보 이미지를 먼저 확보하고 앱 설정 검증을 통과한 뒤 서비스를 중지해 DB 준비와 readiness를 확인한다. 성공 digest를 고정하고 미완료 업데이트는 이전 이미지의 `up`과 CLI를 차단한다. 설정/다운로드 실패는 실행 중인 앱을 유지하며, DB 준비 이후 실패는 중지 상태에서 같은 후보로 복구한다. 백업·복원을 자동화하지 않는다. 자세한 절차는 [Docker 서버 운영](DOCKER_SERVER.md)을 따른다.

CLI는 배포와 같은 잠금을 사용하며 서버가 중지된 상태에서만 실행한다. 백업·복원이 필요하면 `db:backup`·`db:restore`를 사용하고 **두 DB와 백업 명세를 한 세트로 관리**한다. 유지보수 중 쓰기를 중지하고 여러 WAL DB 파일의 장애 원자성을 가정하지 않는다. 파일 누락·식별자 불일치·미완료 복원은 기동을 차단한다.

## 12. 테스트

| 명령 | 검증 범위 |
| --- | --- |
| `pnpm lint`·`pnpm typecheck` | 정적 규칙과 서버·웹 타입 검사 |
| `pnpm test` | 일반 회귀 검사: `tests/unit`, `tests/integration`, `tests/architecture` |
| `pnpm test:all` | 전체 일반 회귀 검사의 릴리스 진입점(`pnpm test`). `devel` 병합 전과 서버 배포에서 필수 실행 |
| `pnpm test:e2e` | 빌드 후 Playwright 브라우저 검증. 이미지 게시 workflow와 별도로 실행한다. |
| `pnpm test:agent-package` | 내부 runtime archive를 저장소 밖에서 실행해 구성·의존성·준비·계산·결과 저장 계약 검증. GHCR image workflow에서 Docker build/push 전에 실행 |

자동 회귀 테스트는 운영 DB·실제 API 자격증명에 의존하지 않는다. 필요한 SQLite·자식 프로세스는 실제로 실행하되 외부 응답은 fixture·대체 서버로 제어한다. 앱·DB·가변 상태는 테스트별로 격리하고 실패해도 자원을 정리한다. 실서비스 API 점검은 별도다.

회귀 검증은 계산·시점 정합성, 준비 결과 보존·재사용, 버전 호환성, 임대·취소·복구·결과 반영, 인증·모듈 경계를 포함한다. 계약 변경 시 해당 테스트도 변경한다.

이미지 게시 게이트는 **설치 → lint → typecheck → 전체 Vitest(`test:all`) → 서버·웹 및 Agent build → Agent 패키지 검사 → 이미지 build·실행 검사**다. 변경 영향별 테스트 선택 배포는 구현된 것으로 가정하지 않는다. 기준: [vitest.config.ts](../vitest.config.ts), [test-fixtures.ts](../tests/helpers/test-fixtures.ts)·[test-app.ts](../tests/helpers/test-app.ts), [게시 workflow](../.github/workflows/deploy.yml).
