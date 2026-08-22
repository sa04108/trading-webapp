import type { Clock } from '../../../../shared/clock.js';
import type { Logger } from '../../../../shared/logger.js';
import type { ExternalApiUsage } from '../../../../shared/db/external-api-usage.js';
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
  options: {
    fetchImpl?: typeof fetch;
    sleep?: (ms: number) => Promise<void>;
    usage?: ExternalApiUsage;
  } = {},
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
  // 테스트·독립 스크립트는 DB 원장을 주입하지 않을 수 있어 메모리 fallback을 유지한다.
  // 앱 container는 반드시 SQLite 원장을 넣으므로 운영 호출 수는 재부팅 뒤에도 이어진다.
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
    if (options.usage) return options.usage.maxCallsUsed('KRX');
    const today = currentDate();
    removeStaleCounts(today);
    let max = 0;
    for (const count of callCounts.values()) {
      if (count > max) max = count;
    }
    return max;
  }

  function quotaWasExceeded(path: string): boolean {
    return options.usage?.quotaExceeded('KRX', path) ?? false;
  }

  function recordCall(today: string, path: string): number {
    if (options.usage) return options.usage.recordCall('KRX', path);
    removeStaleCounts(today);
    const key = countKey(today, path);
    const callsToday = (callCounts.get(key) ?? 0) + 1;
    callCounts.set(key, callsToday);
    return callsToday;
  }

  function reportQuotaExceeded(path: string, error: KrxQuotaError): void {
    options.usage?.reportQuotaExceeded('KRX', path, error.message);
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
    if (quotaWasExceeded(path)) throw new KrxQuotaError();

    const basDd = isoToBasDd(isoDate);
    let callsToday = options.usage?.callsUsed('KRX', path) ?? 0;
    let payload: unknown;
    try {
      payload = await client.request<unknown>('default', `${path}?basDd=${basDd}`, {
        method: 'GET',
        headers: { AUTH_KEY: configured.apiKey },
      }, {
        // 재시도도 공급자 입장에서는 별도 HTTP 요청이다. 실제 attempt 직전에 기록해야
        // 429/5xx 재시도가 오늘 예산에서 사라지지 않는다.
        beforeAttempt: () => {
          callsToday = recordCall(today, path);
        },
      });
    } catch (error) {
      const message = readCaughtErrorMessage(error);

      // RestClient가 구조화된 HTTP 오류를 아직 제공하지 않아 상태 코드를 메시지로 구분한다.
      if (message?.startsWith('REST 요청 실패: 429')) {
        const quotaError = new KrxQuotaError();
        reportQuotaExceeded(path, quotaError);
        throw quotaError;
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
