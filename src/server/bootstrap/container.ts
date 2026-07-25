import fs from 'node:fs';
import type { AppConfig } from './config.js';
import { createLogger, type Logger } from '../shared/logger.js';
import { openDatabase, type DatabaseHandle } from '../shared/db/database.js';
import { systemClock, type Clock } from '../shared/clock.js';
import { createAuditLogService, type AuditLogService } from '../modules/audit/audit-service.js';
import { AuthService } from '../modules/auth/application/auth-service.js';
import type {
  LoginAttemptRepository,
  PasswordHasher,
  SessionRepository,
  TotpService,
  UserRepository,
} from '../modules/auth/application/ports.js';
import { argon2PasswordHasher } from '../modules/auth/infrastructure/argon2-password-hasher.js';
import { otpauthTotpService } from '../modules/auth/infrastructure/otpauth-totp.js';
import {
  createSqliteLoginAttemptRepository,
  createSqliteSessionRepository,
  createSqliteUserRepository,
} from '../modules/auth/infrastructure/sqlite-repositories.js';

export interface SystemStatusProviders {
  queueLength: () => number;
  runningJobs: () => number;
}

export interface Container {
  readonly config: AppConfig;
  readonly logger: Logger;
  readonly database: DatabaseHandle;
  readonly clock: Clock;
  readonly appVersion: string;
  readonly gitCommitSha: string;
  readonly systemStatus: SystemStatusProviders;
  readonly auditLog: AuditLogService;
  readonly userRepository: UserRepository;
  readonly sessionRepository: SessionRepository;
  readonly loginAttemptRepository: LoginAttemptRepository;
  readonly passwordHasher: PasswordHasher;
  readonly totpService: TotpService;
  readonly authService: AuthService;
  close(): void;
}

function readAppVersion(): string {
  try {
    const packageJsonUrl = new URL('../../../package.json', import.meta.url);
    const parsed = JSON.parse(fs.readFileSync(packageJsonUrl, 'utf8')) as {
      version?: string;
    };
    return parsed.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export function createContainer(config: AppConfig): Container {
  const logger = createLogger(config);

  for (const dir of [config.dataRoot, config.importRoot, config.exportRoot, config.tempRoot]) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const database = openDatabase(config.databasePath);
  const clock = systemClock;

  const auditLog = createAuditLogService(database.db, clock, logger);
  const userRepository = createSqliteUserRepository(database.db);
  const sessionRepository = createSqliteSessionRepository(database.db);
  const loginAttemptRepository = createSqliteLoginAttemptRepository(database.db);

  const authService = new AuthService({
    users: userRepository,
    sessions: sessionRepository,
    loginAttempts: loginAttemptRepository,
    passwordHasher: argon2PasswordHasher,
    totp: otpauthTotpService,
    clock,
    audit: auditLog,
    idleTimeoutMs: config.sessionIdleTimeoutSeconds * 1000,
    absoluteTimeoutMs: config.sessionAbsoluteTimeoutSeconds * 1000,
  });

  const systemStatus: SystemStatusProviders = {
    queueLength: () => 0,
    runningJobs: () => 0,
  };

  return {
    config,
    logger,
    database,
    clock,
    appVersion: readAppVersion(),
    gitCommitSha: process.env.BUILD_GIT_SHA ?? 'unknown',
    systemStatus,
    auditLog,
    userRepository,
    sessionRepository,
    loginAttemptRepository,
    passwordHasher: argon2PasswordHasher,
    totpService: otpauthTotpService,
    authService,
    close: () => database.close(),
  };
}
