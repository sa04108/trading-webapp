import type { Logger } from "./logger.js";

export interface TokenProvider {
  issueToken(fetchImpl: typeof fetch): Promise<{ accessToken: string; expiresAtMs: number }>;
}

export interface RestClientOptions {
  readonly baseUrl: string;
  readonly tokenProvider?: TokenProvider;
  readonly logger: Logger;
  readonly fetchImpl?: typeof fetch;
  readonly groupMinIntervalMs?: Record<string, number>;
  readonly maxRetries?: number;
  readonly random?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly clock?: () => number;
}

/** 권한 판정은 quota 기록보다 먼저, 재시도를 포함한 실제 attempt마다 수행한다. */
export interface RestRequestHooks {
  authorizeAttempt?(attempt: number): void | Promise<void>;
  beforeAttempt?(): void;
  readonly signal?: AbortSignal;
}

const DEFAULT_MIN_INTERVAL_MS = 250;
const TOKEN_REFRESH_MARGIN_MS = 60_000;

export class RestClient {
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
    const minInterval = this.options.groupMinIntervalMs?.[group] ?? this.options.groupMinIntervalMs?.["default"] ?? DEFAULT_MIN_INTERVAL_MS;
    const lastCallAt = this.lastCallAtByGroup.get(group) ?? 0;
    const waitMs = lastCallAt + minInterval - this.clock();
    if (waitMs > 0) await this.sleep(waitMs);
    this.lastCallAtByGroup.set(group, this.clock());
  }

  async request<T>(
    group: string,
    path: string,
    init: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
    hooks: RestRequestHooks = {},
  ): Promise<T> {
    let attempt = 0;
    for (;;) {
      hooks.signal?.throwIfAborted();
      await this.respectRateLimit(group);
      const token = await this.getToken();
      hooks.signal?.throwIfAborted();
      await hooks.authorizeAttempt?.(attempt + 1);
      hooks.signal?.throwIfAborted();
      hooks.beforeAttempt?.();
      const response = await this.fetchImpl(`${this.options.baseUrl}${path}`, {
        method: init.method ?? "GET",
        headers: {
          ...(token !== null ? { authorization: `Bearer ${token}` } : {}),
          ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
          ...init.headers,
        },
        ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
        ...(hooks.signal ? { signal: hooks.signal } : {}),
      });
      if (response.ok) return (await response.json()) as T;

      if (response.status === 401 && attempt === 0 && this.options.tokenProvider) {
        this.token = null;
        attempt += 1;
        continue;
      }
      const retryable = response.status === 429 || response.status >= 500;
      if (!retryable || attempt >= this.maxRetries) {
        const body = await response.text().catch(() => "");
        throw new Error(`REST 요청 실패: ${response.status} ${body.slice(0, 200)}`);
      }
      const retryAfterHeader = response.headers.get("retry-after");
      const retryAfterMs = retryAfterHeader ? Number(retryAfterHeader) * 1000 : Number.NaN;
      const backoffMs = Number.isFinite(retryAfterMs)
        ? retryAfterMs
        : Math.min(30_000, 500 * 2 ** attempt) * (0.5 + this.random() / 2);
      this.options.logger.warn(
        { module: "rest-client", event: "rest.retry", status: response.status, attempt, backoffMs },
        "retrying REST request",
      );
      await this.sleep(backoffMs);
      attempt += 1;
    }
  }
}
