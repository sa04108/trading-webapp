import type { Logger } from './logger.js';

/**
 * 증권사 공통 REST 클라이언트 (스펙 §13):
 * - 토큰 발급·캐싱·만료 전 재발급
 * - API 그룹별 rate limiter (최소 간격)
 * - 429 는 Retry-After 우선, 이후 exponential backoff + jitter
 */
export interface TokenProvider {
  issueToken(fetchImpl: typeof fetch): Promise<{ accessToken: string; expiresAtMs: number }>;
}

export interface RestClientOptions {
  readonly baseUrl: string;
  /**
   * OAuth 토큰 공급자. 생략하면 Authorization 헤더를 붙이지 않는다 —
   * DART 처럼 쿼리 파라미터로 인증하는 API 를 위한 경로다. 더미 토큰 공급자를
   * 끼우면 거짓 헤더를 보내게 되므로 옵션으로 둔다.
   */
  readonly tokenProvider?: TokenProvider;
  readonly logger: Logger;
  readonly fetchImpl?: typeof fetch;
  /** API 그룹별 최소 호출 간격 (ms). 기본 그룹은 'default' */
  readonly groupMinIntervalMs?: Record<string, number>;
  readonly maxRetries?: number;
  /** 테스트 결정성을 위해 주입 가능한 jitter (0~1) */
  readonly random?: () => number;
  /** 테스트용 sleep 대체 */
  readonly sleep?: (ms: number) => Promise<void>;
  readonly clock?: () => number;
}

const DEFAULT_MIN_INTERVAL_MS = 250;
const TOKEN_REFRESH_MARGIN_MS = 60_000;

export class BrokerRestClient {
  private token: { accessToken: string; expiresAtMs: number } | null = null;
  private lastCallAtByGroup = new Map<string, number>();
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;
  private readonly clock: () => number;
  private readonly maxRetries: number;

  constructor(private readonly options: RestClientOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.random = options.random ?? Math.random;
    this.clock = options.clock ?? (() => Date.now());
    this.maxRetries = options.maxRetries ?? 4;
  }

  private async getToken(): Promise<string | null> {
    const provider = this.options.tokenProvider;
    if (!provider) return null;
    const now = this.clock();
    if (!this.token || this.token.expiresAtMs - TOKEN_REFRESH_MARGIN_MS <= now) {
      this.token = await provider.issueToken(this.fetchImpl);
    }
    return this.token.accessToken;
  }

  private async respectRateLimit(group: string): Promise<void> {
    const minInterval =
      this.options.groupMinIntervalMs?.[group] ??
      this.options.groupMinIntervalMs?.['default'] ??
      DEFAULT_MIN_INTERVAL_MS;
    const lastCallAt = this.lastCallAtByGroup.get(group) ?? 0;
    const waitMs = lastCallAt + minInterval - this.clock();
    if (waitMs > 0) await this.sleep(waitMs);
    this.lastCallAtByGroup.set(group, this.clock());
  }

  async request<T>(
    group: string,
    path: string,
    init: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
  ): Promise<T> {
    let attempt = 0;

    for (;;) {
      await this.respectRateLimit(group);
      const token = await this.getToken();

      const response = await this.fetchImpl(`${this.options.baseUrl}${path}`, {
        method: init.method ?? 'GET',
        headers: {
          ...(token !== null ? { authorization: `Bearer ${token}` } : {}),
          ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
          ...init.headers,
        },
        ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      });

      if (response.ok) {
        return (await response.json()) as T;
      }

      // 토큰 인증일 때만 401 재발급을 시도한다 — 쿼리 키 방식에서 401 은 키가
      // 틀린 것이므로 재시도가 의미 없다
      if (response.status === 401 && attempt === 0 && this.options.tokenProvider) {
        this.token = null;
        attempt += 1;
        continue;
      }

      const retryable = response.status === 429 || response.status >= 500;
      if (!retryable || attempt >= this.maxRetries) {
        const body = await response.text().catch(() => '');
        throw new Error(`broker request failed: ${response.status} ${body.slice(0, 200)}`);
      }

      const retryAfterHeader = response.headers.get('retry-after');
      const retryAfterMs = retryAfterHeader ? Number(retryAfterHeader) * 1000 : Number.NaN;
      const backoffMs = Number.isFinite(retryAfterMs)
        ? retryAfterMs
        : Math.min(30_000, 500 * 2 ** attempt) * (0.5 + this.random() / 2);

      this.options.logger.warn(
        { module: 'broker', event: 'broker.retry', status: response.status, attempt, backoffMs },
        'retrying broker request',
      );
      await this.sleep(backoffMs);
      attempt += 1;
    }
  }
}
