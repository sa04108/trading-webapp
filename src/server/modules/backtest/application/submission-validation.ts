import { createHash } from "node:crypto";
import { measureAsync } from "../../../../runtime/shared/diagnostics.js";
import { periodToTsRange, type BacktestRequest } from "../../../../shared/schemas/backtest-request.js";
import type { ProvenancePin } from "../../../../shared/schemas/provenance-pin.js";
import type { Clock } from "../../../../runtime/shared/clock.js";
import type { DatabaseHandle } from "../../../../runtime/shared/db/database.js";
import { datasetIdentity } from "../../../../runtime/shared/db/database-layout.js";
import type { FactCoverageStore } from "../../../../runtime/modules/facts/application/fact-coverage-store.js";
import type { FinancialFactAvailabilityService } from "../../../../runtime/modules/facts/application/financial-fact-availability.js";
import type { FactRepository } from "../../../../runtime/modules/facts/application/ports.js";
import type { ConsumedVersionSnapshot, SymbolService } from "../../../../runtime/modules/market-data/application/symbol-service.js";
import type { SymbolMasterService } from "../../../../runtime/modules/market-data/application/symbol-master-service.js";
import type { CandleCoverageRow, CandleCoverageService } from "../../../../runtime/modules/market-data/application/candle-coverage-service.js";
import type { StrategyRegistry } from "../../../../runtime/modules/strategy/application/strategy-registry.js";
import { strategyRequiresFinancialData } from "../../../../runtime/modules/strategy/domain/strategy.js";
import { KRX_FILTER_POLICY_VERSION } from "../../../../runtime/modules/market-data/domain/krx-filter-policy.js";
import { estimateBars, MAX_BACKTEST_BARS } from "../domain/bar-estimate.js";
import { getCostProfile, getSlippageProfile } from "../../../../runtime/modules/backtest/domain/cost-profiles.js";
import { findRebalanceSpacingViolation, rebalanceSpacingViolationMessage } from "../../../../runtime/modules/backtest/domain/rebalance-spacing.js";
import type { LegacyUniverseScheduleEntry, ResolvedUniverse } from "../../../../runtime/modules/backtest/application/universe-rule-resolver.js";
import type { BacktestUniversePreview } from "../../../../runtime/modules/backtest/application/backtest-preparation-orchestrator.js";
import { assertSafePinnedScheduleIdentities, UnsafeBacktestSymbolIdentityError } from "../../../../runtime/modules/backtest/application/backtest-symbol-identity.js";
import { financialCoverageGapMessage, findFinancialCoverageGap } from "../../../../runtime/modules/backtest/application/backtest-financial-coverage.js";
import { delistedEventsToTsMsBySymbol, financialFactCutoffsFromCoverage } from "../../../../runtime/modules/backtest/application/backtest-financial-execution-window.js";
import { findIncompleteFundamentalCheckpointsFromCoverage } from "../../../../runtime/modules/backtest/application/backtest-financial-data-readiness.js";

export interface SubmissionValidationDeps {
  readonly database: DatabaseHandle;
  readonly strategies: StrategyRegistry;
  readonly symbolService: SymbolService;
  readonly symbolMaster: SymbolMasterService;
  readonly candleCoverage: CandleCoverageService;
  readonly factCoverage: FactCoverageStore;
  readonly financialFacts: Pick<FinancialFactAvailabilityService, "symbolsWithFinancialFacts">;
  readonly facts: Pick<FactRepository, "getFacts">;
  readonly clock: Clock;
  readonly maxBacktestBars?: () => number;
}
export type FundamentalsRequirementIssue =
  | { readonly kind: "COVERAGE_GAP"; readonly message: string }
  | { readonly kind: "INGESTION_GAP"; readonly message: string }
  | { readonly kind: "CANDLE_GAP"; readonly message: string }
  | { readonly kind: "STALE_FINANCIAL_DATA"; readonly message: string };

const isoDate = (tsMs: number): string =>
  new Date(tsMs).toISOString().slice(0, 10);

