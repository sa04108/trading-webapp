import { createHash } from 'node:crypto';
import type { Logger } from '../../../shared/logger.js';
import type { SymbolMasterEntry } from '../../market-data/domain/symbol-master.js';
import type { SymbolMasterService } from '../../market-data/application/symbol-master-service.js';
import type { UniverseRule } from '../../../../shared/schemas/universe-rule.js';

export interface UniverseScheduleEntry {
  readonly rebalanceDate: string; // ISO
  readonly symbols: readonly string[]; // shortCode, 시총 내림차순 상위 N
}

export interface ResolvedUniverse {
  readonly schedule: readonly UniverseScheduleEntry[];
  readonly unionSymbols: readonly string[];
  readonly scheduleHash: string; // sha256(schedule 의 JSON 직렬화) — schedule 자체가 결정적이라 안정적이다
  readonly uncoveredDates: readonly string[]; // 마스터가 커버하지 않는 리밸런스 날짜
}

export interface UniverseRuleResolverDeps {
  readonly symbolMaster: SymbolMasterService;
  readonly logger: Logger;
}

/** 시총 내림차순 비교 — BigInt 차이를 Number 로 좁히면 큰 시총에서 오버플로가 나므로 부호만 본다 */
function compareMarketCapDesc(a: bigint, b: bigint): number {
  if (a === b) return 0;
  return a > b ? -1 : 1;
}

export class UniverseRuleResolver {
  constructor(private readonly deps: UniverseRuleResolverDeps) {}

  /**
   * 리밸런스 날짜별로 유니버스 규칙을 적용해 멤버십 일정을 만든다.
   *
   * 마스터가 커버하지 않는 날짜는 getMarketCapsAt 을 부르지 않고 바로 uncoveredDates 에
   * 담는다 — 커버 밖 날짜는 어차피 제출 검증이 거부하므로, 여기서 KRX 호출 예산을
   * 미리 쓰지 않는다.
   */
  async resolve(
    rule: UniverseRule,
    rebalanceDates: readonly string[],
  ): Promise<ResolvedUniverse> {
    const schedule: UniverseScheduleEntry[] = [];
    const uncoveredDates: string[] = [];
    const unionSymbols = new Set<string>();

    for (const date of rebalanceDates) {
      if (!this.deps.symbolMaster.isCovered(date)) {
        uncoveredDates.push(date);
        continue;
      }

      const universe = this.deps.symbolMaster.getUniverseAsOf(date);
      const candidates: SymbolMasterEntry[] = [];
      for (const entry of universe.values()) {
        if (entry.instrumentType === 'COMMON_STOCK' && rule.markets.includes(entry.market)) {
          candidates.push(entry);
        }
      }

      const marketCaps = await this.deps.symbolMaster.getMarketCapsAt(date);
      const ranked: { entry: SymbolMasterEntry; marketCap: bigint }[] = [];
      for (const entry of candidates) {
        const marketCapKrw = marketCaps.get(entry.standardCode);
        if (marketCapKrw === undefined) continue; // 시총 없는 종목은 순위에 넣지 않는다
        ranked.push({ entry, marketCap: BigInt(marketCapKrw) });
      }
      ranked.sort((a, b) => compareMarketCapDesc(a.marketCap, b.marketCap));

      const symbols = ranked.slice(0, rule.topN).map(({ entry }) => entry.shortCode);
      for (const shortCode of symbols) unionSymbols.add(shortCode);
      schedule.push({ rebalanceDate: date, symbols });
    }

    const scheduleHash = createHash('sha256').update(JSON.stringify(schedule)).digest('hex');

    return {
      schedule,
      unionSymbols: [...unionSymbols].sort(),
      scheduleHash,
      uncoveredDates,
    };
  }
}

/** 대상 월의 마지막 일 — 1-indexed month(1~12) */
function lastDayOfMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * `iso` 에 `months` 개월을 더하되 일자는 `iso` 의 원래 일자를 유지한다. 대상 월이 그
 * 일자보다 짧으면(월말 넘침) 그 달의 말일로 클램프한다 — 매번 원본 `from` 을 기준으로
 * 계산하므로, 2월처럼 짧은 달을 한 번 거쳐도 이후 리밸런스가 28/29일에 눌러앉지 않는다.
 */
function addMonthsClampingToMonthEnd(iso: string, months: number): string {
  const year = Number(iso.slice(0, 4));
  const month = Number(iso.slice(5, 7)); // 1~12
  const day = Number(iso.slice(8, 10));

  const totalMonths = (month - 1) + months;
  const targetYear = year + Math.floor(totalMonths / 12);
  const targetMonth = ((totalMonths % 12) + 12) % 12; // 0~11
  const clampedDay = Math.min(day, lastDayOfMonth(targetYear, targetMonth + 1));

  const mm = String(targetMonth + 1).padStart(2, '0');
  const dd = String(clampedDay).padStart(2, '0');
  return `${targetYear}-${mm}-${dd}`;
}

/**
 * period.from 을 첫 리밸런스 날짜로 삼아 rebalanceMonths 간격으로 이후 날짜를 만든다.
 * 거래일 보정은 하지 않는다 — 리밸런스 날짜가 휴장일이어도 getUniverseAsOf 가 직전
 * 상태를 그대로 재구성하므로 resolver 입장에서 여전히 유효한 날짜이기 때문이다.
 * period.to 를 넘는 날짜는 결과에서 제외한다.
 */
export function computeRebalanceDates(
  period: { from: string; to: string },
  rebalanceMonths: number,
): string[] {
  const dates: string[] = [];
  for (let k = 0; ; k += 1) {
    const date = k === 0 ? period.from : addMonthsClampingToMonthEnd(period.from, k * rebalanceMonths);
    if (date > period.to) break;
    dates.push(date);
  }
  return dates;
}
