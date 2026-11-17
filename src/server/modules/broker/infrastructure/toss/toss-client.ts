import { setTimeout as delay } from "node:timers/promises";
import type { Logger } from "../../../../shared/logger.js";
import { BrokerRequestError } from "../../../trading/application/broker-port.js";
import type { TossConfig } from "./toss-stock-info-source.js";
import { tossRequestGroup, tossRequestInterval, type TossRateLimitGroup } from "./toss-rate-limits.js";

export interface TossClientOptions {
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}
interface RequestOptions {
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
  beforeSend?: () => void;
  signal?: AbortSignal;
}
interface RateState {
  gate: Promise<void>;
  lastCall: number;
  blockedUntil: number;
}
interface PendingToken {
  promise: Promise<string>;
  controller: AbortController;
  users: number;
  sent: boolean;
}

/** 대기열 앞 요청은 유지하면서 취소된 호출자는 즉시 반환한다. */
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => { signal.removeEventListener("abort", abort); reject(signal.reason); };
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    if (signal.aborted) abort();
  });
}

function retryDelay(response: Response, attempt: number, now: number): number {
  const retryAfter = response.headers.get("retry-after")?.trim();
  const seconds = (value: string | null | undefined) => value && /^\d+(?:\.\d+)?$/.test(value) ? Number(value) * 1000 : NaN;
  const retryMs = seconds(retryAfter);
  const dateMs = retryAfter && !Number.isFinite(retryMs) ? Date.parse(retryAfter) - now : NaN;
  const resetMs = seconds(response.headers.get("x-ratelimit-reset"));
  const advised = [retryMs, dateMs, resetMs].filter((ms) => Number.isFinite(ms) && ms > 0);
  // 헤더가 없거나 0이어도 바쁜 재시도 루프를 만들지 않는다. 최대 시도 횟수로 작업을 실패시키지 않는다.
  return advised.length ? Math.max(100, ...advised) : Math.min(30_000, 1000 * 2 ** Math.min(attempt, 5));
}

/** 토스 OpenAPI 1.2.28: https://openapi.tossinvest.com/openapi-docs/latest/openapi.json */
export class TossClient {
  private token: { value: string; refreshAt: number } | null = null;
  private pendingToken: PendingToken | null = null;
  private readonly rates = new Map<TossRateLimitGroup, RateState>();
  private readonly shutdown = new AbortController();
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  private readonly now: () => number;

  constructor(private readonly config: TossConfig, private readonly logger: Logger, options: TossClientOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep
      ? (ms, signal) => abortable(options.sleep!(ms), signal)
      : (ms, signal) => delay(ms, undefined, { signal });
  }

  close(): void { this.shutdown.abort(); }

  private validToken(): boolean {
    return this.token !== null && this.token.refreshAt > this.now();
  }

