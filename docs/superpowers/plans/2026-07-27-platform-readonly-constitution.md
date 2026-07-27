# 플랫폼 read-only 헌법 개정 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 스펙에 평면 분리 헌법을 새기고(D-017), TOTP 2단계 인증을 복원하고(0000 스쿼시), Tailscale 을 제거해 Caddy 기반 퍼블릭 노출로 전환한다.

**Architecture:** 웹 플랫폼은 조회·백테스트·데이터 관리 전용 평면이 되고, 돈·전략·보안 조작은 SSH CLI 평면으로 분리된다. 인증은 비밀번호 + TOTP 2단계(등록은 CLI 전용), 노출은 도메인 + Caddy(Let's Encrypt) + UFW 22/80/443 이다. 설계 문서: `docs/superpowers/specs/2026-07-27-platform-readonly-constitution-design.md` (이하 "설계").

**Tech Stack:** 기존과 동일 + `otpauth` 재추가. 인프라는 Caddy(공식 apt repo), UFW, sshd 하드닝 유지.

## Global Constraints

- 완료 게이트 (코드 태스크마다): `pnpm lint && pnpm typecheck && pnpm test && pnpm build`
- `infra/provision.sh` 는 POSIX sh 전용 — pipefail·brace expansion·`[[ ]]`·배열 금지 (dash 즉사 전례)
- `scripts/bootstrap.sh` 는 bash (`set -euo pipefail`)
- 비밀값은 argv 에 넣지 않는다 (ps·히스토리 노출) — stdin 또는 root 전용 파일. 도메인은 비밀이 아니므로 argv 허용
- 셸 스크립트는 LF (`.gitattributes` 의 `*.sh text eol=lf` 가 이미 강제)
- 애플리케이션은 인프라를 모른다: bind 는 `127.0.0.1:3000` 만, Caddy/UFW/도메인 개념이 앱 코드에 들어가면 안 된다 (스펙 §2.1)
- 스크립트는 멱등해야 한다 — 모든 단계가 현재 상태를 확인하고 필요할 때만 변경
- 커밋 메시지는 이 리포 관례(한국어, conventional prefix)를 따른다
- TOTP 파라미터: issuer `Quant Platform`, digits 6, period 30, verify window 1 (제거 전 구현과 동일)
- 참조 원본: 제거 직전 구현은 `git show dd00ac5^:<path>` 로 볼 수 있다. 단 revert 가 아니라 재구현이다 — 복구 코드 해시가 sha256 → Argon2 로 바뀌고, 등록이 admin:create 내장 → 별도 `totp:enroll` 로 바뀐다

---

### Task 1: 스펙 §2·§16 개정 + DECISIONS.md D-017 기록

**Files:**
- Modify: `docs/quant_trading_platform_spec.md` (§2 에 §2.6 신설, §2.2 다이어그램 교체, §16 인증 절 수정)
- Modify: `docs/DECISIONS.md` (D-017 추가)

**Interfaces:**
- Consumes: 설계 문서 전체
- Produces: 이후 태스크의 커밋 메시지가 참조할 D-017

- [ ] **Step 1: 스펙 §2.2 네트워크 책임 다이어그램 교체**

`## 2.2 네트워크 책임` 절의 코드 블록(```text … ```)을 다음으로 교체한다. WireGuard 전제의 그림을 퍼블릭 노출 전제로 바꾸는 것이다:

```text
Application
└─ 127.0.0.1:3000

Caddy
├─ 퍼블릭 443에서 Listen (도메인, Let's Encrypt 자동 발급·갱신)
└─ 127.0.0.1:3000으로 Reverse Proxy

UFW
├─ 22 허용 (rate-limit) — 클라우드 브라우저 SSH 콘솔이 out-of-band 복구 경로
├─ 80 허용 (ACME·HTTPS 리다이렉트)
├─ 443 허용
└─ 나머지 인바운드 차단

Cloud Firewall (현재: Lightsail)
└─ TCP 22·80·443 만 허용
```

같은 절 바로 위 §2.1 의 금지 개념 목록에서 `WireGuard`, `wg0`, `VPN IP` 항목은 그대로 둔다 (앱 코드에 등장 금지라는 뜻이므로 여전히 유효하다). §2.1 마지막 문장 `WireGuard IP를 .env에 넣지 않는다. 네트워크 접근 정책은 인프라가 담당한다.` 를 `네트워크 접근 정책은 인프라가 담당한다 — 도메인·프록시·방화벽 개념을 .env 에 넣지 않는다.` 로 교체한다.

- [ ] **Step 2: 스펙 §2.6 평면 분리 신설**

`## 2.5 임의 코드 실행 금지` 절 끝(§3 제목 직전)에 추가한다:

```markdown
## 2.6 평면 분리

플랫폼(웹)은 조회 평면이다. 다음만 할 수 있다.

- 자동매매 결과·상태 조회
- 백테스트 생성·실행·취소
- 백테스트용 데이터 관리 (CSV 업로드, 증권사 데이터 동기화)
- 비상정지 — 자동매매를 **끄는 것만** 가능하다 (fail-safe)

SSH CLI는 제어 평면이다. 다음은 CLI로만 한다.

- 자동매매 전략 변경
- 주문·자금에 관한 직접 조작
- 자동매매 재개 (킬스위치 되켜기)
- TOTP 등록·재설정 등 보안 설정 변경

웹 API에 제어 평면 엔드포인트를 만들지 않는다. "웹에 없는 기능"이 방어선이므로,
편의를 이유로 제어 기능을 웹에 추가하는 것은 이 문서의 개정 사항이다.

실전 매매 도입 시 실전 신호가 읽는 데이터 경로와 플랫폼에서 쓰기 가능한 백테스트
데이터 경로를 분리한다. 분리 방식은 그 시점에 설계한다.
```

- [ ] **Step 3: 스펙 §16 에 TOTP 복원 반영**

`# 16. 애플리케이션 보안` 의 `## 비밀번호` 절과 `## 세션` 절 사이에 추가한다:

```markdown
## 2단계 인증 (TOTP)

- 비밀번호 검증 후 TOTP 6자리 코드를 요구한다 (RFC 6238, 30초 주기, ±1 창)
- TOTP 등록·재설정은 서버 CLI에서만 한다 (`totp:enroll`) — 웹 세션 탈취로
  2단계 인증을 바꿔치기하는 경로를 차단한다 (§2.6)
- TOTP secret은 등록 시 1회만 표시하고 재노출하지 않는다
- 복구 코드 8개 (각 1회용, Argon2 해시 저장) — TOTP 분실 시 대체 경로
- TOTP 검증 실패는 로그인 실패 잠금(5회/15분)에 합산한다
- TOTP 검증 성공 시 세션 ID를 회전한다
- TOTP 미등록 계정은 비밀번호만으로 로그인된다 — 퍼블릭 노출 전에만 허용되는
  과도기 상태이며, 서버가 부팅 시 경고한다
```

같은 §16 의 Pino redaction 목록(```text 블록) 마지막 `awsSecretAccessKey` 위에 `totp` 와 `recoveryCode` 두 줄을 추가한다.

- [ ] **Step 4: DECISIONS.md 에 D-017 추가**

`docs/DECISIONS.md` 끝에 추가한다:

```markdown
## D-017: 평면 분리 헌법 — 플랫폼 read-only, TOTP 복원(D-014 부분 폐기), Tailscale 제거(D-016 폐기)

- **변경 내용:** 보안 모델의 전제를 "플랫폼 전체를 사설망 뒤에 숨긴다"에서 "플랫폼의
  권한을 줄이는 대신 노출을 허용한다"로 교체했다. 플랫폼은 조회·백테스트·데이터
  관리·비상정지(끄기 전용)만 담당하고, 돈·전략·보안 설정 조작은 SSH CLI 전용이다
  (스펙 §2.6 신설). 인증은 비밀번호 + TOTP 2단계로 복원(§16), 노출은 도메인 +
  Caddy(Let's Encrypt) + UFW 22/80/443 이다.
- **D-014 부분 폐기:** TOTP 제거의 근거가 "사설망 경계가 이미 접근을 제한한다"였다 —
  그 경계가 사라지므로 전제가 소멸한다. D-014 가 예고한 대로 재구현했다: 복구 코드
  해시는 sha256 → Argon2, 등록은 admin:create 내장 → 별도 `totp:enroll`(CLI 전용).
  스키마 컬럼 4개는 배포 전이므로 0000 마이그레이션에 스쿼시로 흡수했다 (D-015 근거
  재적용 — 배포된 적 없는 이력은 보존 가치가 없다).
- **D-016 폐기:** 망 경계 요구가 없어졌으므로 Tailscale·`tag:server`·노드 키 관리
  의존을 제거했다. 퍼블릭 22 는 닫지 않는다 — 클라우드 브라우저 SSH 콘솔(키 인증)이
  out-of-band 복구 경로가 되므로, D-016 의 락아웃 가드 체계(tailnet SSH 실증,
  `--harden` 2단계) 전체가 불필요해져 provision.sh 는 단일 실행으로 돌아왔다.
  sshd 하드닝(키 전용 인증)은 유지한다 — 하드닝의 대상은 접속 클라이언트가 아니라
  "열린 포트가 인터넷으로부터 무엇을 받아주느냐"이고, 브라우저 SSH 는 키 인증이라
  영향이 없다.
- **킬스위치 단방향:** 플랫폼에서 자동매매는 끌 수만 있다. 세션 탈취 시 "끄기"의
  최대 피해는 기회비용이지만 "켜기"는 돈을 움직일 길을 연다. 구현은 자동매매 엔진과
  함께 한다 (D-009 — 소비자 없는 코드를 미리 만들지 않는다).
- **CT 로그:** 도메인이 Let's Encrypt CT 로그에 공개된다 — 퍼블릭 서비스 전제이므로
  무해하다.
- **스펙 관계:** §2.2·§2.6·§16 은 본문을 개정했다. §23(WireGuard)·§24(퍼블릭 방화벽
  마감)·§25(UFW 원문)·§27(Caddy 내부 TLS)은 이 결정으로 대체된다 — 현행 규칙은
  스펙 §2.2 다이어그램과 infra/provision.sh 가 정의한다.
- **설계 문서:** `docs/superpowers/specs/2026-07-27-platform-readonly-constitution-design.md`
```

- [ ] **Step 5: 커밋**

```bash
git add docs/quant_trading_platform_spec.md docs/DECISIONS.md
git commit -m "docs: D-017 — 평면 분리 헌법, TOTP 복원·Tailscale 제거 결정 기록"
```

---

### Task 2: 스키마 TOTP 컬럼 복원 + 0000 마이그레이션 스쿼시

**Files:**
- Modify: `src/server/shared/db/schema.ts`
- Delete + regenerate: `migrations/0000_ambiguous_bedlam.sql`, `migrations/meta/*`

**Interfaces:**
- Produces: drizzle `users` 테이블에 `totpSecret`(text, nullable)·`totpEnabled`(boolean, notNull, default false)·`recoveryCodeHashesJson`(text, nullable), `sessions` 테이블에 `pendingTotp`(boolean, notNull, default false). Task 3 의 repo 가 이 컬럼명을 그대로 사용한다.

- [ ] **Step 1: schema.ts 에 컬럼 복원**

`src/server/shared/db/schema.ts` 의 `users` 테이블에서 `passwordHash` 줄 다음에 추가:

```ts
  totpSecret: text('totp_secret'),
  totpEnabled: integer('totp_enabled', { mode: 'boolean' }).notNull().default(false),
  recoveryCodeHashesJson: text('recovery_code_hashes_json'),
```

`sessions` 테이블에서 `userId` 정의 다음에 추가:

```ts
    pendingTotp: integer('pending_totp', { mode: 'boolean' }).notNull().default(false),
```

- [ ] **Step 2: 마이그레이션 스쿼시 재생성**

```bash
rm -rf migrations
pnpm db:generate
```

- [ ] **Step 3: 스쿼시 결과 검증**

`migrations/meta/_journal.json` 의 `entries` 가 정확히 1개인지, 생성된 `migrations/0000_*.sql` 에 `totp_secret`·`totp_enabled`·`recovery_code_hashes_json`·`pending_totp` 가 모두 들어 있는지 확인한다:

```bash
grep -c '"idx"' migrations/meta/_journal.json          # 기대: 1
grep -o 'totp_secret\|totp_enabled\|recovery_code_hashes_json\|pending_totp' migrations/0000_*.sql | sort -u
# 기대: 4개 이름 전부 출력
```

- [ ] **Step 4: 로컬 DB 폐기 + 게이트**

스쿼시된 마이그레이션은 기존 DB 에서 `table already exists` 로 죽는다 (D-015) — 로컬 개발 DB 를 지운다. 게이트의 통합 테스트는 임시 DB 를 새로 만들므로 영향 없다:

```bash
rm -f data/app.sqlite data/app.sqlite-wal data/app.sqlite-shm
pnpm lint && pnpm typecheck && pnpm test && pnpm build
```

Expected: 전부 통과 (컬럼은 늘었지만 아직 아무 코드도 참조하지 않는다).

- [ ] **Step 5: 커밋**

```bash
git add src/server/shared/db/schema.ts migrations
git commit -m "feat(db): TOTP 컬럼 4개 복원 — 배포 전이므로 0000 스쿼시로 흡수 (D-017)"
```

---

### Task 3: TOTP 포트·어댑터·AuthService 2단계 복원

**Files:**
- Modify: `src/server/modules/auth/application/ports.ts`
- Create: `src/server/modules/auth/infrastructure/otpauth-totp.ts`
- Modify: `src/server/modules/auth/application/auth-service.ts`
- Modify: `src/server/modules/auth/infrastructure/sqlite-repositories.ts`
- Modify: `src/server/bootstrap/container.ts`
- Modify: `src/server/shared/logger.ts`
- Modify: `src/server/shared/db/maintenance.ts` (주석 1줄)
- Modify: `tests/helpers/test-app.ts`
- Modify: `tests/integration/auth.test.ts`
- Modify: `scripts/e2e-server.ts`, `src/server/cli.ts` (UserRecord 필드 추가에 따른 create() 호출부 보정만 — CLI 신기능은 Task 5)

**Interfaces:**
- Consumes: Task 2 의 스키마 컬럼
- Produces:
  - `UserRecord` += `totpSecret: string | null`, `totpEnabled: boolean`, `recoveryCodeHashes: readonly string[]`
  - `SessionRecord` += `pendingTotp: boolean`
  - `UserRepository` += `updateRecoveryCodeHashes(userId: string, hashes: readonly string[], nowMs: number): void`, `setTotp(userId: string, secret: string, recoveryCodeHashes: readonly string[], nowMs: number): void`, `listUsernamesWithoutTotp(): readonly string[]`
  - `TotpService` = `{ generateSecret(): string; buildUri(secret: string, username: string): string; verify(secret: string, token: string): boolean }`
  - `AuthService.login` 반환에 `{ status: 'TOTP_REQUIRED'; sessionId: string }` 추가, `AuthService.verifyTotp(pendingSessionId: string, token: string, ip: string): Promise<TotpVerifyResult>` (`TotpVerifyResult = { status: 'SUCCESS'; sessionId: string } | { status: 'INVALID' }`)
  - `Container` += `totpService: TotpService`

- [ ] **Step 1: otpauth 의존성 추가**

```bash
pnpm add otpauth
```

- [ ] **Step 2: 실패하는 통합 테스트 작성**

`tests/helpers/test-app.ts` 의 `TestAdminOptions`/`createTestAdmin` 을 확장한다 (복구 코드는 Argon2 — sha256 이던 옛 구현과 다르다):

```ts
export interface TestAdminOptions {
  username?: string;
  password?: string;
  totpEnabled?: boolean;
  recoveryCodes?: string[];
}

export async function createTestAdmin(
  container: Container,
  options: TestAdminOptions = {},
): Promise<{ username: string; password: string; totpSecret: string | null }> {
  const username = options.username ?? 'operator';
  const password = options.password ?? 'correct-horse-battery-staple';
  const totpEnabled = options.totpEnabled ?? false;
  const totpSecret = totpEnabled ? container.totpService.generateSecret() : null;

  const recoveryCodeHashes: string[] = [];
  for (const code of options.recoveryCodes ?? []) {
    recoveryCodeHashes.push(await container.passwordHasher.hash(code));
  }

  container.userRepository.create(
    {
      id: newId('usr'),
      username,
      passwordHash: await container.passwordHasher.hash(password),
      totpSecret,
      totpEnabled,
      recoveryCodeHashes,
    },
    container.clock.now(),
  );

  return { username, password, totpSecret };
}
```

`tests/integration/auth.test.ts` 상단에 추가:

```ts
import * as OTPAuth from 'otpauth';

function totpToken(secret: string): string {
  return new OTPAuth.TOTP({
    issuer: 'Quant Platform',
    secret: OTPAuth.Secret.fromBase32(secret),
    digits: 6,
    period: 30,
  }).generate();
}
```

기존 `issues a fresh session id on every login` 테스트는 그대로 두고(여전히 유효 — TOTP 미등록 계정), `logs in with a password alone, then logs out` 의 제목을 `logs in with a password alone when TOTP is not enrolled, then logs out` 으로 바꾼 뒤 다음 두 테스트를 추가한다 (제거 전 구현의 테스트를 복원하되 복구 코드 생성 경로만 다르다):

```ts
  it('requires TOTP as a second step and rotates the session id', async () => {
    const { username, password, totpSecret } = await createTestAdmin(ctx.container, {
      totpEnabled: true,
    });

    const login = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username, password },
    });
    expect(login.json()).toEqual({ status: 'TOTP_REQUIRED' });
    const pendingCookie = sessionCookie(login);

    // TOTP 완료 전에는 인증되지 않는다
    const mePending = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      cookies: { qp_session: pendingCookie },
    });
    expect(mePending.statusCode).toBe(401);

    const wrong = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/totp/verify',
      payload: { token: '000000' },
      cookies: { qp_session: pendingCookie },
    });
    expect(wrong.statusCode).toBe(401);

    const verify = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/totp/verify',
      payload: { token: totpToken(totpSecret ?? '') },
      cookies: { qp_session: pendingCookie },
    });
    expect(verify.statusCode).toBe(200);
    const fullCookie = sessionCookie(verify);
    expect(fullCookie).not.toBe(pendingCookie); // 세션 회전

    const me = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      cookies: { qp_session: fullCookie },
    });
    expect(me.statusCode).toBe(200);
  });

  it('accepts a recovery code once', async () => {
    const recoveryCodes = ['aaaa11112222', 'bbbb33334444'];
    const { username, password } = await createTestAdmin(ctx.container, {
      totpEnabled: true,
      recoveryCodes,
    });

    const login = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username, password },
    });
    const pendingCookie = sessionCookie(login);

    const verify = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/totp/verify',
      payload: { token: recoveryCodes[0] },
      cookies: { qp_session: pendingCookie },
    });
    expect(verify.statusCode).toBe(200);

    // 같은 복구 코드는 재사용 불가
    const secondLogin = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username, password },
    });
    const secondPending = sessionCookie(secondLogin);
    const reuse = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/totp/verify',
      payload: { token: recoveryCodes[0] },
      cookies: { qp_session: secondPending },
    });
    expect(reuse.statusCode).toBe(401);
  });
```

- [ ] **Step 3: 실패 확인**

```bash
pnpm test tests/integration/auth.test.ts
```

Expected: FAIL — `container.totpService` 부재 / `TOTP_REQUIRED` 미반환 / `/auth/totp/verify` 404.

- [ ] **Step 4: 포트 복원 + 신규 메서드**

`src/server/modules/auth/application/ports.ts`:

```ts
export interface UserRecord {
  readonly id: string;
  readonly username: string;
  readonly passwordHash: string;
  readonly totpSecret: string | null;
  readonly totpEnabled: boolean;
  readonly recoveryCodeHashes: readonly string[];
}

export interface SessionRecord {
  readonly id: string;
  readonly userId: string;
  readonly pendingTotp: boolean;
  readonly createdAtMs: number;
  readonly lastSeenAtMs: number;
}
```

`UserRepository` 에 세 메서드 추가:

```ts
  updateRecoveryCodeHashes(userId: string, hashes: readonly string[], nowMs: number): void;
  setTotp(
    userId: string,
    secret: string,
    recoveryCodeHashes: readonly string[],
    nowMs: number,
  ): void;
  listUsernamesWithoutTotp(): readonly string[];
```

파일 끝에 `TotpService` 복원:

```ts
export interface TotpService {
  generateSecret(): string;
  buildUri(secret: string, username: string): string;
  verify(secret: string, token: string): boolean;
}
```

- [ ] **Step 5: otpauth 어댑터 복원**

`src/server/modules/auth/infrastructure/otpauth-totp.ts` 를 제거 전 그대로 생성한다:

```ts
import * as OTPAuth from 'otpauth';
import type { TotpService } from '../application/ports.js';

const ISSUER = 'Quant Platform';

export const otpauthTotpService: TotpService = {
  generateSecret(): string {
    return new OTPAuth.Secret({ size: 20 }).base32;
  },

  buildUri(secret: string, username: string): string {
    return new OTPAuth.TOTP({
      issuer: ISSUER,
      label: username,
      secret: OTPAuth.Secret.fromBase32(secret),
      digits: 6,
      period: 30,
    }).toString();
  },

  verify(secret: string, token: string): boolean {
    if (!/^\d{6}$/.test(token)) return false;
    const totp = new OTPAuth.TOTP({
      issuer: ISSUER,
      secret: OTPAuth.Secret.fromBase32(secret),
      digits: 6,
      period: 30,
    });
    // window 1: 시계 오차 ±30초 허용
    return totp.validate({ token, window: 1 }) !== null;
  },
};
```

- [ ] **Step 6: AuthService 2단계 복원 (복구 코드는 Argon2)**

`src/server/modules/auth/application/auth-service.ts`:

1. import 에 `TotpService`, `UserRecord` 추가. `LoginResult` 에 `| { readonly status: 'TOTP_REQUIRED'; readonly sessionId: string }` 추가하고 `TotpVerifyResult` 를 export:

```ts
export type TotpVerifyResult =
  | { readonly status: 'SUCCESS'; readonly sessionId: string }
  | { readonly status: 'INVALID' };
```

2. `AuthServiceDeps` 에 `readonly totp: TotpService;` 추가.

3. `login` 의 세션 생성부를 2단계 분기로 교체 (성공 audit 은 TOTP 불요 시에만):

```ts
    const requiresTotp = user.totpEnabled && user.totpSecret !== null;
    const session: SessionRecord = {
      id: newSessionId(),
      userId: user.id,
      pendingTotp: requiresTotp,
      createdAtMs: now,
      lastSeenAtMs: now,
    };
    sessions.create(session);

    if (requiresTotp) {
      return { status: 'TOTP_REQUIRED', sessionId: session.id };
    }

    loginAttempts.record(username, ip, true, now);
    audit.record(username, 'auth.login.success', { ip });
    return { status: 'SUCCESS', sessionId: session.id };
```

`login` 의 doc 주석을 갱신한다: `비밀번호 1단계. TOTP 등록 계정은 pending 세션을 발급하고 verifyTotp 가 2단계를 맡는다 (D-017). 어느 경로든 서버가 발급하지 않은 쿠키 값은 인증된 세션이 되지 않는다.`

4. `verifyTotp` 복원 — 복구 코드 소비가 Argon2 검증이라 async 가 된 것 외에는 제거 전과 동일하다:

```ts
  /** 2단계: TOTP 또는 복구 코드 검증. 성공 시 세션 ID 회전(스펙 §16). */
  async verifyTotp(pendingSessionId: string, token: string, ip: string): Promise<TotpVerifyResult> {
    const { users, sessions, loginAttempts, totp, clock, audit } = this.deps;
    const now = clock.now();

    const pending = sessions.findById(pendingSessionId);
    if (!pending || !pending.pendingTotp || this.isExpired(pending, now)) {
      return { status: 'INVALID' };
    }
    const user = users.findById(pending.userId);
    if (!user || !user.totpSecret) return { status: 'INVALID' };

    const recentFailures = loginAttempts.countRecentFailures(
      user.username,
      now - LOGIN_FAILURE_WINDOW_MS,
    );
    if (isLoginLocked(recentFailures, LOGIN_FAILURE_LIMIT)) {
      audit.record(user.username, 'auth.login.locked', { ip });
      return { status: 'INVALID' };
    }

    const normalizedToken = token.trim();
    let verified = totp.verify(user.totpSecret, normalizedToken);

    if (!verified) {
      verified = await this.consumeRecoveryCode(user, normalizedToken, now);
      if (verified) audit.record(user.username, 'auth.recovery-code.used', { ip });
    }

    if (!verified) {
      loginAttempts.record(user.username, ip, false, now);
      audit.record(user.username, 'auth.totp.failure', { ip });
      return { status: 'INVALID' };
    }

    // 세션 회전: pending 세션 폐기 후 새 세션 발급
    sessions.delete(pending.id);
    const session: SessionRecord = {
      id: newSessionId(),
      userId: user.id,
      pendingTotp: false,
      createdAtMs: now,
      lastSeenAtMs: now,
    };
    sessions.create(session);

    loginAttempts.record(user.username, ip, true, now);
    audit.record(user.username, 'auth.login.success', { ip, totp: true });
    return { status: 'SUCCESS', sessionId: session.id };
  }
```

5. `authenticate` 의 세션 판정에 pending 배제 복원 — `if (!session) return null;` 을 `if (!session || session.pendingTotp) return null;` 로 바꾸고 doc 주석을 `인증된(=TOTP 완료) 세션만 사용자로 인정한다. 유효 세션은 last_seen 을 갱신한다.` 로 되돌린다.

6. private 메서드 추가 — **sha256 이 아니라 Argon2 다** (설계 §3.2). 해시 목록이 최대 8개라 순회 검증 비용은 무시 가능하다:

```ts
  private async consumeRecoveryCode(
    user: UserRecord,
    token: string,
    nowMs: number,
  ): Promise<boolean> {
    const { users, passwordHasher } = this.deps;
    for (let i = 0; i < user.recoveryCodeHashes.length; i++) {
      if (await passwordHasher.verify(user.recoveryCodeHashes[i], token)) {
        const remaining = user.recoveryCodeHashes.filter((_, index) => index !== i);
        users.updateRecoveryCodeHashes(user.id, remaining, nowMs);
        return true;
      }
    }
    return false;
  }
```

옛 구현에 있던 `sha256Hex` 는 복원하지 않는다.

- [ ] **Step 7: SQLite repo 복원 + 신규 메서드**

`src/server/modules/auth/infrastructure/sqlite-repositories.ts`:

`toUserRecord` 에 매핑 복원:

```ts
    totpSecret: row.totpSecret,
    totpEnabled: row.totpEnabled,
    recoveryCodeHashes: row.recoveryCodeHashesJson
      ? (JSON.parse(row.recoveryCodeHashesJson) as string[])
      : [],
```

`createSqliteUserRepository` 의 `create` values 에 복원:

```ts
          totpSecret: user.totpSecret,
          totpEnabled: user.totpEnabled,
          recoveryCodeHashesJson: JSON.stringify(user.recoveryCodeHashes),
```

메서드 3개 추가:

```ts
    updateRecoveryCodeHashes(userId, hashes, nowMs) {
      db.update(users)
        .set({ recoveryCodeHashesJson: JSON.stringify(hashes), updatedAtMs: nowMs })
        .where(eq(users.id, userId))
        .run();
    },
    setTotp(userId, secret, recoveryCodeHashes, nowMs) {
      db.update(users)
        .set({
          totpSecret: secret,
          totpEnabled: true,
          recoveryCodeHashesJson: JSON.stringify(recoveryCodeHashes),
          updatedAtMs: nowMs,
        })
        .where(eq(users.id, userId))
        .run();
    },
    listUsernamesWithoutTotp() {
      return db
        .select({ username: users.username })
        .from(users)
        .where(eq(users.totpEnabled, false))
        .all()
        .map((row) => row.username);
    },
```

`createSqliteSessionRepository` 의 `create` values 에 `pendingTotp: session.pendingTotp,` 복원.

- [ ] **Step 8: container·logger·maintenance·호출부 보정**

`src/server/bootstrap/container.ts`: import 에 `TotpService` 타입과 `otpauthTotpService` 추가, `Container` 인터페이스에 `readonly totpService: TotpService;`, AuthService deps 에 `totp: otpauthTotpService,`, 반환 객체에 `totpService: otpauthTotpService,`.

`src/server/shared/logger.ts`: `REDACT_PATHS` 에 `'totp'`, `'recoveryCode'`, `'*.totp'`, `'*.recoveryCode'` 복원 (기존 password 항목들 옆에).

`src/server/shared/db/maintenance.ts`: doc 주석을 `만료 세션(대기 TOTP 포함)·오래된 로그인 시도·보존 기간 지난 감사 로그를 삭제한다.` 로 되돌린다.

`UserRecord` 필수 필드가 늘었으므로 `create()` 호출부 2곳을 보정한다 (동작 불변):

`src/server/cli.ts` `adminCreate`:

```ts
    container.userRepository.create(
      {
        id: newId('usr'),
        username,
        passwordHash,
        totpSecret: null,
        totpEnabled: false,
        recoveryCodeHashes: [],
      },
      container.clock.now(),
    );
```

`scripts/e2e-server.ts` 의 사용자 생성도 같은 3개 필드(`totpSecret: null, totpEnabled: false, recoveryCodeHashes: []`)를 추가한다 — E2E 는 TOTP 미등록 계정의 1단계 로그인으로 그대로 동작한다.

- [ ] **Step 9: 라우트 복원 (테스트가 404 를 벗어나려면 여기까지 필요)**

`src/server/modules/auth/presentation/auth-routes.ts`:

`loginBodySchema` 아래에 복원:

```ts
const totpBodySchema = z.object({
  token: z.string().min(6).max(64),
});
```

login 핸들러의 switch 에 케이스 복원 (`case 'SUCCESS':` 위):

```ts
      case 'TOTP_REQUIRED':
        setSessionCookie(reply, deps, result.sessionId);
        return reply.send({ status: 'TOTP_REQUIRED' });
```

login 라우트 다음에 복원:

```ts
  app.post('/auth/totp/verify', async (request, reply) => {
    const parsed = totpBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: '요청 본문이 올바르지 않습니다' });
    }
    const sessionId = readSessionId(request);
    if (!sessionId) return reply.code(401).send({ error: '진행 중인 로그인 세션이 없습니다' });

    const result = await authService.verifyTotp(sessionId, parsed.data.token, request.ip);
    if (result.status !== 'SUCCESS') {
      return reply.code(401).send({ error: '인증 코드가 올바르지 않습니다' });
    }
    setSessionCookie(reply, deps, result.sessionId);
    return reply.send({ status: 'OK' });
  });