/**
 * 자본변동 수량은 사업보고서의 증자·감자 현황에서 읽는다.
 * 그래서 접수일이 효력발생일보다 최대 15개월 늦다
 * (pit-fact-view.ts 의 PitFactView 생성자 주석 참고).
 * 기간 끝이 이 안에 들면 분할이 이미 일어났어도 아직 DART 에
 * 접수되지 않았을 수 있다. 커버리지가 온전해도 뜨는 경고다(Task 6).
 */
const RECENT_PERIOD_LOOKBACK_MONTHS = 15;

function isRecentPeriodEnd(toTsMs: number, nowMs: number): boolean {
  const cutoff = new Date(nowMs);
  cutoff.setUTCMonth(cutoff.getUTCMonth() - RECENT_PERIOD_LOOKBACK_MONTHS);
  return toTsMs > cutoff.getTime();
}

export function pinnedScheduleIdentityError(
  schedule: readonly LegacyUniverseScheduleEntry[],
  symbolMaster: SymbolMasterService,
): string | null {
  try {
    assertSafePinnedScheduleIdentities(schedule, { symbolMaster });
    return null;
  } catch (error) {
    if (error instanceof UnsafeBacktestSymbolIdentityError)
      return error.message;
    throw error;
  }
}

/** 준비 job의 staged schedule을 계산 worker가 소비하는 pin 모양으로 좁힌다. */
export function preparedPreviewToResolved(
  preview: BacktestUniversePreview,
): ResolvedUniverse {
  const schedule = preview.schedule.map((entry) => ({
    rebalanceDate: entry.rebalanceDate,
    effectiveTradingDate: entry.effectiveDate,
    symbols: entry.members.map((member) => member.symbol),
    members: entry.members,
    excludedNonTradingCount: entry.excludedNonTradingCount,
  }));
  return {
    schedule,
    unionSymbols: [...preview.unionSymbols],
    unionEntries: new Map(),
    // worker가 실제 소비하는 legacy JSON 자체의 hash여야 provenance pin을 독립적으로
    // 재계산할 수 있다. staged hash는 preparation preview 안에 그대로 보존된다.
    scheduleHash: createHash("sha256")
      .update(JSON.stringify(schedule))
      .digest("hex"),
    uncoveredDates: [...preview.uncoveredDates],
  };
}

  /** 준비 hash를 조회하기 전에 끝낼 수 있는 요청 자체의 검증. */
export function validateStaticSubmission(body: BacktestRequest, strategies: StrategyRegistry): string[] {
    const errors: string[] = [];
    const strategy = strategies.get(body.strategyId);
    if (!strategy) {
      errors.push(`알 수 없는 전략: ${body.strategyId}`);
    } else {
      const paramCheck = strategies.validateParameters(
        body.strategyId,
        body.parameters,
      );
      if (!paramCheck.ok) errors.push(paramCheck.error);
    }
    if (body.period.from > body.period.to) {
      errors.push("기간이 올바르지 않습니다 (from > to)");
    }
    if (!getCostProfile(body.execution.commissionProfileId)) {
      errors.push("알 수 없는 수수료 프로파일");
    }
    if (!getSlippageProfile(body.execution.slippageProfileId)) {
      errors.push("알 수 없는 슬리피지 프로파일");
    }
    return errors;
}


