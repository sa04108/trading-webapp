import { describe, expect, it } from 'vitest';
import {
  KrxApprovalExpiredError,
  KrxContractError,
  KrxNotConfiguredError,
  KrxQuotaError,
} from '../../src/server/modules/market-data/application/ports.js';
import { createKrxHistoricalUniverseSource } from '../../src/server/modules/market-data/infrastructure/krx/krx-historical-universe-source.js';
import type { Clock } from '../../src/server/shared/clock.js';
import type { Logger } from '../../src/server/shared/logger.js';
import {
  baseInfoFixture,
  dailyFixture,
  krxEnvelope,
  krxJsonResponse,
} from '../helpers/krx-fixtures.js';

const API_KEY = 'SECRET_KRX_KEY_123';
const BASE_URL = 'https://krx.test';
const NOOP_SLEEP = async () => undefined;

interface FetchCall {
  readonly url: string;
  readonly init: RequestInit | undefined;
}

function fixedClock(isoInstant = '2026-08-02T15:00:00.000Z'): Clock {
  return { now: () => Date.parse(isoInstant) };
}

function mutableClock(isoInstant: string): Clock & { set(isoInstant: string): void } {
  let now = Date.parse(isoInstant);
  return {
    now: () => now,
    set: (next) => {
      now = Date.parse(next);
    },
  };
}

function createCapturingLogger(): {
  readonly logger: Logger;
  readonly calls: Array<{ level: string; args: unknown[] }>;
  readonly lines: string[];
} {
  const calls: Array<{ level: string; args: unknown[] }> = [];
  const lines: string[] = [];
  const capture = (level: string) => (...args: unknown[]) => {
    calls.push({ level, args });
    lines.push(JSON.stringify(args));
  };
  return {
    logger: {
      debug: capture('debug'),
      info: capture('info'),
      warn: capture('warn'),
      error: capture('error'),
    } as unknown as Logger,
    calls,
    lines,
  };
}

