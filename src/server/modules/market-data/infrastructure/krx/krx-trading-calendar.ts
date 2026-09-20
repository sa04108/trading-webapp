import { createHash } from "node:crypto";
import type { KrxMarket } from "../../../../../runtime/modules/market-data/domain/krx-universe-types.js";
import { krxOfficialCalendarSeed as seed } from "./krx-official-calendar-seed.js";

export interface KrxTradingCalendarEvidence {
  readonly state: "OPEN" | "CLOSED" | "UNKNOWN";
  readonly evidence: string;
}

export interface KrxTradingCalendar {
  classify(isoDate: string, market: KrxMarket): KrxTradingCalendarEvidence;
}

/** 공식 연별 휴장일 원문이 있는 연도만 판정한다. 목록 밖 연도를 평일만 보고 개장으로 추측하지 않는다. */
export function createOfficialKrxTradingCalendar(): KrxTradingCalendar {
  const years = new Map<string, { closed: Set<string>; hash: string }>();
  for (const [year, saved] of Object.entries(seed.years)) {
    if (createHash("sha256").update(saved.responseJson).digest("hex") !== saved.responseSha256)
      throw new Error(`KRX 공식 달력 원문 해시 검증 실패: ${year}`);
    const payload: unknown = JSON.parse(saved.responseJson);
    if (typeof payload !== "object" || payload === null || !("block1" in payload) || !Array.isArray(payload.block1))
      throw new Error(`KRX 공식 달력 응답 형식 오류: ${year}`);
    const closed = new Set<string>();
    for (const row of payload.block1 as Record<string, unknown>[]) {
      if (typeof row.calnd_dd !== "string" || !row.calnd_dd.startsWith(`${year}-`))
        throw new Error(`KRX 공식 달력 날짜 오류: ${year}`);
      closed.add(row.calnd_dd);
    }
    years.set(year, { closed, hash: saved.responseSha256 });
  }
  return {
    classify(isoDate) {
      const year = years.get(isoDate.slice(0, 4));
      if (!year) return { state: "UNKNOWN", evidence: `공식 달력 미확보:${isoDate};${seed.sourceUrl}` };
      const day = new Date(`${isoDate}T00:00:00Z`).getUTCDay();
      const closed = day === 0 || day === 6 || year.closed.has(isoDate);
      return {
        state: closed ? "CLOSED" : "OPEN",
        evidence: `${seed.sourceUrl};year=${isoDate.slice(0, 4)};sha256=${year.hash};retrieved=${seed.retrievedAt};rules=${seed.rulesUrl}`,
      };
    },
  };
}
