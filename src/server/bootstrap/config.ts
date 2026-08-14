import { randomBytes } from 'node:crypto';
import { z } from 'zod';

const booleanString = z
  .enum(['true', 'false'])
  .transform((value) => value === 'true');

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  APP_BIND_ADDRESS: z.string().default('127.0.0.1'),
  APP_PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DATABASE_PATH: z.string().default('./data/app.sqlite'),
  DATA_ROOT: z.string().default('./data/market-data'),
  IMPORT_ROOT: z.string().default('./data/imports'),
  EXPORT_ROOT: z.string().default('./data/exports'),
  TEMP_ROOT: z.string().default('./data/temp'),
  MAX_CONCURRENT_BACKTESTS: z.coerce.number().int().min(1).max(4).default(1),
  /** 대기(QUEUED) 백테스트 상한 — 연타로 대기열이 무한히 쌓이는 것을 막는다 (D-025) */
  MAX_QUEUED_BACKTESTS: z.coerce.number().int().min(1).max(200).default(20),
  SESSION_SECRET: z.string().min(32).optional(),
  SESSION_IDLE_TIMEOUT_SECONDS: z.coerce.number().int().min(60).default(43200),
  SESSION_ABSOLUTE_TIMEOUT_SECONDS: z.coerce.number().int().min(60).default(604800),
  /** 감사 로그 보존 일수 (D-011). 0 = 삭제하지 않음 */
  AUDIT_LOG_RETENTION_DAYS: z.coerce.number().int().min(0).max(3650).default(90),
  /** 알림 보존 일수 (설계 2026-08-03-notification-center). 0 = 삭제하지 않음 */
  NOTIFICATION_RETENTION_DAYS: z.coerce.number().int().min(0).max(3650).default(7),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace'])
    .default('info'),
  TRUST_PROXY_LOOPBACK: booleanString.default(true),
  LIVE_TRADING_ENABLED: booleanString.default(false),
  /** 토스증권 Open API (D-018). 미설정이면 종목 이름 조회 어댑터는 비활성 */
  TOSS_BASE_URL: z.string().url().default('https://openapi.tossinvest.com'),
  TOSS_CLIENT_ID: z.string().min(1).optional(),
  TOSS_CLIENT_SECRET: z.string().min(1).optional(),
  /** DART OpenAPI (전자공시). 미설정이면 재무 수집이 비활성 — 봉 데이터는 영향 없다 */
  DART_BASE_URL: z.string().url().default('https://opendart.fss.or.kr'),
  DART_API_KEY: z.string().min(1).optional(),
  /** KRX Open API (정보데이터시스템). 미설정이면 과거 유니버스 모드가 비활성 — 다른 데이터 경로는 영향 없다 */
  KRX_BASE_URL: z.string().url().default('https://data-dbg.krx.co.kr'),
  KRX_API_KEY: z.string().min(1).optional(),
  /** KRX 이용 승인 만료일. 지나면 과거 유니버스 조회·신규 실행을 막는다 (REVIEW §10) */
  KRX_APPROVAL_EXPIRY: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  /** 이 여유 공간(MB) 미만이면 증권사 동기화를 거부한다 (§22 임계치 원칙) */
  SYNC_MIN_FREE_DISK_MB: z.coerce.number().int().min(0).default(2048),
  /**
   * 종목 마스터 백필이 하루에 쓸 수 있는 엔드포인트당 KRX 호출 수 상한.
   * KRX 한도가 엔드포인트당 10,000 이라 나머지는 사용자 조회(백테스트 제출·온디맨드
   * 동기화)가 쓸 여유로 남긴다.
   */
  KRX_DAILY_CALL_BUDGET: z.coerce.number().int().min(1).default(9000),
});

