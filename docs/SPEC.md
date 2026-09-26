# Quant Platform — 아키텍처 및 운영 원칙

> **목적:** 사람과 AI가 프로젝트의 의도, 책임 경계, 변경 시 지켜야 할 원칙을 파악하는 기준 문서.
> **검토일:** 2026-09-17 · **코드 기준:** `main@de9eea1f8bd3436d49842cadd4b62e1bf78a73d4`

구조·보안 경계·데이터 계약을 바꿀 때 코드와 함께 갱신한다. 구현과 충돌하면 설계 변경인지 구현 결함인지 확인하고 정합성을 맞춘다. 기능 목록과 작업 이력은 담지 않는다.

설계 배경은 [DECISIONS.md](DECISIONS.md), 개발 시작은 [README.md](../README.md), 계산 장치 운영·버전 계약은 [AGENT_OPERATIONS.md](AGENT_OPERATIONS.md)·[AGENT_RUNTIME_BOUNDARY.md](AGENT_RUNTIME_BOUNDARY.md)를 참조한다. 상세 필드·기본값·실행 순서는 해당 스키마와 스크립트를 기준으로 한다.

---

## 1. 프로젝트 목표

**단일 관리자가 모바일·데스크톱 브라우저에서 퀀트 백테스트를 준비·실행하고 결과를 비교·검증하는 개인용 플랫폼**이다. 데이터의 시점 정합성, 계산의 재현성, 제한된 서버 자원에서의 안정적인 운영을 우선한다. 공개 회원가입이나 다중 사용자 서비스를 전제로 하지 않는다.

하나의 저장소와 제품으로 운영하는 **모듈러 모놀리스**다. 운영 서버가 인증·수집·작업·최종 결과의 기준점이며, 외부 계산 장치는 계산 용량만 확장한다. 서버·웹·다운로드형 에이전트는 같은 릴리스에 게시하되, 계산 코드의 호환성은 배포 커밋과 별도로 관리한다.

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
| 운영 | Linux, systemd, Caddy, SSH 기반 배포 |

정확한 패키지 버전은 [package.json](../package.json)과 잠금 파일을 따른다. 웹 빌드 결과는 Fastify가 제공하며 별도의 퍼블릭 프론트엔드 서비스로 분리하지 않는다.

---

## 4. 런타임과 데이터 흐름

### 실행 구조

```text
브라우저 ── HTTPS ──> Caddy ── 127.0.0.1:3000 ──> Fastify
                                                   ├─ 인증·REST·SSE·정적 웹
                                                   ├─ 작업·참조·결과 관리 ── 운영 DB
                                                   ├─ 외부 데이터 수집 ──── 계산 데이터 DB
                                                   ├─ 서버 전용 자식: 스냅샷 게시·결과 반영
                                                   └─ 계산 배정
                                                       ├─ 원격 에이전트 → 계산 자식
                                                       └─ 내부 에이전트 → 계산 자식
```

두 경로는 같은 `src/runtime`의 준비·백테스트 자식을 실행한다. 원격 Linux 장치가 서버로 **WSS(TLS 기반 WebSocket) 연결을 먼저 만들고** 제어 메시지를 교환하며, 파일은 인증된 HTTPS로 전송한다. 내부 에이전트는 네트워크 재접속 없이 내부 메시지와 로컬 스냅샷을 사용한다.

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

Git SHA는 출처를 기록한다. `agentVersion`·`collectionVersion`·`previewVersion`·`executionVersion`·`validationVersion`은 배포 클라이언트·수집 실행 출처·미리보기·실행·기간 검증을 구분한다. 수집 실행 해시는 원천 재사용이나 외부 요청 허용 기준이 아니다(D-096). 데이터셋 ID·데이터 revision·게시 버전·스키마 버전·파일 해시는 이 코드 버전과 구분한다.

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
├─ agent/            Linux 클라이언트·자원 관리·캐시·업데이트
├─ workers/          서버 전용 스냅샷 게시·결과 반영 자식
├─ shared/           웹·서버·에이전트 사이의 스키마·통신 계약
└─ web/              앱 셸·기능별 화면·공통 UI
migrations/          operations/ · data/ · agent/
packages/agent/      에이전트 전용 의존성·잠금 파일
infra/ · scripts/    프로비저닝·빌드·배포·운영 도구
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
| 에이전트 파일 전송 | `/api/agents/datasets/:version`, `/api/agents/client/*`, `/api/agents/jobs/:jobId/result`. 장치 인증을 요구하며 결과 수신은 파일·실행 버전·현재 임대를 검증한다. |

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

