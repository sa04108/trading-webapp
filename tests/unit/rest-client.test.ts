import { describe, expect, it, vi } from 'vitest';
import { BrokerRestClient, type TokenProvider } from '../../src/server/shared/rest-client.js';
import { createLogger } from '../../src/server/shared/logger.js';
import { loadConfig } from '../../src/server/bootstrap/config.js';

const logger = createLogger(loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'error' }));

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function buildClient(fetchImpl: typeof fetch, overrides: Record<string, unknown> = {}) {
  let now = 0;
  const sleeps: number[] = [];
  const tokenProvider: TokenProvider = {
    issueToken: vi.fn(async () => ({ accessToken: 'tok-1', expiresAtMs: 10 * 60_000 })),
  };
  const client = new BrokerRestClient({
    baseUrl: 'https://broker.test',
    tokenProvider,
    logger,
    fetchImpl,
    maxRetries: 3,
    random: () => 0.5,
    sleep: async (ms) => {
      sleeps.push(ms);
      now += ms;
    },
    clock: () => now,
    ...overrides,
  });
  return { client, sleeps, tokenProvider, advance: (ms: number) => (now += ms) };
}

describe('BrokerRestClient (스펙 §13 공통 REST 클라이언트)', () => {
  it('caches the token across requests', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { ok: true }));
    const { client, tokenProvider } = buildClient(fetchImpl as unknown as typeof fetch);

    await client.request('default', '/a');
    await client.request('default', '/b');

    expect(tokenProvider.issueToken).toHaveBeenCalledTimes(1);
    const firstCall = (fetchImpl.mock.calls[0] as unknown[])[1] as RequestInit;
    expect((firstCall.headers as Record<string, string>).authorization).toBe('Bearer tok-1');
  });

  it('honors Retry-After on 429 then succeeds', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(429, { error: 'rate' }, { 'retry-after': '2' }))
      .mockResolvedValueOnce(jsonResponse(200, { ok: true }));
    const { client, sleeps } = buildClient(fetchImpl as unknown as typeof fetch);

    const result = await client.request<{ ok: boolean }>('default', '/limited');
    expect(result.ok).toBe(true);
    expect(sleeps).toContain(2000); // Retry-After: 2s 우선
  });

  it('retries 5xx with exponential backoff and eventually fails', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(500, { error: 'boom' }));
    const { client } = buildClient(fetchImpl as unknown as typeof fetch);

    await expect(client.request('default', '/broken')).rejects.toThrow('broker request failed: 500');
    expect(fetchImpl).toHaveBeenCalledTimes(4); // 최초 1 + 재시도 3
  });

  it('does not retry non-retryable 400', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(400, { error: 'bad' }));
    const { client } = buildClient(fetchImpl as unknown as typeof fetch);

    await expect(client.request('default', '/bad')).rejects.toThrow('400');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('spaces out calls in the same rate-limit group', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { ok: true }));
    const { client, sleeps } = buildClient(fetchImpl as unknown as typeof fetch, {
      groupMinIntervalMs: { chart: 350 },
    });

    await client.request('chart', '/one');
    await client.request('chart', '/two');

    expect(sleeps.some((ms) => ms > 0 && ms <= 350)).toBe(true);
  });
});

describe('tokenProvider 없는 인증 (쿼리 파라미터 방식)', () => {
  it('tokenProvider 를 생략하면 Authorization 헤더를 붙이지 않는다', async () => {
    const seen: Array<Record<string, string>> = [];
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      seen.push((init?.headers ?? {}) as Record<string, string>);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as unknown as typeof fetch;

    const client = new BrokerRestClient({
      baseUrl: 'https://opendart.fss.or.kr',
      logger: { debug() {}, info() {}, warn() {}, error() {} } as never,
      fetchImpl,
      sleep: async () => undefined,
      clock: () => 0,
    });

    await client.request('default', '/api/list.json?crtfc_key=x');
    expect(seen[0]).not.toHaveProperty('authorization');
  });

  it('tokenProvider 가 있으면 기존대로 Bearer 를 붙인다', async () => {
    const seen: Array<Record<string, string>> = [];
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      seen.push((init?.headers ?? {}) as Record<string, string>);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as unknown as typeof fetch;

    const tokenProvider: TokenProvider = {
      issueToken: async () => ({ accessToken: 'tok', expiresAtMs: 9_999_999_999_999 }),
    };
    const client = new BrokerRestClient({
      baseUrl: 'https://api.example.com',
      tokenProvider,
      logger: { debug() {}, info() {}, warn() {}, error() {} } as never,
      fetchImpl,
      sleep: async () => undefined,
      clock: () => 0,
    });

    await client.request('default', '/x');
    expect(seen[0]?.authorization).toBe('Bearer tok');
  });

  it('tokenProvider 없이 401 이 오면 토큰 재발급을 시도하지 않고 즉시 실패한다', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return new Response('unauthorized', { status: 401 });
    }) as unknown as typeof fetch;

    const client = new BrokerRestClient({
      baseUrl: 'https://opendart.fss.or.kr',
      logger: { debug() {}, info() {}, warn() {}, error() {} } as never,
      fetchImpl,
      sleep: async () => undefined,
      clock: () => 0,
    });

    await expect(client.request('default', '/x')).rejects.toThrow(/401/);
    expect(calls).toBe(1); // 재발급 재시도가 없어야 한다
  });
});
