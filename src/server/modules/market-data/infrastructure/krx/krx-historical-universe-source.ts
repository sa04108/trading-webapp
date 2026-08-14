import type { Clock } from '../../../../shared/clock.js';
import type { Logger } from '../../../../shared/logger.js';
import { BENCHMARK_NAMES, type KrxBenchmarkId } from '../../../../../shared/schemas/benchmark.js';
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
import { parseBaseInfoRows, parseDailyRows, parseIndexClose, parseKrxEnvelope } from './krx-contract.js';

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

const BENCHMARK_PATHS: Record<KrxBenchmarkId, string> = {
  KOSPI: '/svc/apis/idx/kospi_dd_trd',
  KOSDAQ: '/svc/apis/idx/kosdaq_dd_trd',
};

const SAFE_REQUEST_ERROR_MESSAGE = 'KRX Open API 요청에 실패했습니다.';

function readCaughtErrorMessage(value: unknown): string | null {
  try {
    if (!(value instanceof Error)) return null;
    return typeof value.message === 'string' ? value.message : null;
  } catch {
    return null;
  }
}

function notConfiguredSource(): KrxHistoricalUniverseSource {
  return {
    fetchIssueBaseInfo: async () => {
      throw new KrxNotConfiguredError();
    },
    fetchDailyTrades: async () => {
      throw new KrxNotConfiguredError();
    },
    fetchBenchmarkClose: async () => {
      throw new KrxNotConfiguredError();
    },
    todayMaxEndpointCallCount: () => 0,
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
  // KRX 한도는 엔드포인트마다 따로 걸리므로 경로별로 나눠 센다 — 키는 `${KST 날짜}|${경로}`다.
  const callCounts = new Map<string, number>();

  function currentDate(): string {
    return kstDateOf(clock.now());
  }

  function countKey(today: string, path: string): string {
    return `${today}|${path}`;
  }

  function removeStaleCounts(today: string): void {
    const prefix = `${today}|`;
    for (const key of callCounts.keys()) {
      if (!key.startsWith(prefix)) callCounts.delete(key);
    }
  }

  function todayMaxEndpointCallCount(): number {
    const today = currentDate();
    removeStaleCounts(today);
    let max = 0;
    for (const count of callCounts.values()) {
      if (count > max) max = count;
    }
    return max;
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
    const key = countKey(today, path);
    const callsToday = (callCounts.get(key) ?? 0) + 1;
    callCounts.set(key, callsToday);

    const basDd = isoToBasDd(isoDate);
    let payload: unknown;
    try {
      payload = await client.request<unknown>('default', `${path}?basDd=${basDd}`, {
        method: 'GET',
        headers: { AUTH_KEY: configured.apiKey },
      });
    } catch (error) {
      const message = readCaughtErrorMessage(error);

      // RestClient가 구조화된 HTTP 오류를 아직 제공하지 않아 상태 코드를 메시지로 구분한다.
      if (message?.startsWith('REST 요청 실패: 429')) {
        throw new KrxQuotaError();
      }
      if (message !== null) {
        // 실패 본문과 외부 오류 메타데이터에 인증키가 있을 수 있어 안전한 메시지만 새 오류로 옮긴다.
        const sanitizedMessage =
          configured.apiKey === ''
            ? message
            : message.replaceAll(configured.apiKey, '[REDACTED]');
        // 원본 cause와 custom 필드를 연결하면 인증키가 다시 노출될 수 있다.
        // eslint-disable-next-line preserve-caught-error
        throw new Error(sanitizedMessage);
      }

      // 분류할 수 없는 외부 값은 직렬화하거나 원본을 보존하지 않는다.
      // eslint-disable-next-line preserve-caught-error
      throw new Error(SAFE_REQUEST_ERROR_MESSAGE);
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
    fetchBenchmarkClose: async (benchmarkId: KrxBenchmarkId, isoDate: string): Promise<number | null> => {
      const rows = await fetchRows(
        benchmarkId,
        isoDate,
        BENCHMARK_PATHS[benchmarkId],
        (rawRows) => [...rawRows],
      );
      return parseIndexClose(rows, BENCHMARK_NAMES[benchmarkId]);
    },
    todayMaxEndpointCallCount,
  };
}
