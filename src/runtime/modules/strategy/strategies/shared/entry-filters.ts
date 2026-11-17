import { z } from "zod";

export const entryFilterParameters = {
  trendSmaBars: z.number().int().refine((n) => n === 0 || (n >= 2 && n <= 400)).default(200).meta({ title: "추세 이동평균 봉 수", description: "종가가 이 단순이동평균 위일 때 진입합니다. 0이면 필터를 끕니다." }),
  liquidityLookbackBars: z.number().int().min(2).max(400).default(20).meta({ title: "유동성 계산 봉 수", description: "추정 거래대금을 평균낼 봉 수입니다." }),
  minAverageTradingValueKrw: z.number().min(0).default(100_000_000).meta({ title: "최소 평균 추정 거래대금 (원)", description: "종가 × 거래량으로 추정한 거래대금의 평균 하한입니다. 0이면 필터를 끕니다." }),
  cooldownBars: z.number().int().min(0).max(400).default(5).meta({ title: "청산 후 대기 봉 수", description: "실제 포지션 청산 확인 후 재진입을 기다리는 봉 수입니다." }),
};
export interface EntryFilterState { closes: number[]; closeSum: number; turnovers: Array<number | null>; turnoverSum: number; missing: number; wasHeld: boolean; cooldown: number }
export function newEntryFilter(): EntryFilterState { return { closes: [], closeSum: 0, turnovers: [], turnoverSum: 0, missing: 0, wasHeld: false, cooldown: 0 }; }
export function updateEntryFilter(s: EntryFilterState, close: number, volume: number | null, held: boolean, p: { trendSmaBars: number; liquidityLookbackBars: number; cooldownBars: number }): void {
  if (p.trendSmaBars > 0) {
    s.closes.push(close); s.closeSum += close;
    if (s.closes.length > p.trendSmaBars) s.closeSum -= s.closes.shift()!;
  }
  const turnover = volume !== null && Number.isFinite(volume) && volume >= 0 ? close * volume : null;
  s.turnovers.push(turnover); if (turnover === null) s.missing++; else s.turnoverSum += turnover;
  if (s.turnovers.length > p.liquidityLookbackBars) { const old = s.turnovers.shift()!; if (old === null) s.missing--; else s.turnoverSum -= old; }
  if (s.wasHeld && !held) s.cooldown = p.cooldownBars > 0 ? p.cooldownBars + 1 : 0;
  else if (!held && s.cooldown > 0) s.cooldown--;
  s.wasHeld = held;
}
export function entryAllowed(s: EntryFilterState, close: number, p: { trendSmaBars: number; liquidityLookbackBars: number; minAverageTradingValueKrw: number }): boolean {
  return s.cooldown === 0 && (p.trendSmaBars === 0 || (s.closes.length === p.trendSmaBars && close > s.closeSum / p.trendSmaBars)) && (p.minAverageTradingValueKrw === 0 || (s.turnovers.length === p.liquidityLookbackBars && s.missing === 0 && s.turnoverSum / p.liquidityLookbackBars >= p.minAverageTradingValueKrw));
}
export function scaleEntryFilter(s: EntryFilterState, ratio: number): void { s.closes = s.closes.map((v) => v / ratio); s.closeSum /= ratio; }
