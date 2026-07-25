import fs from 'node:fs';
import type { AppConfig } from './config.js';
import { createLogger, type Logger } from '../shared/logger.js';
import { openDatabase, type DatabaseHandle } from '../shared/db/database.js';

export interface SystemStatusProviders {
  queueLength: () => number;
  runningJobs: () => number;
}

export interface Container {
  readonly config: AppConfig;
  readonly logger: Logger;
  readonly database: DatabaseHandle;
  readonly appVersion: string;
  readonly gitCommitSha: string;
  readonly systemStatus: SystemStatusProviders;
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

  const systemStatus: SystemStatusProviders = {
    queueLength: () => 0,
    runningJobs: () => 0,
  };

  return {
    config,
    logger,
    database,
    appVersion: readAppVersion(),
    gitCommitSha: process.env.BUILD_GIT_SHA ?? 'unknown',
    systemStatus,
    close: () => database.close(),
  };
}
