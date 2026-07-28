import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../../src/server/bootstrap/config.js';

describe('loadConfig', () => {
  it('applies spec defaults in development', () => {
    const config = loadConfig({});
    expect(config.nodeEnv).toBe('development');
    expect(config.bindAddress).toBe('127.0.0.1');
    expect(config.port).toBe(3000);
    expect(config.maxConcurrentBacktests).toBe(1);
    expect(config.maxQueuedBacktests).toBe(20);
    expect(config.duckdbThreads).toBe(1);
    expect(config.duckdbMemoryLimit).toBe('384MB');
    expect(config.sessionIdleTimeoutSeconds).toBe(43200);
    expect(config.sessionAbsoluteTimeoutSeconds).toBe(604800);
    expect(config.liveTradingEnabled).toBe(false);
    expect(config.sessionSecret.length).toBeGreaterThanOrEqual(32);
  });

  it('leaves the toss source unconfigured by default and requires paired credentials', () => {
    const config = loadConfig({});
    expect(config.tossBaseUrl).toBe('https://openapi.tossinvest.com');
    expect(config.tossClientId).toBeNull();
    expect(config.tossClientSecret).toBeNull();
    expect(config.syncMinFreeDiskMb).toBe(2048);

    expect(() => loadConfig({ TOSS_CLIENT_ID: 'c_only' })).toThrow(ConfigError);
    expect(() => loadConfig({ TOSS_CLIENT_SECRET: 's_only' })).toThrow(ConfigError);

    const configured = loadConfig({ TOSS_CLIENT_ID: 'c_x', TOSS_CLIENT_SECRET: 's_y' });
    expect(configured.tossClientId).toBe('c_x');
    expect(configured.tossClientSecret).toBe('s_y');
  });

  it('requires SESSION_SECRET in production', () => {
    expect(() => loadConfig({ NODE_ENV: 'production' })).toThrow(ConfigError);
    expect(() =>
      loadConfig({
        NODE_ENV: 'production',
        SESSION_SECRET: 'x'.repeat(48),
      }),
    ).not.toThrow();
  });

  it('rejects invalid values', () => {
    expect(() => loadConfig({ APP_PORT: 'not-a-port' })).toThrow(ConfigError);
    expect(() => loadConfig({ APP_PORT: '99999' })).toThrow(ConfigError);
    expect(() => loadConfig({ DUCKDB_MEMORY_LIMIT: '384' })).toThrow(ConfigError);
    expect(() => loadConfig({ LOG_LEVEL: 'verbose' })).toThrow(ConfigError);
  });

  it('parses provided values', () => {
    const config = loadConfig({
      APP_PORT: '4100',
      LIVE_TRADING_ENABLED: 'true',
      DUCKDB_MEMORY_LIMIT: '256MB',
    });
    expect(config.port).toBe(4100);
    expect(config.liveTradingEnabled).toBe(true);
    expect(config.duckdbMemoryLimit).toBe('256MB');
  });
});
