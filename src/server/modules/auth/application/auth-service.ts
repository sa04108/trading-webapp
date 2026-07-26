import { randomBytes } from 'node:crypto';
import type { Clock } from '../../../shared/clock.js';
import { isLoginLocked, isSessionExpired } from '../domain/session-policy.js';
import type {
  LoginAttemptRepository,
  PasswordHasher,
  SessionRecord,
  SessionRepository,
  UserRepository,
} from './ports.js';

const LOGIN_FAILURE_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_FAILURE_LIMIT = 5;

export type LoginResult =
  | { readonly status: 'SUCCESS'; readonly sessionId: string }
  | { readonly status: 'INVALID_CREDENTIALS' }
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
   * 비밀번호 단일 단계 로그인 (D-014 로 TOTP 제거).
   * 성공 시 항상 새 세션 ID 를 발급한다 — 서버가 발급하지 않은 쿠키 값은
   * 어느 시점에도 인증된 세션이 되지 않으므로 세션 고정 방어가 유지된다.
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

    const session: SessionRecord = {
      id: newSessionId(),
      userId: user.id,
      createdAtMs: now,
      lastSeenAtMs: now,
    };
    sessions.create(session);

    loginAttempts.record(username, ip, true, now);
    audit.record(username, 'auth.login.success', { ip });
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

  /** 유효 세션만 사용자로 인정한다. 유효 세션은 last_seen 을 갱신한다. */
  authenticate(sessionId: string): AuthenticatedUser | null {
    const { sessions, users, clock } = this.deps;
    const now = clock.now();
    const session = sessions.findById(sessionId);
    if (!session) return null;
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
}
