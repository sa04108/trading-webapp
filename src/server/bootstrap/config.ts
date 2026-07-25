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
  DUCKDB_THREADS: z.coerce.number().int().min(1).max(8).default(1),
  DUCKDB_MEMORY_LIMIT: z
    .string()
    .regex(/^\d+(MB|GB)$/, 'ex) 384MB')
    .default('384MB'),
  SESSION_SECRET: z.string().min(32).optional(),
  SESSION_IDLE_TIMEOUT_SECONDS: z.coerce.number().int().min(60).default(43200),
  SESSION_ABSOLUTE_TIMEOUT_SECONDS: z.coerce.number().int().min(60).default(604800),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace'])
    .default('info'),
  TRUST_PROXY_LOOPBACK: booleanString.default(true),
  LIVE_TRADING_ENABLED: booleanString.default(false),
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
  readonly duckdbThreads: number;
  readonly duckdbMemoryLimit: string;
  readonly sessionSecret: string;
  readonly sessionIdleTimeoutSeconds: number;
  readonly sessionAbsoluteTimeoutSeconds: number;
  readonly logLevel: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace';
  readonly trustProxyLoopback: boolean;
  readonly liveTradingEnabled: boolean;
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
    duckdbThreads: raw.DUCKDB_THREADS,
    duckdbMemoryLimit: raw.DUCKDB_MEMORY_LIMIT,
    sessionSecret: raw.SESSION_SECRET ?? randomBytes(48).toString('base64'),
    sessionIdleTimeoutSeconds: raw.SESSION_IDLE_TIMEOUT_SECONDS,
    sessionAbsoluteTimeoutSeconds: raw.SESSION_ABSOLUTE_TIMEOUT_SECONDS,
    logLevel: raw.LOG_LEVEL,
    trustProxyLoopback: raw.TRUST_PROXY_LOOPBACK,
    liveTradingEnabled: raw.LIVE_TRADING_ENABLED,
  };
}
