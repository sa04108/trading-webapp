import { pino, type Logger, type LoggerOptions } from 'pino';
import type { AppConfig } from '../bootstrap/config.js';

/** 스펙 §16 Pino redaction 대상 */
const REDACT_PATHS = [
  'authorization',
  'cookie',
  'set-cookie',
  'client_secret',
  'access_token',
  'appkey',
  'appsecret',
  'accountNumber',
  'password',
  'awsSecretAccessKey',
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  '*.client_secret',
  '*.access_token',
  '*.appkey',
  '*.appsecret',
  '*.accountNumber',
  '*.password',
  '*.awsSecretAccessKey',
];

/** Fastify 내장 로거와 애플리케이션 로거가 공유하는 pino 옵션 */
export function buildPinoOptions(config: AppConfig): LoggerOptions {
  return {
    level: config.logLevel,
    redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
    ...(config.nodeEnv === 'development'
      ? {
          transport: {
            target: 'pino-pretty',
            options: { colorize: true, translateTime: 'SYS:HH:MM:ss' },
          },
        }
      : {}),
  };
}

export function createLogger(config: AppConfig): Logger {
  return pino(buildPinoOptions(config));
}

export type { Logger };
