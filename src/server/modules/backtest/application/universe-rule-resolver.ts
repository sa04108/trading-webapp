import { createHash } from 'node:crypto';
import type { Logger } from '../../../shared/logger.js';
import type { SymbolMasterEntry } from '../../market-data/domain/symbol-master.js';
import type { SymbolIdentitySelection } from '../../market-data/domain/symbol-identity-lifetime.js';
import type { SymbolMasterService } from '../../market-data/application/symbol-master-service.js';
import type { UniverseRule } from '../../../../shared/schemas/universe-rule.js';
import type { BacktestPeriod } from '../../../../shared/schemas/backtest-request.js';
import { computeRebalanceDates as computeSharedRebalanceDates } from '../../../../shared/schemas/rebalance-interval.js';
import { addCalendarDays, kstEndOfDayMs } from '../../market-data/domain/kst-date.js';
import type {
  DailySelectionMetric,
  SelectionMetricRepository,
} from '../../market-data/application/selection-metric-repository.js';
import type { CandleRepository } from '../../market-data/application/ports.js';
import type { FactRepository } from '../../facts/application/ports.js';
import type { FactCoverageStore } from '../../facts/application/fact-coverage-store.js';
import type { CorporateActionCoverageStore } from '../../facts/application/corporate-action-coverage.js';
import { derivePreparationFactYearRange } from '../../market-data/domain/fact-year-range.js';
import {
  alignCorporateActionEffectiveDates,
  CORPORATE_ACTION_ALIGNMENT_WINDOW,
  corporateActionRawDateRange,
} from '../../facts/domain/corporate-action-effective-date.js';
import { CORPORATE_ACTION_FIELD } from '../../facts/domain/fact.js';
import { PitFactView } from '../../facts/domain/pit-fact-view.js';
import { splitAdjustedClose } from '../../strategy/strategies/shared/adjusted-price.js';
import { assertSafeIdentitySelections } from './backtest-symbol-identity.js';
import {
  compareShortCodes,
  rankUniverseStage,
  type UniverseStageDiagnostic,
  type UniverseStageValue,
} from './universe-stage-ranking.js';

