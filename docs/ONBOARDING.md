# 온보딩 가이드 — Quant Platform

이 문서는 이 저장소에 처음 들어온 주니어 개발자가 **왜 이렇게 생겼는지**를 이해하고
첫 커밋까지 도달하는 것을 목표로 한다. 규칙의 원문은 항상
[SPEC.md](SPEC.md)(이하 "스펙")이고,
이 문서는 그 요약과 길잡이다. 둘이 다르면 스펙이 맞다.

## 1. 이 프로젝트는 무엇인가

**개인용 퀀트 백테스트·자동매매 플랫폼**이다. 사용자는 관리자 1명뿐이고, 회원가입이
없으며, 휴대폰 브라우저에서 백테스트를 돌리고 결과를 보는 것이 주 사용 시나리오다
(모바일 우선 UI). 현재 MVP(백테스트까지)는 완료 상태이고, 실전 자동매매는 아직
구현 전이다 — 진행 상황은 [IMPLEMENTATION_STATUS.md](IMPLEMENTATION_STATUS.md) 참고.

작게 보이지만 "돈을 다루게 될 시스템"이라는 전제로 설계돼 있다. 그래서 정확성
(백테스트 재현성), 보안(인증·권한 분리), 운영(백업·롤백)에 대한 규칙이 유난히
많다. 규칙이 과해 보일 때는 스펙과 [DECISIONS.md](DECISIONS.md)에서 그 이유를
먼저 찾아보라 — 거의 항상 이유가 적혀 있다.

## 2. 문서 지도

| 문서 | 역할 |
|---|---|
| `docs/SPEC.md` | **헌법.** 아키텍처·보안·API·배포의 원문 규칙. 임의로 어기지 않는다 |
| `docs/DECISIONS.md` | 스펙 밖 선택·스펙 편차의 기록 (D-001 ~ D-017). "왜 이렇게 했지?"의 1차 답변처 |
| `docs/PLAN.md` | MVP 구현 계획 (Phase 0~5) |
| `docs/IMPLEMENTATION_STATUS.md` | 무엇이 되어 있고 무엇이 안 되어 있는지 |
| `README.md` | 개발 시작·검증 게이트·배포 절차 요약 |

## 3. 기술 스택과 선택 이유

| 영역 | 선택 | 왜 |
|---|---|---|
| 런타임 | Node 24 (운영) / 22 (개발 허용, D-001) | 단일 서버, 단일 아티팩트 |
| 서버 | Fastify 5 + Zod 4 + Pino | 가볍고 스키마 검증·구조화 로그가 기본 |
| 데이터 DB | SQLite (better-sqlite3 v12 + Drizzle ORM) | 일봉·PIT 재무 fact·메타데이터를 한 DB에서 원자적으로 관리. WAL 모드 |
| 웹 | React 19 + Vite + shadcn/ui + Tailwind 4 | 모바일 우선, TanStack Query/Table, Recharts |
| 인증 | Argon2id + 서버 세션 + TOTP(otpauth) | §7 보안 모델 참고 |
| 테스트 | Vitest (unit/integration) + Playwright (E2E) | |
| 패키지 | pnpm | |

버전 고정에는 다 이유가 있다: TypeScript는 5.9 고정(D-007, typescript-eslint 호환),
better-sqlite3는 v12 고정(D-008, Node 22 prebuild). 올리고 싶으면 해당 D 항목을
먼저 읽어라.

## 4. 아키텍처 큰 그림

**모듈러 모놀리스, 배포 아티팩트 1개.** Fastify 서버 하나가 React 정적 파일과
`/api/v1` REST를 함께 서빙한다. 백테스트는 무겁기 때문에 서버 프로세스 안에서
돌리지 않는다. 기본 local 모드는 같은 아티팩트의 child를 fork하고 동시 실행 1개를
유지한다. 선택적 remote 모드는 별도 PC의 supervisor가 HTTPS lease를 받아 같은 child를
실행하고, 입력·결과를 job 전용 SQLite 파일로 교환한다. 메타데이터와 최종 결과의 기준
DB는 계속 서버 하나뿐이다.

