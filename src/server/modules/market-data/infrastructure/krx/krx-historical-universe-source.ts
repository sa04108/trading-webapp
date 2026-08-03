import type { Clock } from '../../../../shared/clock.js';
import type { Logger } from '../../../../shared/logger.js';
import { RestClient } from '../../../../shared/rest-client.js';
import {
  KrxApprovalExpiredError,
  KrxNotConfiguredError,
  KrxQuotaError,
  type KrxHistoricalUniverseSource,
} from '../../application/ports.js';
import { isoToBasDd, kstDateOf } from '../../domain/kst-date.js';
import type {
  KrxDailyTradeRow,
  KrxIssueBaseInfoRow,
  KrxMarket,
} from '../../domain/krx-universe-types.js';
import { parseBaseInfoRows, parseDailyRows, parseKrxEnvelope } from './krx-contract.js';

export interface KrxConfig {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly approvalExpiry: string | null;
}

const PATHS: Record<KrxMarket, { readonly base: string; readonly daily: string }> = {
  KOSPI: {
    base: '/svc/apis/sto/stk_isu_base_info',
    daily: '/svc/apis/sto/stk_bydd_trd',
  },
  KOSDAQ: {
    base: '/svc/apis/sto/ksq_isu_base_info',
    daily: '/svc/apis/sto/ksq_bydd_trd',
  },
};

function notConfiguredSource(): KrxHistoricalUniverseSource {
  return {
    fetchIssueBaseInfo: async () => {
      throw new KrxNotConfiguredError();
    },
    fetchDailyTrades: async () => {
      throw new KrxNotConfiguredError();
    },
    todayCallCount: () => 0,
  };
}

export function createKrxHistoricalUniverseSource(
  config: KrxConfig | null,
  clock: Clock,
  logger: Logger,
  options: { fetchImpl?: typeof fetch; sleep?: (ms: number) => Promise<void> } = {},
): KrxHistoricalUniverseSource {
  if (config === null) return notConfiguredSource();
  const configured = config;

  const client = new RestClient({
    baseUrl: configured.baseUrl,
    logger,
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    ...(options.sleep ? { sleep: options.sleep } : {}),
    clock: () => clock.now(),
    groupMinIntervalMs: { default: 250 },
  });
  const callCounts = new Map<string, number>();

  function currentDate(): string {
    return kstDateOf(clock.now());
  }

  function removeStaleCounts(today: string): void {
    for (const date of callCounts.keys()) {
      if (date !== today) callCounts.delete(date);
    }
  }

  function todayCallCount(): number {
    const today = currentDate();
    removeStaleCounts(today);
    return callCounts.get(today) ?? 0;
  }

  function ensureApprovalIsValid(today: string): void {
    if (configured.approvalExpiry && today > configured.approvalExpiry) {
      throw new KrxApprovalExpiredError();
    }
  }

  async function fetchRows<T>(
    market: KrxMarket,
    isoDate: string,
    path: string,
    parseRows: (rows: readonly Record<string, unknown>[]) => T[],
  ): Promise<readonly T[]> {
    const today = currentDate();
    ensureApprovalIsValid(today);
    removeStaleCounts(today);
    const callsToday = (callCounts.get(today) ?? 0) + 1;
    callCounts.set(today, callsToday);

    const basDd = isoToBasDd(isoDate);
    let payload: unknown;
    try {
      payload = await client.request<unknown>('default', `${path}?basDd=${basDd}`, {
        method: 'GET',
        headers: { AUTH_KEY: configured.apiKey },
      });
    } catch (error) {
      // RestClient가 구조화된 HTTP 오류를 아직 제공하지 않아 상태 코드를 메시지로 구분한다.
      if (error instanceof Error && error.message.startsWith('REST 요청 실패: 429')) {
        throw new KrxQuotaError();
      }
      throw error;
    }

    const rows = parseRows(parseKrxEnvelope(payload));
    logger.info(
      { module: 'market-data', event: 'krx.fetch', market, basDd, rows: rows.length, callsToday },
      'krx fetch ok',
    );
    return rows;
  }

  return {
    fetchIssueBaseInfo: (
      market: KrxMarket,
      isoDate: string,
    ): Promise<readonly KrxIssueBaseInfoRow[]> =>
      fetchRows(market, isoDate, PATHS[market].base, parseBaseInfoRows),
    fetchDailyTrades: (
      market: KrxMarket,
      isoDate: string,
    ): Promise<readonly KrxDailyTradeRow[]> =>
      fetchRows(market, isoDate, PATHS[market].daily, parseDailyRows),
    todayCallCount,
  };
}