운영 기준은 **AWS Lightsail 서울(`ap-northeast-2`)·Ubuntu 24.04의 단일 서버**다. RAM 1GB 이상·스토리지 40GB 이상, 월 10 USD 미만을 목표로 하며 실제 요금·사용량은 운영 계정에서 확인한다. 클라우드는 교체 가능하다.

| 항목 | 운영 구성 |
| --- | --- |
| 퍼블릭 도메인 | 서비스 도메인의 DNS A 레코드가 서버의 고정 공인 IPv4를 가리킨다. 도메인은 프로비저닝 입력으로 전달하고 `/etc/caddy/Caddyfile`에서 관리한다. |
| HTTPS·프록시 | Caddy가 TLS 인증서 발급·갱신과 HTTPS 진입을 맡고 `127.0.0.1:3000`으로 전달한다. 앱 포트와 DB를 인터넷에 직접 노출하지 않는다. |
| 클라우드 방화벽 | 인바운드는 TCP **22·80·443만 허용**한다. IPv4·IPv6 규칙을 각각 확인한다. 22는 SSH, 80은 인증서 발급·HTTPS 리다이렉트, 443은 웹·에이전트 통신용이다. |
| 호스트 방화벽·SSH | UFW 인바운드 기본 거부, 아웃바운드 허용, 22 rate limit, 80·443 허용. SSH는 공개키 인증을 사용하고 root·비밀번호 로그인을 금지한다. |
| 계산 장치 | 서버로 아웃바운드 연결하므로 장치의 인바운드 포트 개방이나 장치별 SSH 배포가 필요하지 않다. |
| 프로세스·파일 | systemd의 비특권 `quant` 사용자로 실행한다. 코드·설정과 `/var/lib/quant-platform`의 가변 데이터를 분리하고 메모리·프로세스 수 제한을 적용한다. |

클라우드 방화벽·DNS는 별도 운영 설정이다. UFW 설정이 클라우드 방화벽을 대신하지 않는다. 출발 IP 등록이 필요한 외부 API는 실제 아웃바운드 IP와 등록값을 확인한다.

구성 기준: [provision.sh](../infra/provision.sh), [quant-platform.service](../infra/systemd/quant-platform.service). 실제 도메인·인스턴스 식별값은 운영 설정에서 관리하며 추정값을 소스에 고정하지 않는다.

## 10. 환경변수와 설정

**앱·배포 접속·인프라 설정을 분리한다.** 앱 설정은 `/etc/quant-platform/app.env`(`root:root`, `600`)에 두고 변경 후 재시작한다. 비밀값은 저장소·웹 번들·계산 패키지에 넣지 않는다.

| 구분 | 주요 설정 |
| --- | --- |
| 실행·네트워크 | `NODE_ENV`, `APP_BIND_ADDRESS`, `APP_PORT`, `TRUST_PROXY_LOOPBACK` |
| 저장 경로 | `DATABASE_PATH`, `DATA_ROOT`, `EXPORT_ROOT`, `TEMP_ROOT` |
| 인증 | `SESSION_SECRET`는 production에서 필수. 세션 유휴·절대 만료는 `SESSION_*_TIMEOUT_SECONDS`로 설정한다. |
| 데이터 공급자 | `KRX_API_KEY`·`KRX_APPROVAL_EXPIRY`, `DART_API_KEY`, `FRED_API_KEY`, `TOSS_CLIENT_ID`·`TOSS_CLIENT_SECRET` 및 공급자별 base URL |
| 자원·운영 | `MAX_QUEUED_BACKTESTS`, `SYNC_MIN_FREE_DISK_MB`, `KRX_DAILY_CALL_BUDGET`, 로그 수준·보존 기간 |
| 로컬 배포 접속 | 저장소 밖으로 유출하지 않는 로컬 `deploy.env`의 `HOST`·`SSH_*` 설정. 앱 API 키와 구분한다. |