  private async getToken(signal: AbortSignal): Promise<string> {
    signal.throwIfAborted();
    if (this.validToken()) return this.token!.value;
    if (!this.pendingToken || this.pendingToken.controller.signal.aborted) {
      const controller = new AbortController();
      const pending: PendingToken = { controller, users: 0, sent: false, promise: Promise.resolve("") };
      pending.promise = (async () => {
        const response = await this.send("/oauth2/token", {
          method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ grant_type: "client_credentials", client_id: this.config.clientId, client_secret: this.config.clientSecret }).toString(),
        }, AbortSignal.any([controller.signal, this.shutdown.signal]), "AUTH", () => { pending.sent = true; }, () => {
          pending.sent = false;
          if (pending.users === 0) controller.abort();
        });
        if (!response.ok) throw new BrokerRequestError("토스 인증에 실패했습니다", false, response.status);
        const data = await response.json() as { access_token?: unknown; expires_in?: unknown };
        controller.signal.throwIfAborted();
        this.shutdown.signal.throwIfAborted();
        if (typeof data.access_token !== "string" || !data.access_token || typeof data.expires_in !== "number" || !Number.isFinite(data.expires_in) || data.expires_in <= 0) throw new BrokerRequestError("토스 인증 응답이 올바르지 않습니다", false);
        const lifetime = data.expires_in * 1000;
        this.token = { value: data.access_token, refreshAt: this.now() + lifetime - Math.min(60_000, lifetime / 10) };
        return this.token.value;
      })().finally(() => { if (this.pendingToken === pending) this.pendingToken = null; });
      this.pendingToken = pending;
    }
    const pending = this.pendingToken;
    pending.users++;
    try { return await abortable(pending.promise, signal); }
    finally {
      pending.users--;
      // 이미 전송한 발급은 응답까지 공유한다. 중간 취소 후 재발급하면 서버 처리 순서에 따라
      // 서로의 토큰을 무효화할 수 있다. 아직 보내지 않은 대기·429 재시도만 중단한다.
      if (pending.users === 0 && !pending.sent) pending.controller.abort();
    }
  }

  private async send(path: string, init: RequestInit, signal: AbortSignal, group: TossRateLimitGroup, beforeSend?: () => void, onRateLimit?: () => void): Promise<Response> {
    let state = this.rates.get(group);
    if (!state) {
      state = { gate: Promise.resolve(), lastCall: -Infinity, blockedUntil: 0 };
      this.rates.set(group, state);
    }
    const rate = state;
    for (let attempt = 0; ; attempt++) {
      signal.throwIfAborted();
      let started = false;
      const next = rate.gate.then(async () => {
        signal.throwIfAborted();
        let token = group === "AUTH" ? null : await this.getToken(signal);
        for (;;) {
          const wait = Math.max(rate.blockedUntil, rate.lastCall + tossRequestInterval(group, this.now())) - this.now();
          if (wait > 0) await this.sleep(Math.min(wait, 60_000), signal);
          signal.throwIfAborted();
          // 실제 경과 시간을 다시 확인하므로 타이머 조기 해제·피크시간 진입에도 한도를 넘지 않는다.
          if (Math.max(rate.blockedUntil, rate.lastCall + tossRequestInterval(group, this.now())) > this.now()) continue;
          if (group !== "AUTH" && !this.validToken()) { token = await this.getToken(signal); continue; }
          if (group !== "AUTH") token = this.token!.value;
          break;
        }
        beforeSend?.();
        signal.throwIfAborted();
        rate.lastCall = this.now();
        let response: Response;
        try {
          started = true;
          response = await this.fetchImpl(`${this.config.baseUrl}${path}`, {
            ...init, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...init.headers },
            signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
          });
        } catch {
          throw new BrokerRequestError(group === "AUTH" ? "토스 인증 연결에 실패했습니다" : "토스 요청의 응답을 받지 못했습니다", group !== "AUTH" && init.method !== "GET");
        }
        if (response.status === 401 && this.token?.value === token) this.token = null;
        if (response.status === 429) {
          const waitMs = retryDelay(response, attempt, this.now());
          rate.blockedUntil = Math.max(rate.blockedUntil, this.now() + waitMs);
          this.logger.info({ module: "toss", group, waitMs }, "토스 API 호출 한도 대기 후 재시도");
          await response.body?.cancel().catch(() => {});
          onRateLimit?.();
        }
        return response;
      });
      rate.gate = next.then(() => {}, () => {});
      // 대기 취소는 즉시 반환한다. 전송 후에는 실제 응답/통신 오류로 접수 불명 여부를 판단한다.
      const response = await abortable(next, signal).catch((error: unknown) => {
        if (started) return next;
        throw error;
      });
      if (response.status !== 429) return response;
    }
  }

  async request<T>(path: string, init: RequestOptions = {}): Promise<T> {
    const method = init.method ?? "GET";
    const group = tossRequestGroup(method, path);
    const mutation = method !== "GET";
    const signal = init.signal ? AbortSignal.any([init.signal, this.shutdown.signal]) : this.shutdown.signal;
    let response: Response;
    try {
      response = await this.send(path, {
        method,
        headers: { ...(init.body !== undefined ? { "content-type": "application/json" } : {}), ...init.headers },
        ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      }, signal, group, init.beforeSend);
    } catch (error) {
      if (signal.aborted && !(error instanceof BrokerRequestError)) throw new BrokerRequestError("토스 요청 대기가 취소되었습니다", false);
      throw error;
    }
    if (!response.ok) {
      // 429만 미접수가 확정된 제한 응답이다. 다른 상태·통신 오류는 자동 재주문하지 않는다.
      throw new BrokerRequestError(`토스 요청 실패 (${response.status})`, mutation, response.status);
    }
    try { return await response.json() as T; }
    catch { throw new BrokerRequestError("토스 응답을 해석할 수 없습니다", mutation); }
  }
}

export function createTossClient(config: TossConfig, logger: Logger, options: TossClientOptions = {}): TossClient {
  return new TossClient(config, logger, options);
}
