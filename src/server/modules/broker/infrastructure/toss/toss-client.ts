import type { Logger } from "../../../../shared/logger.js";
import { BrokerRequestError } from "../../../trading/application/broker-port.js";
import type { TossConfig } from "./toss-stock-info-source.js";

export interface TossClientOptions {
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

/** 토스 OpenAPI 1.2.28: https://openapi.tossinvest.com/openapi-docs/latest/openapi.json */
export class TossClient {
  private token: { value: string; expiresAt: number } | null = null;
  private pendingToken: Promise<string> | null = null;
  private gate: Promise<void> = Promise.resolve();
  private lastCall = 0;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly config: TossConfig, _logger: Logger, options: TossClientOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  private async pace(): Promise<void> {
    const next = this.gate.then(async () => {
      const delay = Math.max(0, this.lastCall + 1100 - Date.now());
      if (delay) await this.sleep(delay);
      this.lastCall = Date.now();
    });
    this.gate = next.catch(() => {});
    await next;
  }

  private async getToken(): Promise<string> {
    if (this.token && this.token.expiresAt - 60_000 > Date.now()) return this.token.value;
    if (!this.pendingToken) {
      this.pendingToken = (async () => {
        await this.pace();
        let response: Response;
        try { response = await this.fetchImpl(`${this.config.baseUrl}/oauth2/token`, {
          method: "POST",
          signal: AbortSignal.timeout(10_000),
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ grant_type: "client_credentials", client_id: this.config.clientId, client_secret: this.config.clientSecret }).toString(),
        }); } catch { throw new BrokerRequestError("토스 인증 연결에 실패했습니다", false); }
        if (!response.ok) throw new BrokerRequestError("토스 인증에 실패했습니다", false, response.status);
        const data = await response.json() as { access_token?: unknown; expires_in?: unknown };
        if (typeof data.access_token !== "string" || !data.access_token || typeof data.expires_in !== "number" || !Number.isFinite(data.expires_in) || data.expires_in <= 0) throw new BrokerRequestError("토스 인증 응답이 올바르지 않습니다", false);
        this.token = { value: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 };
        return this.token.value;
      })().finally(() => { this.pendingToken = null; });
    }
    return this.pendingToken;
  }

  async request<T>(group: string, path: string, init: { method?: string; body?: unknown; headers?: Record<string, string>; beforeSend?: () => void } = {}): Promise<T> {
    void group;
    const token = await this.getToken();
    await this.pace();
    const mutation = init.method === "POST";
    init.beforeSend?.();
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.config.baseUrl}${path}`, {
        method: init.method ?? "GET",
        signal: AbortSignal.timeout(10_000),
        headers: { authorization: `Bearer ${token}`, ...(init.body !== undefined ? { "content-type": "application/json" } : {}), ...init.headers },
        ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      });
    } catch {
      throw new BrokerRequestError("토스 요청의 응답을 받지 못했습니다", mutation);
    }
    if (!response.ok) {
      if (response.status === 401 && this.token?.value === token) this.token = null;
      // HTTP 상태만으로 주문 미접수를 단정하지 않는다. 프록시 오류 뒤에도 주문이 접수될 수 있다.
      throw new BrokerRequestError(`토스 요청 실패 (${response.status})`, mutation, response.status);
    }
    try { return await response.json() as T; }
    catch { throw new BrokerRequestError("토스 응답을 해석할 수 없습니다", mutation); }
  }
}

export function createTossClient(config: TossConfig, logger: Logger, options: TossClientOptions = {}): TossClient {
  return new TossClient(config, logger, options);
}
