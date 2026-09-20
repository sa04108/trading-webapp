import type { KrxTradingCalendar } from "./krx-trading-calendar.js";
import type { Clock } from "../../../../../runtime/shared/clock.js";
import type { Logger } from "../../../../shared/logger.js";
import type { ExternalApiUsage } from "../../../../shared/db/external-api-usage.js";
import {
  BENCHMARK_NAMES,
  type KrxBenchmarkId,
} from "../../../../../shared/schemas/benchmark.js";
import { RestClient } from "../../../../shared/rest-client.js";
import {
  KrxApprovalExpiredError,
  KrxContractError,
  KrxNotConfiguredError,
  KrxQuotaError,
  type KrxHistoricalUniverseSource,
} from "../../../../../runtime/modules/market-data/application/ports.js";
import {
  isoToBasDd,
  kstDateOf,
} from "../../../../../runtime/modules/market-data/domain/kst-date.js";
import type {
  KrxDailyTradeRow,
  KrxIssueBaseInfoRow,
  KrxMarket,
} from "../../../../../runtime/modules/market-data/domain/krx-universe-types.js";
import {
  parseBaseInfoRows,
  parseDailyRows,
  parseIndexClose,
  parseKrxEnvelope,
} from "./krx-contract.js";

import { KrxRawSnapshotCorruptError, type KrxRawSnapshotKey, type KrxRawSnapshotStore } from "./krx-raw-snapshot-store.js";

import { ProviderRequestBlockedError, type ProviderRequestPolicy, type ProviderSourceState } from "../../../../shared/provider-request-policy.js";

// 같은 서버 저장소를 공유하는 진입점은 하나의 물리 요청을 기다린다.
const storeRequests = new WeakMap<KrxRawSnapshotStore, Map<string, Promise<unknown>>>();

export interface KrxConfig {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly approvalExpiry: string | null;
}

const PATHS: Record<
  KrxMarket,
  { readonly base: string; readonly daily: string }
> = {
  KOSPI: {
    base: "/svc/apis/sto/stk_isu_base_info",
    daily: "/svc/apis/sto/stk_bydd_trd",
  },
  KOSDAQ: {
    base: "/svc/apis/sto/ksq_isu_base_info",
    daily: "/svc/apis/sto/ksq_bydd_trd",
  },
};

const BENCHMARK_PATHS: Record<KrxBenchmarkId, string> = {
  KOSPI: "/svc/apis/idx/kospi_dd_trd",
  KOSDAQ: "/svc/apis/idx/kosdaq_dd_trd",
};

const SAFE_REQUEST_ERROR_MESSAGE = "KRX Open API 요청에 실패했습니다.";

function isBlockedError(value: unknown): value is ProviderRequestBlockedError {
  try {
    return value instanceof ProviderRequestBlockedError;
  } catch {
    return false;
  }
}

function readCaughtErrorMessage(value: unknown): string | null {
  try {
    if (!(value instanceof Error)) return null;
    return typeof value.message === "string" ? value.message : null;
  } catch {
    return null;
  }
}

