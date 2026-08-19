import { describe, expect, it, vi } from 'vitest';
import { RestClient, type TokenProvider } from '../../src/server/shared/rest-client.js';
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
  const client = new RestClient({
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

describe('RestClient (스펙 §13 공통 REST 클라이언트)', () => {
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

  it('물리적인 HTTP 재시도마다 beforeAttempt를 한 번씩 호출한다', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(500, { error: 'temporary' }))
      .mockResolvedValueOnce(jsonResponse(200, { ok: true }));
    const { client } = buildClient(fetchImpl as unknown as typeof fetch);
    const beforeAttempt = vi.fn();

    await client.request(
      'default',
      '/retry-once',
      {},
      { beforeAttempt },
    );

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(beforeAttempt).toHaveBeenCalledTimes(2);
  });

  it('beforeAttempt가 거절하면 HTTP 요청을 보내지 않는다', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { ok: true }));
    const { client } = buildClient(fetchImpl as unknown as typeof fetch);

    await expect(
      client.request(
        'default',
        '/blocked',
        {},
        { beforeAttempt: () => { throw new Error('quota blocked'); } },
      ),
    ).rejects.toThrow('quota blocked');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('retries 5xx with exponential backoff and eventually fails', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(500, { error: 'boom' }));
    const { client } = buildClient(fetchImpl as unknown as typeof fetch);

    await expect(client.request('default', '/broken')).rejects.toThrow('REST 요청 실패: 500');
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

    const client = new RestClient({
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
    const client = new RestClient({
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

  /**
   * DART 는 API 키를 `crtfc_key` 쿼리 파라미터로 보낸다 — 요청 경로 자체가 비밀값이다.
   * 지금 새는 곳은 없지만(전 경로 확인) 막고 있는 것도 없다: 재시도 로그나 실패 메시지에
   * 경로를 넣는 것은 디버깅용으로 가장 먼저 떠오르는 수정이다. 게다가 RestClient 는
   * 증권사 어댑터와 공유되고, 그 실패 문자열은 잡 레코드에 그대로 저장돼 웹 UI 에 뜬다.
   * 아래 두 테스트가 그 두 경로를 못박는다.
   */
  const SECRET = 'SECRET_KEY_ABC123';

  function capturingLogger(): { logger: never; lines: string[] } {
    const lines: string[] = [];
    const capture = (...args: unknown[]) => lines.push(JSON.stringify(args));
    return {
      logger: { debug: capture, info: capture, warn: capture, error: capture } as never,
      lines,
    };
  }

  it('재시도 로그에 요청 경로(=API 키)가 실리지 않는다', async () => {
    const { logger, lines } = capturingLogger();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(429, { error: 'rate' }, { 'retry-after': '1' }))
      .mockResolvedValueOnce(jsonResponse(200, { ok: true }));

    const client = new RestClient({
      baseUrl: 'https://opendart.fss.or.kr',
      logger,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: async () => undefined,
      clock: () => 0,
      random: () => 0.5,
    });

    await client.request('default', `/api/list.json?crtfc_key=${SECRET}&corp_code=x`);

    // 재시도가 실제로 일어났음을 먼저 확인한다 — 로그가 아예 없으면 테스트가 공허해진다
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.some((line) => line.includes('rest.retry'))).toBe(true);
    for (const line of lines) {
      expect(line).not.toContain(SECRET);
    }
  });

  it('HTTP 실패 예외 메시지에 요청 경로(=API 키)가 실리지 않는다', async () => {
    const { logger, lines } = capturingLogger();
    // 재시도하지 않는 4xx — 메시지 조립 경로를 그대로 탄다
    const fetchImpl = (async () => jsonResponse(400, { error: 'bad' })) as unknown as typeof fetch;
    const client = new RestClient({
      baseUrl: 'https://opendart.fss.or.kr',
      logger,
      fetchImpl,
      sleep: async () => undefined,
      clock: () => 0,
    });

    let rejection: unknown;
    try {
      await client.request('default', `/api/list.json?crtfc_key=${SECRET}`);
    } catch (error) {
      rejection = error;
    }
    expect(rejection).toBeInstanceOf(Error);
    expect((rejection as Error).message).toContain('400');
    expect((rejection as Error).message).not.toContain(SECRET);
    // 잡 레코드에 저장되는 문자열이므로 stack 까지 확인한다
    expect((rejection as Error).stack ?? '').not.toContain(SECRET);
    for (const line of lines) {
      expect(line).not.toContain(SECRET);
    }
  });

  it('재시도 소진 후 5xx 예외 메시지에도 요청 경로가 실리지 않는다', async () => {
    const { logger, lines } = capturingLogger();
    const fetchImpl = (async () => jsonResponse(500, { error: 'boom' })) as unknown as typeof fetch;
    const client = new RestClient({
      baseUrl: 'https://opendart.fss.or.kr',
      logger,
      fetchImpl,
      sleep: async () => undefined,
      clock: () => 0,
      random: () => 0.5,
      maxRetries: 2,
    });

    await expect(
      client.request('default', `/api/list.json?crtfc_key=${SECRET}`),
    ).rejects.toThrow(/500/);
    expect(lines.some((line) => line.includes('rest.retry'))).toBe(true);
    for (const line of lines) {
      expect(line).not.toContain(SECRET);
    }
  });

  it('tokenProvider 없이 401 이 오면 토큰 재발급을 시도하지 않고 즉시 실패한다', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return new Response('unauthorized', { status: 401 });
    }) as unknown as typeof fetch;

    const client = new RestClient({
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
