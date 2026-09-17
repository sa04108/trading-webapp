# Quant Platform

**브라우저에서 퀀트 백테스트를 준비·실행하고 결과를 비교·검증하는 개인용 플랫폼**이다. 모바일과 데스크톱을 지원하며, 별도 Linux 계산 에이전트를 연결해 계산 자원을 추가할 수 있다.

이 문서는 **개발 시작, 서버 초기 설정·배포, 에이전트 설치·사용, 유지보수 명령**을 안내한다. 아키텍처·보안·데이터·운영 원칙은 [SPEC](docs/SPEC.md)을 따른다.

> 명령 검토 기준: `main@27e12610ec8627718a19c5f562633dfa7b541e80` · 2026-09-17

## 목차

[1. 시작 전 확인](#start) · [2. 로컬 개발](#development) · [3. 운영 서버 최초 설정](#first-deployment) · [4. 계산 에이전트](#agent) · [5. 검증·재배포](#release) · [6. 서버 관리·복구](#maintenance) · [7. 문제 해결·관련 문서](#help)

---

<a id="start"></a>

## 1. 시작 전 확인

| 실행 위치 | 용도·전제 |
| --- | --- |
| **개발·배포 PC** | 저장소를 내려받아 개발·검증·배포한다. 아래 셸 명령은 Linux/WSL2의 Bash 기준이며, 배포와 에이전트 패키징은 Linux에서 실행한다. |
| **운영 서버** | 프로비저닝된 서버에 SSH로 접속해 실행한다. 서버 CLI는 배포된 JavaScript를 `quant` 사용자·그룹과 운영 환경설정으로 실행한다. |
| **에이전트 장치** | Linux/WSL2의 **일반 사용자**로 실행한다. `sudo ./quant-agent`나 `sudo systemctl --user`를 사용하지 않는다. |

개발·배포 PC에는 **Node.js 24 (`>=24 <25`)**, Git, Bash, SSH/SCP, curl, tar가 필요하다. pnpm 버전은 [package.json](package.json)의 `packageManager`를 따른다. Node는 [공식 설치 안내](https://nodejs.org/en/download)에서 24 계열을 선택한다. 다운로드한 에이전트에는 Node와 의존성이 들어 있으므로 **계산 장치에는 Node·pnpm을 별도로 설치하지 않는다.**

예시의 `203.0.113.10`, `quant.example.com`, `ubuntu`, `~/.ssh/quant.pem`은 실제 서버 IP·도메인·SSH 계정·키 경로로 바꾼다. 앱 주소·포트·경로를 별도로 변경한 환경에서는 아래 기본 경로도 맞춰야 한다.

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

**서버는 로컬 `.env`를 자동으로 읽지 않는다.** 이 안내에서는 직접 작성한 셸 호환 `.env`를 현재 Bash에 주입한 뒤 `pnpm` 명령을 실행한다. 운영 서버의 `app.env`를 로컬에 복사하지 않는다.

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

### 3.1 서버와 접속 준비

[SPEC의 클라우드·네트워크 구성](docs/SPEC.md#9-클라우드와-퍼블릭-네트워크)에 맞게 Ubuntu 24.04 서버, 고정 IP, DNS A 레코드와 방화벽을 먼저 준비한다. 현재 프로비저닝 스크립트의 Node 다운로드 대상은 **Linux x64**다. ARM 서버를 같은 절차로 지원한다고 가정하지 않는다.

SSH 공개키가 등록되어 있어야 하고, 접속 계정은 `sudo -n true`를 수행할 수 있어야 한다. 키에 암호가 있으면 SSH agent에 먼저 등록한다.

**개발·배포 PC:**

```bash
chmod 600 "$HOME/.ssh/quant.pem"
# 암호가 있는 키를 사용할 때만 실행한다.
eval "$(ssh-agent -s)"
ssh-add "$HOME/.ssh/quant.pem"

ssh -i "$HOME/.ssh/quant.pem" -o IdentitiesOnly=yes \
  ubuntu@203.0.113.10 'sudo -n true'
```

첫 접속에서는 서버의 SSH 호스트키 지문을 확인한다. 키 인증 실패와 호스트키 불일치는 서로 다른 문제이므로 확인 없이 검사를 끄지 않는다.

### 3.2 프로비저닝

**개발·배포 PC — 저장소 루트:**

```bash
SSH_KEY="$HOME/.ssh/quant.pem" \
QP_APP_HOST=ubuntu@203.0.113.10 \
QP_DOMAIN=quant.example.com \
./scripts/bootstrap-app.sh
```

이 단계는 호스트의 패키지·SSH·방화벽·Caddy·systemd를 구성하므로 전용 서버에서 수행한다. 앱 배포 전 HTTPS 확인에 `502`가 나오는 것은 앱이 아직 실행되지 않았기 때문일 수 있다. **배포 후의 502는 정상 완료가 아니다.** 부트스트랩 로그는 로컬 `.logs/`에 남는다.

### 3.3 운영 환경설정

**개발·배포 PC에서 서버에 접속한 뒤, 운영 서버에서 설정을 편집한다.**

```bash
ssh -t -i "$HOME/.ssh/quant.pem" -o IdentitiesOnly=yes ubuntu@203.0.113.10
```

```bash
# 여기부터 운영 서버의 SSH 셸이다.
sudoedit /etc/quant-platform/app.env
sudo chown root:root /etc/quant-platform/app.env
sudo chmod 600 /etc/quant-platform/app.env
```

프로비저닝이 생성한 `SESSION_SECRET`과 운영 경로는 유지하고, 사용할 공급자 자격증명과 실제 승인 만료일만 입력한다. 필요한 설정의 용도는 [로컬 환경설정](#22-로컬-환경설정), 전체 예시는 [app.env.example](infra/app.env.example)을 참고한다. 선택적 키는 미사용 시 주석으로 남기며 `DART_API_KEY=`처럼 빈 값으로 활성화하지 않는다. 이 파일은 `systemd`가 읽는 설정이지 실행할 셸 스크립트가 아니다.

### 3.4 첫 배포

**개발·배포 PC의 별도 터미널 — 저장소 루트:**

```bash
if [ ! -e deploy.env ]; then
  (umask 077; cp deploy.env.example deploy.env)
fi
chmod 600 deploy.env
nano deploy.env
```

`deploy.env`에는 SSH 접속 정보만 넣는다. API 키는 넣지 않는다.

```dotenv
QP_APP_HOST=ubuntu@203.0.113.10
QP_APP_SSH_KEY=~/.ssh/quant.pem
QP_APP_SSH_PORT=22
QP_APP_SSH_HOST_KEY=accept-new
```

**bootstrap의 `SSH_KEY`·`QP_SSH_*`와 배포의 `QP_APP_SSH_*`는 이름이 다르다.** bootstrap에 넘긴 값이 `deploy.env`에 자동 저장되지는 않는다. 추가 접속 옵션은 [deploy.env.example](deploy.env.example)을 따른다.

```bash
git status --short --branch
pnpm run deploy
```

배포할 수정사항을 먼저 커밋해 **작업 트리가 깨끗한 상태**여야 한다. 배포는 현재 체크아웃한 커밋을 사용하며, 원격 `main`을 자동으로 가져오지 않는다. 검증·빌드·에이전트 패키징도 배포 명령이 수행하므로 별도 선행 빌드는 필요하지 않다.

### 3.5 최초 관리자 생성·TOTP 등록

**운영 서버 — 대화형 SSH 셸에서 실행한다.** 최초 배포 직후 앱을 중지한 상태에서 계정과 TOTP를 함께 설정한다. 이미 설정한 운영 계정에 반복 실행하지 않는다.

운영 릴리스에는 개발용 `tsx`가 필요하지 않다. 아래 명령은 **운영 사용자·환경파일·작업 디렉터리·배포된 CLI**를 모두 지정한다. `--pty`는 대화형 입력, `--wait`는 종료 결과 확인에 사용한다.

```bash
(
  set -e
  sudo systemctl stop quant-platform

  sudo systemd-run --pty --wait --collect \
    --uid=quant --gid=quant \
    --property=Type=oneshot --property=TimeoutStartSec=infinity \
    --property=UMask=0077 \
    --property=EnvironmentFile=/etc/quant-platform/app.env \
    --working-directory=/opt/quant-platform/current \
    /usr/local/bin/node /opt/quant-platform/current/dist/server/cli.js admin:create

  sudo systemd-run --pty --wait --collect \
    --uid=quant --gid=quant \
    --property=Type=oneshot --property=TimeoutStartSec=infinity \
    --property=UMask=0077 \
    --property=EnvironmentFile=/etc/quant-platform/app.env \
    --working-directory=/opt/quant-platform/current \
    /usr/local/bin/node /opt/quant-platform/current/dist/server/cli.js totp:enroll

  sudo systemctl start quant-platform
)
```

TOTP 등록에서는 방금 만든 사용자 이름을 입력하고 인증 앱의 6자리 코드를 확인한다. **TOTP secret과 일회용 복구 코드는 안전한 별도 장소에 보관**한다. 터미널 녹화·화면 공유·출력 파일 저장에 주의한다.

중간 명령이 실패하면 앱을 중지 상태로 유지한다. 계정 생성만 성공했다면 `admin:create`를 반복하지 말고 [TOTP 재등록 절차](#totp-reset)로 남은 설정을 완료한다. 비밀번호만 설정된 운영 계정을 그대로 서비스하지 않는다.

### 3.6 정상 동작 확인과 첫 실행

**운영 서버:**

```bash
sudo systemctl status quant-platform --no-pager
curl -fsS --retry 15 --retry-delay 1 --retry-connrefused \
  http://127.0.0.1:3000/api/v1/health/ready
sudo journalctl -u quant-platform -n 100 --no-pager
```

**개발·배포 PC:**

```bash
curl -fsS https://quant.example.com/api/v1/health/ready
```

서비스가 실행 중이고 readiness가 `ready`를 반환하면 브라우저에서 `https://quant.example.com`에 접속해 **비밀번호 → TOTP** 로그인을 확인한다. 상태 확인만으로 실제 데이터 수집까지 검증되는 것은 아니다.

로그인 후 백테스트 입력을 설정하고 준비·미리보기를 수행한다. 필요한 데이터는 준비 과정에서 수집하며, 공급자 호출 한도로 대기하는 작업은 허용 시각 이후 재개된다. 별도 데이터 수집 CLI를 먼저 실행하는 절차는 없다. 준비 완료 후 실행을 제출하고 결과를 확인한다. 외부 에이전트 연결은 선택이며 서버 자원이 허용하면 내부 실행기를 사용한다.

---

<a id="agent"></a>
## 4. 계산 에이전트 설치·사용

### 4.1 장치 준비와 설치

Linux glibc 환경, tar, 사용자 systemd가 필요하다. Windows에서는 WSL2를 사용한다. 장치가 운영 서버의 HTTPS 주소에 접근할 수 있어야 하며, 장치의 인바운드 포트를 열 필요는 없다.

운영 웹의 **설정 → Agent**에서 장치 이름으로 토큰을 발급하고, 장치 아키텍처에 맞는 클라이언트를 다운로드한다. 토큰은 발급 직후 한 번만 표시되므로 장치별로 별도 발급한다. 실제 게시된 아키텍처만 다운로드할 수 있다.

**에이전트 장치 — 일반 사용자, 다운로드 파일이 있는 디렉터리:**

```bash
uname -m
getconf GNU_LIBC_VERSION
mkdir -p quant-agent-install
tar -xzf quant-agent-linux-x64.tar.gz -C quant-agent-install
cd quant-agent-install
./quant-agent --check
./quant-agent install
```

`x86_64` 장치는 x64 패키지를 사용한다. `aarch64` 장치는 **arm64 패키지가 게시된 경우에만** 파일명을 `quant-agent-linux-arm64.tar.gz`로 바꾼다. glibc 버전 오류는 패키지 빌드 환경과 장치의 호환성을 확인한다.

서버 주소에는 `https://quant.example.com`처럼 서비스의 기본 주소를 입력하고 장치 토큰을 붙여 넣는다. **현재 토큰 입력은 화면에 표시된다.** 설치 후 사용자 서비스가 시작되며 운영 웹의 Agent 화면과 아래 명령으로 연결 상태를 확인한다.

```bash
systemctl --user status quant-agent --no-pager
journalctl --user -u quant-agent -n 100 --no-pager
```

서비스의 `active` 표시는 프로세스 실행 확인이다. 서버 연결·데이터 준비 여부는 웹과 로그에서도 확인한다.

### 4.2 상시 실행과 서비스 관리

설치기가 로그아웃 후 실행을 위한 linger 설정을 완료하지 못했다면 **에이전트를 설치한 사용자의 셸**에서 다음 명령을 실행한다.

```bash
sudo loginctl enable-linger "$USER"
loginctl show-user "$USER" -p Linger
```

이후 명령은 같은 일반 사용자로 실행한다. 필요한 명령을 골라 사용하며 아래를 한꺼번에 실행하지 않는다.

| 작업 | 명령 |
| --- | --- |
| 상태 확인 | `systemctl --user status quant-agent --no-pager` |
| 실시간 로그 확인 | `journalctl --user -u quant-agent -f` |
| 일시 중지 / 다시 시작 | `systemctl --user stop quant-agent` / `systemctl --user start quant-agent` |
| 재시작 | `systemctl --user restart quant-agent` |
| 자동 시작 해제와 즉시 중지 | `systemctl --user disable --now quant-agent` |
| 자동 시작 복구와 즉시 시작 | `systemctl --user enable --now quant-agent` |

로그 보기를 `Ctrl+C`로 끝내도 서비스는 중지되지 않는다. 설치 후에는 처음 압축을 푼 복사본 대신 **설치된 `current` 실행 파일**을 사용한다.

### 4.3 업데이트·주소·토큰 변경

**에이전트 장치 — 일반 사용자:** 기본 설치 경로와 `XDG_DATA_HOME` 변경을 모두 처리하는 명령이다.

```bash
# 설치된 버전 확인
"${XDG_DATA_HOME:-$HOME/.local/share}/quant-agent/current/quant-agent" --check

# 게시된 최신 에이전트 확인·설치
"${XDG_DATA_HOME:-$HOME/.local/share}/quant-agent/current/quant-agent" update
```

서버가 요구하는 에이전트 버전이 바뀌면 자동 업데이트도 수행한다. 수동 `update`는 저장된 토큰을 사용하며, 실행 중인 사용자 서비스는 업데이트 후 재시작한다. 이미 최신이거나 서비스가 원래 중지되어 있으면 불필요하게 시작하지 않는다.

주소나 토큰을 바꿀 때는 다음 순서로 실행한다. 토큰을 잃었거나 폐기했다면 웹에서 새 장치 토큰을 발급받는다.

```bash
(
  set -e
  systemctl --user stop quant-agent
  "${XDG_DATA_HOME:-$HOME/.local/share}/quant-agent/current/quant-agent" setup
  systemctl --user start quant-agent
)
```

`setup`은 설정을 저장할 뿐 서비스에 즉시 반영하지 않는다. 실패하면 서비스를 중지 상태로 두고 설정을 다시 확인한다.

| 기본 경로 | 용도 |
| --- | --- |
| `~/.local/state/quant-agent/settings.json` | 서버 주소·장치 토큰 |
| `~/.local/state/quant-agent/datasets/`, `jobs/` | 데이터 캐시·작업·전송 대기 결과 |
| `~/.local/share/quant-agent/current` | 설치된 현재 버전 |
| `~/.config/systemd/user/quant-agent.service` | 사용자 서비스 |

XDG 환경설정에 따라 경로가 달라질 수 있다. `install --state "$HOME/agent-state"`로 설치했다면 이후 `setup`, `run`, `update`에도 **동일한 `--state "$HOME/agent-state"`**를 붙인다. `--state`는 상태 저장 위치이며 실행 파일 설치 위치와는 별개다. 경로를 잊었다면 `systemctl --user cat quant-agent`로 서비스의 실행 인자를 확인한다.

### 4.4 장치 해제와 직접 실행

장치를 더 이상 쓰지 않을 때는 로컬에서 중지한 뒤 **웹의 설정 → Agent에서 해당 장치를 해제**한다.

```bash
systemctl --user disable --now quant-agent
```

로컬 중지만으로 토큰이 폐기되지는 않는다. 웹에서 해제해도 이미 받은 데이터·작업 파일이 자동 삭제되지는 않으므로 장치 반납 전에는 해당 상태 경로를 확인한다.

systemd가 없는 환경에서 직접 실행할 때는 **압축을 푼 패키지 디렉터리**에서 실행한다. 이미 설치한 서비스와 동시에 같은 상태 경로를 사용하지 않는다.

```bash
./quant-agent setup
./quant-agent run
```

직접 실행은 터미널 종료와 `Ctrl+C`의 영향을 받는다. 자동 업데이트 뒤 종료 코드 `75`로 끝나면 출력에 안내된 설치 경로의 `current/quant-agent run`으로 다시 시작해야 한다.

<details>
<summary><strong>WSL2: systemd 활성화와 Windows 실행 조건</strong></summary>

**Windows PowerShell:** WSL2 배포판이 설치되어 있다는 전제다. 아래에서 `Ubuntu`는 `wsl --list --verbose`에 나온 실제 배포판 이름으로 바꾼다.

```powershell
wsl --version
wsl --list --verbose
wsl -d Ubuntu
```

**WSL 내부:** `ps -p 1 -o comm=`의 결과가 `systemd`이면 설정 변경은 생략한다. 아니라면 다음 파일을 편집하고 기존 내용을 유지하면서 `[boot]` 절에 `systemd=true`를 설정한다.

```bash
ps -p 1 -o comm=
sudoedit /etc/wsl.conf
```

```ini
[boot]
systemd=true
```

**Windows PowerShell:** 저장 후 대상 배포판을 종료·다시 실행한다. 종료 전 해당 배포판의 진행 중인 작업을 끝낸다.

```powershell
wsl --terminate Ubuntu
wsl -d Ubuntu
```

WSL에 다시 들어온 뒤 `ps -p 1 -o comm=`과 `systemctl --user status`로 확인하고 에이전트를 설치한다. 구형 WSL에서 systemd가 지원되지 않으면 Windows에서 `wsl --update` 후 다시 확인한다.

**사용자 서비스 자동 시작과 Windows 부팅 시 WSL 자동 기동은 다른 설정이다.** linger나 systemd만으로 WSL 인스턴스의 상시 실행을 보장하지 않는다. Windows 재부팅 후에는 대상 배포판의 기동 상태를 확인하고, Windows 절전·종료 또는 WSL 종료 중에는 작업할 수 없다. WSL 설치·systemd 설정의 전제는 [Microsoft 공식 안내](https://learn.microsoft.com/en-us/windows/wsl/systemd)를 따른다.

</details>

---

<a id="release"></a>
## 5. 개발 검증과 재배포

### 5.1 검증·빌드

**개발·배포 PC — 저장소 루트:**

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

UI 동작은 별도로 E2E를 실행한다. 브라우저와 OS 의존성 설치는 해당 환경에서 최초 1회 필요하다.

```bash
pnpm exec playwright install --with-deps chromium
pnpm test:e2e
```

E2E는 자체 테스트 서버의 `127.0.0.1:3100`을 사용하므로 그 포트를 비워 둔다. 모바일·데스크톱 프로젝트를 함께 검사한다.

에이전트 변경을 별도 검증할 때는 Linux에서 패키징과 패키지 검사를 실행한다.

```bash
pnpm build:agent
pnpm test:agent-package
```

특정 테스트만 개발 중에 확인할 때는 Vitest에 디렉터리나 실제 파일 경로를 지정한다.

```bash
pnpm exec vitest run tests/architecture
pnpm exec vitest run tests/integration/job-queue.test.ts
```

이는 **개발 중 선택 실행**이며 배포의 전체 검증을 대체하지 않는다. 현재 `pnpm run deploy`는 변경 영향별 테스트 선택 기능을 제공하지 않는다.

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

**개발·배포 PC — 저장소 루트:** 배포하려는 커밋을 체크아웃하고 `deploy.env`의 대상 서버를 확인한 뒤 실행한다.

```bash
git status --short --branch
git log -1 --oneline
pnpm run deploy
```

명령 내부에서 **의존성 설치 → lint → typecheck → 전체 Vitest → 서버·웹 빌드 → 에이전트 패키징·검증 → SSH 배포**를 수행한다. E2E는 자동 포함되지 않는다. 완료 후 [정상 동작 확인](#36-정상-동작-확인과-첫-실행)을 반복하며, 기존 관리자를 다시 생성하지 않는다.

실패 시 오류 출력을 먼저 확인한다. commit 단계 전 실패하면 코드·DB 복원을 시도하지만, **복원 실패나 finalize 실패까지 모두 이전 상태로 되돌아갔다고 가정하지 않는다.** 서비스·로그·실제 배포 버전을 확인한 뒤 후속 작업을 결정한다. 명령의 기준은 [build-release.sh](scripts/build-release.sh)와 [deploy.mjs](scripts/deploy.mjs)다.

---

<a id="maintenance"></a>
## 6. 서버 관리와 복구

이 절은 **운영 서버에 SSH로 접속한 뒤 실행**한다. DB 변경 작업은 배포·다른 유지보수 CLI와 동시에 실행하지 않는다. 아래 예시는 기본 운영 경로를 기준으로 한다.

### 6.1 상태·로그·재시작

| 작업 | 명령 |
| --- | --- |
| 앱 상태 | `sudo systemctl status quant-platform --no-pager` |
| 최근 앱 로그 | `sudo journalctl -u quant-platform -n 100 --no-pager` |
| 실시간 앱 로그 | `sudo journalctl -u quant-platform -f` |
| 앱 재시작 | `sudo systemctl restart quant-platform` |
| 앱 중지 / 시작 | `sudo systemctl stop quant-platform` / `sudo systemctl start quant-platform` |
| 프록시 상태·로그 | `sudo systemctl status caddy --no-pager` / `sudo journalctl -u caddy -n 100 --no-pager` |
| 현재 릴리스 | `readlink -f /opt/quant-platform/current` |
| 디스크·메모리 | `df -h /var/lib/quant-platform` / `free -h` |

재시작 후에는 [readiness 확인](#36-정상-동작-확인과-첫-실행)까지 수행한다. `active` 상태만으로 초기화·외부 연결의 정상 동작을 판단하지 않는다.

### 6.2 설정 변경 반영

```bash
sudoedit /etc/quant-platform/app.env
sudo systemctl restart quant-platform
curl -fsS --retry 15 --retry-delay 1 --retry-connrefused \
  http://127.0.0.1:3000/api/v1/health/ready
sudo journalctl -u quant-platform -n 100 --no-pager
```

`app.env` 내용 변경에는 재시작이 필요하며 `daemon-reload`만으로 반영되지 않는다. **systemd 유닛 파일 자체를 변경했을 때만** `sudo systemctl daemon-reload` 후 앱을 재시작한다. API 키만 바꾸면서 `SESSION_SECRET`이나 파일 권한을 함께 바꾸지 않는다.

<a id="totp-reset"></a>
### 6.3 TOTP 등록·재발급

이미 생성된 계정에 사용한다. 재발급 확인에 동의하면 기존 인증 앱 항목과 복구 코드는 무효화되므로, 완료 후 새 코드로 로그인을 확인한다.

```bash
(
  set -e
  sudo systemctl stop quant-platform
  sudo systemd-run --pty --wait --collect \
    --uid=quant --gid=quant \
    --property=Type=oneshot --property=TimeoutStartSec=infinity \
    --property=UMask=0077 \
    --property=EnvironmentFile=/etc/quant-platform/app.env \
    --working-directory=/opt/quant-platform/current \
    /usr/local/bin/node /opt/quant-platform/current/dist/server/cli.js totp:enroll
  sudo systemctl start quant-platform
)
```

명령이 실패하면 앱은 중지 상태로 남는다. 기존 TOTP의 재발급 질문에 `yes`가 아닌 답을 해 변경을 취소한 경우에는 기존 설정이 유지된다. TOTP 미등록 계정이라면 실제 등록 완료를 확인하기 전 앱을 공개하지 않는다.

### 6.4 DB 백업

진행 중인 작업과 다른 쓰기 작업을 정리할 유지보수 시간을 확보한다. **백업은 운영 DB·계산 DB·해시 명세의 세 파일이 한 세트**다. 아래는 성공한 뒤에만 앱을 다시 시작하며, 실패하면 중지 상태로 남긴다.

```bash
(
  set -e
  BACKUP="/var/lib/quant-platform/backups/manual-$(date -u +%Y%m%d-%H%M%S).sqlite"
  sudo systemctl stop quant-platform
  sudo systemd-run --pipe --wait --collect \
    --uid=quant --gid=quant \
    --property=Type=oneshot --property=TimeoutStartSec=infinity \
    --property=UMask=0077 \
    --property=EnvironmentFile=/etc/quant-platform/app.env \
    --working-directory=/opt/quant-platform/current \
    /usr/local/bin/node /opt/quant-platform/current/dist/server/cli.js db:backup "$BACKUP"
  sudo -u quant test -s "$BACKUP"
  sudo -u quant test -s "$BACKUP.data"
  sudo -u quant test -s "$BACKUP.json"
  printf '백업 세트: %s, %s.data, %s.json\n' "$BACKUP" "$BACKUP" "$BACKUP"
  readlink -f /opt/quant-platform/current
  sudo systemctl start quant-platform
)
```

출력된 **세 파일과 대응 릴리스 정보**를 함께 보관한다. 이 DB 백업에는 `app.env`, SSH 키, 앱 릴리스 파일이 포함되지 않는다. 서버 디스크 안의 사본만으로 호스트 손실에 대비할 수 없으므로 안전한 별도 저장소에도 보관한다.

### 6.5 DB 복원

> **현재 DB를 백업 시점으로 되돌리는 작업이다.** 필요하면 먼저 위 절차로 현재 상태를 백업한다. 해당 서버의 배포·다른 CLI·계산 에이전트를 중지하고, 백업과 현재 릴리스의 호환성을 확인한다. `db:restore`는 앱 코드나 `app.env`까지 되돌리는 명령이 아니다.

백업 세트는 `quant` 사용자가 읽을 수 있는 경로에 둔다. 아래 `BACKUP`을 실제 **운영 DB 백업 파일** 경로로 교체한다. `.data`나 `.json` 파일을 인자로 넘기지 않는다.

```bash
(
  set -e
  BACKUP='/var/lib/quant-platform/backups/manual-YYYYMMDD-HHMMSS.sqlite'
  sudo -u quant test -s "$BACKUP"
  sudo -u quant test -s "$BACKUP.data"
  sudo -u quant test -s "$BACKUP.json"
  sudo systemctl stop quant-platform

  sudo systemd-run --pipe --wait --collect \
    --uid=quant --gid=quant \
    --property=Type=oneshot --property=TimeoutStartSec=infinity \
    --property=UMask=0077 \
    --property=EnvironmentFile=/etc/quant-platform/app.env \
    --working-directory=/opt/quant-platform/current \
    /usr/local/bin/node /opt/quant-platform/current/dist/server/cli.js db:restore "$BACKUP"

  sudo systemd-run --pipe --wait --collect \
    --uid=quant --gid=quant \
    --property=Type=oneshot --property=TimeoutStartSec=infinity \
    --property=UMask=0077 \
    --property=EnvironmentFile=/etc/quant-platform/app.env \
    --working-directory=/opt/quant-platform/current \
    /usr/local/bin/node /opt/quant-platform/current/dist/server/cli.js db:prepare

  sudo systemctl start quant-platform
)
```

복원은 CLI가 해시를 검증한다. 오류나 연결 단절이 있었다면 완료를 추정하지 말고 실행 상태를 확인한다. 복원 기록이 남은 경우 **같은 백업 경로로 복원을 재개**하고, 기록 파일을 임의로 지워 부팅시키지 않는다. 구형 단일 DB의 복원·전환은 이 일반 절차의 대상이 아니며 [상세 복구 문서](docs/AGENT_OPERATIONS.md#db-마이그레이션과-복원)를 따른다.

복원·준비가 모두 성공한 뒤 readiness, 로그인, 주요 결과 조회를 확인한다. 계산 에이전트는 서버 확인 이후 다시 시작한다.

<details>
<summary><strong>추가 운영 진단 명령</strong></summary>

최근 실행 비용 보고서의 조회는 다음과 같이 수행한다. 이 명령은 기존 DB를 읽으며 서비스 중지는 필요하지 않다.

```bash
sudo systemd-run --pipe --wait --collect \
  --uid=quant --gid=quant \
  --property=Type=oneshot --property=TimeoutStartSec=infinity \
  --property=EnvironmentFile=/etc/quant-platform/app.env \
  --working-directory=/opt/quant-platform/current \
  /usr/local/bin/node /opt/quant-platform/current/dist/server/cli.js \
  backtest:telemetry-report --since-days 30
```

이미 수집한 구간의 **거래불가일 보완이 필요한 경우에만** 다음 명령을 사용한다. 일반적인 첫 실행의 선행 단계가 아니며 실제 KRX API를 호출한다. 기간을 실제 대상으로 바꾸고, 다른 수집·배포와 겹치지 않게 실행한다.

```bash
(
  set -e
  FROM='2025-01-01'
  TO='2025-01-31'
  sudo systemctl stop quant-platform
  sudo systemd-run --pipe --wait --collect \
    --uid=quant --gid=quant \
    --property=Type=oneshot --property=TimeoutStartSec=infinity \
    --property=EnvironmentFile=/etc/quant-platform/app.env \
    --working-directory=/opt/quant-platform/current \
    /usr/local/bin/node /opt/quant-platform/current/dist/server/cli.js \
    krx:backfill-non-trading --from "$FROM" --to "$TO"
  sudo systemctl start quant-platform
)
```

</details>

---

<a id="help"></a>
## 7. 문제 해결·관련 문서

| 증상 | 먼저 확인할 것 |
| --- | --- |
| 로컬 `.env`를 바꿨는데 설정이 그대로다 | 해당 API/CLI 터미널에 파일을 다시 주입하고 프로세스를 재시작한다. 다른 셸의 export 값이나 이미 실행 중인 서버는 자동 갱신되지 않는다. |
| 개발 웹의 API 요청이 실패한다 | `pnpm dev`가 실행 중인지 확인한다. 기본 Vite 프록시는 `127.0.0.1:3000`을 사용한다. |
| 운영 CLI가 권한·환경변수·모듈 오류로 실패한다 | 개발용 `pnpm cli` 대신 이 문서의 전체 `systemd-run` 명령을 사용한다. `app.env`를 일반 사용자에게 읽기 가능하게 바꾸지 않는다. |
| `ConfigError`가 난다 | 앱 로그에서 변수명을 확인한다. 활성화한 빈 키, TOSS 자격증명 한쪽 누락, KRX 설정을 점검한다. 로그 공유 전 비밀값을 제거한다. |
| HTTPS 502 또는 readiness 실패 | 앱 상태·로그와 로컬 readiness를 먼저 확인하고, 이어 Caddy 로그를 확인한다. 인증서 확인만으로 앱 배포가 완료된 것은 아니다. |
| 준비가 대기 상태다 | 화면의 데이터 수집·호출 한도·실행 장치 상태를 확인한다. 원인을 보지 않고 반복 제출하거나 재시작하지 않는다. |
| Agent가 `active`인데 연결되지 않는다 | 서버 주소, 토큰의 유효성, 네트워크, 패키지 아키텍처·glibc, Agent 로그와 웹 상태를 확인한다. |
| `Failed to connect to bus`가 난다 | 에이전트를 설치한 일반 사용자로 로그인했는지, 사용자 systemd가 동작하는지 확인한다. WSL2는 위 systemd 설정을 확인한다. |
| 배포가 작업 트리 오류로 중단된다 | `git status --short --branch`로 배포할 변경을 확인·커밋한다. 오류를 없애려고 사용자 변경을 강제로 지우지 않는다. |
| 복원 이후 앱이 기동하지 않는다 | 백업 세트·릴리스 호환성·미완료 복원 기록과 로그를 확인한다. 빈 DB를 새로 만들어 덮거나 복원 기록을 강제로 삭제하지 않는다. |

설계 원칙은 [SPEC](docs/SPEC.md), 에이전트의 상세 진단·복구는 [AGENT_OPERATIONS](docs/AGENT_OPERATIONS.md), 계산 코드·버전 계약은 [AGENT_RUNTIME_BOUNDARY](docs/AGENT_RUNTIME_BOUNDARY.md), 설계 변경 배경은 [DECISIONS](docs/DECISIONS.md)를 참고한다. 개발 작업 규칙은 [AGENTS.md](AGENTS.md)를 따른다.

명령의 구현 기준은 [package.json](package.json), [서버 CLI](src/server/cli.ts), [bootstrap](scripts/bootstrap-app.sh), [배포 스크립트](scripts/deploy.mjs), [에이전트 CLI](src/agent/cli.ts)다. `systemd-run` 옵션은 [Ubuntu 매뉴얼](https://manpages.ubuntu.com/manpages/noble/man1/systemd-run.1.html)을 참고한다.
