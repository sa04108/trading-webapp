const PAGE_SIZE = 1_000;
const REQUEST_TIMEOUT_MS = 30_000;

export interface EcosDailyRate {
  date: string;
  annualRatePct: number;
}

function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function object(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export class EcosRateSource {
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: { apiKey: string; fetchImpl?: typeof fetch }) {
    if (!options.apiKey.trim()) throw new Error("ECOS API 키가 필요합니다");
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async fetchDailyRates(options: {
    statCode: string;
    itemCode: string;
    startDate: string;
    endDate: string;
    signal?: AbortSignal;
  }): Promise<EcosDailyRate[]> {
    const { statCode, itemCode, startDate, endDate, signal } = options;
    if (!/^[a-zA-Z0-9_-]+$/.test(statCode) || !/^[a-zA-Z0-9_-]+$/.test(itemCode) ||
      !validDate(startDate) || !validDate(endDate) || startDate > endDate) {
      throw new Error("ECOS 조회 조건이 올바르지 않습니다");
    }
    const maxDays = (Date.parse(`${endDate}T00:00:00Z`) - Date.parse(`${startDate}T00:00:00Z`)) / 86_400_000 + 1;
    const rates: EcosDailyRate[] = [];
    const seen = new Set<string>();
    let expectedTotal: number | undefined;
    for (let first = 1; expectedTotal === undefined || first <= expectedTotal; first += PAGE_SIZE) {
      const url = `https://ecos.bok.or.kr/api/StatisticSearch/${encodeURIComponent(this.apiKey)}/json/kr/${first}/${first + PAGE_SIZE - 1}/${encodeURIComponent(statCode)}/D/${startDate.replaceAll("-", "")}/${endDate.replaceAll("-", "")}/${encodeURIComponent(itemCode)}`;
      let payload: unknown;
      try {
        const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
        const response = await this.fetchImpl(url, { signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
        if (!response.ok) throw new Error();
        payload = await response.json();
      } catch {
        // 요청 URL과 공급자 오류 원문에는 인증키가 포함될 수 있다.
        throw new Error("ECOS 금리 조회에 실패했습니다");
      }
      const body = object(payload);
      const result = object(body?.StatisticSearch);
      if (body?.RESULT || result?.RESULT || !result) throw new Error("ECOS 금리 응답 오류");
      const total = result.list_total_count;
      const rows = result.row;
      if (typeof total !== "number" || !Number.isSafeInteger(total) || total < 1 || total > maxDays ||
        (expectedTotal !== undefined && total !== expectedTotal) || !Array.isArray(rows) ||
        rows.length !== Math.min(PAGE_SIZE, total - first + 1)) {
        throw new Error("ECOS 금리 응답이 완전하지 않습니다");
      }
      expectedTotal = total;
      for (const raw of rows) {
        const row = object(raw);
        const time = row?.TIME;
        const rawValue = row?.DATA_VALUE;
        if (row?.STAT_CODE !== statCode || row.ITEM_CODE1 !== itemCode || typeof time !== "string" || !/^\d{8}$/.test(time) ||
          (typeof rawValue !== "string" && typeof rawValue !== "number") ||
          (typeof rawValue === "string" && !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(rawValue.trim()))) {
          throw new Error("ECOS 금리 데이터가 올바르지 않습니다");
        }
        const date = `${time.slice(0, 4)}-${time.slice(4, 6)}-${time.slice(6, 8)}`;
        const annualRatePct = Number(rawValue);
        if (!validDate(date) || date < startDate || date > endDate || seen.has(date) ||
          !Number.isFinite(annualRatePct) || annualRatePct < -100 || annualRatePct > 100) {
          throw new Error("ECOS 금리 데이터가 올바르지 않습니다");
        }
        seen.add(date);
        rates.push({ date, annualRatePct });
      }
    }
    return rates.sort((a, b) => a.date.localeCompare(b.date));
  }
}
