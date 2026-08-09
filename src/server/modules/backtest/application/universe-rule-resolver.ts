import { createHash } from 'node:crypto';
import type { Logger } from '../../../shared/logger.js';
import type { SymbolMasterEntry } from '../../market-data/domain/symbol-master.js';
import type { SymbolMasterService } from '../../market-data/application/symbol-master-service.js';
import type { UniverseRule } from '../../../../shared/schemas/universe-rule.js';
import type { BacktestPeriod } from '../../../../shared/schemas/backtest-request.js';
import { computeRebalanceDates as computeSharedRebalanceDates } from '../../../../shared/schemas/rebalance-interval.js';
import { addCalendarDays, kstEndOfDayMs } from '../../market-data/domain/kst-date.js';
import type { SelectionMetricRepository } from '../../market-data/application/selection-metric-repository.js';
import type { CandleRepository } from '../../market-data/application/ports.js';
import type { FactRepository } from '../../facts/application/ports.js';
import type { CorporateActionCoverageStore } from '../../facts/application/corporate-action-coverage.js';
import { PitFactView } from '../../facts/domain/pit-fact-view.js';
import { splitAdjustedClose } from '../../strategy/strategies/shared/adjusted-price.js';
import {
  rankUniverseStage,
  type UniverseStageDiagnostic,
  type UniverseStageValue,
} from './universe-stage-ranking.js';

export interface LegacyUniverseScheduleEntry {
  readonly rebalanceDate: string; // ISO
  /** 유니버스·시총을 실제로 읽은 거래일. 휴장이면 rebalanceDate 보다 앞선다 */
  readonly effectiveTradingDate: string;
  readonly symbols: readonly string[]; // shortCode, 시총 내림차순 상위 N
  /** 그날 거래불가라 후보에서 뺀 종목 수 — 조용히 빠지면 추적할 방법이 없다 */
  readonly excludedNonTradingCount: number;
}

export interface ResolvedUniverse {
  readonly schedule: readonly LegacyUniverseScheduleEntry[];
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
  readonly selectionMetrics?: SelectionMetricRepository;
  readonly candles?: CandleRepository;
  readonly facts?: FactRepository;
  readonly actionCoverage?: CorporateActionCoverageStore;
  readonly logger: Logger;
}

export interface UniverseDataNeed {
  readonly factSymbols: readonly string[];
  readonly actionSymbols: readonly string[];
  /** DECLINE stage 진입 후보 중 가격 warm-up이 부족한 종목. */
  readonly priceSymbols: readonly string[];
  readonly selectionMetricDates: readonly string[];
  readonly priceRange: { from: string; to: string } | null;
}

export interface UniverseScheduleMember {
  readonly symbol: string;
  readonly standardCode: string;
  readonly marketCapKrw: string | null;
  readonly volume: number | null;
  readonly tradingValueKrw: string | null;
}

export interface UniverseScheduleEntry {
  readonly rebalanceDate: string;
  readonly effectiveDate: string;
  readonly fromTsMs: number;
  readonly members: readonly UniverseScheduleMember[];
  /** staged resolver에서도 worker 경고에 필요한 거래불가 제외 건수를 잃지 않는다. */
  readonly excludedNonTradingCount: number;
}

export interface RebalanceDiagnostic {
  readonly rebalanceDate: string;
  readonly effectiveDate: string;
  readonly stages: readonly UniverseStageDiagnostic[];
}

export type UniverseResolveAttempt =
  | {
      readonly kind: 'READY';
      readonly schedule: readonly UniverseScheduleEntry[];
      readonly diagnostics: readonly RebalanceDiagnostic[];
      /** READY schedule 멤버를 자동 등록할 때 쓰는 실제 선정 시점의 master entry */
      readonly unionEntries: ReadonlyMap<string, SymbolMasterEntry>;
    }
  | { readonly kind: 'NEEDS_DATA'; readonly needs: UniverseDataNeed };

/**
 * 일정 전체의 거래불가 제외 건수 합계 (중복 포함). 워커는 `resolve()` 결과가 아니라
 * job.universeScheduleJson 에 저장된 일정만 받으므로, 합산을 여기 한 곳에 두고
 * 양쪽이 같은 함수를 부르게 한다.
 */
export function sumExcludedNonTrading(schedule: readonly LegacyUniverseScheduleEntry[]): number {
  return schedule.reduce((sum, entry) => sum + entry.excludedNonTradingCount, 0);
}