export interface AppConfig {
  readonly nodeEnv: 'development' | 'test' | 'production';
  readonly bindAddress: string;
  readonly port: number;
  readonly databasePath: string;
  readonly dataRoot: string;
  readonly importRoot: string;
  readonly exportRoot: string;
  readonly tempRoot: string;
  readonly maxConcurrentBacktests: number;
  readonly maxQueuedBacktests: number;
  readonly sessionSecret: string;
  readonly sessionIdleTimeoutSeconds: number;
  readonly sessionAbsoluteTimeoutSeconds: number;
  readonly auditLogRetentionDays: number;
  readonly notificationRetentionDays: number;
  readonly logLevel: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace';
  readonly trustProxyLoopback: boolean;
  readonly liveTradingEnabled: boolean;
  readonly tossBaseUrl: string;
  readonly tossClientId: string | null;
  readonly tossClientSecret: string | null;
  readonly dartBaseUrl: string;
  readonly dartApiKey: string | null;
  readonly krxBaseUrl: string;
  readonly krxApiKey: string | null;
  readonly krxApprovalExpiry: string | null;
  readonly syncMinFreeDiskMb: number;
  readonly krxDailyCallBudget: number;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    throw new ConfigError(`Invalid environment configuration: ${details}`);
  }

  const raw = parsed.data;

  if (raw.NODE_ENV === 'production' && !raw.SESSION_SECRET) {
    throw new ConfigError('SESSION_SECRET is required in production');
  }

  // 반쪽 자격 증명은 "설정했다고 믿었는데 비활성"인 상태를 만든다 — 즉시 실패
  if (Boolean(raw.TOSS_CLIENT_ID) !== Boolean(raw.TOSS_CLIENT_SECRET)) {
    throw new ConfigError('TOSS_CLIENT_ID 와 TOSS_CLIENT_SECRET 은 함께 설정해야 합니다');
  }

  if (raw.KRX_APPROVAL_EXPIRY && !raw.KRX_API_KEY) {
    // 만료일만 있는 설정은 키를 설정했다고 착각한 상태다 — 즉시 실패
    throw new ConfigError('KRX_APPROVAL_EXPIRY 는 KRX_API_KEY 와 함께 설정해야 합니다');
  }

  return {
    nodeEnv: raw.NODE_ENV,
    bindAddress: raw.APP_BIND_ADDRESS,
    port: raw.APP_PORT,
    databasePath: raw.DATABASE_PATH,
    dataRoot: raw.DATA_ROOT,
    importRoot: raw.IMPORT_ROOT,
    exportRoot: raw.EXPORT_ROOT,
    tempRoot: raw.TEMP_ROOT,
    maxConcurrentBacktests: raw.MAX_CONCURRENT_BACKTESTS,
    maxQueuedBacktests: raw.MAX_QUEUED_BACKTESTS,
    sessionSecret: raw.SESSION_SECRET ?? randomBytes(48).toString('base64'),
    sessionIdleTimeoutSeconds: raw.SESSION_IDLE_TIMEOUT_SECONDS,
    sessionAbsoluteTimeoutSeconds: raw.SESSION_ABSOLUTE_TIMEOUT_SECONDS,
    auditLogRetentionDays: raw.AUDIT_LOG_RETENTION_DAYS,
    notificationRetentionDays: raw.NOTIFICATION_RETENTION_DAYS,
    logLevel: raw.LOG_LEVEL,
    trustProxyLoopback: raw.TRUST_PROXY_LOOPBACK,
    liveTradingEnabled: raw.LIVE_TRADING_ENABLED,
    tossBaseUrl: raw.TOSS_BASE_URL,
    tossClientId: raw.TOSS_CLIENT_ID ?? null,
    tossClientSecret: raw.TOSS_CLIENT_SECRET ?? null,
    dartBaseUrl: raw.DART_BASE_URL,
    dartApiKey: raw.DART_API_KEY ?? null,
    krxBaseUrl: raw.KRX_BASE_URL,
    krxApiKey: raw.KRX_API_KEY ?? null,
    krxApprovalExpiry: raw.KRX_APPROVAL_EXPIRY ?? null,
    syncMinFreeDiskMb: raw.SYNC_MIN_FREE_DISK_MB,
    krxDailyCallBudget: raw.KRX_DAILY_CALL_BUDGET,
  };
}
