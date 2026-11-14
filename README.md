# Quant Platform

**브라우저에서 퀀트 백테스트를 준비·실행하고 결과를 비교·검증하는 개인용 플랫폼**이다. 모바일과 데스크톱을 지원하며, Windows Docker Desktop 에이전트를 연결해 계산 자원을 추가할 수 있다.

이 문서는 **개발 시작, 서버 초기 설정·배포, 에이전트 설치·사용, 유지보수 명령**을 안내한다. 아키텍처·보안·데이터·운영 원칙은 [SPEC](docs/SPEC.md)을 따른다.

[Docker 서버 운영](docs/DOCKER_SERVER.md)은 Ubuntu 26.04 LTS의 G3 미니 PC에서 서버를 Compose로 실행하고 기존 Traefik에 연결한다. 기본 한도는 CPU 3개·RAM 10GiB이며 호스트 Node.js 설치는 필요 없다.

## 목차

[1. 시작 전 확인](#start) · [2. 로컬 개발](#development) · [3. 운영 서버 최초 설정](#first-deployment) · [4. 계산 에이전트](#agent) · [5. 검증·재배포](#release) · [6. 서버 관리·복구](#maintenance) · [7. 문제 해결·관련 문서](#help)

---

<a id="start"></a>

## 1. 시작 전 확인

| 실행 위치 | 용도·전제 |
| --- | --- |
| **개발·배포 PC** | 저장소를 내려받아 개발·검증한다. 아래 셸 명령은 Linux/WSL2의 Bash 기준이다. |
| **운영 서버** | Docker Compose와 `scripts/server.sh`로 운영한다. |
| **에이전트 장치** | Windows Docker Desktop에서 Linux 컨테이너로 실행한다. Linux/WSL2 네이티브 설치는 제공하지 않는다. |

로컬 개발 PC에는 **Node.js 24 (`>=24 <25`)**, Git과 Bash가 필요하다. CI와 이미지 빌드는 [.node-version](.node-version)의 **24.22.2 LTS**로 맞춘다. pnpm 버전은 [package.json](package.json)의 `packageManager`를 따른다. Node는 [공식 설치 안내](https://nodejs.org/en/download)에서 24 계열을 선택한다. 서버와 에이전트 이미지에는 Node와 의존성이 포함된다.

---

<a id="development"></a>

## 2. 로컬 개발

### 2.1 저장소와 의존성

**개발 PC에서 실행한다.** 이후 개발·배포 명령의 작업 디렉터리는 저장소 루트다.

```bash
git clone https://github.com/sa04108/trading-webapp.git
cd trading-webapp
node --version
corepack enable
pnpm --version
pnpm install --frozen-lockfile
```

`corepack`이 없거나 서명 오류가 발생하면 `npm install --global corepack`으로 설치·갱신한 뒤 `corepack enable`부터 다시 실행한다. 전역 설치에 권한 오류가 나면 Node 설치 경로의 권한부터 확인한다. 프로젝트의 `pnpm install`을 root로 실행하지 않는다.

Ubuntu에서 네이티브 모듈 빌드 도구가 없다는 오류가 날 때만 설치한다.

```bash
sudo apt-get update
sudo apt-get install -y build-essential python3 pkg-config
pnpm install --frozen-lockfile
```

### 2.2 로컬 환경설정

**서버는 로컬 `.env`를 자동으로 읽지 않는다.** 이 안내에서는 직접 작성한 셸 호환 `.env`를 현재 Bash에 주입한 뒤 `pnpm` 명령을 실행한다. 운영 서버의 `config.env`와는 별도다.

```bash
# 기존 설정은 덮어쓰지 않는다.
if [ ! -e .env ]; then
  (umask 077; printf "NODE_ENV='development'\n" > .env)
fi
chmod 600 .env
nano .env
```

필요한 공급자 설정만 추가한다. 아래 줄은 예시이므로 **실제 값을 채운 뒤 사용할 줄의 주석만 해제**한다. 값은 작은따옴표로 감싸고, 미사용 항목은 주석으로 남긴다. 이 파일은 셸로 읽으므로 출처를 신뢰할 수 없는 파일을 대신 사용하지 않는다.

```dotenv
NODE_ENV='development'
# KRX_API_KEY='발급받은 키'
# KRX_APPROVAL_EXPIRY='실제 승인 만료일 YYYY-MM-DD'
# DART_API_KEY='발급받은 키'
# FRED_API_KEY='발급받은 키'
# TOSS_CLIENT_ID='발급받은 ID'
# TOSS_CLIENT_SECRET='발급받은 비밀값'
```

| 설정 | 필요할 때 |
| --- | --- |
| KRX 키·승인 만료일 | 한국 시장 일봉·과거 종목 구성 데이터를 수집할 때 |
| DART 키 | 재무·자본변동 데이터가 필요한 백테스트를 준비할 때 |
| FRED 키 | 미국 지수 벤치마크를 수집할 때 |
| TOSS ID·SECRET | 표시용 종목 정보 어댑터를 사용할 때. 두 값은 함께 설정한다. |

설정 없이도 개발 서버와 로그인 화면을 기동할 수 있지만, 필요한 공급자 설정과 데이터가 없으면 해당 백테스트 준비는 완료할 수 없다. 상세 허용값은 [서버 설정 코드](src/server/bootstrap/config.ts)를 확인한다.

### 2.3 관리자 생성과 개발 서버 실행

**개발 PC의 터미널 1 — 저장소 루트:** `.env` 주입은 새 터미널마다 수행한다. 이미 export된 설정을 제거하려면 새 셸에서 시작한다. `.env`의 줄을 지우는 것만으로 기존 셸의 환경변수가 해제되지는 않는다.

```bash
set -a
. ./.env
set +a

# 최초 1회. 사용자 이름과 14자 이상의 비밀번호를 입력한다.
pnpm cli admin:create

# 로컬에서도 2단계 인증을 사용할 때 실행한다.
pnpm cli totp:enroll

# API 서버. 중지는 Ctrl+C.
pnpm dev
```

계정이 이미 있으면 생성 명령을 반복하지 않는다. 개발 환경에서 TOTP 등록은 선택이며, **운영 계정은 반드시 등록**한다. 로컬 기본 DB는 `data/` 아래에 생성된다.

**개발 PC의 터미널 2 — 같은 저장소 루트:**

```bash
pnpm dev:web
```

브라우저에서 Vite가 출력한 주소(기본 `http://localhost:5173`)로 접속한다. Vite가 `/api` 요청을 `127.0.0.1:3000`으로 전달하므로 **API와 웹 개발 서버를 모두 실행**해야 한다. 공급자 키를 `VITE_*` 변수로 만들지 않는다.

---

<a id="first-deployment"></a>

## 3. 운영 서버 최초 설정

운영 서버에 Docker Compose와 기존 Traefik을 준비하고 저장소 루트에서 실행한다. 자세한 전제와 네트워크 설정은 [Docker 서버 운영](docs/DOCKER_SERVER.md)을 따른다.

```bash
bash scripts/server.sh init
nano config.env
bash scripts/server.sh validate
bash scripts/server.sh cli admin:create
bash scripts/server.sh cli totp:enroll
bash scripts/server.sh up
bash scripts/server.sh status
bash scripts/server.sh logs
```

`init`이 생성한 `config.env`에 도메인과 필요한 공급자 자격증명을 설정한다. 이 파일만 직접 수정하며 비밀이 포함되므로 권한 600을 유지하고 Git에 추가하지 않는다. 각 줄은 `KEY=value` 형식의 원문 값이다. 따옴표, `$`, `#`도 값 그대로 취급되며 셸의 `source`나 `eval`로 읽지 않는다. 실행 시 생성되는 앱 전용 환경 파일은 임시 파일로 자동 정리되므로 수정하지 않는다. Compose 설정은 도구가 원본에서 직접 전달한다. 선택적 키는 사용하지 않을 때 생략한다.

기존 Docker `server.env` 또는 `app.env`가 있으면 `init`은 새 비밀을 생성하지 않고 중단한다. 기존 설정, 특히 `SESSION_SECRET`을 `config.env`로 옮긴 뒤 기존 파일을 정리한다. 앱 바인딩 `0.0.0.0:3000`과 데이터 경로 `/var/lib/quant-platform`은 자동 관리한다.

`validate`는 이미지의 앱 설정만 검증하며 DB에 접근하거나 서비스를 중단하지 않는다. 관리자 생성과 TOTP 등록을 마친 뒤 `up`으로 실행한다. 브라우저에서 설정한 HTTPS 주소에 접속해 비밀번호와 TOTP 로그인을 확인한다. 백테스트 준비 과정에서 필요한 데이터가 수집되며 공급자 호출 한도로 대기하는 작업은 허용 시각 이후 재개된다. 외부 에이전트 연결은 선택이다.

---

<a id="agent"></a>
## 4. 계산 에이전트 설치·사용

### 4.1 Windows Docker Desktop 설치

운영 웹의 **설정 → Agent**에서 장치 이름을 입력해 연결 토큰을 발급한다. 토큰을 발급하면 해당 장치용 **Windows Docker Desktop 설치 파일**을 다운로드할 수 있다. 토큰은 한 번만 표시되며 설치 파일 안에 포함되므로 파일과 토큰을 안전하게 보관한다.

다운로드한 `quant-agent-windows.cmd`를 Windows에서 실행한다. 설치기는 Docker Desktop을 설치하거나 시작하고, Linux 엔진을 확인한 뒤 설치 파일에 지정된 GHCR 이미지를 내려받아 Agent 컨테이너를 시작한다. Windows 기능 설정, UAC, Docker Desktop 최초 약관 동의 또는 재부팅 안내가 나오면 해당 절차를 마친 뒤 **같은 CMD 파일을 다시 실행**한다. Windows x64와 ARM64를 지원하며 장치에 맞는 Linux amd64 또는 arm64 이미지를 선택한다.

장치가 운영 서버의 HTTPS 주소에 접근할 수 있어야 한다. 인바운드 포트는 필요 없다. 설치기와 컨테이너 동작은 [Windows 설치·이미지 관리 상세](docs/AGENT_OPERATIONS.md#windows-docker-desktop)를 참고한다.

### 4.2 업데이트와 상태 확인

서버 업데이트 후 버전이 바뀌면 설정 → Agent의 ‘저장한 기존 연결 토큰’에 보관한 활성 토큰을 입력하여 `quant-agent-windows.cmd`를 다시 내려받아 실행한다. 같은 토큰을 사용하면 기존 캐시 볼륨을 유지한다. 같은 파일을 재실행하면 파일에 지정된 이미지를 다시 받아 컨테이너를 교체하며 named volume의 데이터 캐시와 미전송 결과는 유지한다. 설치 파일을 잃었거나 토큰을 교체해야 할 때는 기존 장치를 해제하고 새 토큰과 설치 파일을 발급받는다.

Docker Desktop이 실행 중일 때 컨테이너는 자동 재시작한다. Windows 로그인 시 Docker Desktop 자동 시작을 켜 둔다. Windows 절전·종료나 Docker Desktop 종료 중에는 계산할 수 없다. 연결 상태는 운영 웹의 설정 → Agent 화면에서 확인한다. 로컬 진단은 PowerShell에서 다음 명령을 사용한다.

```powershell
docker --context desktop-linux ps --filter "name=quant-agent-"
docker --context desktop-linux logs --tail 100 <컨테이너 이름>
```

설치 파일에는 서버 주소와 장치 토큰이 포함된다. 전달·게시하지 말고, 토큰은 이미지에 저장되지 않은 채 `QUANT_AGENT_SERVER_URL`·`QUANT_AGENT_TOKEN` 컨테이너 환경변수로만 전달된다. Docker 관리자는 컨테이너 환경변수를 확인할 수 있다. 장치를 해제할 때는 운영 웹에서 해당 Agent를 해제하고, 필요하면 Docker Desktop에서 컨테이너와 named volume을 직접 제거한다. 볼륨을 삭제하면 캐시와 미전송 결과도 삭제된다.

서버와 Agent 실행 버전이 다르면 Agent는 작업을 중단하고 최신 설치 파일을 다시 실행하도록 안내한다. Linux 내부 런타임은 Docker 이미지에서 사용하며 Linux/WSL2 네이티브 설치나 별도 업데이트 명령은 제공하지 않는다.

<a id="release"></a>
## 5. 개발 검증과 재배포

### 5.1 검증·빌드

**개발·배포 PC — 저장소 루트:**

```bash
pnpm lint
pnpm typecheck
pnpm test:all
pnpm build
```

검사는 역할과 실행 비용에 따라 나눈다.

| 명령 | 범위와 실행 시점 |
| --- | --- |
| `pnpm test` | 단위·일반 통합·아키텍처 회귀 검사. 개발 중 기본 실행 |
| `pnpm test:all` | 전체 일반 회귀 검사의 릴리스 진입점(`pnpm test`). `devel` 병합 전과 서버 배포에서 필수 실행 |

10년 규모의 합성 DB를 생성하는 장기간 부하 검사와 전용 fixture는 제거했다.
일반 회귀·자원 배정 정책·패키지 검증은 유지한다.
새 테스트의 추가·통합·삭제 기준은 [AGENTS.md](AGENTS.md)의 검증 정책을 따른다.

UI 동작은 별도로 E2E를 실행한다. 브라우저와 OS 의존성 설치는 해당 환경에서 최초 1회 필요하다.

```bash
pnpm exec playwright install --with-deps chromium
pnpm test:e2e
```

E2E는 자체 테스트 서버의 `127.0.0.1:3100`을 사용하므로 그 포트를 비워 둔다. 모바일·데스크톱 프로젝트를 함께 검사한다.

에이전트 이미지 변경은 GitHub Actions가 Docker 빌드 전에 내부 런타임 경계와 실제 작업 실행을 검증한다. `pnpm build:agent`와 `pnpm test:agent-package`는 내부 Docker 구성·hermetic 검증용이며 사용자 다운로드 파일을 만들거나 게시하지 않는다.

특정 테스트만 개발 중에 확인할 때는 Vitest에 디렉터리나 실제 파일 경로를 지정한다.

```bash
pnpm exec vitest run tests/architecture
pnpm exec vitest run tests/integration/job-queue.test.ts
```

이는 **개발 중 선택 실행**이며 배포의 전체 검증을 대체하지 않는다. 이미지 게시 CI는 전체 필수 검증을 실행한다.

### 5.2 스키마 변경

**개발 PC — 저장소 루트:** 스키마 수정 후 마이그레이션을 생성하고, 생성된 SQL을 검토한다. 로컬 DB에 적용할 때는 `pnpm dev`를 먼저 중지한다.

```bash
pnpm db:generate
set -a
. ./.env
set +a
pnpm cli db:prepare
```

검토한 스키마·마이그레이션·관련 테스트를 함께 커밋한다. **운영 적용은 배포 과정에 포함**되므로 운영 서버에서 마이그레이션 생성 명령을 실행하지 않는다.

### 5.3 재배포

`main`에 merge하면 GitHub Actions가 검증한 서버·Agent 이미지를 GHCR에 게시한다. `devel` push는 게시·배포하지 않는다. 이미지 게시 후 서버에서 업데이트한다. 세부 설정은 [GitHub Actions 이미지 게시와 배포](docs/GITHUB_ACTIONS_DEPLOY.md)를 따른다.

**Docker 서버:** 체크아웃을 릴리스에 맞춘 뒤 `bash scripts/server.sh update`를 실행한다. 호스트 pnpm을 사용하는 경우 `pnpm deploy`도 같은 명령이다. 다운로드·설정 검증과 DB 준비·기동 확인을 수행하며 성공한 digest를 고정한다. 다운로드·설정 검증 실패는 기존 앱을 유지한다. DB 준비·기동 단계의 실패는 서버를 중지하고 미완료 업데이트를 기록하며 DB·이미지를 자동 복원하지 않는다. 자세한 절차는 [Docker 업데이트](docs/DOCKER_SERVER.md#업데이트와-실패-처리)를 따른다.


---

<a id="maintenance"></a>
## 6. 서버 관리와 복구

운영 서버의 저장소 루트에서 명령을 실행한다. DB 변경 작업은 업데이트나 다른 유지보수 CLI와 동시에 실행하지 않는다. 상세 절차는 [Docker 서버 운영](docs/DOCKER_SERVER.md)을 따른다.

```bash
bash scripts/server.sh status
bash scripts/server.sh logs
bash scripts/server.sh stop
bash scripts/server.sh up
```

`stop`, `status`, `logs`는 `config.env`가 잘못되어도 사용할 수 있다. 설정 변경은 `config.env`를 수정하고 `validate`로 확인한 뒤 `up`을 실행해 현재 고정 이미지에 반영한다. 새 이미지는 `update`로 선택한다. 기존 `SESSION_SECRET`과 파일 권한을 유지한다.

<a id="totp-reset"></a>
### 6.1 TOTP 등록·재발급

```bash
bash scripts/server.sh stop
bash scripts/server.sh cli totp:enroll
bash scripts/server.sh up
```

재발급에 동의하면 기존 인증 앱 항목과 복구 코드는 무효화된다. 완료 후 새 코드로 로그인을 확인한다.

### 6.2 DB 백업·복원

운영 DB, 계산 DB와 해시 명세 세 파일이 한 백업 세트다. 유지보수 시간에 쓰기 작업과 에이전트를 중지하고, 컨테이너의 데이터 경로 아래 백업을 만든다.

```bash
bash scripts/server.sh stop
bash scripts/server.sh cli db:backup /var/lib/quant-platform/backups/before.sqlite
bash scripts/server.sh up
```

`before.sqlite`, `before.sqlite.data`, `before.sqlite.json`과 대응 이미지 정보를 함께 안전한 별도 저장소에 보관한다. 복원은 현재 DB를 백업 시점으로 되돌린다. 백업과 이미지의 호환성을 확인한 뒤 데이터 경로에 세 파일을 두고 실행한다.

```bash
bash scripts/server.sh stop
bash scripts/server.sh cli db:restore /var/lib/quant-platform/backups/before.sqlite
bash scripts/server.sh cli db:prepare
bash scripts/server.sh up
```

복원은 해시를 검증한다. 중단되어 복원 기록이 남으면 같은 백업 경로로 재개하고 기록을 임의로 삭제하지 않는다. 성공 후 readiness와 로그인, 주요 결과를 확인한 뒤 에이전트를 다시 시작한다. 구형 단일 DB 전환은 [상세 복구 문서](docs/AGENT_OPERATIONS.md#db-마이그레이션과-복원)를 따른다.

### 6.3 추가 진단과 수집

```bash
bash scripts/server.sh stop
bash scripts/server.sh cli backtest:telemetry-report --since-days 30
bash scripts/server.sh cli krx:backfill-non-trading --from 2025-01-01 --to 2025-01-31
bash scripts/server.sh up
```

보고서는 기존 DB를 읽는다. 거래불가일 보완은 이미 수집한 구간에 필요할 때만 사용하며 실제 KRX API를 호출한다. 날짜를 대상에 맞추고 다른 수집·업데이트와 겹치지 않게 한다. 일반 백테스트 준비에 별도 동기화 CLI는 필요 없다.

---

<a id="help"></a>
## 7. 문제 해결·관련 문서

| 증상 | 먼저 확인할 것 |
| --- | --- |
| 로컬 `.env`를 바꿨는데 설정이 그대로다 | 해당 API/CLI 터미널에 파일을 다시 주입하고 프로세스를 재시작한다. 다른 셸의 export 값이나 이미 실행 중인 서버는 자동 갱신되지 않는다. |
| 개발 웹의 API 요청이 실패한다 | `pnpm dev`가 실행 중인지 확인한다. 기본 Vite 프록시는 `127.0.0.1:3000`을 사용한다. |
| 운영 CLI가 권한·환경변수·모듈 오류로 실패한다 | `bash scripts/server.sh cli`를 사용하고 `config.env`와 Docker 접근 권한을 확인한다. |
| `ConfigError`가 난다 | 앱 로그에서 변수명을 확인한다. 활성화한 빈 키, TOSS 자격증명 한쪽 누락, KRX 설정을 점검한다. 로그 공유 전 비밀값을 제거한다. |
| HTTPS 502 또는 readiness 실패 | 앱 상태·로그와 로컬 readiness를 먼저 확인하고, 이어 Traefik 로그와 Docker label 라우트를 확인한다. 인증서 확인만으로 앱 배포가 완료된 것은 아니다. |
| 준비가 대기 상태다 | 화면의 데이터 수집·호출 한도·실행 장치 상태를 확인한다. 원인을 보지 않고 반복 제출하거나 재시작하지 않는다. |
| Agent가 연결되지 않는다 | Docker Desktop Linux 엔진, 컨테이너 상태·로그, 설치 파일에 포함된 토큰, 서버 HTTPS 접근을 확인한다. 필요하면 같은 설치 파일을 다시 실행한다. |
| 복원 이후 앱이 기동하지 않는다 | 백업 세트·릴리스 호환성·미완료 복원 기록과 로그를 확인한다. 빈 DB를 새로 만들어 덮거나 복원 기록을 강제로 삭제하지 않는다. |

설계 원칙은 [SPEC](docs/SPEC.md), 에이전트의 상세 진단·복구는 [AGENT_OPERATIONS](docs/AGENT_OPERATIONS.md), 계산 코드·버전 계약은 [AGENT_RUNTIME_BOUNDARY](docs/AGENT_RUNTIME_BOUNDARY.md), 설계 변경 배경은 [DECISIONS](docs/DECISIONS.md)를 참고한다. 개발 작업 규칙은 [AGENTS.md](AGENTS.md)를 따른다.

명령의 구현 기준은 [package.json](package.json), [서버 CLI](src/server/cli.ts), [서버 운영 스크립트](scripts/server.sh), [Windows 설치기](scripts/install-agent-windows.ps1)다.