function createFetch(
  responder: (call: FetchCall, index: number) => Response | Promise<Response>,
): { readonly fetchImpl: typeof fetch; readonly calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const call = { url: String(input), init };
    calls.push(call);
    return responder(call, calls.length - 1);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function createConfiguredSource(options: {
  readonly clock?: Clock;
  readonly approvalExpiry?: string | null;
  readonly fetchImpl: typeof fetch;
  readonly logger?: Logger;
}) {
  return createKrxHistoricalUniverseSource(
    {
      baseUrl: BASE_URL,
      apiKey: API_KEY,
      approvalExpiry: options.approvalExpiry ?? null,
    },
    options.clock ?? fixedClock(),
    options.logger ?? createCapturingLogger().logger,
    { fetchImpl: options.fetchImpl, sleep: NOOP_SLEEP },
  );
}

async function captureFetchRejection(thrown: unknown): Promise<{
  readonly rejection: unknown;
  readonly loggerLines: string[];
}> {
  const captured = createCapturingLogger();
  const { fetchImpl } = createFetch(() => {
    throw thrown;
  });
  const source = createConfiguredSource({ fetchImpl, logger: captured.logger });

  try {
    await source.fetchDailyTrades('KOSPI', '2026-08-01');
  } catch (error) {
    return { rejection: error, loggerLines: captured.lines };
  }
  throw new Error('오류가 전파되지 않았습니다.');
}

function expectGenericSafeError(rejection: unknown, loggerLines: readonly string[]): Error {
  expect(rejection).toBeInstanceOf(Error);
  const error = rejection as Error;
  expect(error.message).toBe('KRX Open API 요청에 실패했습니다.');
  expect([error.name, error.message, error.stack].join('\n')).not.toContain(API_KEY);
  expect(JSON.stringify(error)).not.toContain(API_KEY);
  expect(loggerLines.join('\n')).not.toContain(API_KEY);
  return error;
}

function expectDetachedSafeError(
  rejection: unknown,
  original: Error,
  loggerLines: readonly string[],
): Error {
  expect(rejection).toBeInstanceOf(Error);
  const error = rejection as Error;
  expect(error === original).toBe(false);
  expect(error.message).toBe('safe message');
  expect([error.name, error.message, error.stack].join('\n')).not.toContain(API_KEY);
  expect(JSON.stringify(error)).not.toContain(API_KEY);
  expect(loggerLines.join('\n')).not.toContain(API_KEY);
  return error;
}

describe('KRX 과거 유니버스 어댑터', () => {
  it('설정이 없으면 두 조회가 미설정 오류를 던지고 HTTP를 호출하지 않는다', async () => {
    const { fetchImpl, calls } = createFetch(() => krxJsonResponse(krxEnvelope([])));
    const source = createKrxHistoricalUniverseSource(null, fixedClock(), createCapturingLogger().logger, {
      fetchImpl,
    });

    await expect(source.fetchIssueBaseInfo('KOSPI', '2026-08-01')).rejects.toBeInstanceOf(
      KrxNotConfiguredError,
    );
    await expect(source.fetchDailyTrades('KOSDAQ', '2026-08-01')).rejects.toBeInstanceOf(
      KrxNotConfiguredError,
    );
    expect(calls).toHaveLength(0);
    expect(source.todayCallCount()).toBe(0);
  });

  it('승인이 지난 뒤에는 HTTP·카운터·성공 로그를 남기지 않는다', async () => {
    const { fetchImpl, calls } = createFetch(() => krxJsonResponse(krxEnvelope([])));
    const captured = createCapturingLogger();
    const source = createConfiguredSource({
      approvalExpiry: '2026-08-01',
      clock: fixedClock('2026-08-02T15:00:00.000Z'),
      fetchImpl,
      logger: captured.logger,
    });

    await expect(source.fetchDailyTrades('KOSPI', '2026-08-01')).rejects.toBeInstanceOf(
      KrxApprovalExpiredError,
    );
    expect(calls).toHaveLength(0);
    expect(source.todayCallCount()).toBe(0);
    expect(captured.calls.filter(({ args }) => args[0] && (args[0] as { event?: string }).event === 'krx.fetch')).toHaveLength(0);
  });

  it('승인 만료일 당일은 조회할 수 있다', async () => {
    const { fetchImpl, calls } = createFetch(() => krxJsonResponse(krxEnvelope([])));
    const source = createConfiguredSource({
      approvalExpiry: '2026-08-03',
      clock: fixedClock('2026-08-03T05:00:00.000Z'),
      fetchImpl,
    });

    await expect(source.fetchIssueBaseInfo('KOSPI', '2026-08-01')).resolves.toEqual([]);
    expect(calls).toHaveLength(1);
  });

  it('API 키는 AUTH_KEY 헤더로만 보내고 URL과 로그에 남기지 않는다', async () => {
    const captured = createCapturingLogger();
    const { fetchImpl, calls } = createFetch(() =>
      krxJsonResponse(krxEnvelope([baseInfoFixture()])),
    );
    const source = createConfiguredSource({ fetchImpl, logger: captured.logger });

    await source.fetchIssueBaseInfo('KOSPI', '2026-08-01');

    const call = calls[0]!;
    const headers = call.init?.headers as Record<string, string>;
    expect(headers).toEqual({ AUTH_KEY: API_KEY });
    expect(headers).not.toHaveProperty('authorization');
    expect(call.url).toBe(`${BASE_URL}/svc/apis/sto/stk_isu_base_info?basDd=20260801`);
    expect(call.url).not.toContain(API_KEY);
    expect(captured.lines.join('\n')).not.toContain(API_KEY);
  });

  it('시장별 기본정보·일별 경로와 basDd를 정확히 만든다', async () => {
    const { fetchImpl, calls } = createFetch(() => krxJsonResponse(krxEnvelope([])));
    const source = createConfiguredSource({ fetchImpl });

    await source.fetchIssueBaseInfo('KOSPI', '2026-01-02');
    await source.fetchDailyTrades('KOSPI', '2026-01-03');
    await source.fetchIssueBaseInfo('KOSDAQ', '2026-01-04');
    await source.fetchDailyTrades('KOSDAQ', '2026-01-05');

    expect(calls.map(({ url }) => url)).toEqual([
      `${BASE_URL}/svc/apis/sto/stk_isu_base_info?basDd=20260102`,
      `${BASE_URL}/svc/apis/sto/stk_bydd_trd?basDd=20260103`,
      `${BASE_URL}/svc/apis/sto/ksq_isu_base_info?basDd=20260104`,
      `${BASE_URL}/svc/apis/sto/ksq_bydd_trd?basDd=20260105`,
    ]);
    expect(calls.every(({ init }) => init?.method === 'GET')).toBe(true);
  });

  it('정상 기본정보와 일별 응답을 포트 행으로 바꾼다', async () => {
    const { fetchImpl } = createFetch((_call, index) =>
      krxJsonResponse(
        krxEnvelope(
          index === 0
            ? [baseInfoFixture({ ISU_CD: 'KR7005930003', ISU_SRT_CD: '005930' })]
            : [dailyFixture({ ISU_CD: '005930', MKTCAP: '350,000,000,000,001' })],
        ),
      ),
    );
    const source = createConfiguredSource({ fetchImpl });

    const baseRows = await source.fetchIssueBaseInfo('KOSPI', '2026-08-01');
    const dailyRows = await source.fetchDailyTrades('KOSPI', '2026-08-01');

    expect(baseRows[0]).toMatchObject({
      standardCode: 'KR7005930003',
      shortCode: '005930',
      listedDate: '1975-06-11',
    });
    expect(dailyRows[0]).toEqual({
      shortCode: '005930',
      name: '삼성전자',
      marketCapRaw: '350000000000001',
    });
  });

  it.each([
    ['OutBlock_1 누락', { resultCode: 'SUCCESS' }],
    ['OutBlock_1 형식 오류', { OutBlock_1: {} }],
    ['기본정보 행 오류', krxEnvelope([{ ISU_SRT_CD: '005930' }])],
  ])('%s 응답은 계약 오류다', async (_name, payload) => {
    const { fetchImpl } = createFetch(() => krxJsonResponse(payload));
    const source = createConfiguredSource({ fetchImpl });

    await expect(source.fetchIssueBaseInfo('KOSPI', '2026-08-01')).rejects.toBeInstanceOf(
      KrxContractError,
    );
  });

  it('일별 행 형식이 잘못되면 계약 오류다', async () => {
    const { fetchImpl } = createFetch(() =>
      krxJsonResponse(krxEnvelope([dailyFixture({ MKTCAP: 'not-an-integer' })])),
    );
    const source = createConfiguredSource({ fetchImpl });

    await expect(source.fetchDailyTrades('KOSDAQ', '2026-08-01')).rejects.toBeInstanceOf(
      KrxContractError,
    );
  });

  it('429 재시도를 모두 소진하면 quota 오류로 바꾸고 논리 호출은 한 번만 센다', async () => {
    const captured = createCapturingLogger();
    const { fetchImpl, calls } = createFetch(() =>
      krxJsonResponse({ message: `server did not echo ${API_KEY}` }, 429),
    );
    const source = createConfiguredSource({ fetchImpl, logger: captured.logger });

    let rejection: unknown;
    try {
      await source.fetchDailyTrades('KOSPI', '2026-08-01');
    } catch (error) {
      rejection = error;
    }

    expect(rejection).toBeInstanceOf(KrxQuotaError);
    expect((rejection as Error).message).not.toContain(API_KEY);
    expect(calls).toHaveLength(5);
    expect(source.todayCallCount()).toBe(1);
    expect(captured.lines.join('\n')).not.toContain(API_KEY);
  });

  it('429가 아닌 REST 오류는 quota로 분류하지 않고 반사된 API 키를 가린다', async () => {
    const captured = createCapturingLogger();
    const { fetchImpl } = createFetch(() =>
      krxJsonResponse({ message: `reflected ${API_KEY} and ${API_KEY}` }, 400),
    );
    const source = createConfiguredSource({ fetchImpl, logger: captured.logger });

    let rejection: unknown;
    try {
      await source.fetchDailyTrades('KOSPI', '2026-08-01');
    } catch (error) {
      rejection = error;
    }

    expect(rejection).toBeInstanceOf(Error);
    expect(rejection).not.toBeInstanceOf(KrxQuotaError);
    const error = rejection as Error;
    expect(JSON.stringify({ name: error.name, message: error.message, stack: error.stack })).not.toContain(
      API_KEY,
    );
    expect(error.message.match(/\[REDACTED\]/g)).toHaveLength(2);
    expect(captured.lines.join('\n')).not.toContain(API_KEY);
  });

  it('fetch가 API 키를 담은 문자열을 던지면 일반 안전 오류로 바꾼다', async () => {
    const captured = createCapturingLogger();
    const { fetchImpl } = createFetch(() => {
      throw `network failure ${API_KEY}`;
    });
    const source = createConfiguredSource({ fetchImpl, logger: captured.logger });

    let rejection: unknown;
    try {
      await source.fetchDailyTrades('KOSPI', '2026-08-01');
    } catch (error) {
      rejection = error;
    }

    expect(rejection).toBeInstanceOf(Error);
    expect((rejection as Error).message).toBe('KRX Open API 요청에 실패했습니다.');
    expect(JSON.stringify(rejection)).not.toContain(API_KEY);
    expect(captured.lines.join('\n')).not.toContain(API_KEY);
  });

  it('Error 이름에만 API 키가 있어도 새 안전 오류로 바꾼다', async () => {
    const thrown = new Error('safe message');
    thrown.name = `Network${API_KEY}Error`;

    const { rejection, loggerLines } = await captureFetchRejection(thrown);

    expectDetachedSafeError(rejection, thrown, loggerLines);
  });

  it('Error stack에만 API 키가 있어도 새 안전 오류로 바꾼다', async () => {
    const thrown = new Error('safe message');
    thrown.stack = `Error: safe message\nsecret frame ${API_KEY}`;

    const { rejection, loggerLines } = await captureFetchRejection(thrown);

    expectDetachedSafeError(rejection, thrown, loggerLines);
  });

  it('Error cause에 API 키가 있으면 cause를 남기지 않는다', async () => {
    const thrown = new Error('safe message', {
      cause: new Error(`nested ${API_KEY}`),
    });

    const { rejection, loggerLines } = await captureFetchRejection(thrown);

    const safe = expectDetachedSafeError(rejection, thrown, loggerLines);
    expect(Object.hasOwn(safe, 'cause')).toBe(false);
  });

  it('Error의 순환 중첩 own data에 API 키가 있으면 custom 필드를 복사하지 않는다', async () => {
    const details: unknown[] = [];
    details.push(details, { credentials: ['safe', API_KEY] });
    const thrown = Object.assign(new Error('safe message'), { details });

    const { rejection, loggerLines } = await captureFetchRejection(thrown);

    const safe = expectDetachedSafeError(rejection, thrown, loggerLines);
    expect(Object.hasOwn(safe, 'details')).toBe(false);
  });

  it('getPrototypeOf trap이 API 키를 던지는 Proxy Error는 일반 안전 오류로 바꾼다', async () => {
    const thrown = new Proxy(new Error('safe proxy message'), {
      getPrototypeOf: () => {
        throw new Error(`proxy trap ${API_KEY}`);
      },
    });

    const { rejection, loggerLines } = await captureFetchRejection(thrown);

    expectGenericSafeError(rejection, loggerLines);
  });

  it('API 키를 담은 Symbol own 필드가 있는 Error는 필드를 복사하지 않는다', async () => {
    const thrown = new Error('safe message');
    Object.defineProperty(thrown, Symbol(API_KEY), { value: 'safe', enumerable: true });

    const { rejection, loggerLines } = await captureFetchRejection(thrown);

    const safe = expectDetachedSafeError(rejection, thrown, loggerLines);
    expect(Object.getOwnPropertySymbols(safe)).toEqual([]);
  });

  it.each([
    ['객체', { nested: { credential: API_KEY } }],
    ['배열', ['safe', API_KEY]],
    ['문자열', 'safe primitive failure'],
  ])('비-Error %s를 던지면 내용과 무관하게 일반 안전 오류로 바꾼다', async (_name, thrown) => {
    const { rejection, loggerLines } = await captureFetchRejection(thrown);

    expectGenericSafeError(rejection, loggerLines);
  });

  it('API 키가 없는 Error도 안전한 메시지만 남긴 새 Error로 분리한다', async () => {
    const expected = new Error('network failure');
    const safeCycle: Record<string, unknown> = {};
    safeCycle.self = safeCycle;
    Object.assign(expected, {
      cause: new Error('safe cause'),
      details: ['safe', safeCycle],
    });

    const { rejection, loggerLines } = await captureFetchRejection(expected);

    expect(rejection).toBeInstanceOf(Error);
    const safe = rejection as Error;
    expect(safe === expected).toBe(false);
    expect(safe.name).toBe('Error');
    expect(safe.message).toBe('network failure');
    expect(safe.stack).not.toBe(expected.stack);
    expect(Object.hasOwn(safe, 'cause')).toBe(false);
    expect(Object.hasOwn(safe, 'details')).toBe(false);
    expect(loggerLines.join('\n')).not.toContain(API_KEY);
  });

  it('설정된 논리 호출을 KST 날짜별로 세고 성공 로그에 안전한 메타데이터만 남긴다', async () => {
    const captured = createCapturingLogger();
    const { fetchImpl } = createFetch(() =>
      krxJsonResponse(krxEnvelope([dailyFixture(), dailyFixture({ ISU_CD: '000660' })])),
    );
    const source = createConfiguredSource({ fetchImpl, logger: captured.logger });

    await source.fetchDailyTrades('KOSDAQ', '2026-08-01');
    await source.fetchDailyTrades('KOSDAQ', '2026-08-02');

    expect(source.todayCallCount()).toBe(2);
    const successLogs = captured.calls.filter(
      ({ level, args }) => level === 'info' && (args[0] as { event?: string }).event === 'krx.fetch',
    );
    expect(successLogs).toHaveLength(2);
    expect(successLogs[1]?.args).toEqual([
      {
        module: 'market-data',
        event: 'krx.fetch',
        market: 'KOSDAQ',
        basDd: '20260802',
        rows: 2,
        callsToday: 2,
      },
      'krx fetch ok',
    ]);
  });

  it('KST 날짜가 바뀌면 현재 카운터를 새 날짜로 초기화하고 오래된 키를 치운다', async () => {
    const clock = mutableClock('2026-08-03T14:59:59.000Z');
    const { fetchImpl } = createFetch(() => krxJsonResponse(krxEnvelope([])));
    const source = createConfiguredSource({ clock, fetchImpl });

    await source.fetchIssueBaseInfo('KOSPI', '2026-08-01');
    expect(source.todayCallCount()).toBe(1);

    clock.set('2026-08-03T15:00:00.000Z');
    expect(source.todayCallCount()).toBe(0);
    await source.fetchDailyTrades('KOSPI', '2026-08-01');
    expect(source.todayCallCount()).toBe(1);
  });

  it('계약 파싱 실패도 논리 호출을 소비하지만 성공 로그는 남기지 않는다', async () => {
    const captured = createCapturingLogger();
    const { fetchImpl } = createFetch(() => krxJsonResponse({ missing: 'OutBlock_1' }));
    const source = createConfiguredSource({ fetchImpl, logger: captured.logger });

    await expect(source.fetchIssueBaseInfo('KOSPI', '2026-08-01')).rejects.toBeInstanceOf(
      KrxContractError,
    );
    expect(source.todayCallCount()).toBe(1);
    expect(
      captured.calls.some(({ args }) => (args[0] as { event?: string }).event === 'krx.fetch'),
    ).toBe(false);
  });
});
