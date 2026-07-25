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

export interface UserRepository {
  findByUsername(username: string): UserRecord | null;
  findById(id: string): UserRecord | null;
  create(user: UserRecord, nowMs: number): void;
  updateRecoveryCodeHashes(userId: string, hashes: readonly string[], nowMs: number): void;
  countUsers(): number;
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
  verify(secret: string, token: string): boolean;
}