export interface LegacyUniverseScheduleEntry {
  readonly rebalanceDate: string; // ISO
  /** 유니버스·시총을 실제로 읽은 거래일. 휴장이면 rebalanceDate 보다 앞선다 */
  readonly effectiveTradingDate: string;
  readonly symbols: readonly string[]; // shortCode, 시총 내림차순 상위 N
  /** Task 7 이후 job은 전략이 실행 중 선정 지표를 재조회하지 않도록 이 pin도 보존한다. */
  readonly members?: readonly UniverseScheduleMember[];
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
  readonly factCoverage?: FactCoverageStore;
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
  | {
      readonly kind: 'NEEDS_DATA';
      readonly needs: UniverseDataNeed;
      /** false면 아직 수집하지 않은 master 날짜가 있어 unionEntries가 후보 전체를 덮지 않는다. */
      readonly candidateScopeKnown: boolean;
      /**
       * 현재까지의 stage를 통과했거나, 미준비 stage에서 아직 줄일 수 없는
       * 알려진 master 후보. sync 전 symbols FK 등록과 future final-union 상한의
       * DART 필요 계획에 모두 쓴다. `candidateScopeKnown=true`인 빈 Map만
       * 선정 가능한 후보가 없음을 뜻한다.
       */
      readonly unionEntries: ReadonlyMap<string, SymbolMasterEntry>;
    };

/**
 * 일정 전체의 거래불가 제외 건수 합계 (중복 포함). 워커는 `resolve()` 결과가 아니라
 * job.universeScheduleJson 에 저장된 일정만 받으므로, 합산을 여기 한 곳에 두고
 * 양쪽이 같은 함수를 부르게 한다.
 */
export function sumExcludedNonTrading(schedule: readonly LegacyUniverseScheduleEntry[]): number {
  return schedule.reduce((sum, entry) => sum + entry.excludedNonTradingCount, 0);
}

function assertSelectionMetricRowsComplete(
  effectiveDate: string,
  criterion: 'MARKET_CAP' | 'VOLUME' | 'TRADING_VALUE' | 'PER',
  candidates: readonly Pick<SymbolMasterEntry, 'shortCode' | 'standardCode'>[],
  metrics: ReadonlyMap<string, DailySelectionMetric>,
): void {
  const missing = candidates
    .filter((entry) => !metrics.has(entry.standardCode))
    .map((entry) => entry.shortCode)
    .sort();
  if (missing.length === 0) return;
  throw new Error(
    `KRX 선정 지표 수집이 완료된 날짜에 ${criterion} 후보 행이 누락됐습니다 `
      + `(${effectiveDate}): ${missing.join(', ')}. `
      + '누락 종목만 제외해 순위를 바꾸지 않고 준비를 중단했습니다.',
  );
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
   *
   * MARKET_CAP 첫 단계만 보는 단순 경로라 PER·DECLINE 같은 여러 단계 규칙에는 쓸 수
   * 없다 — 그 경로는 `resolveOrDescribeNeeds` 가 맡는다. clone-draft 가 완료된 준비
   * 없이 이 메서드로 blockers 를 추측하던 마지막 프로덕션 호출자였는데, 잘못된
   * 유니버스로 판정한다는 문제가 있어 없앴다(리뷰 finding, 2026-08-09) — 지금은 이
   * 아래 테스트가 직접 부르는 것 외에는 호출자가 없다.
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
      const direction = rule.stages[0]!.direction;
      ranked.sort((a, b) => {
        const valueOrder = a.marketCap === b.marketCap ? 0 : a.marketCap < b.marketCap ? -1 : 1;
        if (valueOrder !== 0) return direction === 'LOW' ? valueOrder : -valueOrder;
        return compareShortCodes(a.entry.shortCode, b.entry.shortCode);
      });

      // 이 메서드는 MARKET_CAP 첫 단계만 본다(위 docblock 참고) — stages[1..] 는
      // 여기서 소비하지 않는다.
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
    const { selectionMetrics, candles, facts, factCoverage, actionCoverage } = this.requirePipelineDeps();
    const factSymbols = new Set<string>();
    const actionSymbols = new Set<string>();
    const priceSymbols = new Set<string>();
    const selectionMetricDates = new Set<string>();
    let priceRange: { from: string; to: string } | null = null;
    const schedule: UniverseScheduleEntry[] = [];
    const diagnostics: RebalanceDiagnostic[] = [];
    const unionEntries = new Map<string, SymbolMasterEntry>();
    let candidateScopeKnown = true;
    // getUniverseAsOf가 각 effectiveDate에 실제 유효한 pair만 돌려주므로, 한 resolve
    // 안에서는 pair의 전체 생애 1:1 검증을 한 번만 하면 된다. 날짜까지 cache key에
    // 넣으면 DAY 일정에서 같은 200종목을 수천 번 DB 조회하게 된다. 호출 수명 캐시라
    // 다음 resolve/ingest의 변경은 숨기지 않는다.
    const validatedIdentityPairs = new Set<string>();
    const observedIdentitySelections = new Map<string, SymbolIdentitySelection>();

    const assertFreshIdentitySelections = (
      candidates: readonly SymbolIdentitySelection[],
    ): void => {
      const uniqueByDateAndPair = new Map<string, SymbolIdentitySelection>();
      for (const selection of candidates) {
        const key = `${selection.effectiveDate}\0${selection.shortCode}\0${selection.standardCode}`;
        if (!uniqueByDateAndPair.has(key)) uniqueByDateAndPair.set(key, selection);
      }
      if (uniqueByDateAndPair.size > 0) {
        assertSafeIdentitySelections(this.deps.symbolMaster, [...uniqueByDateAndPair.values()]);
      }
    };

    const validateIdentitySelections = (
      candidates: readonly SymbolIdentitySelection[],
    ): void => {
      for (const selection of candidates) {
        observedIdentitySelections.set(
          `${selection.effectiveDate}\0${selection.shortCode}\0${selection.standardCode}`,
          selection,
        );
      }
      const pendingByPair = new Map<string, SymbolIdentitySelection>();
      for (const selection of candidates) {
        const key = `${selection.shortCode}\0${selection.standardCode}`;
        if (!validatedIdentityPairs.has(key) && !pendingByPair.has(key)) {
          pendingByPair.set(key, selection);
        }
      }
      const pending = [...pendingByPair.values()];
      if (pending.length === 0) return;
      assertSafeIdentitySelections(this.deps.symbolMaster, pending);
      for (const selection of pending) {
        const key = `${selection.shortCode}\0${selection.standardCode}`;
        validatedIdentityPairs.add(key);
      }
    };

    const validateCandidateIdentities = (
      entries: readonly Pick<SymbolMasterEntry, 'shortCode' | 'standardCode'>[],
      effectiveDate: string,
    ): void => {
      validateIdentitySelections(entries.map((entry) => ({
        shortCode: entry.shortCode,
        standardCode: entry.standardCode,
        effectiveDate,
      })));
    };

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
        candidateScopeKnown = false;
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
        .sort((a, b) => compareShortCodes(a.shortCode, b.shortCode));
      const stageDiagnostics: UniverseStageDiagnostic[] = [];
      const dateFactSymbols = new Set<string>();
      const dateActionSymbols = new Set<string>();
      const datePriceSymbols = new Set<string>();
      const dateSelectionMetricDates = new Set<string>();
      const datePrice = { range: null as { from: string; to: string } | null };
      let hasUnresolvedStage = false;

      for (const stage of rule.stages) {
        let stageReady = true;
        let rows: UniverseStageValue[];

        if (stage.criterion === 'TRADING_VALUE') {
          const stageMetrics = selectionMetrics.getAt(
            effectiveDate,
            candidates.map((entry) => entry.standardCode),
          );
          const metricDateMissing =
            selectionMetrics.findMissingTradingValueDates([effectiveDate]).length > 0;
          if (metricDateMissing) {
            dateSelectionMetricDates.add(effectiveDate);
            stageReady = false;
          } else {
            assertSelectionMetricRowsComplete(
              effectiveDate,
              stage.criterion,
              candidates,
              stageMetrics,
            );
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
          const metricDateMissing =
            selectionMetrics.findMissingTradingValueDates([effectiveDate]).length > 0;
          if (!metricDateMissing) {
            assertSelectionMetricRowsComplete(
              effectiveDate,
              stage.criterion,
              candidates,
              stageMetrics,
            );
          }
          rows = candidates.map((entry) => ({
            standardCode: entry.standardCode,
            shortCode: entry.shortCode,
            value: stage.criterion === 'MARKET_CAP'
              ? stageMetrics.get(entry.standardCode)?.marketCapKrw ?? null
              : stageMetrics.get(entry.standardCode)?.volume ?? null,
          }));
          // 0014 migration 은 시총만 복사하고 volume 은 ensureSelectionMetrics 의
          // backfill 이 채운다. KRX ingest 흔적이 없는 날짜에서 값이 비면 결측 제외로
          // 추측하지 않고 TRADING_VALUE 와 같은 신호로 metric 수집을 요구한다 —
          // 한 번의 ingest 로 채워질 수 있는 결측이기 때문이다. ingest 된 날짜의
          // null 은 구조적 결측이므로 그대로 제외한다.
          if (
            rows.some((row) => row.value === null)
            && metricDateMissing
          ) {
            dateSelectionMetricDates.add(effectiveDate);
            stageReady = false;
          }
        } else if (stage.criterion === 'PER' || stage.criterion === 'ROE') {
          // coverage·facts가 shortCode 키라, issuer가 다른 전 생애 데이터를 읽기 전에
          // 현재 후보의 양방향 identity가 전체 SCD에서 1:1인지 먼저 확인한다.
          validateCandidateIdentities(candidates, effectiveDate);
          // 재무 결측은 단순 fact 행 존재가 아니라 financial coverage 연도로 판정한다.
          // 자본변동 전용 수집도 fact 행을 남기므로 행 존재는
          // 재무 있음을 증명하지 못한다 (fact-coverage-store.ts 주석). coverage 는
          // 공시가 없던 연도도 시도 후 기록되므로 이 판정은 sync 한 번이면 수렴한다.
          const requiredYears = financialStageRequiredFactYears(effectiveDate, period);
          const coveredBySymbol = factCoverage.getCoveredYears(
            candidates.map((entry) => entry.shortCode),
          );
          const missing = candidates.filter((entry) => {
            const covered = new Set(coveredBySymbol.get(entry.shortCode) ?? []);
            return requiredYears.some((year) => !covered.has(year));
          });
          for (const entry of missing) dateFactSymbols.add(entry.shortCode);
          if (missing.length > 0) stageReady = false;

          const loaded = await facts.getFacts({
            scope: 'SYMBOL',
            keys: candidates.map((entry) => entry.shortCode),
          });
          const view = new PitFactView(loaded);
          view.advanceTo(kstEndOfDayMs(effectiveDate));
          if (stage.criterion === 'PER') {
            const stageMetrics = selectionMetrics.getAt(
              effectiveDate,
              candidates.map((entry) => entry.standardCode),
            );
            const metricDateMissing =
              selectionMetrics.findMissingTradingValueDates([effectiveDate]).length > 0;
            const hasIncompleteMarketCaps = candidates.some((entry) => (
              stageMetrics.get(entry.standardCode)?.marketCapKrw == null
            ));
            if (metricDateMissing && hasIncompleteMarketCaps) {
              dateSelectionMetricDates.add(effectiveDate);
              stageReady = false;
            } else if (!metricDateMissing) {
              assertSelectionMetricRowsComplete(
                effectiveDate,
                stage.criterion,
                candidates,
                stageMetrics,
              );
            }
            rows = exactRatioRankingRows(candidates, (entry) => {
              const cap = stageMetrics.get(entry.standardCode)?.marketCapKrw ?? null;
              const income = positiveNumberFraction(
                view.fundamentals(entry.shortCode)?.ttm('NET_INCOME') ?? null,
              );
              return cap === null || cap <= 0n || income === null
                ? null
                : { numerator: cap * income.denominator, denominator: income.numerator };
            });
          } else {
            rows = exactRatioRankingRows(candidates, (entry) => {
              const snapshot = view.fundamentals(entry.shortCode);
              const income = positiveNumberFraction(snapshot?.ttm('NET_INCOME') ?? null);
              const equity = positiveNumberFraction(snapshot?.get('TOTAL_EQUITY') ?? null);
              return income === null || equity === null
                ? null
                : {
                    numerator: income.numerator * equity.denominator,
                    denominator: income.denominator * equity.numerator,
                  };
            });
          }
        } else {
          // DECLINE은 일봉·자본변동을 shortCode로 읽는다. 과거 issuer의 봉이나 공시가
          // 섞인 뒤 순위를 계산하지 않도록 첫 저장소 접근보다 먼저 검사한다.
          validateCandidateIdentities(candidates, effectiveDate);
          const codes = candidates.map((entry) => entry.shortCode);
          // 조회 하한 없이 부르면 후보 × 리밸런스 날짜마다 전체 일봉 이력을 읽는다.
          // 보수 범위(requiredFrom)만 있으면 N봉 판정과 수익률 계산에 충분하다.
          const requiredFrom = addCalendarDays(
            effectiveDate,
            -(stage.lookbackTradingDays * 2 + 14),
          );
          const histories = await loadCandleHistories(candles, codes, requiredFrom, effectiveDate);
          const lookbackHistories = new Map(
            codes.map((code) => [
              code,
              (histories.get(code) ?? []).slice(-stage.lookbackTradingDays),
            ]),
          );
          const priceMissingCodes = codes.filter(
            (code) => (lookbackHistories.get(code)?.length ?? 0) < stage.lookbackTradingDays,
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
            datePrice.range = datePrice.range === null
              ? { from: requiredFrom, to: effectiveDate }
              : {
                  from: requiredFrom < datePrice.range.from ? requiredFrom : datePrice.range.from,
                  to: effectiveDate > datePrice.range.to ? effectiveDate : datePrice.range.to,
                };
            for (const code of priceMissingCodes) datePriceSymbols.add(code);
            stageReady = false;
          }

          let actualFrom = effectiveDate;
          for (const code of codes) {
            const history = lookbackHistories.get(code) ?? [];
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
          const actionExecutionFrom = priceFetchRequired ? requiredFrom : actualFrom;
          // DECLINE 수익률에 영향을 줄 실제 변경일 E는 첫 봉 다음 날~마지막 봉이다.
          // DART 기준일 R은 E보다 최대 90일 앞, 30일 뒤일 수 있으므로 인접 연도까지
          // coverage가 닫히기 전에는 raw fact가 없다는 이유로 READY를 만들지 않는다.
          const relevantRawFrom = addCalendarDays(
            actionExecutionFrom,
            1 - CORPORATE_ACTION_ALIGNMENT_WINDOW.afterDays,
          );
          const relevantRawTo = addCalendarDays(
            effectiveDate,
            CORPORATE_ACTION_ALIGNMENT_WINDOW.beforeDays,
          );
          const requiredYears = yearsBetween(relevantRawFrom, relevantRawTo);
          const coveredBySymbol = actionCoverage.getCoveredYears(actionCandidateCodes);
          const gapsBySymbol = actionCoverage.getGapYears(actionCandidateCodes);
          // covered+gap 연도는 "수집했지만 DART 행을 보정 비율로 만들지 못한" 상태다
          // (예: 발행형태/일자/직전 주식수 파싱 실패). 후보 하나만 결측 제외하면 그
          // 종목이 원래 탈락시켰을 다른 종목이 대신 뽑혀 결과가 낙관적으로 바뀔 수 있다.
          // 앞 stage가 확정된 뒤 실제 DECLINE 후보에 하나라도 걸리면 전체 준비를 막는다.
          const gapAffectedCodes = new Set<string>();
          for (const code of actionCandidateCodes) {
            const covered = new Set(coveredBySymbol.get(code) ?? []);
            if (requiredYears.some((year) => !covered.has(year))) {
              dateActionSymbols.add(code);
              stageReady = false;
              continue;
            }
            const gaps = new Set(gapsBySymbol.get(code) ?? []);
            if (requiredYears.some((year) => gaps.has(year))) gapAffectedCodes.add(code);
          }
          if (gapAffectedCodes.size > 0) {
            if (stageReady && !hasUnresolvedStage) {
              throw new Error(
                '급하락 유니버스의 자본변동 보정 비율을 만들 수 없는 연도가 있습니다 — '
                  + `대상: ${[...gapAffectedCodes].sort().join(', ')}. `
                  + '해당 종목을 임의로 제외해 순위를 바꾸지 않고 준비를 중단했습니다.',
              );
            }
            // 앞 stage나 가격/action coverage가 아직 미해소면 그 데이터를 먼저 채워
            // 실제 DECLINE 입력 후보를 좁힌 뒤 다시 판정한다.
            stageReady = false;
          }

          const loaded = await facts.getFacts({ scope: 'SYMBOL', keys: codes });
          const rankableCodes = new Set(codes.filter((code) => (
            (lookbackHistories.get(code)?.length ?? 0) === stage.lookbackTradingDays
          )));
          const rawActionFacts = loaded.filter((fact) => fact.field === CORPORATE_ACTION_FIELD);
          const rawActionRange = corporateActionRawDateRange(rawActionFacts);
          const sharesChanges = rawActionRange === null
            ? []
            : this.deps.symbolMaster.sharesChangesBetween(
                addCalendarDays(
                  rawActionRange.from,
                  -CORPORATE_ACTION_ALIGNMENT_WINDOW.beforeDays,
                ),
                addCalendarDays(
                  rawActionRange.to,
                  CORPORATE_ACTION_ALIGNMENT_WINDOW.afterDays,
                ),
              );
          // worker와 동일한 전체 fact/change 그래프를 먼저 정렬한다. 관련 fact만 잘라
          // 매칭하면 범위 밖 사건이 같은 change를 요구할 때 resolver와 worker가 한
          // 사건을 서로 다른 날짜로 옮길 수 있다.
          const aligned = alignCorporateActionEffectiveDates(rawActionFacts, sharesChanges);
          const relevantUnaligned = aligned.unaligned.filter((action) => {
            if (!rankableCodes.has(action.symbol)) return false;
            const history = lookbackHistories.get(action.symbol) ?? [];
            const first = history[0];
            const last = history[history.length - 1];
            if (first === undefined || last === undefined) return false;
            const firstDate = new Date(first.tsMs).toISOString().slice(0, 10);
            const lastDate = new Date(last.tsMs).toISOString().slice(0, 10);
            return action.periodKey >= addCalendarDays(
              firstDate,
              1 - CORPORATE_ACTION_ALIGNMENT_WINDOW.afterDays,
            ) && action.periodKey <= addCalendarDays(
              lastDate,
              CORPORATE_ACTION_ALIGNMENT_WINDOW.beforeDays,
            );
          });
          if (relevantUnaligned.length > 0) {
            if (stageReady && !hasUnresolvedStage) {
              const symbols = [...new Set(relevantUnaligned.map((action) => action.symbol))].sort();
              throw new Error(
                `급하락 유니버스의 자본변동 ${relevantUnaligned.length}건을 KRX 상장주식수 변경일과 `
                  + `정렬할 수 없습니다 — 대상: ${symbols.join(', ')}. `
                  + '잘못된 급락률로 종목을 선정하지 않도록 준비를 중단했습니다.',
              );
            }
            // 앞 stage 또는 이 stage의 데이터가 아직 미해소면 그 needs를 먼저 채운 뒤
            // 실제 후보로 다시 판정한다. raw 날짜로 계산한 임시 순위는 확정하지 않는다.
            stageReady = false;
          }
          const view = new PitFactView(aligned.facts);
          rows = candidates.map((entry) => {
            const history = lookbackHistories.get(entry.shortCode) ?? [];
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
        if (!stageReady) {
          // 이 stage의 순위가 미상이므로 현재 input 후보 전체가 이후
          // final-union의 보수적 상한이다.
          hasUnresolvedStage = true;
        } else if (hasUnresolvedStage) {
          // 앞 stage의 순위가 바뀌 수 있으므로 non-empty 후속 선택은 상한을
          // 줄일 수 없다. 다만 완전한 상한 전체에서 eligible이 0이면
          // 앞 stage 결과와 무관하게 final empty라는 단조로운 증명이다.
          if (ranked.diagnostic.eligibleCount === 0) candidates = [];
        } else {
          const byStandardCode = new Map(candidates.map((entry) => [entry.standardCode, entry]));
          candidates = ranked.selectedCodes.flatMap((code) => {
            const entry = byStandardCode.get(code);
            return entry === undefined ? [] : [entry];
          });
        }

        // standardCode 기반 선정 지표가 아직 없으면 현재 candidates는 후속 stage의
        // 실제 입력이 아니라 보수적 상한이다. 여기서 PER/ROE/DECLINE을 읽으면 이후
        // 시총·거래대금에서 탈락할 ambiguous shortCode 때문에 과잉 차단되므로, 시장
        // 데이터를 먼저 준비하고 다음 resolve에서 좁혀진 후보로 재개한다.
        if (
          !stageReady
          && (
            stage.criterion === 'MARKET_CAP'
            || stage.criterion === 'VOLUME'
            || stage.criterion === 'TRADING_VALUE'
          )
        ) break;
      }

      // 이 날짜의 완전한 후보 상한이 비었다면 앞 unresolved stage가
      // 남긴 needs는 final 선정을 바꿀 수 없는 stale work다. 날짜별로만 버려
      // 다른 rebalance date의 non-empty 상한 needs는 지우지 않는다.
      if (candidates.length > 0) {
        for (const symbol of dateFactSymbols) factSymbols.add(symbol);
        for (const symbol of dateActionSymbols) actionSymbols.add(symbol);
        for (const symbol of datePriceSymbols) priceSymbols.add(symbol);
        for (const date of dateSelectionMetricDates) selectionMetricDates.add(date);
        if (datePrice.range !== null) widenPriceRange(datePrice.range.from, datePrice.range.to);
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
      // short-keyed 저장소를 읽는 동안 await 경계에서 SCD가 바뀌었을 수 있다.
      // stage cache를 우회해 반환 직전에 한 번 더 확인해야 준비 작업이 stale pair로
      // DART 등록·저장을 진행하지 않는다. 시장 지표만 미해소인 broad 후보는 이 Map에
      // 들어오지 않으므로 과잉 차단도 없다.
      assertFreshIdentitySelections([...observedIdentitySelections.values()]);
      return {
        kind: 'NEEDS_DATA',
        candidateScopeKnown,
        unionEntries,
        needs: {
          factSymbols: [...factSymbols].sort(),
          actionSymbols: [...actionSymbols].sort(),
          priceSymbols: [...priceSymbols].sort(),
          selectionMetricDates: [...selectionMetricDates].sort(),
          priceRange,
        },
      };
    }
    // market-only 규칙도 최종 schedule에서 shortCode 기반 전략·엔진으로 넘어간다.
    // members 원문 전체를 한 batch로 검사해 unionEntries의 shortCode first-wins를
    // 신뢰하지 않으면서 DAY 일정의 날짜별 DB 왕복도 피한다.
    assertFreshIdentitySelections([
      ...observedIdentitySelections.values(),
      ...schedule.flatMap((entry) =>
        entry.members.map((member) => ({
          shortCode: member.symbol,
          standardCode: member.standardCode,
          effectiveDate: entry.effectiveDate,
        })),
      ),
    ]);
    return { kind: 'READY', schedule, diagnostics, unionEntries };
  }

  private requirePipelineDeps(): Required<Pick<
    UniverseRuleResolverDeps,
    'selectionMetrics' | 'candles' | 'facts' | 'factCoverage' | 'actionCoverage'
  >> {
    const { selectionMetrics, candles, facts, factCoverage, actionCoverage } = this.deps;
    if (!selectionMetrics || !candles || !facts || !factCoverage || !actionCoverage) {
      throw new Error('유니버스 선정 파이프라인 의존성이 연결되지 않았습니다.');
    }
    return { selectionMetrics, candles, facts, factCoverage, actionCoverage };
  }
}

/**
 * effectiveDate 시점 TTM 순이익에 필요한 재무 coverage 연도. 공시 지연 때문에 직전
 * 사업연도까지 본다. 하한은 준비 작업이 실제로 동기화하는 계획 범위
 * (`derivePreparationFactYearRange(period, 4)`)로 클램프한다 — 그보다 이른 연도를
 * 요구하면 어떤 sync 도 채울 수 없어 준비 작업이 같은 needs 를 반복하다 실패한다.
 */
function financialStageRequiredFactYears(effectiveDate: string, period: BacktestPeriod): number[] {
  const planRange = derivePreparationFactYearRange(period, 4);
  const effectiveYear = Number(effectiveDate.slice(0, 4));
  const fromYear = Math.max(effectiveYear - 1, planRange.fromYear);
  const years: number[] = [];
  for (let year = fromYear; year <= effectiveYear; year += 1) years.push(year);
  return years;
}

function yearsBetween(from: string, to: string): number[] {
  const years: number[] = [];
  for (let year = Number(from.slice(0, 4)); year <= Number(to.slice(0, 4)); year += 1) {
    years.push(year);
  }
  return years;
}

interface ExactPositiveRatio {
  readonly numerator: bigint;
  readonly denominator: bigint;
}

function positiveNumberFraction(value: number | null): ExactPositiveRatio | null {
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

function exactRatioRankingRows(
  candidates: readonly SymbolMasterEntry[],
  ratioOf: (entry: SymbolMasterEntry) => ExactPositiveRatio | null,
): UniverseStageValue[] {
  const ratios = candidates.flatMap((entry) => {
    const ratio = ratioOf(entry);
    return ratio === null ? [] : [{ entry, ...ratio }];
  });
  ratios.sort((a, b) => {
    const left = a.numerator * b.denominator;
    const right = b.numerator * a.denominator;
    if (left !== right) return left < right ? -1 : 1;
    return compareShortCodes(a.entry.shortCode, b.entry.shortCode);
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
  fromDate: string,
  effectiveDate: string,
): Promise<Map<string, import('../../market-data/domain/candle.js').Candle[]>> {
  const histories = new Map<string, import('../../market-data/domain/candle.js').Candle[]>();
  for await (const candle of candles.getCandles({
    market: 'KR',
    timeframe: '1d',
    symbols,
    // fromDate 의 KST 자정부터 — 직전 달력일의 끝 다음 ms 가 그 경계다.
    fromTsMs: kstEndOfDayMs(addCalendarDays(fromDate, -1)) + 1,
    toTsMs: kstEndOfDayMs(effectiveDate),
  })) {
    const list = histories.get(candle.symbol) ?? [];
    list.push(candle);
    histories.set(candle.symbol, list);
  }
  for (const list of histories.values()) list.sort((a, b) => a.tsMs - b.tsMs);
  return histories;
}