/** 시총 내림차순 비교 — BigInt 차이를 Number 로 좁히면 큰 시총에서 오버플로가 나므로 부호만 본다 */
function compareMarketCapDesc(a: bigint, b: bigint): number {
  if (a === b) return 0;
  return a > b ? -1 : 1;
}

export class UniverseRuleResolver {
  constructor(private readonly deps: UniverseRuleResolverDeps) {}

  /**
   * period.from~to 전체가 종목 마스터 coverage 로 빈틈없이 덮였는지 본다. `resolve`
   * 의 `uncoveredDates` 는 리밸런스 날짜만 보므로, 리밸런스 날짜 사이 평일이 비어
   * 있는 부분 커버리지는 이 메서드로 따로 잡아야 한다(symbol-master-service.ts
   * `isRangeCovered` 주석 — 운영에서 확인된 버그의 정확한 원인).
   */
  isPeriodCovered(period: { readonly from: string; readonly to: string }): boolean {
    return this.deps.symbolMaster.isRangeCovered(period.from, period.to);
  }

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
    const schedule: LegacyUniverseScheduleEntry[] = [];
    const uncoveredDates: string[] = [];
    const unionSymbols = new Set<string>();
    const unionEntries = new Map<string, SymbolMasterEntry>();

    // 리밸런스 기준일들이 걸치는 최소·최대 날짜 한 번만 읽어 날짜별 집합으로 접는다 —
    // 날짜마다 질의하면 리밸런스가 잦은 실행에서 같은 질의를 수십 번 반복하게 된다.
    const nonTradingByDate = new Map<string, Set<string>>();
    if (rebalanceDates.length > 0) {
      const sortedDates = [...rebalanceDates].sort();
      const first = sortedDates[0] as string;
      const last = sortedDates[sortedDates.length - 1] as string;
      // rebalanceDate 가 휴장일이면 effectiveTradingDateWithinCoverage 가 coverage 안에서
      // 날짜 상한 없이 뒤로 찾아가므로, effectiveTradingDate 는 rebalanceDate 보다 앞설 수
      // 있다 — 조회 하한을 rebalanceDate 그대로 두면 그 사이 거래불가일을 놓친다. 31일은
      // KRX 최장 연휴(설·추석이 주말과 겹치는 경우)도 1주일 안팎이라 여유 있게 웃돈다.
      for (const row of this.deps.symbolMaster.nonTradingDaysBetween(
        addCalendarDays(first, -31),
        last,
      )) {
        const set = nonTradingByDate.get(row.date) ?? new Set<string>();
        set.add(row.shortCode);
        nonTradingByDate.set(row.date, set);
      }
    }

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

      const nonTrading = nonTradingByDate.get(effectiveTradingDate) ?? new Set<string>();
      let excludedNonTradingCount = 0;
      const marketCaps = await this.deps.symbolMaster.getMarketCapsAt(effectiveTradingDate);
      const ranked: { entry: SymbolMasterEntry; marketCap: bigint }[] = [];
      for (const entry of candidates) {
        // 그날 거래할 수 없으면 시총이 아무리 커도 살 수 없다 — 후보에 두면 그 자리가 헛돈다.
        // 기준일 종가 시점에 이미 확정된 사실이라 look-ahead 가 아니다.
        if (nonTrading.has(entry.shortCode)) {
          excludedNonTradingCount += 1;
          continue;
        }
        const marketCapKrw = marketCaps.get(entry.standardCode);
        if (marketCapKrw === undefined) continue; // 시총 없는 종목은 순위에 넣지 않는다
        ranked.push({ entry, marketCap: BigInt(marketCapKrw) });
      }
      ranked.sort((a, b) => compareMarketCapDesc(a.marketCap, b.marketCap));

      // Task 1 호환 경로: 선정 지표 단계 파이프라인(Task 4)이 들어오기 전까지는
      // 기존 resolver가 지원하던 MARKET_CAP 첫 단계만 소비한다.
      const top = ranked.slice(0, rule.stages[0]!.limit);
      const symbols = top.map(({ entry }) => entry.shortCode);
      for (const { entry } of top) {
        unionSymbols.add(entry.shortCode);
        if (!unionEntries.has(entry.shortCode)) unionEntries.set(entry.shortCode, entry);
      }
      schedule.push({ rebalanceDate: date, effectiveTradingDate, symbols, excludedNonTradingCount });
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

