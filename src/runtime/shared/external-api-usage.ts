export type LimitedExternalApi = 'DART' | 'KRX';

export interface ExternalApiQuotaExceededEvent {
  readonly api: LimitedExternalApi;
  readonly quotaScope: string;
  readonly usageDateKst: string;
  readonly callsUsed: number;
  readonly message: string;
}

/** API 어댑터가 의존하는 좁은 호출 원장 포트. */
export interface ExternalApiUsage {
  recordCall(api: LimitedExternalApi, quotaScope: string): number;
  callsUsed(api: LimitedExternalApi, quotaScope: string): number;
  maxCallsUsed(api: LimitedExternalApi): number;
  quotaExceeded(api: LimitedExternalApi, quotaScope: string): boolean;
  reportQuotaExceeded(
    api: LimitedExternalApi,
    quotaScope: string,
    message: string,
  ): boolean;
}
