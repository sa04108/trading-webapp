import { and, eq, max, sql } from 'drizzle-orm';
import type { Clock } from '../clock.js';
import type { DatabaseHandle } from './database.js';
import { externalApiDailyUsage } from './schema.js';

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

export interface SqliteExternalApiUsageOptions {
  readonly database: DatabaseHandle;
  readonly clock: Clock;
  /** KST 달력일 계산은 기존 market-data domain 함수를 조립부에서 주입한다. */
  readonly currentDateKst: (nowMs: number) => string;
  /** scope·KST 날짜마다 최초 한도 확인 때만 호출된다. */
  readonly onQuotaExceeded?: (event: ExternalApiQuotaExceededEvent) => void;
}

/**
 * SQLite 기반 외부 API 호출 원장. increment와 최초 한도 표시는 BEGIN IMMEDIATE로
 * 직렬화해 같은 DB를 쓰는 동시 요청·프로세스도 호출 수를 잃지 않는다.
 */
export class SqliteExternalApiUsage implements ExternalApiUsage {
  constructor(private readonly options: SqliteExternalApiUsageOptions) {}

  recordCall(api: LimitedExternalApi, quotaScope: string): number {
    const usageDateKst = this.today();
    const now = this.options.clock.now();
    return this.options.database.sqlite.transaction(() => {
      this.options.database.db.insert(externalApiDailyUsage).values({
        api,
        quotaScope,
        usageDateKst,
        callsUsed: 1,
        updatedAtMs: now,
      }).onConflictDoUpdate({
        target: [
          externalApiDailyUsage.api,
          externalApiDailyUsage.quotaScope,
          externalApiDailyUsage.usageDateKst,
        ],
        set: {
          callsUsed: sql`${externalApiDailyUsage.callsUsed} + 1`,
          updatedAtMs: now,
        },
      }).run();
      return this.rowFor(api, quotaScope, usageDateKst)?.callsUsed ?? 0;
    }).immediate();
  }

  callsUsed(api: LimitedExternalApi, quotaScope: string): number {
    return this.rowFor(api, quotaScope, this.today())?.callsUsed ?? 0;
  }

  maxCallsUsed(api: LimitedExternalApi): number {
    return this.options.database.db
      .select({ callsUsed: max(externalApiDailyUsage.callsUsed) })
      .from(externalApiDailyUsage)
      .where(and(
        eq(externalApiDailyUsage.api, api),
        eq(externalApiDailyUsage.usageDateKst, this.today()),
      ))
      .get()?.callsUsed ?? 0;
  }

  quotaExceeded(api: LimitedExternalApi, quotaScope: string): boolean {
    const row = this.rowFor(api, quotaScope, this.today());
    return row?.quotaExceededAtMs != null;
  }

  reportQuotaExceeded(
    api: LimitedExternalApi,
    quotaScope: string,
    message: string,
  ): boolean {
    const usageDateKst = this.today();
    const now = this.options.clock.now();
    const result = this.options.database.sqlite.transaction(() => {
      const current = this.rowFor(api, quotaScope, usageDateKst);
      if (current?.quotaExceededAtMs != null) {
        return { first: false, callsUsed: current.callsUsed };
      }

      this.options.database.db.insert(externalApiDailyUsage).values({
        api,
        quotaScope,
        usageDateKst,
        callsUsed: current?.callsUsed ?? 0,
        quotaExceededAtMs: now,
        updatedAtMs: now,
      }).onConflictDoUpdate({
        target: [
          externalApiDailyUsage.api,
          externalApiDailyUsage.quotaScope,
          externalApiDailyUsage.usageDateKst,
        ],
        set: { quotaExceededAtMs: now, updatedAtMs: now },
      }).run();
      return { first: true, callsUsed: current?.callsUsed ?? 0 };
    }).immediate();

    if (result.first) {
      this.options.onQuotaExceeded?.({
        api,
        quotaScope,
        usageDateKst,
        callsUsed: result.callsUsed,
        message,
      });
    }
    return result.first;
  }

  private today(): string {
    return this.options.currentDateKst(this.options.clock.now());
  }

  private rowFor(api: LimitedExternalApi, quotaScope: string, usageDateKst: string) {
    return this.options.database.db
      .select()
      .from(externalApiDailyUsage)
      .where(and(
        eq(externalApiDailyUsage.api, api),
        eq(externalApiDailyUsage.quotaScope, quotaScope),
        eq(externalApiDailyUsage.usageDateKst, usageDateKst),
      ))
      .get();
  }
}