  async resolveOrDescribeNeeds(
    rule: UniverseRule,
    period: BacktestPeriod,
  ): Promise<UniverseResolveAttempt> {
    const { selectionMetrics, candles, facts, actionCoverage } = this.requirePipelineDeps();
    const factSymbols = new Set<string>();
    const actionSymbols = new Set<string>();
    const priceSymbols = new Set<string>();
    const selectionMetricDates = new Set<string>();
    let priceRange: { from: string; to: string } | null = null;
    const schedule: UniverseScheduleEntry[] = [];
    const diagnostics: RebalanceDiagnostic[] = [];
    const unionEntries = new Map<string, SymbolMasterEntry>();

    const widenPriceRange = (from: string, to: string): void => {
      priceRange = priceRange === null
        ? { from, to }
        : {
            from: from < priceRange.from ? from : priceRange.from,
            to: to > priceRange.to ? to : priceRange.to,
          };
    };

    for (const rebalanceDate of computeSharedRebalanceDates(period, rule.rebalanceInterval)) {
      const effectiveDate = this.deps.symbolMaster.effectiveTradingDateWithinCoverage(rebalanceDate);
      if (!this.deps.symbolMaster.isCovered(rebalanceDate) || effectiveDate === undefined) {
        selectionMetricDates.add(rebalanceDate);
        continue;
      }

      const nonTrading = new Set(
        this.deps.symbolMaster.nonTradingDaysBetween(effectiveDate, effectiveDate)
          .map((row) => row.shortCode),
      );
      const universe = this.deps.symbolMaster.getUniverseAsOf(effectiveDate);
      const marketCandidates = [...universe.values()]
        .filter((entry) => entry.instrumentType === 'COMMON_STOCK' && rule.markets.includes(entry.market));
      const excludedNonTradingCount = marketCandidates
        .filter((entry) => nonTrading.has(entry.shortCode))
        .length;
      let candidates = marketCandidates
        .filter((entry) => !nonTrading.has(entry.shortCode))
        .sort((a, b) => a.shortCode.localeCompare(b.shortCode));
      const stageDiagnostics: UniverseStageDiagnostic[] = [];

      for (const stage of rule.stages) {
        let stageReady = true;
        let rows: UniverseStageValue[];

        if (stage.criterion === 'TRADING_VALUE') {
          const stageMetrics = selectionMetrics.getAt(
            effectiveDate,
            candidates.map((entry) => entry.standardCode),
          );
          if (selectionMetrics.findMissingTradingValueDates([effectiveDate]).length > 0) {
            selectionMetricDates.add(effectiveDate);
            stageReady = false;
          }
          rows = candidates.map((entry) => ({
            standardCode: entry.standardCode,
            shortCode: entry.shortCode,
            value: stageMetrics.get(entry.standardCode)?.tradingValueKrw ?? null,
          }));
        } else if (stage.criterion === 'MARKET_CAP' || stage.criterion === 'VOLUME') {
          const stageMetrics = selectionMetrics.getAt(
            effectiveDate,
            candidates.map((entry) => entry.standardCode),
          );
          rows = candidates.map((entry) => ({
            standardCode: entry.standardCode,
            shortCode: entry.shortCode,
            value: stage.criterion === 'MARKET_CAP'
              ? stageMetrics.get(entry.standardCode)?.marketCapKrw ?? null
              : stageMetrics.get(entry.standardCode)?.volume ?? null,
          }));
        } else if (stage.criterion === 'PER') {
          const stageMetrics = selectionMetrics.getAt(
            effectiveDate,
            candidates.map((entry) => entry.standardCode),
          );
          const missing = candidates.filter((entry) => !facts.hasFacts('SYMBOL', entry.shortCode));
          for (const entry of missing) factSymbols.add(entry.shortCode);
          if (missing.length > 0) stageReady = false;

          const loaded = await facts.getFacts({
            scope: 'SYMBOL',
            keys: candidates.map((entry) => entry.shortCode),
          });
          const view = new PitFactView(loaded);
          view.advanceTo(kstEndOfDayMs(effectiveDate));
          rows = exactPerRankingRows(candidates, stageMetrics, view);
        } else {
          const codes = candidates.map((entry) => entry.shortCode);
          const histories = await loadCandleHistories(candles, codes, effectiveDate);
          const requiredFrom = addCalendarDays(
            effectiveDate,
            -(stage.lookbackTradingDays * 2 + 14),
          );
          const priceMissingCodes = codes.filter(
            (code) => (histories.get(code)?.length ?? 0) < stage.lookbackTradingDays,
          );
          const warmupMissing = priceMissingCodes.length > 0;
          // symbol_master_coverage 는 해당 날짜의 두 KRX 시장 응답을 실제로 받아
          // 일봉까지 저장한 뒤에만 닫힌다. 따라서 보수 범위 전체가 covered인데도
          // N봉이 안 되는 종목은 재수집 가능한 누락이 아니라 신규 상장·장기 거래정지
          // 같은 구조적 짧은 이력이다. 이 경우 value=null로 랭킹에서 제외하고 다시
          // priceSymbols를 내지 않아 preparation이 같은 범위를 영원히 반복하지 않게 한다.
          const priceFetchRequired = warmupMissing
            && !this.deps.symbolMaster.isRangeCovered(requiredFrom, effectiveDate);
          if (priceFetchRequired) {
            widenPriceRange(requiredFrom, effectiveDate);
            for (const code of priceMissingCodes) priceSymbols.add(code);
            stageReady = false;
          }

          let actualFrom = effectiveDate;
          for (const code of codes) {
            const history = (histories.get(code) ?? []).slice(-stage.lookbackTradingDays);
            const first = history[0];
            if (first !== undefined) {
              const firstDate = new Date(first.tsMs).toISOString().slice(0, 10);
              if (firstDate < actualFrom) actualFrom = firstDate;
            }
          }
          // 아직 가격 범위를 덜 조회했다면 짧은 후보도 다음 재해소에서 N봉을 채울 수
          // 있으므로 보수 범위의 action을 함께 준비한다. 반대로 전 범위를 이미 조회한
          // 구조적 짧은 이력은 이 stage에서 확실히 탈락하므로 DART까지 낭비하지 않는다.
          const actionCandidateCodes = priceFetchRequired
            ? codes
            : codes.filter((code) => !priceMissingCodes.includes(code));
          const requiredYears = yearsBetween(priceFetchRequired ? requiredFrom : actualFrom, effectiveDate);
          const coveredBySymbol = actionCoverage.getCoveredYears(actionCandidateCodes);
          const gapsBySymbol = actionCoverage.getGapYears(actionCandidateCodes);
          for (const code of actionCandidateCodes) {
            const covered = new Set(coveredBySymbol.get(code) ?? []);
            const gaps = new Set(gapsBySymbol.get(code) ?? []);
            if (requiredYears.some((year) => !covered.has(year) || gaps.has(year))) {
              actionSymbols.add(code);
              stageReady = false;
            }
          }

          const loaded = await facts.getFacts({ scope: 'SYMBOL', keys: codes });
          const view = new PitFactView(loaded);
          rows = candidates.map((entry) => {
            const history = (histories.get(entry.shortCode) ?? []).slice(-stage.lookbackTradingDays);
            if (history.length !== stage.lookbackTradingDays) {
              return { standardCode: entry.standardCode, shortCode: entry.shortCode, value: null };
            }
            const actions = view.corporateActions(entry.shortCode, kstEndOfDayMs(effectiveDate));
            const first = splitAdjustedClose(history, actions, 0);
            const last = splitAdjustedClose(history, actions, history.length - 1);
            const value = first === null || last === null || first <= 0
              ? null
              : (last / first) - 1;
            return { standardCode: entry.standardCode, shortCode: entry.shortCode, value };
          });
        }

        const ranked = rankUniverseStage(stage, rows);
        stageDiagnostics.push(ranked.diagnostic);
        if (stageReady) {
          const byStandardCode = new Map(candidates.map((entry) => [entry.standardCode, entry]));
          candidates = ranked.selectedCodes.flatMap((code) => {
            const entry = byStandardCode.get(code);
            return entry === undefined ? [] : [entry];
          });
        }
      }

      const finalMetrics = selectionMetrics.getAt(
        effectiveDate,
        candidates.map((entry) => entry.standardCode),
      );
      for (const entry of candidates) {
        if (!unionEntries.has(entry.shortCode)) unionEntries.set(entry.shortCode, entry);
      }
      diagnostics.push({ rebalanceDate, effectiveDate, stages: stageDiagnostics });
      schedule.push({
        rebalanceDate,
        effectiveDate,
        fromTsMs: Date.parse(`${rebalanceDate}T00:00:00Z`),
        excludedNonTradingCount,
        members: candidates.map((entry) => {
          const metric = finalMetrics.get(entry.standardCode);
          return {
            symbol: entry.shortCode,
            standardCode: entry.standardCode,
            marketCapKrw: metric?.marketCapKrw?.toString() ?? null,
            volume: metric?.volume ?? null,
            tradingValueKrw: metric?.tradingValueKrw?.toString() ?? null,
          };
        }),
      });
    }

    if (
      factSymbols.size > 0
      || actionSymbols.size > 0
      || priceSymbols.size > 0
      || selectionMetricDates.size > 0
      || priceRange !== null
    ) {
      return {
        kind: 'NEEDS_DATA',
        needs: {
          factSymbols: [...factSymbols].sort(),
          actionSymbols: [...actionSymbols].sort(),
          priceSymbols: [...priceSymbols].sort(),
          selectionMetricDates: [...selectionMetricDates].sort(),
          priceRange,
        },
      };
    }
    return { kind: 'READY', schedule, diagnostics, unionEntries };
  }

