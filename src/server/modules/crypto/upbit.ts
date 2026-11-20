import type { CryptoDailyBar } from "../../../shared/crypto-backtest.js";

const BASE_URL = "https://api.upbit.com/v1";
const DAY_MS = 86_400_000;
const REQUEST_INTERVAL_MS = 150;
const MAX_MARKETS = 500;
const MAX_DAYS = 36_525;
let nextRequestAt = 0;
let pacingQueue: Promise<void> = Promise.resolve();

function abortError(signal?: AbortSignal): void {
  signal?.throwIfAborted();
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  abortError(signal);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function pace(signal?: AbortSignal): Promise<void> {
  const turn = pacingQueue.then(async () => {
    abortError(signal);
    const delay = Math.max(0, nextRequestAt - Date.now());
    if (delay) await wait(delay, signal);
    abortError(signal);
    nextRequestAt = Date.now() + REQUEST_INTERVAL_MS;
  });
  pacingQueue = turn.catch(() => {});
  if (!signal) return turn;
  abortError(signal);
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    turn.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

async function getJson(path: string, signal?: AbortSignal): Promise<unknown> {
  for (let attempt = 0; attempt < 3; attempt++) {
    await pace(signal);
    try {
      const requestSignal = signal
        ? AbortSignal.any([signal, AbortSignal.timeout(15_000)])
        : AbortSignal.timeout(15_000);
      const response = await fetch(`${BASE_URL}${path}`, { signal: requestSignal });
      if (response.ok) return await response.json();
      if (response.status !== 429 && response.status < 500) {
        throw new Error(`업비트 요청 실패: HTTP ${response.status}`);
      }
      if (attempt === 2) throw new Error(`업비트 요청 재시도 실패: HTTP ${response.status}`);
    } catch (error) {
      abortError(signal);
      if (error instanceof Error && error.message.startsWith("업비트 요청")) throw error;
      if (attempt === 2) throw new Error("업비트 요청 재시도 실패", { cause: error });
    }
    await wait(500 * 2 ** attempt, signal);
  }
  throw new Error("업비트 요청 실패");
}

function parseDate(value: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`유효하지 않은 UTC 날짜: ${value}`);
  const time = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== value) {
    throw new Error(`유효하지 않은 UTC 날짜: ${value}`);
  }
  return time;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function listUpbitKrwMarkets(): Promise<{ market: string; name: string }[]> {
  const data = await getJson("/market/all?is_details=false");
  if (!Array.isArray(data)) throw new Error("업비트 마켓 응답이 올바르지 않습니다");
  const result: { market: string; name: string }[] = [];
  for (const row of data) {
    if (!isRecord(row) || typeof row.market !== "string")
      throw new Error("업비트 마켓 응답이 올바르지 않습니다");
    if (!row.market.startsWith("KRW-")) continue;
    if (!/^KRW-[A-Z0-9]+$/.test(row.market) || typeof row.korean_name !== "string" || !row.korean_name) {
      throw new Error("업비트 마켓 응답이 올바르지 않습니다");
    }
    result.push({ market: row.market, name: row.korean_name });
  }
  return result;
}

export async function fetchUpbitDailyBars(
  markets: string[],
  fromDate: string,
  toDate: string,
  signal?: AbortSignal,
): Promise<CryptoDailyBar[]> {
  const from = parseDate(fromDate);
  const to = parseDate(toDate);
  if (from > to || (to - from) / DAY_MS + 1 > MAX_DAYS)
    throw new Error("업비트 조회 기간이 올바르지 않습니다");
  if (
    markets.length > MAX_MARKETS ||
    markets.some((market) => !/^KRW-[A-Z0-9]+$/.test(market)) ||
    new Set(markets).size !== markets.length
  ) {
    throw new Error("업비트 마켓 목록이 올바르지 않습니다");
  }
  abortError(signal);
  const end = Math.min(to + DAY_MS, Math.floor(Date.now() / DAY_MS) * DAY_MS);
  if (end <= from) return [];
  const bars: CryptoDailyBar[] = [];
  for (const market of markets) {
    let cursor = end;
    while (cursor > from) {
      const query = new URLSearchParams({ market, to: new Date(cursor).toISOString(), count: "200" });
      const data = await getJson(`/candles/days?${query}`, signal);
      if (!Array.isArray(data) || data.length > 200) throw new Error("업비트 일봉 응답이 올바르지 않습니다");
      if (data.length === 0) break;
      let previous = cursor;
      for (const row of data) {
        if (!isRecord(row) || row.market !== market || typeof row.candle_date_time_utc !== "string")
          throw new Error("업비트 일봉 응답이 올바르지 않습니다");
        const stamp = row.candle_date_time_utc;
        if (!/^\d{4}-\d{2}-\d{2}T00:00:00$/.test(stamp))
          throw new Error("업비트 일봉 날짜가 올바르지 않습니다");
        const date = stamp.slice(0, 10);
        const time = parseDate(date);
        if (time >= previous) throw new Error("업비트 일봉 순서가 올바르지 않습니다");
        previous = time;
        const values = [
          row.opening_price,
          row.high_price,
          row.low_price,
          row.trade_price,
          row.candle_acc_trade_price,
        ];
        if (values.some((value) => typeof value !== "number" || !Number.isFinite(value) || value < 0))
          throw new Error("업비트 일봉 값이 올바르지 않습니다");
        const [open, high, low, close, turnover] = values as [number, number, number, number, number];
        if (
          open <= 0 ||
          low <= 0 ||
          close <= 0 ||
          high < Math.max(open, low, close) ||
          low > Math.min(open, close)
        )
          throw new Error("업비트 일봉 값이 올바르지 않습니다");
        if (time >= from) bars.push({ market, date, open, high, low, close, turnover });
      }
      cursor = previous;
      if (data.length < 200) break;
    }
  }
  return bars.sort((a, b) => a.market.localeCompare(b.market) || a.date.localeCompare(b.date));
}

export async function fetchUpbitQuotes(
  markets: string[],
  signal?: AbortSignal,
): Promise<Map<string, { price: number; atMs: number }>> {
  const prices = new Map<string, { price: number; atMs: number }>();
  if (markets.length === 0) return prices;
  if (markets.some((m) => !/^KRW-[A-Z0-9]+$/.test(m))) throw new Error("원화 마켓 코드가 올바르지 않습니다.");
  for (let i = 0; i < markets.length; i += 80) {
    const batch = markets.slice(i, i + 80);
    const data = await getJson(`/ticker?${new URLSearchParams({ markets: batch.join(",") })}`, signal);
    if (!Array.isArray(data)) throw new Error("업비트 현재가 응답이 올바르지 않습니다.");
    for (const row of data) {
      if (
        !isRecord(row) ||
        typeof row.market !== "string" ||
        !batch.includes(row.market) ||
        prices.has(row.market) ||
        typeof row.trade_price !== "number" ||
        !Number.isFinite(row.trade_price) ||
        row.trade_price <= 0 ||
        typeof row.trade_timestamp !== "number" ||
        !Number.isSafeInteger(row.trade_timestamp) ||
        row.trade_timestamp <= 0
      )
        throw new Error("업비트 현재가 또는 체결 시각이 올바르지 않습니다.");
      prices.set(row.market, { price: row.trade_price, atMs: row.trade_timestamp });
    }
  }
  return prices;
}