export function createKrxHistoricalUniverseSource(
  config: KrxConfig | null,
  clock: Clock,
  logger: Logger,
  options: {
    fetchImpl?: typeof fetch;
    sleep?: (ms: number) => Promise<void>;
    usage?: ExternalApiUsage;
    rawSnapshotStore?: KrxRawSnapshotStore;
    rawNamespace?: string;
    requestPolicy?: ProviderRequestPolicy;
    tradingCalendar?: KrxTradingCalendar;
    beforeSourceFetch?: (key: KrxRawSnapshotKey) => void;
  } = {},
): KrxHistoricalUniverseSource {
  const configured = config ?? { baseUrl: "https://data-dbg.krx.co.kr", apiKey: "", approvalExpiry: null };
  const namespaceUrl = new URL(options.rawNamespace ?? configured.baseUrl);
  const namespace = `${namespaceUrl.origin}${namespaceUrl.pathname}`.replace(/\/+$/, "");
  const pending = options.rawSnapshotStore
    ? (storeRequests.get(options.rawSnapshotStore) ?? new Map<string, Promise<unknown>>())
    : new Map<string, Promise<unknown>>();
  if (options.rawSnapshotStore) storeRequests.set(options.rawSnapshotStore, pending);

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
    if (options.usage) return options.usage.maxCallsUsed("KRX");
    const today = currentDate();
    removeStaleCounts(today);
    let max = 0;
    for (const count of callCounts.values()) {
      if (count > max) max = count;
    }
    return max;
  }

  function quotaWasExceeded(path: string): boolean {
    return options.usage?.quotaExceeded("KRX", path) ?? false;
  }

  function recordCall(today: string, path: string): number {
    if (options.usage) return options.usage.recordCall("KRX", path);
    removeStaleCounts(today);
    const key = countKey(today, path);
    const callsToday = (callCounts.get(key) ?? 0) + 1;
    callCounts.set(key, callsToday);
    return callsToday;
  }

  function reportQuotaExceeded(path: string, error: KrxQuotaError): void {
    options.usage?.reportQuotaExceeded("KRX", path, error.message);
  }

  function ensureApprovalIsValid(today: string): void {
    if (configured.approvalExpiry && today > configured.approvalExpiry) {
      throw new KrxApprovalExpiredError();
    }
  }

  function pendingEmptyState(path: string, basDd: string, payload: unknown, fetchedAtMs: number): ProviderSourceState | null {
    if (!options.tradingCalendar) return null;
    const market: KrxMarket = path.includes("ksq") || path.includes("kosdaq") ? "KOSDAQ" : "KOSPI";
    if (parseKrxEnvelope(payload).length > 0) return null;
    const isoDate = `${basDd.slice(0, 4)}-${basDd.slice(4, 6)}-${basDd.slice(6, 8)}`;
    const calendar = options.tradingCalendar.classify(isoDate, market);
    if (calendar.state === "CLOSED") return null;
    return { kind: "REQUIREMENT", evidence: `KRX_EMPTY_PENDING:${JSON.stringify({ calendar, fetchedAtMs })}` };
  }

  function authorizeSource(path: string, basDd: string, state: ProviderSourceState) {
    const key = { provider: "KRX" as const, namespace, endpoint: path, parameters: { basDd } };
    const pending = state.evidence.startsWith("KRX_EMPTY_PENDING:");
    if (state.kind !== "MISSING" && !options.requestPolicy)
      throw new ProviderRequestBlockedError(pending ? "PENDING_PUBLICATION" : "BLOCKED_SOURCE_REQUIREMENT", JSON.stringify(key), state.evidence);
    try {
      return options.requestPolicy?.authorize(key, state);
    } catch (error) {
      if (pending && isBlockedError(error))
        throw new ProviderRequestBlockedError("PENDING_PUBLICATION", error.requestKey, error.evidence);
      throw error;
    }
  }

  async function fetchPayload(path: string, basDd: string, requireExisting = false): Promise<unknown> {
    const key = { namespace, endpoint: path, basDd };
    let state: ProviderSourceState = requireExisting
      ? { kind: "REQUIREMENT", evidence: "기존 수집 날짜의 필수 필드에 사용할 저장 원문 없음" }
      : { kind: "MISSING", evidence: "해당 요청 키의 저장 원문 없음" };
    try {
      const saved = options.rawSnapshotStore?.get(key);
      if (saved) {
        const pendingState = pendingEmptyState(path, basDd, saved.payload, saved.fetchedAtMs);
        if (!pendingState) return saved.payload;
        state = pendingState;
      }
    } catch (error) {
      if (!(error instanceof KrxRawSnapshotCorruptError) || !options.requestPolicy) throw error;
      state = { kind: "CORRUPT", evidence: error.evidence };
    }
    const requestKey = `${namespace}|${path}|${basDd}`;
    const running = pending.get(requestKey);
    if (running) return running;
    const request = fetchRemotePayload(path, basDd, state);
    pending.set(requestKey, request);
    try {
      return await request;
    } finally {
      pending.delete(requestKey);
    }
  }

  async function fetchRemotePayload(path: string, basDd: string, state: ProviderSourceState): Promise<unknown> {
    const permit = authorizeSource(path, basDd, state);
    if (config === null) throw new KrxNotConfiguredError();
    const today = currentDate();
    ensureApprovalIsValid(today);
    if (quotaWasExceeded(path)) throw new KrxQuotaError();
    let payload: unknown;
    try {
      payload = await client.request<unknown>(
        "default",
        `${path}?basDd=${basDd}`,
        {
          method: "GET",
          headers: { AUTH_KEY: configured.apiKey },
        },
        {
          // 재시도도 공급자 입장에서는 별도 HTTP 요청이다. 실제 attempt 직전에 기록해야
          // 429/5xx 재시도가 오늘 예산에서 사라지지 않는다.
          beforeAttempt: () => {
            ensureApprovalIsValid(currentDate());
            if (quotaWasExceeded(path)) throw new KrxQuotaError();
            options.beforeSourceFetch?.({ namespace, endpoint: path, basDd });
            permit?.beforeAttempt();
            recordCall(currentDate(), path);
          },
        },
      );
    } catch (error) {
      if (isBlockedError(error)) throw error;
      const message = readCaughtErrorMessage(error);

      // RestClient가 구조화된 HTTP 오류를 아직 제공하지 않아 상태 코드를 메시지로 구분한다.
      if (message?.startsWith("REST 요청 실패: 429")) {
        const quotaError = new KrxQuotaError();
        reportQuotaExceeded(path, quotaError);
        throw quotaError;
      }
      if (message !== null) {
        // 실패 본문과 외부 오류 메타데이터에 인증키가 있을 수 있어 안전한 메시지만 새 오류로 옮긴다.
        const sanitizedMessage =
          configured.apiKey === ""
            ? message
            : message.replaceAll(configured.apiKey, "[REDACTED]");
        // 원본 cause와 custom 필드를 연결하면 인증키가 다시 노출될 수 있다.
        // eslint-disable-next-line preserve-caught-error
        throw new Error(sanitizedMessage);
      }

      // 분류할 수 없는 외부 값은 직렬화하거나 원본을 보존하지 않는다.
      // eslint-disable-next-line preserve-caught-error
      throw new Error(SAFE_REQUEST_ERROR_MESSAGE);
    }

    // 파싱과 정규화 실패 이전에 미사용 필드를 포함한 전체 응답을 보존한다.
    const fetchedAtMs = clock.now();
    options.rawSnapshotStore?.put({ namespace, endpoint: path, basDd }, payload, fetchedAtMs);
    // HTTP 200이어도 오류 봉투는 수집 완료로 인증하지 않는다.
    parseKrxEnvelope(payload);
    // 계획의 물리 수집 권한을 소비한 뒤 빈 응답의 게시 확정 여부는 별도로 판정한다.
    permit?.complete();
    const pendingState = pendingEmptyState(path, basDd, payload, fetchedAtMs);
    if (pendingState) {
      const nextPermit = authorizeSource(path, basDd, pendingState);
      throw new ProviderRequestBlockedError("PENDING_PUBLICATION", nextPermit?.fingerprint ?? JSON.stringify({ namespace, path, basDd }), pendingState.evidence);
    }
    return payload;
  }

  async function fetchRows<T>(
    market: KrxMarket,
    isoDate: string,
    path: string,
    parseRows: (rows: readonly Record<string, unknown>[]) => T[],
    requireExisting = false,
  ): Promise<readonly T[]> {
    const basDd = isoToBasDd(isoDate);
    const payload = await fetchPayload(path, basDd, requireExisting);
    const rawRows = parseKrxEnvelope(payload);
    const rows: T[] = [];
    let firstContractError: KrxContractError | null = null;
    let invalidRows = 0;
    for (const rawRow of rawRows) {
      try {
        rows.push(...parseRows([rawRow]));
      } catch (error) {
        if (!(error instanceof KrxContractError)) throw error;
        firstContractError ??= error;
        invalidRows += 1;
      }
    }
    // 한두 종목의 행 훼손은 후속 종목 제외로 격리한다. 응답 전체를 해석할 수 없으면
    // 휴장/빈 응답과 구분할 수 없으므로 정상 coverage로 닫지 않는다.
    if (
      rawRows.length > 0 &&
      rows.length === 0 &&
      firstContractError !== null
    ) {
      throw firstContractError;
    }
    if (invalidRows > 0) {
      logger.warn(
        {
          module: "market-data",
          event: "krx.invalid-rows-skipped",
          market,
          basDd,
          path,
          invalidRows,
        },
        "KRX 응답의 계약 위반 종목 행을 건너뛴다",
      );
    }
    logger.info(
      {
        module: "market-data",
        event: "krx.fetch",
        market,
        basDd,
        rows: rows.length,
        callsToday: options.usage?.callsUsed("KRX", path) ?? callCounts.get(countKey(currentDate(), path)) ?? 0,
      },
      "krx fetch ok",
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
      requestOptions?: { readonly requireExisting?: boolean },
    ): Promise<readonly KrxDailyTradeRow[]> =>
      fetchRows(market, isoDate, PATHS[market].daily, parseDailyRows, requestOptions?.requireExisting),
    fetchBenchmarkClose: async (
      benchmarkId: KrxBenchmarkId,
      isoDate: string,
    ): Promise<number | null> => {
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