  private requirePipelineDeps(): Required<Pick<
    UniverseRuleResolverDeps,
    'selectionMetrics' | 'candles' | 'facts' | 'actionCoverage'
  >> {
    const { selectionMetrics, candles, facts, actionCoverage } = this.deps;
    if (!selectionMetrics || !candles || !facts || !actionCoverage) {
      throw new Error('유니버스 선정 파이프라인 의존성이 연결되지 않았습니다.');
    }
    return { selectionMetrics, candles, facts, actionCoverage };
  }
}

function yearsBetween(from: string, to: string): number[] {
  const years: number[] = [];
  for (let year = Number(from.slice(0, 4)); year <= Number(to.slice(0, 4)); year += 1) {
    years.push(year);
  }
  return years;
}

interface PositiveFraction {
  readonly numerator: bigint;
  readonly denominator: bigint;
}

function positiveNumberFraction(value: number | null): PositiveFraction | null {
  if (value === null || !Number.isFinite(value) || value <= 0) return null;
  const [coefficient, exponentText] = value.toString().toLowerCase().split('e');
  const exponent = exponentText === undefined ? 0 : Number(exponentText);
  const [whole, fraction = ''] = coefficient!.split('.');
  const digits = `${whole}${fraction}`;
  if (!/^\d+$/.test(digits)) return null;
  let numerator = BigInt(digits);
  let denominator = 10n ** BigInt(fraction.length);
  if (exponent > 0) numerator *= 10n ** BigInt(exponent);
  if (exponent < 0) denominator *= 10n ** BigInt(-exponent);
  return { numerator, denominator };
}