/** 동일한 검증 규칙을 주입형 테스트와 격리 워커에서 실행한다. */
export function createSubmissionValidator(deps: SubmissionValidationDeps) {
  const { strategies, symbolService, symbolMaster, candleCoverage, factCoverage, financialFacts, clock } = deps;
  /**
   * 등록되지 않은 종목은 봉이 있어도 없는 것으로 취급한다(리뷰 finding, 2026-08-08).
   * `krx_daily_bars` 는 `symbols` 등록과 무관하게 채워지므로 `candleCoverage` 를
   * 그대로 쓰면 미등록 종목도 제출을 통과한다.
   *
   * 예전 `symbol_coverage` 캐시는 등록된 종목만 채워졌으므로 이 게이트는 캐시의
   * 부작용으로 공짜로 따라왔다. 캐시를 걷어낸 지금은 의도를 코드로 직접 말해야 한다.
   *
   * 이 게이트가 없으면 미등록 유니버스가 제출 시점(400) 이 아니라 큐 소비 후
   * 워커(`backtest-child.ts`)에서 늦게 죽는다.
   */
  const coverageCache = new Map<string, CandleCoverageRow[]>();
  const registeredCoverage = (codes: readonly string[]): CandleCoverageRow[] => {
    const key = JSON.stringify(codes);
    const cached = coverageCache.get(key);
    if (cached) return cached;
    const rows = candleCoverage
      .getCoverage(codes)
      .map((row) =>
        symbolService.exists(row.code)
          ? row
          : { code: row.code, firstTsMs: null, lastTsMs: null, barCount: 0 },
      );
    coverageCache.set(key, rows);
    return rows;
  };

  /**
   * 기간 × 종목별 커버리지 검사. 전체 이력 min/max가 아니라 요청 기간 안에서 worker와
   * 같은 유효성 규칙을 통과한 일봉을 센다. 확정 schedule의 종목 하나를 0봉이라는
   * 이유로 제외하면 실제 실행 유니버스가 달라지므로 일부 결측도 모두 거부한다.
   * `codes`는 리밸런스 일정의 합집합(unionSymbols)이다.
   */
  const checkPeriodCoverage = (
    codes: readonly string[],
    period: { from: string; to: string },
  ): string | null => {
    const { fromTsMs, toTsMs } = periodToTsRange(period);
    const inPeriod = new Map(
      candleCoverage
        .getCoverageBetween(codes, fromTsMs, toTsMs)
        .map(
          (row) =>
            [
              row.code,
              symbolService.exists(row.code)
                ? row
                : {
                    code: row.code,
                    firstTsMs: null,
                    lastTsMs: null,
                    barCount: 0,
                  },
            ] as const,
        ),
    );
    const allHistory = new Map(
      registeredCoverage(codes).map((row) => [row.code, row]),
    );

    const ranges: string[] = [];
    for (const symbol of codes) {
      const current = inPeriod.get(symbol);
      if (current && current.barCount > 0) continue;
      const full = allHistory.get(symbol);
      ranges.push(
        !full ||
          full.barCount === 0 ||
          full.firstTsMs === null ||
          full.lastTsMs === null
          ? `${symbol}: 수집된 데이터 없음`
          : `${symbol}: ${isoDate(full.firstTsMs)} ~ ${isoDate(full.lastTsMs)}`,
      );
    }

    return ranges.length === 0
      ? null
      : `선택한 기간에 일봉이 없는 유니버스 종목이 있습니다. 보유 범위 — ${ranges.join(", ")}`;
  };

  /**
   * 커버리지 확인 + 봉 수 상한 검사. 데이터셋·스냅샷 경로가 공유한다 — 유니버스가
   * 어디서 왔든 "이 종목 집합으로 이 기간에 얼마나 소비하나" 는 같은 질문이다.
   * 두 경로가 갈리는 지점은 기간 커버리지 판정 방식뿐이라 `coverageCheck` 로
   * 주입한다. 확정 유니버스의 종목을 일부만 빼고 실행하지 않도록 현재 경로도
   * 요청 기간 내 유효 일봉을 종목별로 엄격히 확인한다.
   *
   * 소비 timeframe 을 고르는 절차는 없다 — `Timeframe` 이 '1d' 하나뿐이라(Task 4)
   * 예전처럼 슬라이스별 가용성을 견줘 고를 것이 없다.
   */
  const resolveConsumedUniverse = (
    body: BacktestRequest,
    codes: readonly string[],
    errors: string[],
    coverageCheck: (codes: readonly string[]) => string | null,
  ): {
    universe: ConsumedVersionSnapshot;
    timeframe: "1d";
    estimatedBars: number;
  } | null => {
    const consumed = "1d" as const;

    // 유니버스 전체가 미등록이면 여기서 먼저 끊는다(리뷰 finding, 2026-08-08).
    // registeredCoverage 만 쓰면 이 경우도 "일봉이 없습니다" 로 뭉뚱그려진다.
    // krx_daily_bars 는 등록과 무관해 실제로는 봉이 있을 수 있으므로, 원인을
    // 등록 누락으로 정확히 짚어 준다.
    if (
      codes.length > 0 &&
      codes.every((code) => !symbolService.exists(code))
    ) {
      errors.push(
        `선택한 종목이 등록돼 있지 않습니다: ${codes.join(", ")} — 유니버스 미리보기를 ` +
          "실행해 종목을 등록한 뒤 다시 제출하세요.",
      );
      return null;
    }

    const hasData = registeredCoverage(codes).some((row) => row.barCount > 0);
    if (!hasData) {
      errors.push(
        "선택한 종목에 수집된 일봉이 없습니다 — 종목 마스터 수집을 먼저 실행하세요.",
      );
      return null;
    }

    const coverageError = coverageCheck(codes);
    if (coverageError !== null) {
      errors.push(coverageError);
      return null;
    }

    // 제출 시점의 종목 버전 스냅샷을 고정 — 대기 중 재무 동기화가 끼어들어도 어긋나지 않는다 (§9.5)
    const universe = symbolService.versionSnapshotFor(codes);

    // 논리적 봉 수 상한 — 로컬 실행기는 날짜별 입력과 별도의 작업 메모리 예산을 적용한다.
    const { fromTsMs, toTsMs } = periodToTsRange(body.period);
    const estimated = estimateBars(
      registeredCoverage(codes).map((row) => ({ ...row, symbol: row.code })),
      codes,
      fromTsMs,
      toTsMs,
    );
    const maxBars = deps.maxBacktestBars?.() ?? MAX_BACKTEST_BARS;
    if (estimated > maxBars) {
      errors.push(
        `예상 봉 수가 상한을 넘습니다 (추정 ${estimated.toLocaleString()}봉 > ` +
          `${maxBars.toLocaleString()}봉). 기간이나 종목 수를 줄이세요.`,
      );
      return null;
    }

    return { universe, timeframe: consumed, estimatedBars: estimated };
  };

  type ValidationResult =
    | {
        readonly ok: true;
        readonly universe: ConsumedVersionSnapshot;
        readonly timeframe: "1d";
        readonly estimatedBars: number;
        readonly provenancePin: ProvenancePin;
        readonly resolved: ResolvedUniverse;
        readonly warnings: readonly string[];
      }
    | { readonly ok: false; readonly status: 400; readonly errors: string[] }
    | {
        readonly ok: false;
        readonly status: 422;
        readonly errors: string[];
        readonly uncoveredDates?: readonly string[];
      };

  /**
   * 제출 검증 — 신규 제출(POST)과 즉시 복제(clone)가 동일한 기준을 거친다.
   * 통과 시 제출 시점의 유니버스 버전과 서버 소유 provenance pin(Task 12)을 함께
   * 반환한다 (재현성 §9.5, REVIEW §9.2). 400 메시지는 `errors[0]` 이므로 검사 순서가
   * 곧 우선순위다.
   *
   * 전략·기간·프로파일처럼 요청 자체의 형식 오류는 유니버스 해소보다 먼저 걸러
   * 반환한다. 어차피 거부할 요청 때문에 KRX 호출 예산(종목 마스터 조회·시총
   * join)을 쓰지 않기 위해서다.
   * 순서는 uncovered 리밸런스 날짜(422) → 캔들 존재 검증(400) 이다(①②).
   *
   * 자본변동 수집 게이트(Task 6, 여기 있던 ③)는 Task 10에서 없앴다 — 제출은 이제
   * 현재 사용자의 참조 행이 가리키는 exact preparation ID의 검증 결과를 전제하고,
   * 그 준비(`buildBacktestPreparationPlan`)가 전략의 `dataRequirements.
   * requiresCorporateActions`·DECLINE stage 후보에 따라 최종 유니버스의 자본변동을
   * 이미 동기화해 둔다. 실전에 등록된 전략은 전부 이 조건을 충족한다
   * (tests/unit/backtest-preparation-plan.test.ts 전략별 표 참고) — 제출 시점에
   * 이미 동기화하고, 해소되지 않은 blocking gap 종목은 차순위를 다시 계산해 제외한다.
   * 따라서 제출 시점에 다시 대조해도 선정 종목의 결측은 남지 않는다.
   *
   * `preparedPreview` 는 항상 있어야 한다 — 완료된 준비 없이 유니버스를 다시
   * 추측하는 옛 경로(`UniverseRuleResolver.resolve`, stages[0] 만 보는 stopgap)는
   * 없앴다. 완료된 준비가 없는 제출 호출자는 이 함수를 부르기 전에 스스로
   * "데이터 준비 필요" 로 갈라져야 한다. 초안 조회는 이 검증 자체를 호출하지 않는다
   * (D-050).
   */
  const validateSubmission = async (
    body: BacktestRequest,
    preparedPreview: BacktestUniversePreview,
  ): Promise<ValidationResult> => {
    // 전략 버전은 검사하지 않는다 (D-029) — 요청이 버전을 들고 다니지 않는다.
    // 실행되는 것은 언제나 지금 등록된 전략이다.
    const errors = validateStaticSubmission(body, strategies);

    if (errors.length > 0) {
      return { ok: false, status: 400, errors };
    }

    // ① 유니버스 규칙 → 리밸런스 날짜별 멤버십 일정. 커버 밖 날짜가 있으면 캔들
    // 검증으로 넘어가지 않고 바로 422 로 알린다 — 종목 구성 자체를 모르는 날짜의
    // 캔들을 따질 수 없다.
    const resolved = preparedPreviewToResolved(preparedPreview);
    if (resolved.uncoveredDates.length > 0) {
      return {
        ok: false,
        status: 422,
        errors: [
          `종목 마스터가 다음 리밸런스 날짜를 커버하지 않습니다: ${resolved.uncoveredDates.join(", ")} — ` +
            "데이터 탭에서 해당 날짜를 동기화한 뒤 다시 시도하세요.",
        ],
        uncoveredDates: resolved.uncoveredDates,
      };
    }

    // 리밸런스 날짜만 각각 수집된 coverage 섬이면 schedule 자체는 해소되지만,
    // 그 사이에 생긴 상장폐지·거래정지·종목 변경을 알 수 없다. 이 상태를 경고로만
    // 통과시키면 이미 없어진 종목을 계속 거래하는 낙관 편향이 생길 수 있으므로,
    // 기간 전체 KRX 마스터가 이어질 때까지 실행 생성 경로를 모두 막는다.
    // 복제 미리보기는 resolver를 다시 돌리지 않으므로 저장된 boolean을 신뢰하지
    // 않고 현재 coverage를 직접 확인한다. 그 사이 백필이 끝난 경우도 낡은 false로
    // 오거부하지 않는다.
    if (!symbolMaster.isRangeCovered(body.period.from, body.period.to)) {
      return {
        ok: false,
        status: 422,
        errors: [
          "종목 마스터가 백테스트 기간 전체를 커버하지 않습니다 — " +
            "유니버스 미리보기에서 기간 전체 동기화를 완료한 뒤 다시 제출하세요.",
        ],
      };
    }

    // 완료된 preparation 뒤 등록 행이 바뀌거나, 복제 계열이 resolver 재실행 없이
    // 저장된 미리보기를 재사용해도 shortCode 기반 봉·팩트를 다른 증권과 합치지 않는다.
    // schedule 원문을 보므로 unionEntries의 shortCode first-wins에도 의존하지 않는다.
    const identityError = pinnedScheduleIdentityError(
      resolved.schedule,
      symbolMaster,
    );
    if (identityError !== null) {
      return { ok: false, status: 422, errors: [identityError] };
    }

    // ② unionSymbols 캔들 존재 검증 — 하나라도 0봉이면 확정 schedule과 실제 실행
    // 유니버스가 달라지므로 종목별로 엄격히 확인한다.
    const universeErrors: string[] = [];
    const resolvedConsumption = resolveConsumedUniverse(
      body,
      resolved.unionSymbols,
      universeErrors,
      (codes) => checkPeriodCoverage(codes, body.period),
    );
    if (universeErrors.length > 0 || resolvedConsumption === null) {
      return {
        ok: false,
        status: 400,
        errors:
          universeErrors.length > 0
            ? universeErrors
            : ["제출을 검증할 수 없습니다"],
      };
    }

    // 2봉(매도 → 다음 봉 매수) 리밸런스 전략은 연속 실제 거래 봉에서 두 번째
    // isRebalanceBar를 매수 단계가 소비해 버린다. 달력 DAY 값만 보고 막으면 휴일을
    // 잘못 해석하고 정상적인 긴 주기까지 과잉 차단하므로, 확정 유니버스의 DISTINCT
    // 일봉 타임라인과 엔진의 schedule 활성화 규칙을 그대로 사용한다.
    const strategy = strategies.get(body.strategyId);
    const requiredRebalanceGapBars = strategy?.requiredRebalanceGapBars ?? 0;
    const { fromTsMs, toTsMs } = periodToTsRange(body.period);
    const spacingViolation = requiredRebalanceGapBars <= 0 ? null : findRebalanceSpacingViolation(
      candleCoverage.getTimeline(resolved.unionSymbols, fromTsMs, toTsMs),
      resolved.schedule.map((entry) => ({
        fromTsMs: Date.parse(`${entry.rebalanceDate}T00:00:00Z`),
      })),
      requiredRebalanceGapBars,
      fromTsMs,
    );
    if (strategy && spacingViolation !== null) {
      return {
        ok: false,
        status: 422,
        errors: [
          rebalanceSpacingViolationMessage(
            strategy.name,
            requiredRebalanceGapBars,
            spacingViolation,
          ),
        ],
      };
    }

    // 그래도 DART 공시 지연은 준비가 끝났다는 사실과 무관하게 남는 위험이라 경고는
    // 유지한다 — 최근 기간은 분할이 있었어도 아직 접수되지 않았을 수 있다.
    const warnings = [...new Set(preparedPreview.warnings)];
    if (isRecentPeriodEnd(periodToTsRange(body.period).toTsMs, clock.now())) {
      const warning =
        "선택한 기간이 최근이라 아직 DART 에 공시되지 않은 자본변동이 있을 수 있습니다. " +
        "분할이 최근에 있었다면 결과에 반영되지 않았을 수 있습니다.";
      if (!warnings.includes(warning)) warnings.push(warning);
    }

    // ③ 종목 버전 pin 은 기존 universeJson 메커니즘을 그대로 쓴다 — unionSymbols 기준.
    // ④ provenancePin — 순서형 유니버스 파이프라인(Task 11, 스펙 2026-08-09)은 늘 이
    // 모양이다. preparedPreview 가 항상 있으므로 diagnostics 도 늘 그 값에서 나온다.
    const provenancePin: ProvenancePin = {
      sourceKind: "SYMBOL_MASTER",
      filterPolicyVersion: KRX_FILTER_POLICY_VERSION,
      selectionMethod: "ORDERED_UNIVERSE_PIPELINE",
      universeRule: body.universeRule,
      scheduleHash: resolved.scheduleHash,
      diagnostics: preparedPreview.diagnostics,
      preparedAtMs: clock.now(),
    };

    return {
      ok: true,
      universe: resolvedConsumption.universe,
      timeframe: resolvedConsumption.timeframe,
      estimatedBars: resolvedConsumption.estimatedBars,
      provenancePin,
      resolved,
      warnings,
    };
  };

  /**
   * 재무 전략 데이터 요구 검사. `validateSubmission` 이 만드는
   * `errors` 배열에 합류시키지 않는 이유: 그 배열은 항상 400 으로 변환되는데, 이 조건은
   * 요청 형식 오류가 아니라 준비 데이터의 현재성 문제이므로 재준비 가능한 409로 돌려준다.
   * 신규 제출·즉시 clone·재설정 clone·난수 seed 생성이 같은 검사를 거친다. 완료된
   * preparation의 coverage 현재성 검사를 통과한 직후 데이터가 지워지는 race도 이
   * enqueue 직전 관문에서 다시 걸린다. 재설정용 초안은 D-050에 따라 검사를 미룬다.
   */
  const checkFundamentalsRequirement = async (
    body: BacktestRequest,
    unionSymbols: readonly string[],
    schedule: readonly LegacyUniverseScheduleEntry[],
  ): Promise<FundamentalsRequirementIssue | null> => {
    const strategy = strategies.get(body.strategyId);
    if (strategy === null || !strategyRequiresFinancialData(strategy))
      return null;
    // 일부 종목만 준비되지 않은 상태를 허용하면 그 종목이 랭킹 후보에서 조용히 빠져
    // 성과가 낙관적으로 치우친다. coverage뿐 아니라 전략이 실제 읽는 계정·연속 분기·
    // 신선도를 같은 PIT 시점으로 다시 확인한다.
    const gap = findFinancialCoverageGap({
      request: body,
      strategy,
      symbols: unionSymbols,
      coverage: factCoverage,
    });
    if (gap !== null) {
      return {
        kind:
          gap.kind === "BLOCKING_INGESTION_GAP"
            ? "INGESTION_GAP"
            : "COVERAGE_GAP",
        message: financialCoverageGapMessage(gap),
      };
    }
    const factCutoffs = financialFactCutoffsFromCoverage({
      period: body.period,
      schedule,
      delistedTsMsBySymbol: delistedEventsToTsMsBySymbol(
        symbolMaster.delistedEventsBetween(body.period.from, body.period.to),
      ),
      candles: candleCoverage,
    });
    const missingCutoffs = [...new Set(unionSymbols)].filter(
      (symbol) => !factCutoffs.has(symbol),
    );
    if (missingCutoffs.length > 0) {
      return {
        kind: "CANDLE_GAP",
        message:
          `실제 편입 기간·상장폐지 이전에 실행 가능한 일봉이 없는 종목이 있습니다: ${missingCutoffs.join(", ")} — ` +
          "일봉과 유니버스 데이터를 다시 준비하세요.",
      };
    }
    const readiness = strategy.dataRequirements?.fundamentalsReady;
    const missingFacts =
      readiness === undefined
        ? (() => {
            const symbolsWithFacts =
              financialFacts.symbolsWithFinancialFacts(factCutoffs);
            return unionSymbols.filter(
              (symbol) => !symbolsWithFacts.has(symbol),
            );
          })()
        : (
            await findIncompleteFundamentalCheckpointsFromCoverage({
              strategy,
              parameters: body.parameters,
              facts: deps.facts,
              schedule,
              candles: candleCoverage,
              period: body.period,
            })
          ).map((checkpoint) => checkpoint.symbol);
    if (missingFacts.length === 0) return null;
    // 정상 준비에서는 이 종목들이 이미 제외·재순위된다. 여기까지 왔다면 준비 확인과
    // enqueue 사이에 fact가 삭제됐거나 고정 clone snapshot이 낡은 것이다.
    return {
      kind: "STALE_FINANCIAL_DATA",
      message:
        `준비 완료 후 사용할 수 있는 재무 데이터가 사라진 종목이 있습니다: ${missingFacts.join(", ")} — ` +
        "유니버스 미리보기를 다시 준비하세요.",
    };
  };


  return {
    async validate(body: BacktestRequest, preview: BacktestUniversePreview) {
      // 캐시는 한 요청의 검증 안에서만 공유한다. DB 변경 뒤 재사용하지 않는다.
      coverageCache.clear();
      const snapshot = datasetIdentity(deps.database.sqlite);
      const result = await measureAsync("submission.coverage", () => validateSubmission(body, preview), { logStart: true, itemCount: preview.unionSymbols.length });
      if (!result.ok) return result;
      const fundamentalsIssue = await measureAsync("submission.fundamentals", () => checkFundamentalsRequirement(body, result.resolved.unionSymbols, result.resolved.schedule), { logStart: true, itemCount: result.resolved.unionSymbols.length });
      return { ...result, fundamentalsIssue, snapshot };
    },
  };
}

export type SubmissionValidationResult = Awaited<ReturnType<ReturnType<typeof createSubmissionValidator>["validate"]>>;
export interface SubmissionValidationInput {
  readonly body: BacktestRequest;
  readonly preview: BacktestUniversePreview;
  readonly maxBars: number;
  readonly nowMs: number;
  readonly snapshot: { readonly datasetId: string; readonly revision: number };
}
export interface SubmissionValidator {
  validate(input: SubmissionValidationInput, signal?: AbortSignal): Promise<SubmissionValidationResult>;
  stop(): Promise<void>;
}
