import { randomBytes } from 'node:crypto';
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
  | { readonly status: 'INVALID' }
  | { readonly status: 'LOCKED' };

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
    // ready() 를 기다리지 않는 경로에서도 unhandled rejection 이 되지 않게 한다
    void this.dummyHashPromise.catch(() => undefined);
  }

  /**
   * 더미 해시 계산 완료를 기다린다. 요청을 받기 전에 호출해야 한다 —
   * 생성자는 계산을 시작만 하므로, 그 사이에 도착한 미존재 사용자 로그인은
   * 남은 해시 시간 + 검증을 치르고 존재하는 사용자는 검증만 치른다. 콜드스타트
   * 구간에서만 존재 여부가 응답 시간으로 드러나는 창이 열린다.
   */
  async ready(): Promise<void> {
    await this.dummyHashPromise;
  }

  /**
   * 비밀번호 1단계. TOTP 등록 계정은 pending 세션을 발급하고 verifyTotp 가 2단계를 맡는다 (D-017).
   * 어느 경로든 서버가 발급하지 않은 쿠키 값은 인증된 세션이 되지 않는다.
   */
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

    const requiresTotp = user.totpEnabled;
    const session: SessionRecord = {
      id: newSessionId(),
      userId: user.id,
      pendingTotp: requiresTotp,
      createdAtMs: now,
      lastSeenAtMs: now,
    };
    sessions.create(session);

    if (requiresTotp) {
      // 감사 로그를 남긴다 — 2단계에서 막히는 시도는 "비밀번호가 샜다" 의 가장 강한
      // 신호인데, 성공도 실패도 아니라는 이유로 아무 기록 없이 지나가면 그 신호가
      // login_attempts 에도 audit 에도 남지 않는다.
      audit.record(username, 'auth.login.totp-required', { ip });
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
      return { status: 'LOCKED' };
    }

    const normalizedToken = token.trim();
    let verified = false;
    const step = totp.verify(user.totpSecret, normalizedToken, now);

    if (step !== null) {
      // 코드가 맞아도 이미 소비한 타임스텝이면 거부한다 (RFC 6238 §5.2). window ±1
      // 때문에 한 코드가 90초간 유효하므로, 이 차단이 없으면 어깨너머로 본 코드
      // 하나로 공격자가 자기 pending 세션을 정식 세션으로 바꿀 수 있다.
      verified = users.consumeTotpStep(user.id, step, now);
      if (!verified) audit.record(user.username, 'auth.totp.replay', { ip });
    } else if (!/^\d{6}$/.test(normalizedToken)) {
      // 6자리 숫자는 복구 코드가 될 수 없다 (복구 코드는 hex 10자, cli.ts).
      // 이 가드가 없으면 오타 한 번마다 Argon2 검증이 최대 8회 돈다 — 1GB/2vCPU
      // 호스트에서 libuv 스레드풀을 메워 로그인 전체를 정지시킨다.
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

  private async consumeRecoveryCode(
    user: UserRecord,
    token: string,
    nowMs: number,
  ): Promise<boolean> {
    const { users, passwordHasher } = this.deps;
    for (const hash of user.recoveryCodeHashes) {
      if (await passwordHasher.verify(hash, token)) {
        // 스냅샷 배열을 통째로 덮어쓰지 않는다 — 위 await 가 두 요청의 교차를
        // 허용하므로, 저장소가 해시 하나만 원자적으로 지우게 한다. 이미 지워졌으면
        // 다른 요청이 먼저 썼다는 뜻이므로 실패로 접는다 (각 코드 1회용, 스펙 §16).
        return users.consumeRecoveryCodeHash(user.id, hash, nowMs);
      }
    }
    return false;
  }
}