function exactPerRankingRows(
  candidates: readonly SymbolMasterEntry[],
  metrics: ReturnType<SelectionMetricRepository['getAt']>,
  view: PitFactView,
): UniverseStageValue[] {
  const ratios = candidates.flatMap((entry) => {
    const cap = metrics.get(entry.standardCode)?.marketCapKrw ?? null;
    const income = positiveNumberFraction(view.fundamentals(entry.shortCode)?.ttm('NET_INCOME') ?? null);
    if (cap === null || cap <= 0n || income === null) return [];
    return [{
      entry,
      numerator: cap * income.denominator,
      denominator: income.numerator,
    }];
  });
  ratios.sort((a, b) => {
    const left = a.numerator * b.denominator;
    const right = b.numerator * a.denominator;
    if (left !== right) return left < right ? -1 : 1;
    return a.entry.shortCode.localeCompare(b.entry.shortCode);
  });
  const rankByCode = new Map<string, number>();
  let rank = 0;
  for (let index = 0; index < ratios.length; index += 1) {
    if (index > 0) {
      const previous = ratios[index - 1]!;
      const current = ratios[index]!;
      if (previous.numerator * current.denominator !== current.numerator * previous.denominator) {
        rank += 1;
      }
    }
    rankByCode.set(ratios[index]!.entry.standardCode, rank);
  }
  return candidates.map((entry) => ({
    standardCode: entry.standardCode,
    shortCode: entry.shortCode,
    value: rankByCode.get(entry.standardCode) ?? null,
  }));
}

async function loadCandleHistories(
  candles: CandleRepository,
  symbols: readonly string[],
  effectiveDate: string,
): Promise<Map<string, import('../../market-data/domain/candle.js').Candle[]>> {
  const histories = new Map<string, import('../../market-data/domain/candle.js').Candle[]>();
  for await (const candle of candles.getCandles({
    market: 'KR',
    timeframe: '1d',
    symbols,
    toTsMs: kstEndOfDayMs(effectiveDate),
  })) {
    const list = histories.get(candle.symbol) ?? [];
    list.push(candle);
    histories.set(candle.symbol, list);
  }
  for (const list of histories.values()) list.sort((a, b) => a.tsMs - b.tsMs);
  return histories;
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