허용값·기본값·조합 검증은 [config.ts](../src/server/bootstrap/config.ts), 예시는 [app.env.example](../infra/app.env.example)·[deploy.env.example](../deploy.env.example)를 따른다. 선택적 비밀값은 미사용 시 생략하며 빈 문자열로 대체하지 않는다. 도메인 `DOMAIN`은 앱이 아닌 프로비저닝 입력이다.

## 11. 빌드·배포·복구

저장소가 지정한 Node·pnpm으로 `pnpm install --frozen-lockfile`을 실행한다. 개발은 `pnpm dev`·`pnpm dev:web`, 서버·웹 빌드는 `pnpm build`다.

초기 구성은 `scripts/bootstrap.sh`, 이후 배포는 **Linux에서 `pnpm run deploy`**다. 깨끗한 작업 트리의 동일 스냅샷을 검증해 서버·웹·에이전트와 체크섬을 게시한다. 에이전트는 전용 코드·의존성·Node만 포함하고 서버·웹·인증 패키지는 제외한다.

배포 진입점은 독립 Bash 스크립트인 `scripts/deploy.sh` 하나다. 로컬 검증·전송 후 한 번의 원격 실행이 잠금을 잡고 배포를 끝낸다. `--remote`는 내부 호출용이며, 대상별 조정 계층·Node 조정 블록·호환 래퍼는 두지 않는다. `deploy.env`는 셸 코드로 평가하지 않는다. stdout·stderr를 화면과 `.logs/deploy-*.log`에 함께 기록하며 `LOG`로 위치를 지정할 수 있다.

배포는 SSH 전송 후 **체크섬 검증·staging 설치 → 서비스 중지·두 DB 백업 → 코드 전환·`db:prepare` → 기동 검증 → 성공 확정·정리**로 진행한다. 성공 확정 전 실패 시 코드와 DB 세트 복원을 시도한다. 코드만 롤백하고 DB 호환성을 방치하지 않으며, 성공 후 이력 정리 실패만으로 정상 배포를 되돌리지 않는다.

백업·복원은 `db:backup`·`db:restore`를 사용하며 **두 DB와 백업 명세를 한 세트로 관리**한다. 유지보수 중 쓰기를 중지하고 여러 WAL DB 파일의 장애 원자성을 가정하지 않는다. 파일 누락·식별자 불일치·미완료 복원은 기동을 차단한다.

실행 순서의 기준은 [build-release.sh](../scripts/build-release.sh)·[deploy.sh](../scripts/deploy.sh)다.

## 12. 테스트

| 명령 | 검증 범위 |
| --- | --- |
| `pnpm lint`·`pnpm typecheck` | 정적 규칙과 서버·웹 타입 검사 |
| `pnpm test` | Vitest의 `tests/unit`, `tests/integration`, `tests/architecture` |
| `pnpm test:e2e` | 빌드 후 Playwright 브라우저 검증. 기본 배포 스크립트와 별도로 실행한다. |
| `pnpm test:agent-package` | 실제 패키지를 저장소 밖에서 실행해 구성·의존성·준비·계산·결과 저장 계약 검증 |

자동 회귀 테스트는 운영 DB·실제 API 자격증명에 의존하지 않는다. 필요한 SQLite·자식 프로세스는 실제로 실행하되 외부 응답은 fixture·대체 서버로 제어한다. 앱·DB·가변 상태는 테스트별로 격리하고 실패해도 자원을 정리한다. 실서비스 API 점검은 별도다.

회귀 검증은 계산·시점 정합성, 준비 결과 보존·재사용, 버전 호환성, 임대·취소·복구·결과 반영, 인증·모듈 경계를 포함한다. 계약 변경 시 해당 테스트도 변경한다.

현재 배포 게이트는 **설치 → lint → typecheck → 전체 Vitest → build → 에이전트 build → 패키지 검증**이다. 변경 영향별 테스트 선택 배포는 구현된 것으로 가정하지 않는다. 기준: [vitest.config.ts](../vitest.config.ts), [test-fixtures.ts](../tests/helpers/test-fixtures.ts)·[test-app.ts](../tests/helpers/test-app.ts), [build-release.sh](../scripts/build-release.sh).
