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
    expect(() => loadConfig({ LOG_LEVEL: 'verbose' })).toThrow(ConfigError);
  });

  it('parses provided values', () => {
    const config = loadConfig({
      APP_PORT: '4100',
      LIVE_TRADING_ENABLED: 'true',
    });
    expect(config.port).toBe(4100);
    expect(config.liveTradingEnabled).toBe(true);
  });

  describe('DART 설정', () => {
    it('DART_API_KEY 미설정이면 null 이고 로드는 성공한다', () => {
      const config = loadConfig({});
      expect(config.dartApiKey).toBeNull();
      expect(config.dartBaseUrl).toBe('https://opendart.fss.or.kr');
    });

    it('DART_API_KEY 를 읽는다', () => {
      expect(loadConfig({ DART_API_KEY: 'abc' }).dartApiKey).toBe('abc');
    });

    it('빈 DART_API_KEY 는 거부한다 — 설정했다고 믿는 비활성 상태를 만들지 않는다', () => {
      expect(() => loadConfig({ DART_API_KEY: '' })).toThrow(/DART_API_KEY/);
    });
  });

  describe('KRX 설정', () => {
    it('미설정이면 krxApiKey 는 null 이고 기본 base URL 을 쓴다', () => {
      const config = loadConfig({});
      expect(config.krxApiKey).toBeNull();
      expect(config.krxBaseUrl).toBe('https://data-dbg.krx.co.kr');
      expect(config.krxApprovalExpiry).toBeNull();
    });

    it('만료일 형식이 틀리면 ConfigError 다', () => {
      expect(() => loadConfig({ KRX_API_KEY: 'k', KRX_APPROVAL_EXPIRY: '2027/08/03' })).toThrow(ConfigError);
    });

    it('만료일만 있고 키가 없으면 ConfigError 다 — 반쪽 설정은 즉시 실패', () => {
      expect(() => loadConfig({ KRX_APPROVAL_EXPIRY: '2027-08-03' })).toThrow(ConfigError);
    });
  });
});