```
브라우저 (React) ── HTTPS ──> Caddy ──> Fastify (127.0.0.1:3000)
                                          ├─ /api/v1 (REST + SSE 진행률)
                                          ├─ SQLite  (일봉·재무 fact·작업·결과 메타)
                                          ├─ local: fork ──> backtest-child
                                          └─ remote: HTTPS <── supervisor ──> backtest-child
```

**애플리케이션은 인프라를 모른다** (스펙 §2.1). 코드 어디에도 Caddy, UFW, AWS,
도메인 같은 개념이 등장하면 안 된다. 앱이 아는 것은 `APP_BIND_ADDRESS=127.0.0.1`,
`APP_PORT=3000` 같은 일반적인 환경변수뿐이다. 클라우드를 갈아치워도 앱 코드는
그대로여야 한다.

## 5. 계층 규칙 — 이 저장소에서 가장 중요한 규칙

각 모듈(`src/server/modules/<이름>/`)은 네 계층으로 나뉜다:

```
domain/          순수 로직. 외부 세계를 전혀 모른다
application/     유스케이스 + "port"(인터페이스) 정의
infrastructure/  port 의 구현체 (SQLite, REST, otpauth …)
presentation/    Fastify 라우트
```

의존 방향은 **presentation/infrastructure → application → domain** 단방향이다.
`domain/` 안에서는 Fastify·React·SQLite·HTTP·fs·`process.env`·증권사 DTO를
import 하는 것이 **금지**다. 이 규칙은 매너가 아니라 기계로 강제된다 —
dependency-cruiser 가 테스트(`tests/architecture/`)로 돌면서 어기면 게이트가
깨진다.

왜 이렇게까지 하나: 백테스트 엔진(돈 계산)이 순수 함수로 격리되어 있어야
"동일 입력 → 동일 결과"를 테스트로 보장할 수 있고, 증권사·DB·프레임워크를
바꿔도 핵심 로직이 안 다치기 때문이다.

새 기능을 만들 때의 사고 순서: ① domain 에 순수 타입/함수 → ② application 에
유스케이스와 port → ③ infrastructure 에 구현체 → ④ presentation 에 라우트 →
⑤ `bootstrap/container.ts` 에 수동 DI로 조립. DI 프레임워크는 없다 —
`createContainer()` 가 손으로 엮는다.

## 6. 디렉터리 지도

```
src/server/bootstrap/     config(Zod 검증) → container(수동 DI) → server(Fastify 조립) → main
src/server/modules/
  auth/                   로그인·세션·TOTP (§7)
  audit/                  감사 로그 (누가 뭘 했나 — audit_logs 테이블)
  market-data/            KRX 일봉, coverage, 종목 마스터
  backtest/               엔진(domain), 작업 큐·오케스트레이터(application), 라우트
  strategy/               전략 레지스트리 + strategies/ (코드 등록식 — 아래 참고)
  broker/                 증권사 REST 어댑터 (kiwoom — App Key 발급 전까지 비활성, D-002)
  system/                 health/live·ready, system/info
src/server/shared/        db(스키마·마이그레이션 러너·정리 작업), logger, 보안 헤더, ids
src/shared/schemas/       웹·서버가 공유하는 Zod 스키마 (백테스트 요청 등)
src/web/features/         화면 단위 (auth, backtests, dashboard, datasets, settings)
src/workers/              backtest-child.ts + remote-backtest-supervisor.ts
migrations/               Drizzle 마이그레이션 — 0000 하나뿐인 이유는 §9
infra/, scripts/          서버 프로비저닝·배포·백업 (§10)
tests/                    unit / integration / e2e / architecture
```

## 7. 도메인 핵심 개념

