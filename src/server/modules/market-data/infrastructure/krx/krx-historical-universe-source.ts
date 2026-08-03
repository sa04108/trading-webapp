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

const SAFE_REQUEST_ERROR_MESSAGE = 'KRX Open API 요청에 실패했습니다.';
const MAX_CREDENTIAL_SCAN_DEPTH = 20;
const NATIVE_ERROR_STACK_DESCRIPTOR = Object.getOwnPropertyDescriptor(new Error(), 'stack');

interface DataPropertyRead {
  readonly safe: boolean;
  readonly value?: unknown;
}

function isObjectLike(value: unknown): value is object {
  return (typeof value === 'object' && value !== null) || typeof value === 'function';
}

/** 런타임이 만든 lazy stack accessor인지 함수 정체성으로 확인한다. */
function isNativeErrorStackAccessor(
  owner: object,
  key: PropertyKey,
  descriptor: PropertyDescriptor,
): boolean {
  return (
    owner instanceof Error &&
    key === 'stack' &&
    !('value' in descriptor) &&
    NATIVE_ERROR_STACK_DESCRIPTOR !== undefined &&
    !('value' in NATIVE_ERROR_STACK_DESCRIPTOR) &&
    descriptor.get === NATIVE_ERROR_STACK_DESCRIPTOR.get &&
    descriptor.set === NATIVE_ERROR_STACK_DESCRIPTOR.set
  );
}

/** getter를 실행하거나 값을 직렬화하지 않고 own data 안의 인증키를 찾는다. */
function containsCredential(
  value: unknown,
  credential: string,
  seen: Set<object> = new Set<object>(),
  depth = 0,
): boolean {
  if (credential === '') return false;
  if (typeof value === 'string') return value.includes(credential);
  if (!isObjectLike(value)) return false;
  if (seen.has(value)) return false;
  if (depth >= MAX_CREDENTIAL_SCAN_DEPTH) return true;
  seen.add(value);

  let descriptors: PropertyDescriptorMap;
  try {
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    return true;
  }

  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key === 'string' && key.includes(credential)) return true;
    const descriptor = Object.getOwnPropertyDescriptor(descriptors, key)?.value as
      | PropertyDescriptor
      | undefined;
    if (!descriptor) return true;
    if (!('value' in descriptor)) {
      if (isNativeErrorStackAccessor(value, key, descriptor)) continue;
      return true;
    }
    if (containsCredential(descriptor.value, credential, seen, depth + 1)) return true;
  }
  return false;
}

/** 임의 getter는 실행하지 않고 검증한 native stack과 data 값만 읽는다. */
function readDataProperty(value: object, key: PropertyKey): DataPropertyRead {
  const seen = new Set<object>();
  let current: object | null = value;
  let depth = 0;

  while (current !== null && depth < MAX_CREDENTIAL_SCAN_DEPTH) {
    if (seen.has(current)) return { safe: false };
    seen.add(current);
    try {
      const descriptor = Object.getOwnPropertyDescriptor(current, key);
      if (descriptor) {
        if ('value' in descriptor) return { safe: true, value: descriptor.value };
        if (!isNativeErrorStackAccessor(current, key, descriptor)) return { safe: false };
        if (!descriptor.get) return { safe: true };
        try {
          return { safe: true, value: Reflect.apply(descriptor.get, current, []) };
        } catch {
          return { safe: false };
        }
      }
      current = Object.getPrototypeOf(current) as object | null;
    } catch {
      return { safe: false };
    }
    depth += 1;
  }

  return current === null ? { safe: true } : { safe: false };
}

function errorContainsCredential(error: Error, credential: string): boolean {
  if (containsCredential(error, credential)) return true;
  for (const key of ['name', 'message', 'stack'] as const) {
    const property = readDataProperty(error, key);
    if (!property.safe || containsCredential(property.value, credential)) return true;
  }
  return false;
}

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
      if (error instanceof Error) {
        const message = readDataProperty(error, 'message');
        const messageText = message.safe && typeof message.value === 'string' ? message.value : null;

        // RestClient가 구조화된 HTTP 오류를 아직 제공하지 않아 상태 코드를 메시지로 구분한다.
        if (messageText?.startsWith('REST 요청 실패: 429')) {
          throw new KrxQuotaError();
        }
        // logger가 cause와 custom 필드도 직렬화할 수 있어 인증키가 있으면 원본을 보존하지 않는다.
        if (errorContainsCredential(error, configured.apiKey)) {
          const sanitizedMessage =
            messageText === null
              ? SAFE_REQUEST_ERROR_MESSAGE
              : messageText.replaceAll(configured.apiKey, '[REDACTED]');
          // 원본 cause와 custom 필드에 인증키가 있을 수 있어 의도적으로 연결하지 않는다.
          // eslint-disable-next-line preserve-caught-error
          throw new Error(sanitizedMessage);
        }
        throw error;
      }

      // 원문을 cause로 보존하면 임의 객체 안의 인증키가 다시 노출되므로 의도적으로 연결하지 않는다.
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
    todayCallCount,
  };
}
