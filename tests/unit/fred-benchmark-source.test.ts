import { describe, expect, it } from 'vitest';
import {
  FredContractError,
  FredNotConfiguredError,
} from '../../src/server/modules/market-data/application/ports.js';
import { createFredBenchmarkSource } from '../../src/server/modules/market-data/infrastructure/fred/fred-benchmark-source.js';
import type { Logger } from '../../src/server/shared/logger.js';

const API_KEY = 'secret-fred-key';
const BASE_URL = 'https://fred.test';
const logger = {
  debug() {}, info() {}, warn() {}, error() {},
} as unknown as Logger;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('FRED 벤치마크 어댑터', () => {
  it('기간 일봉을 한 번에 조회하고 결측값은 뺀다', async () => {
    const calls: string[] = [];
    const fetchImpl = (async (input: Parameters<typeof fetch>[0]) => {
      calls.push(String(input));
      return jsonResponse({
        observations: [
          { date: '2019-01-01', value: '.' },
          { date: '2019-01-02', value: '2510.03' },
        ],
      });
    }) as typeof fetch;
    const source = createFredBenchmarkSource(
      { baseUrl: BASE_URL, apiKey: API_KEY },
      logger,
      { fetchImpl, sleep: async () => undefined },
    );

    await expect(source.fetchBenchmarkRange('SP500', '2019-01-01', '2019-01-31')).resolves.toEqual([
      { date: '2019-01-02', close: 2510.03 },
    ]);
    expect(calls).toEqual([
      `${BASE_URL}/fred/series/observations?series_id=SP500&observation_start=2019-01-01&observation_end=2019-01-31&file_type=json&api_key=${API_KEY}`,
    ]);
  });

  it('미설정과 잘못된 응답을 명확한 오류로 바꾼다', async () => {
    const unconfigured = createFredBenchmarkSource(null, logger);
    await expect(
      unconfigured.fetchBenchmarkRange('DJIA', '2026-01-01', '2026-01-02'),
    ).rejects.toBeInstanceOf(FredNotConfiguredError);

    const invalid = createFredBenchmarkSource(
      { baseUrl: BASE_URL, apiKey: API_KEY },
      logger,
      { fetchImpl: (async () => jsonResponse({ observations: [{ date: 'bad', value: '1' }] })) as typeof fetch },
    );
    await expect(
      invalid.fetchBenchmarkRange('DJIA', '2026-01-01', '2026-01-02'),
    ).rejects.toBeInstanceOf(FredContractError);
  });

  it('FRED 오류에 API 키를 남기지 않는다', async () => {
    const source = createFredBenchmarkSource(
      { baseUrl: BASE_URL, apiKey: API_KEY },
      logger,
      { fetchImpl: (async () => jsonResponse({ error: API_KEY }, 401)) as typeof fetch },
    );

    let message = '';
    try {
      await source.fetchBenchmarkRange('NASDAQ100', '2026-01-01', '2026-01-02');
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).not.toContain(API_KEY);
    expect(message).toContain('[REDACTED]');
  });

  it('API 키를 가린 뒤 원본 Error를 그대로 던진다', async () => {
    const original = new Error(`request failed: ${API_KEY}`);
    const source = createFredBenchmarkSource(
      { baseUrl: BASE_URL, apiKey: API_KEY },
      logger,
      { fetchImpl: (async () => { throw original; }) as typeof fetch },
    );

    let rejection: unknown;
    try {
      await source.fetchBenchmarkRange('DJIA', '2026-01-01', '2026-01-02');
    } catch (error) {
      rejection = error;
    }

    expect(rejection).toBe(original);
    expect(original.message).toBe('request failed: [REDACTED]');
    expect(original.stack).not.toContain(API_KEY);
  });
});