**Candle(봉)**: `{ symbol, market, timeframe, ts, open, high, low, close, volume }`.
`ts` 는 **UTC epoch ms** 다. 저장소의 모든 시간은 UTC 이고 (서버 시간대도 UTC 고정),
KST 변환은 표시 계층에서만 한다. 1분봉을 import 하면 KR 세션(09:00–15:30 KST)
기준으로 1시간봉으로 집계된다.

**백테스트 정확성 3원칙** (스펙 §9 — 엔진을 만질 때 절대 어기면 안 됨):
1. **next-bar-open 체결**: 신호가 난 봉이 아니라 *다음 봉 시가*에 체결된다.
2. **look-ahead 금지**: 전략은 미래 데이터를 볼 수 없다. 미래 급등 fixture 로
   "급등 전에 신호가 없어야 한다"는 테스트가 존재한다.
3. **결정성**: 동일 입력 + 동일 seed → 동일 결과(해시 비교 테스트). 난수는
   seeded RNG(mulberry32)만 쓴다. 엔진 안에서 `Math.random()`·`Date.now()` 금지.

**작업 큐**: 백테스트 작업은 SQLite 에서 `BEGIN IMMEDIATE` 로 원자적으로 확보(claim)
된다. 취소는 IPC → SIGTERM → SIGKILL 순서, 서버 재시작 시 고아 작업은
`INTERRUPTED` 로 복구된다. 진행률은 SSE(+폴링 폴백)로 웹에 전달된다.

**전략은 코드 등록식이다**: 전략은 `src/server/modules/strategy/strategies/` 에
TypeScript 로 작성하고 레지스트리에 등록한다. UI 는 전략 코드를 만들거나 수정할
수 없고, 등록된 전략의 **검증된 파라미터만** 바꿀 수 있다. `eval`·동적 import
업로드 등 임의 코드 실행 경로는 어떤 이유로도 만들지 않는다 (스펙 §2.5).

## 8. 보안 모델 — D-017 "평면 분리 헌법"

2026-07-27 에 보안 전제가 크게 바뀌었다 (D-017). 요지:

- **웹(플랫폼) = 조회 평면**: 결과 조회, 백테스트 실행, 데이터 관리, 그리고
  (자동매매 구현 후) 비상정지 **끄기만**. 
- **SSH CLI = 제어 평면**: 전략 변경, 주문·자금 조작, 자동매매 재개, TOTP 등록
  같은 보안 설정 변경. **웹 API 에 이런 엔드포인트를 만들지 않는 것 자체가
  방어선이다** — "편하니까 웹에 추가"는 헌법 개정 사항이다 (스펙 §2.6).
