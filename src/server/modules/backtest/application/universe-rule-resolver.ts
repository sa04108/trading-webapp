import { createHash } from 'node:crypto';
import type { Logger } from '../../../shared/logger.js';
import type { SymbolMasterEntry } from '../../market-data/domain/symbol-master.js';
import type { SymbolMasterService } from '../../market-data/application/symbol-master-service.js';
import type { UniverseRule } from '../../../../shared/schemas/universe-rule.js';

export interface UniverseScheduleEntry {
  readonly rebalanceDate: string; // ISO
  /** 유니버스·시총을 실제로 읽은 거래일. 휴장이면 rebalanceDate 보다 앞선다 */
  readonly effectiveTradingDate: string;
  readonly symbols: readonly string[]; // shortCode, 시총 내림차순 상위 N
}

export interface ResolvedUniverse {
  readonly schedule: readonly UniverseScheduleEntry[];
  readonly unionSymbols: readonly string[];
  /**
   * unionSymbols 각 shortCode 의 종목 마스터 원본 항목(Task 4, 스펙 2026-08-06) —
   * 자동 등록이 이름·시장·표준코드를 여기서 가져온다. 증권사(symbolInfoService)는
   * 상장폐지 종목의 이름을 주지 않으므로 마스터가 유일한 출처다. 같은 shortCode 가
   * 여러 리밸런스 날짜에 걸쳐 나와도 처음 만난 항목만 남긴다 — 등록 목적으로는
   * 어느 시점 스냅샷이든 상관없다.
   */
  readonly unionEntries: ReadonlyMap<string, SymbolMasterEntry>;
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
   * 날짜별로 isCovered 와 effectiveTradingDateWithinCoverage 를 둘 다 확인한다.
   * effectiveTradingDateWithinCoverage 는 date 를 포함하는 커버 구간 **안**에서만
   * 찾으므로 그 자체로 이미 "coverage 를 벗어나지 않는다"는 보장을 담고 있지만,
   * isCovered(date) 를 별도로도 확인해 "이 날짜 자체를 안다"는 조건을 명시적으로
   * 남겨 둔다 — 전역으로 찾는 raw 버전(effectiveTradingDate, 여기서는 안 쓴다)을
   * 실수로 다시 끌어와도 이 명시적 게이트가 방어선이 되게 하려는 목적이다.
   *
   * 유니버스·시총은 rebalanceDate 가 아니라 effectiveTradingDate 로 읽는다. 휴장일은
   * MKTCAP 행 자체가 없어, rebalanceDate 그대로 넘기면 상위 N 이 빈 목록이 된다.
   *
   * 둘 중 하나라도 없는 날짜는 getMarketCapsAt 을 부르지 않고 바로 uncoveredDates 에
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
    const unionEntries = new Map<string, SymbolMasterEntry>();

    for (const date of rebalanceDates) {
      const effectiveTradingDate = this.deps.symbolMaster.effectiveTradingDateWithinCoverage(date);
      if (!this.deps.symbolMaster.isCovered(date) || effectiveTradingDate === undefined) {
        uncoveredDates.push(date);
        continue;
      }

      const universe = this.deps.symbolMaster.getUniverseAsOf(effectiveTradingDate);
      const candidates: SymbolMasterEntry[] = [];
      for (const entry of universe.values()) {
        if (entry.instrumentType === 'COMMON_STOCK' && rule.markets.includes(entry.market)) {
          candidates.push(entry);
        }
      }

      const marketCaps = await this.deps.symbolMaster.getMarketCapsAt(effectiveTradingDate);
      const ranked: { entry: SymbolMasterEntry; marketCap: bigint }[] = [];
      for (const entry of candidates) {
        const marketCapKrw = marketCaps.get(entry.standardCode);
        if (marketCapKrw === undefined) continue; // 시총 없는 종목은 순위에 넣지 않는다
        ranked.push({ entry, marketCap: BigInt(marketCapKrw) });
      }
      ranked.sort((a, b) => compareMarketCapDesc(a.marketCap, b.marketCap));

      const top = ranked.slice(0, rule.topN);
      const symbols = top.map(({ entry }) => entry.shortCode);
      for (const { entry } of top) {
        unionSymbols.add(entry.shortCode);
        if (!unionEntries.has(entry.shortCode)) unionEntries.set(entry.shortCode, entry);
      }
      schedule.push({ rebalanceDate: date, effectiveTradingDate, symbols });
    }

    const scheduleHash = createHash('sha256').update(JSON.stringify(schedule)).digest('hex');

    return {
      schedule,
      unionSymbols: [...unionSymbols].sort(),
      unionEntries,
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