```

- [ ] **Step 10: 테스트 통과 확인 + 게이트**

```bash
pnpm test tests/integration/auth.test.ts
pnpm lint && pnpm typecheck && pnpm test && pnpm build
```

Expected: 전부 PASS.

- [ ] **Step 11: 커밋**

```bash
git add -A
git commit -m "feat(auth): TOTP 2단계 복원 — 복구 코드는 Argon2, pending 세션은 인증 불인정 (D-017)"
```

---

### Task 4: 웹 로그인 2단계 화면 복원

**Files:**
- Modify: `src/web/features/auth/login-page.tsx`

**Interfaces:**
- Consumes: `POST /api/v1/auth/login` 이 `{ status: 'TOTP_REQUIRED' }` 를 반환할 수 있음, `POST /api/v1/auth/totp/verify` (Task 3)

- [ ] **Step 1: 2단계 화면 복원**

제거 전 구현을 그대로 되살린다:

```bash
git show dd00ac5^:src/web/features/auth/login-page.tsx > src/web/features/auth/login-page.tsx
```

복원되는 동작: `credentials` 단계 폼 → 응답이 `TOTP_REQUIRED` 면 `totp` 단계로 전환(6자리 코드 또는 복구 코드 입력, `autocomplete="one-time-code"`), 검증 성공 시 대시보드 이동, "처음으로" 버튼으로 1단계 복귀. 서버 API 계약이 제거 전과 동일하므로 수정 없이 그대로 쓴다. 복원 후 파일을 열어 import 경로(`@/components/ui/*`, `@/lib/api-client`)가 현재 트리와 일치하는지 확인한다 — 불일치가 있으면 현재 관례에 맞게 고친다.

- [ ] **Step 2: 게이트 + E2E**

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm build
pnpm test:e2e
```

Expected: 전부 PASS — E2E 계정은 TOTP 미등록이라 1단계 로그인 그대로다.

- [ ] **Step 3: 커밋**

```bash
git add src/web/features/auth/login-page.tsx
git commit -m "feat(web): 로그인 2단계(TOTP) 화면 복원 (D-017)"
```

---

### Task 5: CLI totp:enroll + 부팅 경고

**Files:**
- Modify: `src/server/cli.ts`
- Modify: `src/server/bootstrap/main.ts`
- Test: `tests/integration/auth.test.ts` (enroll 경로는 repo 메서드 단위로 이미 Task 3 이 커버 — 여기서는 부팅 경고를 검증할 수 없으므로<sup>*</sup> 수동 검증)

<sup>*</sup> 부팅 경고는 `main.ts` 에만 있고 테스트는 `buildServer` 를 직접 조립한다. 경고 로직을 서비스로 뽑는 것은 소비자가 하나뿐인 추상화라 만들지 않는다 (D-009 정신).

**Interfaces:**
- Consumes: `UserRepository.setTotp`, `listUsernamesWithoutTotp`, `TotpService`, `PasswordHasher` (Task 3)
- Produces: `pnpm cli totp:enroll` 명령, 부팅 시 `auth.totp.not-enrolled` 경고 로그

- [ ] **Step 1: cli.ts 에 totp:enroll 추가**

`import readline` 위에 `import { randomBytes } from 'node:crypto';` 추가. `adminCreate` 함수 다음에:

```ts
async function totpEnroll(): Promise<void> {
  const config = loadConfig();
  const container = createContainer(config);
  try {
    const username = await ask('사용자 이름: ');
    const user = container.userRepository.findByUsername(username);
    if (!user) throw new Error('존재하지 않는 사용자입니다.');
    if (user.totpEnabled) {
      const answer = await ask(
        '이미 TOTP 가 등록되어 있습니다. 재발급하면 기존 인증 앱 항목과 복구 코드가 전부 무효화됩니다. 계속하려면 yes: ',
      );
      if (answer !== 'yes') {
        console.log('중단했습니다.');
        return;
      }
    }

    const secret = container.totpService.generateSecret();
    const recoveryCodes = Array.from({ length: 8 }, () => randomBytes(5).toString('hex'));
    const recoveryCodeHashes: string[] = [];
    for (const code of recoveryCodes) {
      recoveryCodeHashes.push(await container.passwordHasher.hash(code));
    }

    container.userRepository.setTotp(user.id, secret, recoveryCodeHashes, container.clock.now());
    container.auditLog.record(username, 'auth.totp.enrolled');

    console.log('\nTOTP 가 등록되었습니다.\n');
    console.log('1) 인증 앱(Google Authenticator 등)에 아래 URI 또는 secret 을 등록하세요:');
    console.log(`   otpauth URI: ${container.totpService.buildUri(secret, username)}`);
    console.log(`   TOTP secret (base32): ${secret}`);
    console.log('\n2) 복구 코드를 안전한 곳에 보관하세요 (각 1회용, 재표시 불가):');
    for (const code of recoveryCodes) console.log(`   ${code}`);
    console.log('\n이 정보는 다시 표시되지 않습니다. (스펙 §16 TOTP secret 재노출 금지)');
  } finally {
    container.close();
  }
}
```

`main()` 의 switch 에 케이스 추가:

```ts
    case 'totp:enroll':
      await totpEnroll();
      break;
```

usage 출력에 `console.log('  totp:enroll    TOTP 2단계 인증 등록·재발급 (CLI 전용, 스펙 §16)');` 추가.

`adminCreate` 의 마지막 안내 두 줄을 다음으로 교체:

```ts
    console.log(`\n관리자 계정 '${username}' 이 생성되었습니다.`);
    console.log('다음: pnpm cli totp:enroll 로 TOTP 를 등록하세요 — 퍼블릭 노출 전 필수 (설계 §3.4)');
```

- [ ] **Step 2: 부팅 경고 추가**

`src/server/bootstrap/main.ts` 의 `container.jobOrchestrator.start();` 다음에:

```ts
  const withoutTotp = container.userRepository.listUsernamesWithoutTotp();
  if (withoutTotp.length > 0) {
    container.logger.warn(
      { module: 'bootstrap', event: 'auth.totp.not-enrolled', usernames: withoutTotp },
      'TOTP 미등록 계정 — 퍼블릭 노출 전에 totp:enroll 로 등록하라 (D-017)',
    );
  }
```

`Container` 는 이미 `userRepository` 를 노출한다 (cli.ts 가 쓰고 있다).

- [ ] **Step 3: 수동 검증**

```bash
rm -f data/app.sqlite data/app.sqlite-wal data/app.sqlite-shm
pnpm cli admin:create        # 계정 생성 → totp:enroll 안내 출력 확인
pnpm dev                     # 부팅 로그에 auth.totp.not-enrolled 경고 확인 후 Ctrl-C
pnpm cli totp:enroll         # URI·secret·복구 코드 8개 출력 확인
pnpm dev                     # 경고가 사라졌는지 확인 후 Ctrl-C
```

인증 앱(또는 `otpauth` REPL)으로 실제 로그인 2단계까지 확인하면 더 좋다.

- [ ] **Step 4: 게이트 + 커밋**

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm build
git add src/server/cli.ts src/server/bootstrap/main.ts
git commit -m "feat(cli): totp:enroll — TOTP 등록·재발급은 CLI 전용, 미등록 계정은 부팅 경고 (D-017)"
```

---

### Task 6: provision.sh — Tailscale 제거, Caddy·UFW 단일 실행

**Files:**
- Rewrite: `infra/provision.sh`

**Interfaces:**
- Consumes: 없음 (독립 스크립트)
- Produces: `sudo sh provision.sh <도메인>` 단일 호출 계약. Task 7 의 bootstrap.sh 가 이 계약으로 호출한다. stdin 을 더 이상 읽지 않는다 (auth key 폐기).

주의: 이 스크립트는 **신규 서버** 기준이다. 이미 Tailscale 로 하드닝된 서버의 전환은 설계 §4.5 의 수동 runbook 을 따른다 (UFW 허용 추가 → Caddy → tailscale 해제 순서).

- [ ] **Step 1: 전체 재작성**

`infra/provision.sh` 를 다음 내용으로 교체한다. 유지되는 블록(패키지·Node·app.env·systemd·아웃바운드 IP)은 기존 코드 그대로이고, Tailscale 관련 블록과 `--harden` 분기가 사라지며 Caddy·UFW·sshd 가 단일 흐름에 들어온다:

```sh
#!/bin/sh
# 서버 프로비저닝 (설계: docs/superpowers/specs/2026-07-27-platform-readonly-constitution-design.md).
# scripts/bootstrap.sh 가 업로드·실행한다. 직접 실행 시:
#   sudo sh provision.sh <도메인>
#
# 도메인의 A 레코드가 이 서버의 고정 공인 IP 를 가리켜야 한다 — Caddy 가 그 이름으로
# Let's Encrypt 인증서를 받는다. 도메인은 비밀값이 아니므로 argv 로 받는다.
#
# POSIX sh 로만 쓴다 — bashism 금지. 클라우드의 first-boot 스크립트가 dash 로 실행되어
# `set -o pipefail` 에 즉사한 전례가 있다 (2026-07-26). 이 파일은 launch script 가
# 아니지만 같은 규율을 유지한다: pipefail·brace expansion·[[ ]]·배열 금지.
#
# 멱등하다 — 모든 단계가 현재 상태를 확인하고 필요할 때만 변경한다.
#
# D-016 의 2단계(--harden) 구조는 폐기됐다 (D-017): 퍼블릭 22 를 닫지 않으므로
# "되돌릴 수 없는 지점" 이 없고, 클라우드 브라우저 SSH 콘솔이 상시 out-of-band
# 경로다. 락아웃 가드가 필요 없어 단일 실행으로 충분하다.
set -eu

DOMAIN="${1:-}"
SELF_DIR="$(cd "$(dirname "$0")" && pwd)"

# 붙여넣기 전에 nodejs.org 의 현재 24.x LTS patch 로 갱신한다. SHA 는 자동 검증.
NODE_VERSION=v24.18.0

[ "$(id -u)" -eq 0 ] || { echo "root 로 실행해야 합니다 (sudo sh $0 <도메인>)" >&2; exit 1; }
[ -n "${DOMAIN}" ] || {
  echo "사용법: sudo sh $0 <도메인>" >&2
  echo "도메인의 A 레코드가 이 서버의 고정 공인 IP 를 가리키고 있어야 합니다." >&2
  exit 1
}

echo "==> 패키지·타임존·유저·디렉터리"
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

echo "==> Node.js ${NODE_VERSION}"
if [ -x /usr/local/bin/node ] && [ "$(/usr/local/bin/node --version)" = "${NODE_VERSION}" ]; then
  echo "이미 설치됨 — 다운로드·압축 해제는 건너뜀"
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
fi
# 버전 검사 밖에서 매번 실행한다 — ln -sfn·corepack enable 은 이미 멱등하므로,
# 이전 실행이 corepack enable 전에 죽어 /usr/local/bin/node 만 만들어진 상태로
# 재실행돼도 (버전 검사가 참이 되어 else 를 건너뛰어도) 나머지가 복구된다
for bin in node npm npx corepack; do
  ln -sfn "/opt/node/bin/${bin}" "/usr/local/bin/${bin}"
done
corepack enable
node --version

echo "==> 고정 아웃바운드 IP 확인 (정보성)"
# 증권사 API 트래픽은 이 호스트의 고정 공인 IP 로 나가야 한다(§18) — 증권사가 허용
# 출발 IP 를 등록제로 운영하기 때문이다. 실패해도 프로비저닝을 죽이지 않는다 — 일시적
# 네트워크 문제로 배포 자체가 막히면 안 되므로 참고용으로만 쓴다.
#
# 특정 업체에 묶지 않는다 (스펙 §2.1): OUTBOUND_IP_URL 로 원하는 엔드포인트를 지정할 수
# 있고(사내 서비스도 가능), 미지정이면 아래 목록을 순서대로 시도해 첫 성공을 쓴다.
# --max-time: 아웃바운드가 막힌 호스트에서 curl 의 기본 연결 타임아웃(300초)까지
# 프로비저닝이 멈춘 것처럼 보이지 않게 한다.
OUTBOUND_IP="확인 실패"
# 아래 ${...} 는 여러 URL 을 순회하기 위해 의도적으로 인용하지 않는다 (단어 분리 필요)
for url in ${OUTBOUND_IP_URL:-https://ifconfig.me/ip https://icanhazip.com https://api.ipify.org}; do
  ip="$(curl -4 -fsS --max-time 10 "${url}" 2>/dev/null | tr -d '[:space:]' || true)"
  # HTML 에러 페이지 등을 IP 로 오인하지 않게 숫자·점만 허용한다
  case "${ip}" in
    ''|*[!0-9.]*) : ;;
    *) OUTBOUND_IP="${ip}"; break ;;
  esac
done
echo "아웃바운드 IP: ${OUTBOUND_IP} — 증권사에 등록한 고정 공인 IP 와 일치해야 한다"

echo "==> DNS 확인 — ${DOMAIN}"
RESOLVED="$(getent ahostsv4 "${DOMAIN}" 2>/dev/null | awk '{print $1; exit}' || true)"
[ -n "${RESOLVED}" ] || {
  echo "${DOMAIN} 이 해석되지 않습니다 — A 레코드를 만들고 전파를 기다린 뒤 재실행하세요." >&2
  exit 1
}
if [ "${OUTBOUND_IP}" != "확인 실패" ] && [ "${RESOLVED}" != "${OUTBOUND_IP}" ]; then
  # 하드 실패로 두지 않는 이유: 아웃바운드 확인 자체가 best-effort 라 NAT 구성에 따라
  # 어긋날 수 있다. 진짜 판정은 아래 인증서 발급 확인이 한다.
  echo "경고: ${DOMAIN} → ${RESOLVED} 인데 아웃바운드 IP 는 ${OUTBOUND_IP} 다." >&2
  echo "A 레코드가 다른 곳을 가리키면 인증서 발급이 실패한다." >&2
fi

echo "==> UFW — 22(rate-limit)·80·443"
# 퍼블릭 22 는 열어 둔다 (D-017): 클라우드 브라우저 SSH 콘솔이 out-of-band 복구
# 경로다. limit 는 소스 IP 당 30초에 6회 신규 연결로 제한해 브루트포스를 늦춘다 —
# 인증 자체는 아래 sshd 하드닝이 키 전용으로 막는다.
ufw default deny incoming
ufw default allow outgoing
ufw limit 22/tcp
ufw allow 80/tcp   # ACME HTTP-01 + HTTPS 리다이렉트
ufw allow 443/tcp
ufw --force enable
ufw status verbose

echo "==> SSH 하드닝 (키 전용)"
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

echo "==> Caddy — ${DOMAIN} → 127.0.0.1:3000"
# 공식 apt repo 로 설치한다 — unattended-upgrades 가 보안 패치를 함께 관리한다.
if ! command -v caddy >/dev/null 2>&1; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
    | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
    > /etc/apt/sources.list.d/caddy-stable.list
  $APT update
  $APT install caddy
fi

# HSTS·보안 헤더·압축은 앱이 담당한다 (D-016 에서 이관) — Caddy 는 프록시만 한다.
cat > /etc/caddy/Caddyfile <<EOF
${DOMAIN} {
	reverse_proxy 127.0.0.1:3000
}
EOF
caddy validate --config /etc/caddy/Caddyfile
systemctl enable caddy
systemctl restart caddy

echo "==> 인증서 발급 확인 (최대 90초)"
# 앱 배포 전이므로 502 가 정상이다 — TLS 응답이 온다는 것 자체가 발급 성공이다.
# 자기 자신의 공인 IP 로의 hairpin 접속이 막히는 호스트가 있어 실패해도 죽이지 않는다.
# 확정 판정은 bootstrap.sh 가 개발 PC(외부 시점)에서 한다.
CODE=000
i=0
while [ "${i}" -lt 18 ]; do
  CODE="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 5 "https://${DOMAIN}/" 2>/dev/null || echo 000)"
  [ "${CODE}" != "000" ] && break
  i=$((i + 1))
  sleep 5
done
if [ "${CODE}" = "000" ]; then
  echo "경고: https://${DOMAIN} 의 TLS 응답을 서버 안에서 확인하지 못했다." >&2
  echo "hairpin NAT 제약일 수 있다 — 외부에서 접속해 보고, 안 되면: journalctl -u caddy" >&2
else
  echo "TLS 응답 확인 (HTTP ${CODE} — 앱 배포 전에는 502 가 정상)"
fi

echo "==> app.env"
if [ -f /etc/quant-platform/app.env ]; then
  # 절대 덮지 않는다 — SESSION_SECRET 이 바뀌면 기존 세션이 전부 무효화된다
  echo "이미 존재 — 건너뜀"
else
  SECRET="$(openssl rand -base64 48 | tr -d '\n')"
  # sed 로 치환하면 비밀값이 별도 프로세스(sed)의 argv 로 넘어가 호출 동안
  # /proc/<pid>/cmdline·ps 에 노출된다 — printf 는 빌트인이라 노출되지 않는다.
  # 목적지 파일에 바로 쓰지 않고 임시 파일에 완성한 뒤 mv 로 원자적 교체한다.
  # 중간에 실패(디스크 꽉 참·시그널)해도 잘린 app.env 가 생기지 않는다 — 잘린 파일이
  # 생기면 위 "이미 존재 — 건너뜀" 이 그 상태를 영구 고착시키고 재실행도 못 고친다.
  umask 077
  TMP_ENV="$(mktemp)"
  grep -v '^SESSION_SECRET=' "${SELF_DIR}/app.env.example" > "${TMP_ENV}"
  printf 'SESSION_SECRET=%s\n' "${SECRET}" >> "${TMP_ENV}"
  chown root:root "${TMP_ENV}" && chmod 600 "${TMP_ENV}"
  mv "${TMP_ENV}" /etc/quant-platform/app.env
fi

echo "==> systemd 유닛"
install -m 644 -o root -g root "${SELF_DIR}/quant-platform.service" \
  /etc/systemd/system/quant-platform.service
systemctl daemon-reload
# start 는 하지 않는다 — dist 가 아직 없다. 첫 기동은 deploy.sh 가 한다.
systemctl enable quant-platform

echo ""
echo "프로비저닝 완료: https://${DOMAIN}"
```

- [ ] **Step 2: 셸 문법 검증**

```bash
sh -n infra/provision.sh
bash -n infra/provision.sh
```

Expected: 출력 없이 종료 코드 0. (checkbashisms 가 있으면 `checkbashisms infra/provision.sh` 도 돌린다 — 없으면 생략.)

- [ ] **Step 3: 커밋**

```bash
git add infra/provision.sh
git commit -m "feat(infra): provision.sh — Tailscale 제거, Caddy·UFW 22/80/443 단일 실행 (D-017)"
```

---

### Task 7: bootstrap.sh — tailnet 검증·하드닝 게이트 제거

**Files:**
- Rewrite: `scripts/bootstrap.sh`

**Interfaces:**
- Consumes: Task 6 의 `sudo sh provision.sh <도메인>` 계약
- Produces: `QP_HOST`·`QP_DOMAIN`·`SSH_KEY`(·`QP_LOG`) 환경변수 계약. `TS_AUTHKEY` 는 폐기.

- [ ] **Step 1: 전체 재작성**

`scripts/bootstrap.sh` 를 다음으로 교체한다. 유지되는 것: 입력 → 로그 리다이렉트 순서, EXIT trap, SSH preflight 와 그 진단 메시지, sudo preflight, 업로드 3종. 사라지는 것: TS_AUTHKEY, FQDN 마커 파싱, tailnet SSH 실증, `--harden` 2단계. 새로 오는 것: QP_DOMAIN 입력, 프로비저닝 후 SSH 재검증, 개발 PC 시점의 HTTPS 검증:

```bash
#!/usr/bin/env bash
# 서버 부트스트랩 — 새 호스트를 배포 가능 상태로 만든다
# (설계: docs/superpowers/specs/2026-07-27-platform-readonly-constitution-design.md §4).
#
# 사용법: ./scripts/bootstrap.sh
#         서버 주소와 도메인을 순서대로 물어본다. 비대화형으로 돌리려면
#         QP_HOST / QP_DOMAIN / SSH_KEY 환경변수를 미리 설정한다.
#
#   QP_HOST    서버 주소, `[user@]host` 형식. user 를 생략하면 ssh 의 규칙에 맡긴다
#              (~/.ssh/config 의 User, 없으면 로컬 사용자명).
#   QP_DOMAIN  서비스 도메인 (예: quant.example.com). A 레코드가 서버의 고정 공인
#              IP 를 가리키고 있어야 한다 — Caddy 가 이 이름으로 인증서를 받는다.
#   SSH_KEY    개인키 경로. 지정하면 -i 로 넘긴다. 없으면 ~/.ssh/config 나
#              기본 이름 키(id_ed25519 등)에 의존한다.
#
# 이 스크립트는 로그인 사용자명을 가정하지 않는다 — 클라우드 이미지마다 다르고
# (ubuntu / admin / ec2-user), 자체 설치 호스트는 임의다. 스펙 §2.1 의 "애플리케이션과
# 도구는 특정 클라우드를 모른다" 를 따른다.
#
# 인증은 공개키만 지원한다. 비밀번호 인증을 넣지 않는 이유는 provision.sh 가
# PasswordAuthentication no 를 쓰기 때문이다 (스펙 §16·D-017) — 어떤 호스트에서든
# 프로비저닝이 끝나면 비밀번호로는 다시 들어올 수 없다. 한 실행에 ssh/scp 가 5회
# 호출되므로 매번 프롬프트가 뜨는 문제도 있고, sudo 확인은 어차피 passwordless
# sudo 를 요구한다. 퍼블릭 22 는 계속 열려 있으므로(D-017) 락아웃 걱정은 없다 —
# 키를 잃어도 클라우드 브라우저 SSH 콘솔로 들어갈 수 있다.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REMOTE_DIR=/tmp/quant-provision

# ── 입력은 로그 리다이렉트보다 먼저 받는다 ────────────────────────────────────
# tee 를 거치면 프롬프트가 버퍼링에 걸려 화면에 안 나타날 수 있다. 입력을 다 받은
# 뒤에 리다이렉트를 걸어 그 위험을 없앤다.
# read 뒤의 `|| true`: 비대화형 실행(stdin 이 /dev/null·닫힘)에서 read 는 EOF 로
# 비영점 종료한다. 그러면 set -e 가 여기서 스크립트를 죽여, 바로 아래의 사람이 읽을
# 안내가 실행되지 못하고 설명 없는 exit 1 만 남는다. 값의 유무 판단은 다음 줄에 맡긴다.
TARGET="${QP_HOST:-}"
if [ -z "${TARGET}" ]; then
  read -rp "서버 주소 입력(user@host): " TARGET || true
fi
[ -n "${TARGET}" ] || {
  echo "서버 주소가 필요합니다 — 비대화형이면 QP_HOST 로 지정하세요" >&2
  exit 1
}

DOMAIN="${QP_DOMAIN:-}"
if [ -z "${DOMAIN}" ]; then
  read -rp "서비스 도메인 입력(예: quant.example.com): " DOMAIN || true
fi
[ -n "${DOMAIN}" ] || {
  echo "도메인이 필요합니다 — 비대화형이면 QP_DOMAIN 으로 지정하세요" >&2
  exit 1
}

# ── 여기서부터 모든 출력을 로그 파일에도 남긴다 ───────────────────────────────
# 화면에 의존하지 않는 것이 요점이다 — 터미널 종류·스크롤백 한도·창 크기와 무관하게
# 실행 기록이 남아야 한다.
# 파일명은 *.log 로 .gitignore 에 이미 걸려 있다. QP_LOG 로 경로를 바꿀 수 있다.
LOG="${QP_LOG:-${REPO_ROOT}/.logs/bootstrap-$(date -u +%Y%m%d-%H%M%S).log}"
mkdir -p "$(dirname "${LOG}")"
exec > >(tee "${LOG}") 2>&1
TEE_PID=$!

on_exit() {
  status=$?
  if [ "${status}" -ne 0 ]; then
    echo
    echo "실패 (exit ${status}). 로그: ${LOG}"
  fi
  # tee 가 마지막 줄까지 쓰도록 fd 를 닫고 기다린다 — 안 하면 끝이 잘릴 수 있다
  exec 1>&- 2>&-
  wait "${TEE_PID}" 2>/dev/null || true
  exit "${status}"
}
trap on_exit EXIT

echo "로그: ${LOG}"

# 키 지정은 선택이다 — SSH_KEY 가 있으면 -i 로 넘기고, 없으면 ssh 의 평소 규칙
# (~/.ssh/config, 기본 이름 키)에 맡긴다. IdentitiesOnly 를 함께 켜는 이유는
# 하드닝이 MaxAuthTries 3 을 걸기 때문이다 — agent 에 등록된 키까지 순서대로
# 제시되면 맞는 키가 4번째가 되어 서버가 먼저 연결을 끊을 수 있다.
SSH_OPTS=()
if [ -n "${SSH_KEY:-}" ]; then
  [ -f "${SSH_KEY}" ] || { echo "SSH_KEY 파일이 없습니다: ${SSH_KEY}" >&2; exit 1; }
  SSH_OPTS=(-i "${SSH_KEY}" -o IdentitiesOnly=yes)
fi

echo "==> SSH 접속 확인: ${TARGET}"
# 이 확인이 없으면 아래 ssh/scp 가 set -e 로 조용히 죽어, 실패 원인이 그 다음 단계를
# 가리킨다 — 실제로 그렇게 오진한 적이 있다.
ssh "${SSH_OPTS[@]}" -o ConnectTimeout=15 -o BatchMode=yes "${TARGET}" true 2>/dev/null || {
  {
    echo "SSH 접속 실패: ${TARGET}"
    echo
    if [[ "${TARGET}" != *@* ]]; then
      echo "주소에 사용자명이 없다. ssh 가 ~/.ssh/config 의 User 나 로컬 사용자명을 쓴다 —"
      echo "의도한 계정이 아니면 user@host 형식으로 다시 지정하라."
      echo "(클라우드 이미지의 관례는 제각각이다: ubuntu / admin / ec2-user 등)"
      echo
    fi
    if [ -n "${SSH_KEY:-}" ]; then
      echo "지정한 키로 붙지 못했다: ${SSH_KEY}"
    else
      # 키를 안 넘겼을 때가 가장 흔한 실패다 — ~/.ssh 에서 후보를 찾아
      # 그대로 복사해 쓸 수 있는 명령을 만들어 준다.
      echo "키를 지정하지 않았다. ssh 는 ~/.ssh/config 나 기본 이름 키만 시도한다 —"
      echo "다른 이름의 키(예: 클라우드 콘솔에서 내려받은 <name>.pem)는 시도조차 하지 않는다."
      CANDIDATES="$(ls -1 ~/.ssh/*.pem ~/.ssh/id_* 2>/dev/null | grep -v '\.pub$' || true)"
      if [ -n "${CANDIDATES}" ]; then
        echo
        echo "찾은 키 후보 — 하나를 골라 다시 실행하면 된다:"
        while IFS= read -r k; do
          [ -n "${k}" ] && echo "  SSH_KEY=${k} ./scripts/bootstrap.sh"
        done <<< "${CANDIDATES}"
      else
        echo
        echo "~/.ssh 에서 키 후보를 찾지 못했다. 호스트에 등록한 공개키의 짝을 확인하거나,"
        echo "새로 만들어 등록하라: ssh-keygen -t ed25519 -f ~/.ssh/quant-platform"
      fi
      echo
      echo "매번 지정하지 않으려면 ~/.ssh/config 에 등록해도 된다:"
      echo "  Host ${TARGET##*@}"
      echo "    User <로그인 사용자명>"
      echo "    IdentityFile ~/.ssh/<your-key>"
      echo "    IdentitiesOnly yes"
    fi
    echo
    echo "원인 가르기: ssh -v ${SSH_KEY:+-i ${SSH_KEY} }${TARGET} true"
    echo "  Permission denied (publickey) → 키가 없거나 틀렸다 (또는 사용자명이 다르다)"
    echo "  Connection timed out          → 방화벽에서 TCP 22 가 닫혀 있다"
    echo "  Unprotected private key file  → 키 파일 권한 (Windows: icacls /inheritance:r /grant:r)"
  } >&2
  exit 1
}

echo "==> 프로비저닝 파일 업로드"
ssh "${SSH_OPTS[@]}" "${TARGET}" "mkdir -p ${REMOTE_DIR}" \
  || { echo "원격 디렉터리 생성 실패: ${REMOTE_DIR}" >&2; exit 1; }
scp "${SSH_OPTS[@]}" "${REPO_ROOT}/infra/provision.sh" \
    "${REPO_ROOT}/infra/systemd/quant-platform.service" \
    "${REPO_ROOT}/infra/app.env.example" \
    "${TARGET}:${REMOTE_DIR}/" \
  || { echo "파일 업로드 실패 — ${REPO_ROOT}/infra 아래 3개 파일과 원격 디스크 여유를 확인하세요" >&2; exit 1; }

# provision.sh 는 root 로 돌아야 하고, TTY 없이 붙는다. sudo 가 비밀번호를 물으면
# 답할 방법이 없으므로 여기서 먼저 분명하게 실패시킨다. passwordless sudo 는 이
# 도구의 전제다 (클라우드 이미지는 보통 그렇게 오지만, 자체 설치 호스트라면 직접
# 설정해야 한다).
ssh "${SSH_OPTS[@]}" "${TARGET}" "sudo -n true" \
  || { echo "sudo 에 비밀번호가 필요합니다 — 이 계정에 passwordless sudo 를 설정한 뒤 재실행하세요" >&2; exit 1; }

echo "==> 프로비저닝 (패키지·Node·UFW·sshd·Caddy·app.env·systemd)"
ssh "${SSH_OPTS[@]}" "${TARGET}" "sudo sh ${REMOTE_DIR}/provision.sh ${DOMAIN}"

# provision.sh 가 sshd 를 재시작했다 — 새 연결로 즉시 재검증해 하드닝이 SSH 를
# 깨뜨렸다면 지금 크게 알린다 (퍼블릭 22 는 열려 있으므로 락아웃은 아니고,
# 최악의 경우에도 클라우드 브라우저 SSH 콘솔이 남는다).
echo "==> 프로비저닝 후 SSH 재검증"
ssh "${SSH_OPTS[@]}" -o ConnectTimeout=15 -o BatchMode=yes "${TARGET}" true \
  || { echo "프로비저닝 후 SSH 재접속 실패 — 클라우드 브라우저 SSH 콘솔로 확인하세요" >&2; exit 1; }

# 인증서의 확정 판정은 여기다 — 서버 안(hairpin 제약 가능)이 아니라 외부 시점.
echo "==> HTTPS 검증: https://${DOMAIN}"
CODE="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 15 "https://${DOMAIN}/" || echo 000)"
if [ "${CODE}" = "000" ]; then
  echo "https://${DOMAIN} 에 TLS 로 접속하지 못했습니다." >&2
  echo "  - A 레코드가 서버 고정 IP 를 가리키는지, DNS 전파가 끝났는지 확인" >&2
  echo "  - 클라우드 방화벽에서 TCP 80·443 이 열려 있는지 확인" >&2
  echo "  - 서버에서: journalctl -u caddy --no-pager -n 50" >&2
  exit 1
fi
echo "TLS 응답 확인 (HTTP ${CODE} — 앱 배포 전에는 502 가 정상)"

cat <<MSG

부트스트랩 완료: https://${DOMAIN}

다음 단계:
  1) 첫 배포:      ${SSH_KEY:+SSH_KEY=${SSH_KEY} }QP_HOST=${TARGET} ./scripts/deploy.sh
  2) 관리자 생성 + TOTP 등록 (서버에서, 순서대로):
     ssh ${SSH_KEY:+-i ${SSH_KEY} }${TARGET}
     sudo systemd-run --pty --uid=quant --gid=quant \\
       --property=EnvironmentFile=/etc/quant-platform/app.env \\
       --working-directory=/opt/quant-platform/current \\
       /usr/local/bin/node /opt/quant-platform/current/dist/server/cli.js admin:create
     sudo systemd-run --pty --uid=quant --gid=quant \\
       --property=EnvironmentFile=/etc/quant-platform/app.env \\
       --working-directory=/opt/quant-platform/current \\
       /usr/local/bin/node /opt/quant-platform/current/dist/server/cli.js totp:enroll
     TOTP 등록은 퍼블릭 노출 전 필수다 (D-017) — 미등록이면 서버가 부팅 경고를 남긴다.
  3) 클라우드 방화벽은 TCP 22·80·443 만 허용한다 (IPv4·IPv6 각각 확인)
MSG
```

- [ ] **Step 2: 문법 검증 + 비대화형 가드 확인**

```bash
bash -n scripts/bootstrap.sh
QP_HOST= QP_DOMAIN= ./scripts/bootstrap.sh </dev/null; echo "exit=$?"
```

Expected: 문법 오류 없음. 두 번째 명령은 `서버 주소가 필요합니다 …` 를 stderr 로 내고 exit=1.

- [ ] **Step 3: 커밋**

```bash
git add scripts/bootstrap.sh
git commit -m "feat(scripts): bootstrap.sh — tailnet 검증·하드닝 게이트 제거, 도메인 기반 HTTPS 검증 (D-017)"
```

---

### Task 8: README 배포 절·deploy.sh 문자열 갱신

**Files:**
- Modify: `README.md` (`## 배포` 절)
- Modify: `scripts/deploy.sh` (usage 문자열 2곳 — 동작 변경 없음)

**Interfaces:**
- Consumes: Task 6·7 의 새 스크립트 계약

- [ ] **Step 1: deploy.sh 문자열만 교체**

`scripts/deploy.sh` 에서 (D-016 때와 같은 성질의 usage 문자열 수정 — 동작 불변):
- 2행 주석 `… tailnet FQDN 으로 배포한다.` → `… 서버로 배포한다.`
- 프롬프트 `"서버 주소 [user@]host (tailnet FQDN): "` → `"서버 주소 [user@]host: "`

- [ ] **Step 2: README `## 배포` 절 재작성**

`## 배포` 제목부터 `## 구조` 직전까지를 다음으로 교체한다:

```markdown
## 배포

애플리케이션은 클라우드·증권사를 모른다. 호스트 요구사항은 Ubuntu 24.04(또는 동등한
Linux), RAM 1GB 이상, 스토리지 40GB 이상, 고정 공인 IP, 월 10 USD 미만이다. 이걸
만족하면 어떤 VPS 로도 교체할 수 있다. 현재 선택은 AWS Lightsail 서울 Micro
($7/월, 2 vCPU / 1GB / 40GB)다.

플랫폼은 도메인 + Caddy(Let's Encrypt) 로 퍼블릭에 노출된다. 앱 자체는
`127.0.0.1:3000` 에만 바인딩하고 Caddy 가 앞에서 TLS 를 종단한다. 플랫폼은 조회
평면이라(스펙 §2.6 — 돈·전략·보안 조작은 SSH CLI 전용) 이 노출이 허용된다.
인증은 비밀번호 + TOTP 2단계다 (스펙 §16).

**증권사 API 트래픽은 반드시 이 고정 공인 IP 로 나가야 한다.** 증권사가 허용 출발
IP 를 등록제로 운영하기 때문이다. 프로비저닝이 아웃바운드 IP 를 조회해 출력하니
등록한 IP 와 일치하는지 확인한다. 조회는 공개 IP echo 서비스 몇 곳을 순서대로
시도한다(특정 업체에 묶지 않기 위해서다) — 다른 엔드포인트를 쓰려면
`OUTBOUND_IP_URL` 로 지정한다.

1GB 호스트의 운영 제약: 동시 백테스트 1개, DuckDB 1 thread·메모리 상한 384MB,
시간봉 사전 집계, 대규모 파라미터 sweep 금지.

Tailscale 에서 퍼블릭 + Caddy 로 옮긴 이유와 트레이드오프는
[docs/DECISIONS.md](docs/DECISIONS.md) 의 D-017 에 있다.

### 사전 준비 (1회)

1. 도메인 확보 — 서버의 고정 공인 IP 를 가리키는 A 레코드를 만든다.
2. 호스트 준비 — Ubuntu 24.04 LTS, 고정 공인 IP 연결, SSH 공개키 등록,
   passwordless sudo.

   AWS Lightsail 예: `Seoul → Linux/Unix → OS Only → Ubuntu 24.04 LTS →
   SSH 공개키 업로드 → Micro $7 → Static IP 연결`
3. 클라우드 방화벽은 TCP 22·80·443 만 허용한다 (IPv4·IPv6 각각 확인).
   퍼블릭 22 는 의도적으로 열어 둔다 — 클라우드 브라우저 SSH 콘솔이 out-of-band
   복구 경로다. UFW 의 `limit` 와 sshd 키 전용 인증이 브루트포스를 막는다.

### 서버 구축 (인스턴스마다)

```bash
./scripts/bootstrap.sh
```

서버 주소(`[user@]host`)와 도메인을 순서대로 물어본다. 비대화형은
`QP_HOST`·`QP_DOMAIN`·`SSH_KEY` 로 지정한다.

**서버 주소는 `[user@]host` 형식이다.** 로그인 사용자명은 호스트마다 다르므로
(클라우드 이미지 관례가 `ubuntu`·`admin`·`ec2-user` 등으로 갈리고 자체 설치는 임의)
스크립트가 가정하지 않는다. 생략하면 `~/.ssh/config` 의 `User` 나 로컬 사용자명이 쓰인다.

**인증은 공개키만 지원한다.** 프로비저닝이 sshd 에 `PasswordAuthentication no` 를
쓰므로 비밀번호로는 들어올 수 없다. 키는 `SSH_KEY=~/.ssh/your-key` 로 넘기거나
`~/.ssh/config` 에 등록한다. 키를 잃어도 클라우드 브라우저 SSH 콘솔로 들어갈 수 있다.

**`sudo` 는 비밀번호 없이 되어야 한다** — `provision.sh` 가 root 로 돌아야 하고
프롬프트에 답할 TTY 가 없다.

`infra/provision.sh` 는 멱등한 단일 실행이다:

- apt 갱신·업그레이드, 빌드 도구 (`build-essential`·`python3`·`pkg-config` —
  better-sqlite3·argon2·DuckDB 가 네이티브 모듈이라 서버에서 컴파일된다),
  `sqlite3` CLI, `jq`·`openssl`·`ufw`·`unattended-upgrades`
- 서버 시간대 UTC 고정, `quant` 시스템 유저(nologin), 디렉터리 트리
- Node.js 24 (nodejs.org 타르볼, SHA256 검증, `/opt/node` 심링크)
- UFW: 인바운드 기본 거부 + 22(rate-limit)·80·443 허용
- sshd 하드닝: `PermitRootLogin no`, `PasswordAuthentication no`,
  `KbdInteractiveAuthentication no`, `MaxAuthTries 3`, `LoginGraceTime 30`,
  `X11Forwarding no`
- Caddy (공식 apt repo): `<도메인> → 127.0.0.1:3000` 리버스 프록시, Let's
  Encrypt 발급·갱신 자동. 보안 헤더·압축은 앱이 담당하므로 Caddy 는 프록시만 한다
- `/etc/quant-platform/app.env` 생성 — `SESSION_SECRET` 은 서버에서 만든다.
  **파일이 이미 있으면 절대 덮지 않는다** (덮으면 기존 세션이 전부 무효화된다)
- systemd 유닛 설치 후 `enable` — `start` 는 하지 않는다 (첫 기동은 `deploy.sh`)

마지막에 bootstrap 이 개발 PC 시점에서 `https://<도메인>` 의 TLS 응답을 확인한다 —
앱 배포 전에는 502 가 정상이다.

### 첫 배포와 계정

```bash
./scripts/deploy.sh   # 검증 게이트 → 릴리스 전환 → health check → 실패 시 자동 롤백
```

`bootstrap.sh` 와 같은 방식이다 — 서버 주소를 첫 단계에서 물어보고
`QP_HOST`·`SSH_KEY` 도 동일하게 인식한다. 검증 게이트가 몇 분 걸리므로 주소 입력과
SSH 접속 확인을 그 전에 끝낸다.

배포 후 서버에서 관리자 생성과 TOTP 등록을 순서대로 한다 (정확한 명령은 bootstrap
출력에 나온다):

```bash
pnpm cli admin:create   # 실제로는 systemd-run 래핑 — bootstrap 출력 참고
pnpm cli totp:enroll    # 퍼블릭 노출 전 필수 (D-017) — 미등록이면 부팅 경고
```

TOTP 등록·재발급은 CLI 에서만 할 수 있다 — 웹 세션이 탈취돼도 2단계 인증을
바꿔치기할 수 없다 (스펙 §2.6).

접속: `https://<도메인>` — 인증서는 자동 발급·갱신된다 (Caddy).
```

- [ ] **Step 3: 게이트 + 커밋**

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm build
git add README.md scripts/deploy.sh
git commit -m "docs(readme): 배포 절을 도메인+Caddy 퍼블릭 절차로 교체 (D-017)"
```

---

## Self-Review 체크리스트 (계획 작성자가 수행 완료)

- 스펙 커버리지: 설계 §2(문서, Task 1) / §3.1(Task 2) / §3.2·3.3·3.5(Task 3·4·5) / §3.4(Task 5 부팅 경고 + Task 7 안내문) / §4.1~4.4·4.6(Task 6·7·8) / §4.5(수동 runbook — Task 6 주석과 설계 문서가 담당) / §5(코드 없음) / §6(태스크 순서 그대로)
- 킬스위치(설계 §2.2)는 의도적으로 태스크 없음 — 자동매매 엔진과 함께 구현 (D-009)
- 타입 일관성: `TotpService`·`setTotp`·`listUsernamesWithoutTotp`·`TotpVerifyResult` 시그니처가 Task 3 정의와 Task 5 사용처에서 동일함을 확인
- E2E: TOTP 미등록 계정은 1단계 로그인이므로 기존 E2E 무수정 통과 (Task 3 Step 8, Task 4 Step 2)
