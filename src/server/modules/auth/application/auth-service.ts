import { createHash, randomBytes } from 'node:crypto';
import type { Clock } from '../../../shared/clock.js';
import { isLoginLocked, isSessionExpired } from '../domain/session-policy.js';
import type {
  LoginAttemptRepository,
  PasswordHasher,
  SessionRecord,
  SessionRepository,
  TotpService,
  UserRecord,
  UserRepository,
} from './ports.js';

const LOGIN_FAILURE_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_FAILURE_LIMIT = 5;

export type LoginResult =
  | { readonly status: 'SUCCESS'; readonly sessionId: string }
  | { readonly status: 'TOTP_REQUIRED'; readonly sessionId: string }
  | { readonly status: 'INVALID_CREDENTIALS' }
  | { readonly status: 'LOCKED' };

export type TotpVerifyResult =
  | { readonly status: 'SUCCESS'; readonly sessionId: string }
  | { readonly status: 'INVALID' };

export interface AuthenticatedUser {
  readonly id: string;
  readonly username: string;
}

export interface AuditSink {
  record(actor: string, event: string, detail?: Record<string, unknown>): void;
}

export interface AuthServiceDeps {
  readonly users: UserRepository;
  readonly sessions: SessionRepository;
  readonly loginAttempts: LoginAttemptRepository;
  readonly passwordHasher: PasswordHasher;
  readonly totp: TotpService;
  readonly clock: Clock;
  readonly audit: AuditSink;
  readonly idleTimeoutMs: number;
  readonly absoluteTimeoutMs: number;
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function newSessionId(): string {
  return randomBytes(32).toString('hex');
}

export class AuthService {
  /**
   * 사용자 부재 시 타이밍 균등화용 더미 해시.
   * 기동 시점에 미리 계산한다 — 첫 로그인 시도부터 두 경로가 검증 1회로 균등하다
   * (지연 생성이면 콜드스타트 첫 시도가 해시+검증 2회로 구별 가능).
   */
  private readonly dummyHashPromise: Promise<string>;

  constructor(private readonly deps: AuthServiceDeps) {
    this.dummyHashPromise = deps.passwordHasher.hash('timing-equalizer-dummy');
    // 로그인 요청 전에 실패해도 프로세스를 죽이지 않는다 — 실제 소비 시점에 다시 던져진다
    void this.dummyHashPromise.catch(() => undefined);
  }

  async login(username: string, password: string, ip: string): Promise<LoginResult> {
    const { users, sessions, loginAttempts, passwordHasher, clock, audit } = this.deps;
    const now = clock.now();

    const recentFailures = loginAttempts.countRecentFailures(username, now - LOGIN_FAILURE_WINDOW_MS);
    if (isLoginLocked(recentFailures, LOGIN_FAILURE_LIMIT)) {
      audit.record(username, 'auth.login.locked', { ip });
      return { status: 'LOCKED' };
    }

    const user = users.findByUsername(username);
    let passwordOk = false;
    if (user) {
      passwordOk = await passwordHasher.verify(user.passwordHash, password);
    } else {
      // 사용자 부재 시에도 더미 해시를 검증해 응답 시간 차이로 계정 존재가 드러나지 않게 한다
      await passwordHasher.verify(await this.dummyHashPromise, password);
    }

    if (!user || !passwordOk) {
      loginAttempts.record(username, ip, false, now);
      audit.record(username, 'auth.login.failure', { ip });
      return { status: 'INVALID_CREDENTIALS' };
    }

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
  }

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
      verified = this.consumeRecoveryCode(user, normalizedToken, now);
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

  logout(sessionId: string): void {
    const session = this.deps.sessions.findById(sessionId);
    this.deps.sessions.delete(sessionId);
    if (session) {
      const user = this.deps.users.findById(session.userId);
      this.deps.audit.record(user?.username ?? session.userId, 'auth.logout');
    }
  }

  /** 인증된(=TOTP 완료) 세션만 사용자로 인정한다. 유효 세션은 last_seen 을 갱신한다. */
  authenticate(sessionId: string): AuthenticatedUser | null {
    const { sessions, users, clock } = this.deps;
    const now = clock.now();
    const session = sessions.findById(sessionId);
    if (!session || session.pendingTotp) return null;
    if (this.isExpired(session, now)) {
      sessions.delete(session.id);
      return null;
    }
    sessions.touch(session.id, now);
    const user = users.findById(session.userId);
    if (!user) return null;
    return { id: user.id, username: user.username };
  }

  private isExpired(session: SessionRecord, nowMs: number): boolean {
    return isSessionExpired(session, nowMs, {
      idleTimeoutMs: this.deps.idleTimeoutMs,
      absoluteTimeoutMs: this.deps.absoluteTimeoutMs,
    });
  }

  private consumeRecoveryCode(user: UserRecord, token: string, nowMs: number): boolean {
    const tokenHash = sha256Hex(token);
    const remaining = user.recoveryCodeHashes.filter((hash) => hash !== tokenHash);
    if (remaining.length === user.recoveryCodeHashes.length) return false;
    this.deps.users.updateRecoveryCodeHashes(user.id, remaining, nowMs);
    return true;
  }
}

export { sha256Hex };