- 이 분리 덕분에 웹을 도메인 + Caddy(Let's Encrypt)로 퍼블릭에 노출한다. 웹
  세션이 탈취돼도 돈을 움직일 경로가 없다.

인증 흐름 (auth 모듈을 만질 때 알아야 할 불변식):
1. 비밀번호(Argon2id, 14자 이상) 검증 → TOTP 등록 계정이면 `pending_totp` 세션 발급.
   **pending 세션은 `authenticate()` 를 통과하지 못한다** — TOTP 검증 라우트만 접근 가능.
2. TOTP(6자리, ±30초 창) 또는 1회용 복구 코드 검증 성공 → **세션 ID 회전** 후 정식 세션.
3. 실패는 로그인 잠금(5회/15분)에 합산. TOTP 코드는 재사용 차단(last-used step),
   복구 코드 소비는 원자적이다.
4. TOTP 등록·재발급은 `pnpm cli totp:enroll` — **CLI 전용**. 세션 탈취자가 2FA 를
   자기 기기로 바꿔치기하는 경로를 막는다.

기타: 세션은 서버 저장(httpOnly·Secure·SameSite=Strict 쿠키, 유휴 12h·절대 7d),
CSRF 는 Origin==Host 검사, 비밀값은 Pino redaction 목록으로 로그에서 가려진다 —
새 비밀 필드를 만들면 `src/server/shared/logger.ts` 와 스펙 §16 목록에 **둘 다**
추가해야 한다.

## 9. DB 와 마이그레이션

- 스키마 정의: `src/server/shared/db/schema.ts` (Drizzle). 부팅 시 마이그레이션이
  자동 적용된다.
- 스키마를 바꾸면 `pnpm db:generate` 로 마이그레이션을 생성한다.
- 마이그레이션이 `0000` 하나뿐인 이유: 아직 운영 배포 전이라 이력을 스쿼시했다
  (D-015). **첫 운영 배포 이후에는 스쿼시 금지** — 그때부터는 새 마이그레이션을
  추가하고, 파괴적 변경(컬럼 삭제 등)은 코드가 참조를 끊은 *다음* 릴리스에 싣는다
  (expand-contract, D-010).
- 로컬 DB 는 `./data/app.sqlite`. 꼬였으면 지우고 `pnpm cli admin:create` 부터
  다시 하면 된다 (개발 데이터는 버려도 되는 것만 둔다).

## 10. 개발 시작하기

```bash
pnpm install
pnpm cli admin:create        # 관리자 계정 (비밀번호 14자 이상)
pnpm dev                     # Fastify — http://127.0.0.1:3000
pnpm dev:web                 # Vite dev 서버 (API 프록시) — 웹 작업 시
```

재무전략(`value-quality-rank` 등)이나 PER·ROE 유니버스 단계를 만지려면 `DART_API_KEY` 를
`.env` 에 넣는다. 수집은 CLI 명령이 아니라 백테스트 준비(preparation)가 요청 기간과
최소 warm-up 만큼만 자동으로 한다 — 연도·종목을 지정해 미리 돌리는 절차는 없다. 키가
없으면 그 준비가 막힌다 (실행 후 "거래 0건" 으로 끝나 원인을 못 찾는 상태를 막는다).
일일 호출 한도에 닿으면 준비가 대기 상태로 남아 다음 KST 날짜에 자동으로 이어지고,
서버 재시작 뒤에도 중단된 지점부터 이어진다 — 실패가 아니다. 준비를 취소해도 그때까지
저장한 종목 데이터는 지우지 않는다.

환경변수는 전부 개발용 기본값이 있어서 `.env` 없이 바로 뜬다 (`bootstrap/config.ts`
참고). `SESSION_SECRET` 은 production 에서만 필수다. TOTP 는 등록해야 켜진다 —
로컬에서는 등록 안 하면 비밀번호만으로 로그인되고, 부팅 로그에 경고가 남는 게 정상이다.

**검증 게이트 — 커밋 전에 반드시 전부 통과:**

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm build
pnpm test:e2e                # UI 를 바꿨다면 (Playwright, 390×844 / 1440×900)
```

CSV 형식: `timestamp,open,high,low,close,volume` (ISO 8601 UTC 또는 epoch ms).

## 11. 배포 개요 (요약 — 원문은 README 배포 절)

```
./scripts/bootstrap-server.sh # 새 서버 1회: 주소·도메인 입력 → provision-server.sh 실행
./scripts/bootstrap-worker.sh # 새 계산 PC 1회: Docker·Compose·env·work-root 준비
pnpm run deploy               # 서버 + 선택적 Worker 통합 배포 (deploy.env)
./scripts/backup.sh      # SQLite·exports 백업 (용량 상한 회전, D-013·D-019)
```

- `infra/provision-server.sh` 는 **멱등한 단일 실행**이다: 패키지·Node·UFW(22 rate-limit,
  80, 443)·sshd 하드닝(키 전용)·Caddy(도메인 → 127.0.0.1:3000)·app.env·systemd.
- 두 스크립트의 SSH 접속 파라미터는 전부 환경변수다 (`QP_HOST`·`QP_SSH_USER`·
  `QP_SSH_PORT`·`SSH_KEY`·`QP_SSH_JUMP`·`QP_SSH_HOST_KEY`·`QP_SSH_OPTS`) —
  `~/.ssh/config` 를 만들지 않아도 한 줄로 실행된다. 이름·의미는 두 스크립트가 같다.
- deploy-server.sh 는 재시작 직전 SQLite 스냅샷을 뜨고, health check 실패 시 코드와 DB 를
  함께 롤백한다 (D-010).
- Worker는 Docker Compose 전용이며 app systemd fallback이 없다. 웹과 같은
  `build-release.sh` archive를 image에 넣고 content checksum과 인증·SHA·protocol probe를
  통과해야 전환한다 (D-061).
- 독립 복원 스크립트는 제공하지 않는다. 백업 복구 절차와 격리 복구 검증은 Phase 7
  disaster runbook 에서 함께 설계한다 (D-031).
- 주의: `provision-server.sh` 는 **POSIX sh** 다 — bash 문법(배열, `[[ ]]`, pipefail) 금지.
  `bootstrap-server.sh`/`deploy-server.sh`와 Worker 스크립트는 bash. `provision-worker.sh`와 container
  entrypoint는 POSIX sh다. 셸 스크립트는 전부 LF (`.gitattributes` 강제).

## 12. 작업 관례

- **스펙이 헌법이다.** 스펙과 다르게 하고 싶으면 먼저 DECISIONS.md 에 D-xxx 로
  "무엇을·왜·대안·영향"을 기록한다. 코드만 바꾸고 문서를 안 바꾸는 것이 이
  저장소에서 가장 나쁜 커밋이다.
- **소비자 없는 코드를 만들지 않는다** (D-009): 쓰는 곳 없는 테이블·컬럼·옵션·
  기능 플래그는 넣지 않는다. 필요해지는 시점에 그 시점의 요구대로 만든다.
- 커밋 메시지는 한국어 + conventional prefix (`feat:`, `fix:`, `docs:`,
  `refactor:` …). 본문에 "왜"를 적는다. 관련 D 번호가 있으면 언급한다.
- 비밀값(키·토큰·비밀번호)은 argv 로 넘기지 않는다 — ps·셸 히스토리에 남는다.
  stdin 이나 root 전용 파일로 전달한다 (deploy-server.sh·provision-server.sh 가 예시).
- 테스트는 실동작을 검증한다 — 모킹으로 초록불만 만드는 테스트는 리뷰에서 걸린다.

## 13. 자주 밟는 함정

| 함정 | 설명 |
|---|---|
| Node 버전 | 개발 22 허용, 운영 24 (D-001). `engine-strict` 는 꺼져 있다 |
| TS/라이브러리 업그레이드 | TS 5.9·better-sqlite3 v12 고정 — D-007/D-008 읽기 전에 올리지 말 것 |
| 시간 처리 | 저장·계산은 항상 UTC epoch ms. KST 는 표시에서만 |
| 엔진에서 난수·현재시각 | seeded RNG 만. `Math.random()`/`Date.now()` 는 결정성 테스트를 깨뜨린다 |
| domain 에서 import | fs·env·프레임워크·DB — dependency-cruiser 가 잡는다. 설계를 다시 보라는 신호 |
| 웹에 제어 기능 추가 | 스펙 §2.6 위반 — "헌법 개정" 없이는 금지 |
| 새 비밀 필드 로깅 | redaction 목록(logger.ts + 스펙 §16) 갱신 누락 |
| 서버 app.env | `SESSION_SECRET` 이 든 파일 — 절대 덮어쓰지 않는다 (세션 전체 무효화) |
| 셸 스크립트 CRLF | Windows 에디터로 저장 시 주의 — `.gitattributes` 가 LF 강제하지만 도구 우회 금지 |

---

막히면: ① 스펙에서 해당 § 찾기 → ② DECISIONS.md 에서 관련 D 찾기 →
③ git log 에서 해당 파일의 커밋 메시지.
이 순서면 대부분의 "왜?"가 풀린다.
