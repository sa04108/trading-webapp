# Tailscale 단일 명령 프로비저닝 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `./scripts/bootstrap.sh <ip>` 한 번으로 새 서버가 배포 가능 상태가 되게 한다 — WireGuard·Caddy 를 Tailscale 로 대체하고 락아웃 방지를 코드로 강제한다.

**Architecture:** 개발 PC 의 `scripts/bootstrap.sh` 가 `infra/provision.sh` 를 서버로 올려 2 단계로 실행한다 — 기본 모드(§21·22·23·28·29) 후 tailnet 경유 SSH 를 **실제로 검증**하고 나서야 `--harden`(§25·26). TLS 종단은 `tailscale serve`, Caddy 가 주던 것 중 앱에 없는 HSTS 와 압축만 Fastify 로 옮긴다.

**Tech Stack:** POSIX sh(서버) / bash(개발 PC), Tailscale(`--advertise-tags=tag:server`, `tailscale serve`), Fastify 5 + `@fastify/compress`, vitest.

**설계 문서:** [docs/superpowers/specs/2026-07-26-tailscale-provisioning-design.md](../specs/2026-07-26-tailscale-provisioning-design.md)

## Global Constraints

- `infra/provision.sh` 는 **POSIX sh** — Lightsail 이 launch script 를 dash 로 실행해 `set -o pipefail` 로 실제 깨진 전례가 있다. pipefail·brace expansion·`[[ ]]`·배열 금지. 검증: `dash -n`.
- `scripts/*.sh` 는 bash (deploy.sh 와 동일 관례). 검증: `bash -n`.
- **비밀값을 argv 로 넘기지 않는다** (deploy.sh 헤더 원칙). auth key 는 env/프롬프트 → stdin, SESSION_SECRET 은 서버 생성.
- **멱등**: provision.sh 의 모든 단계는 현재 상태를 확인하고 필요할 때만 변경한다. 2 회 실행 = 1 회 실행.
- 주석은 한국어, 스펙 절 번호(§n)와 결정 번호(D-nnn) 인용 — 리포 관례.
- 기존 게이트 유지: `pnpm lint && pnpm typecheck && pnpm test && pnpm build`. Node `>=24 <25`, TS ~5.9.
- `scripts/deploy.sh` 는 수정하지 않는다. (예외: 2026-07-26 최종 리뷰 후 사용자가 이번
  한 번만 명시적으로 승인 — usage 문자열·헤더 주석의 `<wireguard-host>` 표현만 tailnet
  FQDN 예시로 교체했다. 동작은 한 줄도 바꾸지 않았다.)

---

### Task 1: HSTS 헤더 추가

앱의 `SECURITY_HEADERS`(스펙 §16)에는 CSP·nosniff·X-Frame-Options·Referrer-Policy 가 이미 있다. Caddy 제거로 사라지는 것은 HSTS 하나이므로 그 한 줄만 추가한다.

**Files:**
- Modify: `src/server/shared/security.ts:9-15`
- Test: `tests/unit/security-headers.test.ts` (신규)

**Interfaces:**
- Consumes: `createTestApp` (`tests/helpers/test-app.ts`) — `Promise<TestApp>`, `TestApp.app.inject()` 사용 가능
- Produces: `SECURITY_HEADERS` 에 `'Strict-Transport-Security': 'max-age=31536000'` 키 추가 (기존 소비자 — onSend 훅, SSE — 는 목록을 순회하므로 변경 불요)

- [ ] **Step 1: 실패하는 테스트 작성**

`tests/unit/security-headers.test.ts`:

```typescript
import { afterEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../helpers/test-app.js';

describe('보안 헤더 (스펙 §16 + D-016 HSTS)', () => {
  let testApp: TestApp;

  afterEach(async () => {
    await testApp.close();
  });

  it('모든 응답에 보안 헤더를 설정한다 — Caddy 제거 후에도 앱이 보장', async () => {
    testApp = await createTestApp();
    const res = await testApp.app.inject({ method: 'GET', url: '/api/v1/health/live' });

    expect(res.statusCode).toBe(200);
    expect(res.headers['strict-transport-security']).toBe('max-age=31536000');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['content-security-policy']).toContain("default-src 'self'");
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `pnpm vitest run tests/unit/security-headers.test.ts`
Expected: FAIL — `strict-transport-security` 가 `undefined`

- [ ] **Step 3: 최소 구현**

`src/server/shared/security.ts` 의 `SECURITY_HEADERS` 에 추가:

```typescript
export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'Content-Security-Policy':
    "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'",
  // TLS 종단은 tailscale serve 지만 HTTP 응답 정책은 앱 책임이다 (D-016) —
  // 엣지를 무엇으로 바꾸든 헤더가 따라다닌다.
  'Strict-Transport-Security': 'max-age=31536000',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
};
```

- [ ] **Step 4: 통과 확인**

Run: `pnpm vitest run tests/unit/security-headers.test.ts`
Expected: PASS (1 test)

- [ ] **Step 5: 커밋**

```bash
git add src/server/shared/security.ts tests/unit/security-headers.test.ts
git commit -m "feat(security): HSTS 헤더 추가 — Caddy 제거 대비 (D-016)"
```

---

### Task 2: @fastify/compress 등록

Caddy 의 `encode zstd gzip` 대체. 기본 threshold(1024 bytes) 유지 — 작은 JSON 응답은 압축하지 않는다.

**Files:**
- Modify: `package.json` (의존성), `src/server/bootstrap/server.ts:48` 근처, `tests/helpers/test-app.ts:17`
- Test: `tests/unit/compression.test.ts` (신규)

**Interfaces:**
- Consumes: `buildServer(container)` — `app.ready()` 전에는 라우트 추가 가능
- Produces: `createTestApp(env?, configure?)` — 두 번째 인자 `configure?: (app: FastifyInstance) => void` 를 `buildServer` 직후·`ready()` 직전에 호출. 기존 호출부(단일 인자)는 영향 없음

- [ ] **Step 1: 의존성 설치**

```bash
pnpm add @fastify/compress
```

- [ ] **Step 2: 테스트 헬퍼에 configure 훅 추가**

`tests/helpers/test-app.ts` 의 시그니처와 본문 수정:

```typescript
export async function createTestApp(
  env: Record<string, string> = {},
  configure?: (app: FastifyInstance) => void,
): Promise<TestApp> {
```

`buildServer` 호출부를:

```typescript
  const container = createContainer(config);
  const app = await buildServer(container);
  configure?.(app); // 테스트 전용 라우트 등록 등 — ready() 전에만 가능
  await app.ready();
```

- [ ] **Step 3: 실패하는 테스트 작성**

`tests/unit/compression.test.ts`:

```typescript
import { afterEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../helpers/test-app.js';

describe('응답 압축 (D-016 — Caddy encode 대체)', () => {
  let testApp: TestApp;

  afterEach(async () => {
    await testApp.close();
  });

  it('threshold 를 넘는 응답을 gzip 으로 압축한다', async () => {
    testApp = await createTestApp({}, (app) => {
      app.get('/test/large', async () => ({ data: 'x'.repeat(4096) }));
    });
    const res = await testApp.app.inject({
      method: 'GET',
      url: '/test/large',
      headers: { 'accept-encoding': 'gzip' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-encoding']).toBe('gzip');
  });

  it('Accept-Encoding 이 없으면 압축하지 않는다', async () => {
    testApp = await createTestApp({}, (app) => {
      app.get('/test/large', async () => ({ data: 'x'.repeat(4096) }));
    });
    const res = await testApp.app.inject({ method: 'GET', url: '/test/large' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-encoding']).toBeUndefined();
  });
});
```

- [ ] **Step 4: 실패 확인**

Run: `pnpm vitest run tests/unit/compression.test.ts`
Expected: FAIL — 첫 테스트에서 `content-encoding` 이 `undefined`

- [ ] **Step 5: 최소 구현**

`src/server/bootstrap/server.ts` — import 추가:

```typescript
import fastifyCompress from '@fastify/compress';
```

`fastifyMultipart` 등록 직후에 (라우트 등록 전이어야 전역 적용):

```typescript
  // Caddy 의 encode zstd gzip 대체 (D-016). SSE 는 reply.hijack() 으로
  // onSend 훅을 우회하므로 압축의 영향을 받지 않는다.
  await app.register(fastifyCompress);
```

- [ ] **Step 6: 통과 확인 + 전체 게이트**

Run: `pnpm vitest run tests/unit/compression.test.ts` → PASS (2 tests)
Run: `pnpm lint && pnpm typecheck && pnpm test` → 전부 green (기존 82 + 신규 3 = 85)

- [ ] **Step 7: 커밋**

```bash
git add package.json pnpm-lock.yaml src/server/bootstrap/server.ts tests/helpers/test-app.ts tests/unit/compression.test.ts
git commit -m "feat(server): @fastify/compress 등록 — Caddy encode 대체 (D-016)"
```

---

### Task 3: infra/provision.sh

서버에서 root 로 실행되는 프로비저닝 본체 — 기본 모드(§21·22·23·28·29)와 `--harden` 모드(§25·26)를 한 파일에 담는다.

**Files:**
- Create: `infra/provision.sh`

**Interfaces:**
- Consumes: stdin 첫 줄 = Tailscale auth key (없으면 빈 값 허용 — 이미 조인된 재실행), 같은 디렉터리의 `quant-platform.service`·`app.env.example` (bootstrap.sh 가 함께 업로드)
- Produces: stdout 마지막에 `FQDN=<Self.DNSName>` 마커 한 줄 (Task 4 의 bootstrap.sh 가 grep), `--harden` 인자로 진입하는 하드닝 모드

- [ ] **Step 1: provision.sh 작성**

```sh
#!/bin/sh
# 서버 프로비저닝 (설계: docs/superpowers/specs/2026-07-26-tailscale-provisioning-design.md).
# scripts/bootstrap.sh 가 업로드·실행한다. 직접 실행 시:
#   기본:   printf '%s\n' "$TS_AUTHKEY" | sudo sh provision.sh
#   하드닝: sudo sh provision.sh --harden   (tailnet 경유 SSH 검증 후에만!)
#
# POSIX sh 로만 쓴다 — bashism 금지. Lightsail launch script 가 dash 로 실행되어
# `set -o pipefail` 에 즉사한 전례가 있다 (2026-07-26). 이 파일은 launch script 가
# 아니지만 같은 규율을 유지한다: pipefail·brace expansion·[[ ]]·배열 금지.
#
# 멱등하다 — 모든 단계가 현재 상태를 확인하고 필요할 때만 변경한다.
set -eu

MODE="${1:-base}"
SELF_DIR="$(cd "$(dirname "$0")" && pwd)"

# 붙여넣기 전에 nodejs.org 의 현재 24.x LTS patch 로 갱신한다. SHA 는 자동 검증.
NODE_VERSION=v24.18.0

[ "$(id -u)" -eq 0 ] || { echo "root 로 실행해야 합니다 (sudo sh $0)" >&2; exit 1; }

# ─────────────────────────────────────────────── --harden (§25 UFW + §26 SSH)
if [ "${MODE}" = "--harden" ]; then
  echo "==> §25 UFW — tailscale0 만 허용"
  # 전제: bootstrap.sh 가 tailnet 경유 SSH 를 실증한 뒤에만 이 모드를 호출한다.
  # 여기서 퍼블릭 22 가 닫힌다 — Lightsail 브라우저 SSH 콘솔도 함께 죽는다.
  ufw default deny incoming
  ufw default allow outgoing
  ufw allow in on tailscale0 to any port 22 proto tcp
  # 443 은 tailscale serve 가 tailscaled 프로세스 안에서 종단하므로 tailscale0
  # 인바운드 패킷으로 나타나지 않는다고 판단해 열지 않는다. 실측에서 serve 접속이
  # 막히면 다음 줄을 추가한다 (설계 §10 실측 확인 항목):
  #   ufw allow in on tailscale0 to any port 443 proto tcp
  ufw --force enable
  ufw status verbose

  echo "==> §26 SSH 하드닝"
  cat > /etc/ssh/sshd_config.d/99-quant-hardening.conf <<'EOF'
PermitRootLogin no
PasswordAuthentication no
KbdInteractiveAuthentication no
PubkeyAuthentication yes
X11Forwarding no
MaxAuthTries 3
LoginGraceTime 30
EOF
  sshd -t
  # Ubuntu 의 유닛명은 sshd 가 아니라 ssh 다
  systemctl restart ssh
  echo "하드닝 완료"
  exit 0
fi

# ─────────────────────────────────────────────── 기본 모드
# auth key 는 stdin 첫 줄로 받는다 — argv 는 ps 와 셸 히스토리에 남는다 (deploy.sh 원칙).
# EOF/빈 줄이면 빈 값 — 이미 조인된 서버의 재실행에서는 키가 필요 없다.
IFS= read -r TS_AUTHKEY || TS_AUTHKEY=""

echo "==> §21 패키지·타임존·유저·디렉터리"
export DEBIAN_FRONTEND=noninteractive
# 첫 부팅 직후에는 unattended-upgrades 가 apt 락을 잡고 있을 수 있다 — 기다린다.
APT="apt-get -o DPkg::Lock::Timeout=600 -y"
$APT update
$APT full-upgrade
$APT install ca-certificates curl git jq openssl unzip xz-utils build-essential \
             python3 pkg-config sqlite3 ufw unattended-upgrades

timedatectl set-timezone UTC

id quant >/dev/null 2>&1 || useradd --system --home /var/lib/quant-platform \
  --create-home --shell /usr/sbin/nologin quant

# brace expansion 은 dash 에 없다 — 경로를 하나씩 적는다
mkdir -p \
  /opt/quant-platform/releases \
  /etc/quant-platform \
  /var/lib/quant-platform/market-data \
  /var/lib/quant-platform/imports \
  /var/lib/quant-platform/exports \
  /var/lib/quant-platform/temp \
  /var/lib/quant-platform/backups
chown -R quant:quant /var/lib/quant-platform
chown -R root:root /opt/quant-platform /etc/quant-platform
chmod 750 /etc/quant-platform

echo "==> §22 Node.js ${NODE_VERSION}"
if [ -x /usr/local/bin/node ] && [ "$(/usr/local/bin/node --version)" = "${NODE_VERSION}" ]; then
  echo "이미 설치됨 — 건너뜀"
else
  cd /tmp
  NODE_FILE="node-${NODE_VERSION}-linux-x64.tar.xz"
  curl -fsSLO "https://nodejs.org/dist/${NODE_VERSION}/${NODE_FILE}"
  curl -fsSLO "https://nodejs.org/dist/${NODE_VERSION}/SHASUMS256.txt"
  # grep 과 sha256sum 을 파이프로 잇지 않는다 — pipefail 없이는 grep 의 빈손을 셸이 못 본다
  grep " ${NODE_FILE}\$" SHASUMS256.txt > node.sha256
  sha256sum -c node.sha256
  mkdir -p "/opt/node-${NODE_VERSION}"
  tar -xJf "${NODE_FILE}" -C "/opt/node-${NODE_VERSION}" --strip-components=1
  rm -f "${NODE_FILE}" SHASUMS256.txt node.sha256
  # 심볼릭 링크 전환 — patch 업그레이드는 /opt/node 만 다시 걸면 끝난다
  ln -sfn "/opt/node-${NODE_VERSION}" /opt/node
  for bin in node npm npx corepack; do
    ln -sfn "/opt/node/bin/${bin}" "/usr/local/bin/${bin}"
  done
  corepack enable
fi
node --version

echo "==> §23 Tailscale"
# Tailscale 공식 설치 절차를 그대로 쓴다. 위 Node 설치와 달리 파이프를 허용하는 이유:
# 검증할 체크섬이 애초에 공개돼 있지 않고(설치 스크립트가 서명 검증을 자체 수행한다),
# curl 이 실패하면 바로 다음 `tailscale status`/`tailscale up` 이 command not found 로
# 죽어 조용히 넘어가지 않는다. Node 쪽은 SHA 검증이 파이프에 가려지는 게 문제였다.
command -v tailscale >/dev/null 2>&1 || curl -fsSL https://tailscale.com/install.sh | sh

BACKEND_STATE="$(tailscale status --json 2>/dev/null | jq -r '.BackendState' || echo "NoState")"
if [ "${BACKEND_STATE}" = "Running" ]; then
  echo "이미 tailnet 에 조인됨 — 건너뜀"
else
  [ -n "${TS_AUTHKEY}" ] || {
    echo "조인이 필요한데 auth key 가 없습니다. Tailscale 콘솔에서 발급하세요:" >&2
    echo "  pre-authorized ✅ / tag:server ✅ / ephemeral ❌" >&2
    exit 1
  }
  # 키를 argv 에 노출하지 않는다 — root 전용 임시 파일로 전달
  umask 077
  KEY_FILE="$(mktemp)"
  printf '%s' "${TS_AUTHKEY}" > "${KEY_FILE}"
  # tag:server 가 노드 키 만료를 막는다 — 태그 없이 조인하면 몇 달 뒤
  # 헤드리스 서버가 조용히 tailnet 에서 떨어진다 (설계 §6-3)
  tailscale up --authkey "file:${KEY_FILE}" \
    --hostname quant-platform --advertise-tags=tag:server
  rm -f "${KEY_FILE}"
fi

# 이름을 가정하지 않는다 — 동명 노드가 있으면 quant-platform-1 처럼 접미사가 붙는다
FQDN="$(tailscale status --json | jq -r '.Self.DNSName' | sed 's/\.$//')"
[ -n "${FQDN}" ] && [ "${FQDN}" != "null" ] || { echo "FQDN 조회 실패" >&2; exit 1; }

echo "==> tailscale serve — 443 → 127.0.0.1:3000 (인증서 발급·갱신 포함)"
tailscale serve --bg --https=443 http://127.0.0.1:3000

echo "==> §28 app.env"
if [ -f /etc/quant-platform/app.env ]; then
  # 절대 덮지 않는다 — SESSION_SECRET 이 바뀌면 기존 세션이 전부 무효화된다
  echo "이미 존재 — 건너뜀"
else
  SECRET="$(openssl rand -base64 48 | tr -d '\n')"
  # base64 는 +/= 를 포함할 수 있으므로 sed 구분자는 # (base64 알파벳 밖)
  sed "s#<48_BYTE_RANDOM_VALUE>#${SECRET}#" "${SELF_DIR}/app.env.example" \
    > /etc/quant-platform/app.env
  chown root:root /etc/quant-platform/app.env
  chmod 600 /etc/quant-platform/app.env
fi

echo "==> §29 systemd 유닛"
install -m 644 -o root -g root "${SELF_DIR}/quant-platform.service" \
  /etc/systemd/system/quant-platform.service
systemctl daemon-reload
# start 는 하지 않는다 — dist 가 아직 없다. 첫 기동은 deploy.sh 가 한다.
systemctl enable quant-platform

echo ""
echo "기본 프로비저닝 완료. 다음: bootstrap.sh 가 tailnet SSH 검증 후 --harden 실행."
# bootstrap.sh 가 이 마커를 grep 한다 — 형식을 바꾸면 함께 바꿔야 한다
echo "FQDN=${FQDN}"
```

- [ ] **Step 2: 구문 검증**

Run: `dash -n infra/provision.sh && bash -n infra/provision.sh && echo OK`
Expected: `OK`

Run: `grep -nE 'pipefail|\[\[|\{[a-z-]+,[a-z-]+\}|<<<|function |local ' infra/provision.sh`
Expected: 매치 없음 (주석 제외 — 있으면 bashism)

- [ ] **Step 3: harden 분기 도달 검증**

`--harden` 인자가 base 경로를 건너뛰고 harden 블록으로 가는지 확인한다. root 검사에
걸리지 않도록 실제 실행이 아니라 분기 로직만 dash 로 재현한다:

```bash
dash -c 'set -eu; MODE="--harden"
if [ "${MODE}" = "--harden" ]; then echo "harden branch OK"; exit 0; fi
echo "base branch (틀림)"'
```

Expected: `harden branch OK`

- [ ] **Step 4: stdin read 가드 검증**

auth key 가 없는 재실행(stdin EOF)에서 `set -e` 로 죽지 않아야 한다:

```bash
dash -c 'set -eu; IFS= read -r K || K=""; echo "key=[${K}]"' < /dev/null
```

Expected: `key=[]`, 종료코드 0

- [ ] **Step 5: SESSION_SECRET 치환 구분자 검증**

base64 는 `+/=` 를 포함할 수 있다. `#` 구분자가 안전한지 확인한다:

```bash
dash -c 'S="ab+c/d=ef"; echo "SESSION_SECRET=<48_BYTE_RANDOM_VALUE>" | sed "s#<48_BYTE_RANDOM_VALUE>#${S}#"'
```

Expected: `SESSION_SECRET=ab+c/d=ef`

- [ ] **Step 6: 커밋**

```bash
git add infra/provision.sh
git commit -m "feat(infra): provision.sh — §21·22·23·25·26·28·29 멱등 프로비저닝 (D-016)"
```

---

### Task 3B: .gitattributes — 셸 스크립트 LF 강제

**구현 중 발견된 결함.** 계획 작성 시점에는 몰랐던 것으로, Task 4 가 여기에 의존한다.

이 리포에는 `.gitattributes` 가 없고 개발 PC 의 `core.autocrlf=true` 다. 그 결과 blob 은
전부 LF 인데 **워킹트리 사본에 CR 이 들어간다** — 측정값: `scripts/deploy.sh` 102 bytes,
`scripts/backup.sh` 107, `scripts/restore.sh` 29. `infra/provision.sh` 가 지금 깨끗한 것은
방금 쓴 파일이라 체크아웃을 거치지 않았기 때문이며, 다음 `git checkout` 이면 CRLF 가 된다.

Task 4 의 bootstrap.sh 는 **워킹트리 사본을 scp** 한다. CRLF 인 채로 올라가면 Ubuntu 에서
`#!/bin/sh\r` 이 되어 프로비저닝 전체가 죽는다 — 기능의 핵심 약속이 무너지는 자리다.
`scripts/backup.sh` 는 서버에서 도는 스크립트라 같은 위험을 공유한다.

**Files:**
- Create: `.gitattributes`
- Renormalize: `scripts/deploy.sh`, `scripts/backup.sh`, `scripts/restore.sh` (워킹트리만 — blob 은 이미 LF)

**Interfaces:**
- Produces: 모든 `*.sh` 가 체크아웃 후에도 LF 를 유지한다. Task 4 의 scp 가 이것에 의존한다.

- [ ] **Step 1: 현재 상태를 증거로 남긴다**

```bash
for f in infra/provision.sh scripts/deploy.sh scripts/backup.sh scripts/restore.sh; do
  printf '%-28s worktree CR: %s  blob CR: %s\n' "$f" \
    "$(tr -dc '\r' < "$f" | wc -c)" "$(git show "HEAD:$f" | tr -dc '\r' | wc -c)"
done
```

Expected: deploy/backup/restore 의 worktree CR 이 0 이 아니고, blob CR 은 전부 0

- [ ] **Step 2: .gitattributes 작성**

```gitattributes
# 셸 스크립트는 항상 LF 로 체크아웃한다 (D-016).
# 개발 PC 가 Windows(core.autocrlf=true)이고 scripts/bootstrap.sh 는 워킹트리 사본을
# 그대로 서버로 scp 한다 — CRLF 로 체크아웃되면 Ubuntu 에서 `#!/bin/sh\r` 이 되어
# 프로비저닝이 통째로 죽는다. scripts/backup.sh 는 서버에서 도는 스크립트다.
*.sh text eol=lf

# 리포 기본값: 텍스트 파일은 저장소에 LF 로 정규화한다
* text=auto
```

- [ ] **Step 3: 워킹트리 재정규화**

```bash
git add --renormalize .
git status --short
```

blob 이 이미 LF 이므로 스테이지에는 `.gitattributes` 만 올라오는 것이 정상이다.
워킹트리 CR 을 실제로 걷어내려면 재체크아웃이 필요하다:

```bash
rm -f scripts/deploy.sh scripts/backup.sh scripts/restore.sh
git checkout -- scripts/deploy.sh scripts/backup.sh scripts/restore.sh
```

- [ ] **Step 4: 검증 — CR 이 0 이어야 한다**

```bash
for f in infra/provision.sh scripts/deploy.sh scripts/backup.sh scripts/restore.sh; do
  printf '%-28s worktree CR: %s\n' "$f" "$(tr -dc '\r' < "$f" | wc -c)"
done
bash -n scripts/deploy.sh && bash -n scripts/backup.sh && bash -n scripts/restore.sh && \
  dash -n infra/provision.sh && echo "구문 OK"
```

Expected: 네 파일 모두 `worktree CR: 0`, 그리고 `구문 OK`

- [ ] **Step 5: 커밋**

```bash
git add .gitattributes
git commit -m "fix(repo): .gitattributes 로 *.sh LF 강제 — CRLF 가 서버 스크립트를 깨뜨린다 (D-016)"
```

---

### Task 4: scripts/bootstrap.sh — 개발 PC 래퍼

업로드 → 기본 프로비저닝 → **tailnet SSH 실증** → 하드닝. 락아웃 가드가 이 파일의 존재 이유다.

**Files:**
- Create: `scripts/bootstrap.sh`

**Interfaces:**
- Consumes: `infra/provision.sh`(Task 3, stdin 으로 키·`FQDN=` 마커 출력), `infra/systemd/quant-platform.service`, `infra/app.env.example`, env `TS_AUTHKEY`(선택)
- Produces: 없음 (최종 사용자 진입점)

- [ ] **Step 1: bootstrap.sh 작성**

```bash
#!/usr/bin/env bash
# 서버 부트스트랩 — 새 인스턴스를 배포 가능 상태로 만든다 (설계 문서 §3·§4).
# 사용법: TS_AUTHKEY=tskey-... ./scripts/bootstrap.sh <public-ip>
#         (TS_AUTHKEY 미설정이면 프롬프트. 이미 조인된 서버 재실행이면 Enter 로 생략)
#
# 순서가 락아웃 가드다: 기본 프로비저닝(퍼블릭 SSH) → tailnet 경유 SSH 를 "실제로"
# 검증 → 성공했을 때만 --harden(UFW 가 퍼블릭 22 를 닫는다). 스펙 §25 의
# "검증 전 차단 금지" 를 사람의 규율이 아니라 제어 흐름으로 강제한다.
# 전제: 이 PC 가 tailnet 에 조인돼 있어야 한다 (tailscale status 로 확인).
set -euo pipefail

HOST="${1:?usage: bootstrap.sh <public-ip-or-host>}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REMOTE_DIR=/tmp/quant-provision

if [ -z "${TS_AUTHKEY:-}" ]; then
  read -rsp "Tailscale auth key (재실행이면 Enter): " TS_AUTHKEY
  echo
fi

echo "==> 프로비저닝 파일 업로드"
ssh "ubuntu@${HOST}" "mkdir -p ${REMOTE_DIR}"
scp "${REPO_ROOT}/infra/provision.sh" \
    "${REPO_ROOT}/infra/systemd/quant-platform.service" \
    "${REPO_ROOT}/infra/app.env.example" \
    "ubuntu@${HOST}:${REMOTE_DIR}/"

echo "==> 기본 프로비저닝 (§21·22·23·28·29)"
OUT="$(mktemp)"
trap 'rm -f "${OUT}"' EXIT
# 키는 stdin 으로 — argv·원격 히스토리에 남기지 않는다
printf '%s\n' "${TS_AUTHKEY}" \
  | ssh "ubuntu@${HOST}" "sudo sh ${REMOTE_DIR}/provision.sh" \
  | tee "${OUT}"

FQDN="$(grep '^FQDN=' "${OUT}" | tail -1 | cut -d= -f2)"
[ -n "${FQDN}" ] || { echo "출력에서 FQDN= 마커를 찾지 못했습니다" >&2; exit 1; }

echo "==> tailnet 경유 SSH 검증: ${FQDN}"
if ssh -o ConnectTimeout=15 -o BatchMode=yes "ubuntu@${FQDN}" true; then
  echo "==> 하드닝 (§25 UFW + §26 SSH) — 퍼블릭 22 가 닫힌다"
  ssh "ubuntu@${FQDN}" "sudo sh ${REMOTE_DIR}/provision.sh --harden"
else
  cat >&2 <<MSG
경고: tailnet 경유 SSH 실패 — 하드닝을 건너뜁니다. 퍼블릭 SSH 는 살아 있습니다.
  1) 이 PC 가 tailnet 에 있는지 확인: tailscale status
  2) 해결 후 하드닝만 재실행:
     ssh ubuntu@${FQDN} sudo sh ${REMOTE_DIR}/provision.sh --harden
MSG
  exit 1
fi

cat <<MSG

부트스트랩 완료: https://${FQDN}

다음 단계:
  1) 첫 배포:      ./scripts/deploy.sh ${FQDN}
  2) 관리자 생성 (1회, 서버에서):
     ssh ubuntu@${FQDN}
     sudo systemd-run --pty --uid=quant --gid=quant \\
       --property=EnvironmentFile=/etc/quant-platform/app.env \\
       --working-directory=/opt/quant-platform/current \\
       /usr/local/bin/node /opt/quant-platform/current/dist/server/cli.js admin:create
  3) (선택) Lightsail Networking 에서 TCP 22 제거 — UFW 심층방어
MSG
```

- [ ] **Step 2: 구문 검증**

Run: `bash -n scripts/bootstrap.sh && echo OK`
Expected: `OK`

- [ ] **Step 3: FQDN 마커 파싱 검증**

```bash
bash -c 'OUT=$(mktemp); printf "junk\nFQDN=quant-platform.tail1234.ts.net\n" > "$OUT";
FQDN="$(grep "^FQDN=" "$OUT" | tail -1 | cut -d= -f2)"; echo "[$FQDN]"; rm -f "$OUT"'
```

Expected: `[quant-platform.tail1234.ts.net]`

- [ ] **Step 4: 커밋**

```bash
git add scripts/bootstrap.sh
git commit -m "feat(scripts): bootstrap.sh — 단일 명령 프로비저닝, 락아웃 가드 내장 (D-016)"
```

---

### Task 5: 구 인프라 파일 삭제

전부 provision.sh 또는 Tailscale 로 대체됐다. 남기면 §21·§22 의 진실이 두 곳이 된다.

**Files:**
- Delete: `infra/lightsail/launch-script.sh`, `infra/wireguard/wg0.conf.example`, `infra/caddy/Caddyfile`, `infra/systemd/caddy-override.conf`, `infra/ufw/setup-ufw.sh`

- [ ] **Step 1: 삭제**

```bash
git rm infra/lightsail/launch-script.sh \
       infra/wireguard/wg0.conf.example \
       infra/caddy/Caddyfile \
       infra/systemd/caddy-override.conf \
       infra/ufw/setup-ufw.sh
```

- [ ] **Step 2: 잔여 참조 확인**

Run: `grep -rn "Caddy\|wireguard\|wg0\|caddy" --include="*.sh" --include="*.service" --include="*.example" infra/ scripts/`
Expected: 매치 없음 (문서·스펙은 Task 6·7 에서 처리)

- [ ] **Step 3: 남은 infra/ 구조 확인**

Run: `find infra -type f`
Expected: `infra/app.env.example`, `infra/provision.sh`, `infra/systemd/quant-platform.service` — 정확히 3 개

- [ ] **Step 4: 커밋**

```bash
git commit -m "chore(infra): WireGuard·Caddy·UFW 스크립트·launch script 제거 (D-016)"
```

---

### Task 6: README 배포 섹션 교체

**Files:**
- Modify: `README.md:28-30` (「## 배포 (스펙 §18~§31)」 섹션)

- [ ] **Step 1: 기존 「## 배포」 섹션을 아래로 교체**

```markdown
## 배포 (스펙 §18~§31, D-016)

애플리케이션은 클라우드·증권사를 모른다. 요구사항: Ubuntu 24.04, RAM 1GB+, 고정
공인 IP (현재: AWS Lightsail Seoul, Micro $7). 접근은 Tailscale 사설망으로만 한다 —
앱은 인터넷에 노출되지 않는다.

### tailnet 사전 설정 (계정에 1회)

1. Tailscale 계정 + 2FA
2. DNS 설정에서 **MagicDNS** 와 **HTTPS Certificates** 활성화
3. Access Controls(ACL)에 태그 정의: `"tagOwners": { "tag:server": ["autogroup:admin"] }`
4. 개발 PC·휴대폰을 tailnet 에 조인 (앱 설치 + 로그인)

### 서버 구축 (인스턴스마다)

1. 인스턴스 생성 — Lightsail 기준: Seoul → Linux/Unix → **OS Only** →
   Ubuntu 24.04 LTS → SSH 공개키 업로드 → Micro $7 → Static IP 연결
   (Static IP 는 증권사 허용 출발 IP 용도다. launch script 는 쓰지 않는다.)
2. Tailscale 콘솔에서 auth key 발급 — **pre-authorized ✅ / `tag:server` ✅ /
   ephemeral ❌** (태그가 노드 키 만료를 막는다)
3. 부트스트랩:

   ```bash
   TS_AUTHKEY=tskey-... ./scripts/bootstrap.sh <public-ip>
   ```

   §21~§29 를 멱등하게 수행한다. tailnet 경유 SSH 가 **실증된 뒤에만** UFW·SSH
   하드닝이 적용된다 (락아웃 가드). 실패 시 퍼블릭 SSH 는 살아 있다.
4. 첫 배포와 관리자 생성 (정확한 명령은 bootstrap 출력에 나온다):

   ```bash
   ./scripts/deploy.sh <fqdn>    # 검증 게이트 → 릴리스 전환 → health check → 실패 시 자동 롤백
   ```

5. (선택) Lightsail Networking 에서 TCP 22 제거 — UFW 가 이미 막는 것의 심층방어

접속: `https://<fqdn>` — 인증서는 자동 발급·갱신된다 (`tailscale serve`).
휴대폰은 Tailscale 앱 로그인 외에 설치할 것이 없다.
```

- [ ] **Step 2: 렌더 확인**

Run: `pnpm lint` (README 는 대상 아님 — 형식 깨짐만 육안 확인)
IDE 미리보기에서 코드블록·목록 렌더 확인.

- [ ] **Step 3: 커밋**

```bash
git add README.md
git commit -m "docs(readme): 배포 섹션을 Tailscale 기반 절차로 교체 (D-016)"
```

---

### Task 7: DECISIONS.md — D-016

**Files:**
- Modify: `docs/DECISIONS.md` (파일 끝, D-015 뒤에 추가)

- [ ] **Step 1: D-016 추가**

```markdown
## D-016: WireGuard·Caddy → Tailscale — 스펙 §23~§27 편차

- **변경 내용:** 사설망을 순수 WireGuard 에서 Tailscale 로, TLS 종단을 Caddy 에서
  `tailscale serve` 로 교체했다. `infra/provision.sh`(서버, 멱등) +
  `scripts/bootstrap.sh`(개발 PC) 가 §21~§29 를 단일 명령으로 수행한다. Caddy 가 주던
  것 중 앱에 없던 HSTS 는 `SECURITY_HEADERS` 에, 압축은 `@fastify/compress` 로 옮겼다.
- **이유:** 순수 WireGuard 는 단일 명령 프로비저닝이 원리적으로 불가능하다 — Lightsail
  공개키를 기존 WG 서버(리포 밖 머신)에 peer 로 등록해야 터널이 서고, 그 전에는
  핸드셰이크 확인이 불가능해 UFW 를 안전하게 켤 수 없다. 요구사항 "클라우드가 무엇이든
  동일하게, 쉽고 빠르게" 가 이 제약과 양립하지 않는다.
- **보안 모델:** 데이터 평면은 동일한 WireGuard 다 — 노드 간 E2E 암호화, 앱은 여전히
  인터넷에 비노출, D-014(비밀번호 단일 단계)의 전제 유지. 바뀐 것은 control plane 뿐이다.
- **새 의존:** Tailscale control plane. 다운 시 기존 연결은 유지되나 신규 조인·재인증이
  실패한다. 노드 키 만료는 `tag:server` 로 면제한다 — 태그 없이 조인하면 헤드리스
  서버가 몇 달 뒤 조용히 떨어진다.
- **락아웃 가드:** provision.sh 를 기본/`--harden` 2 단계로 나누고, bootstrap.sh 가
  tailnet 경유 SSH 를 실제로 시도해 성공했을 때만 하드닝을 실행한다. 스펙 §25 의
  "검증 전 차단 금지" 가 제어 흐름으로 강제된다.
- **스펙 관계:** §23(WireGuard)·§24(퍼블릭 방화벽 마감, 선택으로 강등)·§25(UFW 규칙,
  tailscale0 으로)·§27(Caddy, 제거) 편차. §18 의 호스트 요구사항과 §30 배포 절차는
  그대로다. deploy.sh 는 수정하지 않았다.
- **설계 문서:** `docs/superpowers/specs/2026-07-26-tailscale-provisioning-design.md`
```

- [ ] **Step 2: 커밋**

```bash
git add docs/DECISIONS.md
git commit -m "docs(decisions): D-016 — Tailscale 전환 기록"
```

---

### Task 8: 최종 게이트 + 실서버 검증 체크리스트

**Files:** 없음 (검증만)

- [ ] **Step 1: 전체 게이트**

Run: `pnpm lint && pnpm typecheck && pnpm test && pnpm build`
Expected: 전부 green (기존 82 + Task 1·2 의 신규 3 = 85)

- [ ] **Step 2: 스크립트 구문 재확인**

Run: `dash -n infra/provision.sh && bash -n scripts/bootstrap.sh && bash -n scripts/deploy.sh && echo OK`
Expected: `OK`

- [ ] **Step 3: 실서버 검증 (수동 — 실제 인스턴스에서, 설계 §10)**

코드 머지 후 실제 프로비저닝 때 확인한다. 자동화 대상이 아니라 **판정 기준**이다:

1. `bootstrap.sh` 1 회 → `deploy.sh` 1 회 → 휴대폰에서 `https://<fqdn>` 로그인 화면
2. `bootstrap.sh` **2 회째 실행** — 에러 없이 완주, 결과 동일 (멱등성 실증)
3. `sudo reboot` 후 `tailscale serve status` — serve 설정이 유지되는가
4. `tailscale serve status` 에 인증서 상태 표시 확인 — 갱신을 데몬이 처리하는가
   (아니면 `tailscale cert` + systemd timer 로 대체 — 설계 §10)
5. UFW 22 만 연 상태에서 serve 를 통한 443 접속 확인 — 막히면 provision.sh 의
   주석 처리된 443 규칙을 활성화
6. `curl -4 https://checkip.amazonaws.com` (서버에서) = Lightsail Static IP
   (증권사 아웃바운드 경로 확인 — exit node 미사용 실증)

문제 발견 시 해당 태스크로 돌아가 수정 후 재커밋.
