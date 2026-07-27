export interface UserRecord {
  readonly id: string;
  readonly username: string;
  readonly passwordHash: string;
  readonly totpSecret: string | null;
  readonly totpEnabled: boolean;
  readonly recoveryCodeHashes: readonly string[];
  /** 마지막으로 소비한 TOTP 타임스텝. 재사용 차단용 (RFC 6238 §5.2). 미사용이면 null. */
  readonly totpLastUsedStep: number | null;
}

export interface SessionRecord {
  readonly id: string;
  readonly userId: string;
  readonly pendingTotp: boolean;
  readonly createdAtMs: number;
  readonly lastSeenAtMs: number;
}

export interface UserRepository {
  findByUsername(username: string): UserRecord | null;
  findById(id: string): UserRecord | null;
  create(user: UserRecord, nowMs: number): void;
  countUsers(): number;
  /**
   * 복구 코드 해시 하나를 소비한다. 스냅샷 배열을 통째로 덮어쓰지 않고 저장소 안에서
   * 원자적으로 읽고-거르고-쓴다 — 동시 요청이 서로의 소비를 되살리지 못하게 한다.
   * 이미 소비됐거나 존재하지 않는 해시면 false.
   */
  consumeRecoveryCodeHash(userId: string, hash: string, nowMs: number): boolean;
  /**
   * TOTP 타임스텝을 소비한다. `step` 이 이미 쓰인 값 이하이면 재사용이므로 false 를
   * 돌려주고 아무것도 바꾸지 않는다 — 비교와 기록이 한 문장 안에서 원자적이어야 한다.
   */
  consumeTotpStep(userId: string, step: number, nowMs: number): boolean;
  setTotp(
    userId: string,
    secret: string,
    recoveryCodeHashes: readonly string[],
    nowMs: number,
  ): void;
  listUsernamesWithoutTotp(): readonly string[];
}

export interface SessionRepository {
  create(session: SessionRecord): void;
  findById(id: string): SessionRecord | null;
  touch(id: string, nowMs: number): void;
  delete(id: string): void;
}

export interface LoginAttemptRepository {
  record(username: string, ip: string, success: boolean, nowMs: number): void;
  countRecentFailures(username: string, sinceMs: number): number;
}

export interface PasswordHasher {
  hash(plain: string): Promise<string>;
  verify(hash: string, plain: string): Promise<boolean>;
}

export interface TotpService {
  generateSecret(): string;
  buildUri(secret: string, username: string): string;
  /**
   * 검증에 성공하면 그 토큰이 속한 타임스텝(counter)을, 실패하면 null 을 돌려준다.
   * boolean 이 아니라 스텝을 돌려주는 이유는 호출자가 재사용을 차단해야 하기 때문이다
   * (RFC 6238 §5.2) — window ±1 이면 같은 코드가 90초간 유효하므로 "맞았다" 만으로는
   * 이미 쓴 코드인지 알 수 없다.
   *
   * `nowMs` 를 받는 이유는 테스트 결정성이다 — 생략하면 내부에서 현재 시각을 읽는다.
   * 손상된 secret(base32 아님)은 던지지 않고 null 로 닫는다.
   */
  verify(secret: string, token: string, nowMs?: number): number | null;
}
