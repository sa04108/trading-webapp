import { ProviderRequestBlockedError } from "../../../shared/provider-request-policy.js";
import type {
  FactSyncRequest,
  FactSyncHooks,
  FactSyncReport,
} from "../../../../runtime/modules/facts/application/fact-sync-port.js";
export type {
  FactSyncRequest,
  FactSyncProgress,
  FactSyncHooks,
  FactSyncReport,
} from "../../../../runtime/modules/facts/application/fact-sync-port.js";
import { createHash } from "node:crypto";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import type { Clock } from "../../../../runtime/shared/clock.js";
import type { Logger } from "../../../shared/logger.js";
import { measureAsync, measureSync } from "../../../../runtime/shared/diagnostics.js";
import {
  kstDateOf,
} from "../../../../runtime/modules/market-data/domain/kst-date.js";
import {
  CORPORATE_ACTION_FIELD,
  type Fact,
} from "../../../../runtime/modules/facts/domain/fact.js";
import {
  DART_DAILY_CALL_LIMIT,
  DART_MIN_INTERVAL_MS,
  planFactSync,
  type FactSyncPlan,
} from "../../../../runtime/modules/facts/domain/sync-plan.js";
// 원천은 market-data(symbol-service.ts) 쪽이다 — market-data 는 facts 를 몰라도
// 되지만(§7) facts 는 이미 market-data 를 안다(예: exchange-session.js 사용).
// 손으로 맞추던 중복 상수를 없앴다(리뷰 finding, 2026-08-08).
import { FACTS_SLICE } from "../../../../runtime/modules/market-data/application/symbol-service.js";
import type {
  CorporateActionCoverageStore,
  CorporateActionGapDetail,
} from "../../../../runtime/modules/facts/application/corporate-action-coverage.js";
import type {
  FactCoverageStore,
} from "../../../../runtime/modules/facts/application/fact-coverage-store.js";
import {
  DartQuotaError,
} from "../../../../runtime/modules/facts/application/ports.js";
import type {
  FactIngestionGap,
  FactRepository,
  FactSource,
  FactSourceRequestHooks,
  FetchFinancialsRequest,
  SymbolVersionBumper,
} from "../../../../runtime/modules/facts/application/ports.js";

const REPORT_GAP_LIMIT = 100;
const REPORT_GAP_REASON_MAX_CHARS = 240;

/** 실제 DART 요청 직전 quota 예약이 거절됐음을 내부 흐름에 전달한다. */
class DartDailyQuotaReachedError extends Error {
  constructor() {
    super("DART 일일 호출 한도에 도달했습니다.");
    this.name = "DartDailyQuotaReachedError";
  }
}

function isDartDailyQuotaError(error: unknown): boolean {
  return (
    error instanceof DartDailyQuotaReachedError ||
    error instanceof DartQuotaError
  );
}

/**
 * `sync`·`syncCorporateActions` 가 갈라지는 지점 둘만 담는다 — 무엇을 수집하는가와
 * 어느 커버리지를 갱신하는가. 나머지(종목 순회·저장·취소·리포트 조립)는
 * `FactSyncService.runSync` 하나가 공유한다.
 */
interface SyncStrategy {
  /** 재무 접수번호 체크포인트까지 기록하는 경로인지 구분한다. */
  readonly includeFinancials: boolean;
  /** 증분 계획이 기준으로 삼을 커버리지. 경로마다 다른 저장소를 본다. */
  getCoveredYears(
    symbols: readonly string[],
  ): ReadonlyMap<string, readonly number[]>;
  /** current protocol과 무관한 실제 과거 수집 연도. freshness 확인에만 쓴다. */
  getCollectedYears(
    symbols: readonly string[],
  ): ReadonlyMap<string, readonly number[]>;
  /** 공시검색 하한. 재무와 자본변동이 각자의 watermark를 제공한다. */
  getUpdatedAtMs(symbols: readonly string[]): ReadonlyMap<string, number>;
  /**
   * 종목 하나를 수집한다. `actionGaps` 는 저장·리포트용 `gaps` 와 별도로 돌려준다 —
   * 자본변동 커버리지의 gap 연도는 자본변동 자신의 gap 에서만 뽑아야 하기 때문이다.
   */
  fetch(
    scoped: FetchFinancialsRequest,
    sourceHooks: FactSourceRequestHooks,
  ): Promise<{
    financialFacts: readonly Fact[];
    actionFacts: readonly Fact[];
    gaps: readonly FactIngestionGap[];
    financialGaps: readonly FactIngestionGap[];
    actionGaps: readonly FactIngestionGap[];
  }>;
  /** 팩트 저장·버전·공시 체크포인트 성공 뒤에만 수집 완료 연도를 기록한다. */
  recordCoverage(
    symbol: string,
    years: readonly number[],
    financialGaps: readonly FactIngestionGap[],
    actionGapDetails: readonly CorporateActionGapDetail[],
    nowMs: number,
  ): void;
}

function factPeriodYear(fact: Fact): number | null {
  const match = /^(\d{4})/.exec(fact.periodKey);
  if (!match) return null;
  const year = Number(match[1]);
  return Number.isInteger(year) ? year : null;
}

function actionGapsForYear(
  gaps: readonly FactIngestionGap[],
  year: number,
): FactIngestionGap[] {
  return gaps.filter((gap) => {
    const match = /^(\d{4})/.exec(gap.periodKey);
    const gapYear = match ? Number(match[1]) : year;
    return gapYear === year;
  });
}

function assertFetchedFactScopes(
  symbol: string,
  shareYears: readonly number[],
  financialFacts: readonly Fact[],
  actionFacts: readonly Fact[],
): void {
  const allowedFinancialYears = new Set(shareYears);
  for (const fact of financialFacts) {
    const year = factPeriodYear(fact);
    if (
      fact.scope !== "SYMBOL" ||
      fact.key !== symbol ||
      fact.field === CORPORATE_ACTION_FIELD ||
      year === null ||
      !allowedFinancialYears.has(year)
    ) {
      throw new Error(
        `DART 재무 응답이 요청 범위를 벗어났습니다: ` +
          `${fact.scope}/${fact.key}/${fact.field}/${fact.periodKey}`,
      );
    }
  }
  for (const fact of actionFacts) {
    if (
      fact.scope !== "SYMBOL" ||
      fact.key !== symbol ||
      fact.field !== CORPORATE_ACTION_FIELD
    ) {
      throw new Error(
        `DART 자본변동 응답이 요청 범위를 벗어났습니다: ` +
          `${fact.scope}/${fact.key}/${fact.field}/${fact.periodKey}`,
      );
    }
  }
}

/**
 * 재무·자본변동 수집 오케스트레이션.
 *
 * 누락(gap)은 삼키지 않고 리포트로 되돌린다 — 조용히 빠진 계정은 랭킹을 소리 없이
 * 왜곡한다 (설계 §4.1-2).
 *
 * **종목 단위로 수집하고 종목 단위로 저장한다.** 전 종목을 모아 마지막에 한 번 저장하면
 * 200종목 × 12년 백필(종목·연도당 12회 + 앵커 ≈ 29,600 호출, 일 한도 40,000,
 * rate limiter 로 최소 59분)에서 180번째 종목의 오류 하나가 앞선 179종목의 결과를
 * 통째로 버린다.
 * 저장을 종목마다 끊으면 수집 이력(symbol_facts_state)이 남아 다음 실행이 남은 종목만
 * 이어받는다.
 */
export class FactSyncService {
  constructor(
    private readonly source: FactSource,
    private readonly repository: FactRepository,
    private readonly logger: Logger,
    private readonly versions: SymbolVersionBumper,
    private readonly clock: Clock,
    private readonly coverage: FactCoverageStore,
    private readonly actionCoverage: CorporateActionCoverageStore,
  ) {}

  /**
   * 재무 + 자본변동을 함께 받는다. 자본변동도 같이 받으므로 자본변동 커버리지에도
   * 그 사실을 남긴다. 남기지 않으면 `syncCorporateActions` 가 이미 받은 연도를
   * 재무 없이 다시 청구한다.
   */
  async sync(
    request: FactSyncRequest,
    hooks: FactSyncHooks = {},
  ): Promise<FactSyncReport> {
    return this.runSync(request, hooks, {
      includeFinancials: true,
      getCoveredYears: (symbols) => this.coverage.getCoveredYears(symbols),
      getCollectedYears: (symbols) =>
        this.coverage.getCollectedYears?.(symbols) ??
        this.coverage.getCoveredYears(symbols),
      getUpdatedAtMs: (symbols) => this.coverage.getUpdatedAtMs(symbols),
      fetch: async (scoped, sourceHooks) => {
        // 같은 work-unit의 두 fetch는 request 객체를 공유한다. source가 주식총수 응답을
        // 한 번만 읽고, protocol 재처리에서는 세 DART 엔드포인트 원문도 영속 cache에서
        // 재생한다(dart-fact-source.ts의 requestRows·rawSnapshots 참고).
        const financials = await this.source.fetchFinancials(
          scoped,
          sourceHooks,
        );
        const actions = await this.source.fetchCorporateActions(
          scoped,
          sourceHooks,
        );
        return {
          financialFacts: financials.facts,
          actionFacts: actions.facts,
          gaps: [...financials.gaps, ...actions.gaps],
          financialGaps: financials.gaps,
          actionGaps: actions.gaps,
        };
      },
      recordCoverage: (
        symbol,
        years,
        financialGaps,
        actionGapDetails,
        nowMs,
      ) => {
        // action 결과를 먼저 원자적으로 남긴다. 반대 순서에서 action write가 실패하면
        // 재무 coverage가 이 work-unit을 완료로 만들어 다음 incremental retry가
        // gap 기록 없이 통째로 건너뛴다. 재무 write가 뒤에서 실패하는 경우에는 재무
        // coverage가 열려 있어 안전하게 전체 fetch를 다시 시도한다.
        this.actionCoverage.addCoverageResult(
          symbol,
          years,
          [...new Set(actionGapDetails.map((gap) => gap.year))],
          nowMs,
          actionGapDetails,
        );
        this.coverage.addCoverageResult(symbol, years, financialGaps, nowMs);
      },
    });
  }

  /**
   * `sync`가 실제로 쓸 재무 symbol-year 계획을 외부 호출 없이 미리 본다.
   * 준비 API의 DART-key 게이트가 "메타데이터상 필요"가 아니라 남은 coverage 작업을
   * 기준으로 판단할 때 쓴다.
   *
   * 공시 기반 강제 재수집(forcedYearsBySymbol)은 외부 호출이 필요해 여기 없다 —
   * 이 계획은 하한이다. 실행이 공시 갱신을 발견하면 실제 호출이 이보다 늘 수 있다.
   */
  planFinancialSync(
    symbols: readonly string[],
    fromYear: number,
    toYear: number,
  ): FactSyncPlan {
    const unique = [...new Set(symbols)];
    return this.withRawSnapshotMisses(
      planFactSync({
        symbols: unique,
        fromYear,
        toYear,
        todayKstDate: kstDateOf(this.clock.now()),
        coveredBySymbol: this.coverage.getCoveredYears(unique),
        mode: "INCREMENTAL",
      }),
      true,
    );
  }

  /**
   * `syncCorporateActions` 가 실제로 쓸 연도 계획을 미리 본다 (Task 8 게이트 화면).
   * 커버리지 조회(`actionCoverage`)·기준일(`clock`)·모드(`INCREMENTAL`)를 실행
   * 경로와 완전히 같게 둔다 — 화면의 예상 호출·시간이 실제 수집과 갈리면 안 된다
   * (`domain/sync-plan.ts` 헤더 참고). 강제 재수집이 빠진 하한인 것은
   * `planFinancialSync` 와 같다.
   */
  planCorporateActionSync(
    symbols: readonly string[],
    fromYear: number,
    toYear: number,
  ): FactSyncPlan {
    const unique = [...new Set(symbols)];
    return this.withRawSnapshotMisses(
      planFactSync({
        symbols: unique,
        fromYear,
        toYear,
        todayKstDate: kstDateOf(this.clock.now()),
        coveredBySymbol: this.actionCoverage.getCoveredYears(unique),
        mode: "INCREMENTAL",
      }),
      false,
    );
  }

  private withRawSnapshotMisses(
    plan: FactSyncPlan,
    includeFinancials: boolean,
  ): FactSyncPlan {
    if (this.source.countRawSnapshotMisses === undefined) return plan;
    const groups = new Map<
      string,
      {
        symbols: string[];
        years: readonly number[];
        shareYears: readonly number[];
        policy: "PREFER_CACHE" | "REFRESH";
      }
    >();
    for (const [symbol, years] of plan.yearsBySymbol) {
      const requestedYears = years;
      if (requestedYears.length === 0) continue;
      const shareYears = plan.shareYearsBySymbol.get(symbol) ?? [];
      const policy = "PREFER_CACHE" as const;
      const groupKey = JSON.stringify([policy, requestedYears, shareYears]);
      const group = groups.get(groupKey) ?? {
        symbols: [],
        years: requestedYears,
        shareYears,
        policy,
      };
      group.symbols.push(symbol);
      groups.set(groupKey, group);
    }
    let calls = 0;
    for (const group of groups.values()) {
      calls += this.source.countRawSnapshotMisses(
        {
          symbols: group.symbols,
          years: group.years,
          shareYears: group.shareYears,
          consolidated: true,
          rawSnapshotPolicy: group.policy,
        },
        includeFinancials,
      );
    }
    return {
      ...plan,
      calls,
      estimatedMs: calls * DART_MIN_INTERVAL_MS,
      overDailyLimit: calls > DART_DAILY_CALL_LIMIT,
    };
  }

  /**
   * 자본변동만 받는다 — 재무제표(`fnlttSinglAcntAll`)는 부르지 않는다. 자본변동
   * 원문(`irdsSttus`·`stockTotqySttus`)은 같은 work-unit과 이후 protocol 재처리에서
   * cache를 재사용한다. 분할 보정만 필요한 전략에 재무제표 비용을 물리지 않는다.
   *
   * 증분 판단은 자본변동 자신의 커버리지를 본다. 재무 커버리지를 보면 재무만 먼저
   * 받은 연도를 자본변동도 받았다고 잘못 판단한다.
   */
  async syncCorporateActions(
    request: FactSyncRequest,
    hooks: FactSyncHooks = {},
  ): Promise<FactSyncReport> {
    return this.runSync(request, hooks, {
      includeFinancials: false,
      getCoveredYears: (symbols) =>
        this.actionCoverage.getCoveredYears(symbols),
      getCollectedYears: (symbols) =>
        this.actionCoverage.getCollectedYears?.(symbols) ??
        this.actionCoverage.getCoveredYears(symbols),
      getUpdatedAtMs: (symbols) => this.actionCoverage.getUpdatedAtMs(symbols),
      fetch: async (scoped, sourceHooks) => {
        const actions = await this.source.fetchCorporateActions(
          scoped,
          sourceHooks,
        );
        return {
          financialFacts: [],
          actionFacts: actions.facts,
          gaps: actions.gaps,
          financialGaps: [],
          actionGaps: actions.gaps,
        };
      },
      recordCoverage: (
        symbol,
        years,
        _financialGaps,
        actionGapDetails,
        nowMs,
      ) => {
        this.actionCoverage.addCoverageResult(
          symbol,
          years,
          [...new Set(actionGapDetails.map((gap) => gap.year))],
          nowMs,
          actionGapDetails,
        );
      },
    });
  }

  /**
   * `sync` 와 `syncCorporateActions` 의 공통 몸통이다. 종목 순회·저장·취소·리포트
   * 조립은 두 경로가 같으므로 여기 하나만 둔다. 복제하면 한쪽만 고쳐질 때 두 경로가
   * 소리 없이 갈라진다.
   */
  private async runSync(
    request: FactSyncRequest,
    hooks: FactSyncHooks,
    strategy: SyncStrategy,
  ): Promise<FactSyncReport> {
    /**
     * 중복 심볼은 접는다. `planFactSync` 가 Set 으로 접으므로 순회가 접지 않으면 실제
     * work-unit이 계획보다 늘고 cache miss 원천 호출과 화면 예상도 함께 부푼다.
     * total 도 고유 종목 수여야
     * 진행률이 100% 에 닿는다 (설계 §3).
     */
    const symbols = [...new Set(request.symbols)];
    const todayKstDate = kstDateOf(this.clock.now());

    const gaps: FactIngestionGap[] = [];
    let gapCount = 0;
    let savedFacts = 0;
    let doneSymbols = 0;
    let stoppedAtSymbol: string | null = null;
    let stopReason: "ERROR" | "CANCELLED" | "DAILY_QUOTA" | null = null;
    let failureReason: string | null = null;
    const sourceHooks: FactSourceRequestHooks =
      hooks.beforeDartRequest === undefined
        ? {}
        : {
            beforeRequest: () => {
              if (hooks.beforeDartRequest?.() === "PAUSE_DAILY_QUOTA") {
                throw new DartDailyQuotaReachedError();
              }
            },
          };

    // 목록 최신성은 영속 일일 작업이 관리한다. 로컬 재생은 목록 호출과 독립적이다.
    const coveredBySymbol = strategy.getCoveredYears(symbols);
    const coverageWatermarks = strategy.getUpdatedAtMs(symbols);

    const plan = planFactSync({
      symbols,
      fromYear: request.fromYear,
      toYear: request.toYear,
      todayKstDate,
      coveredBySymbol,
      mode: request.mode,
    });

    for (const [index, symbol] of symbols.entries()) {
      // 캐시 적중이 연속돼도 HTTP 요청과 취소 신호가 종목 경계에서 처리되게 한다.
      await yieldToEventLoop();
      // 취소는 종목을 시작하기 전에 확인한다 — 시작한 종목을 중간에 버리면
      // 저장분과 이력이 어긋난다
      if (hooks.shouldStop?.()) {
        stoppedAtSymbol = symbol;
        stopReason = "CANCELLED";
        break;
      }

      const years = plan.yearsBySymbol.get(symbol) ?? [];
      if (years.length === 0) {
        // 받을 것이 없다 — 호출도 이력 갱신도 하지 않는다
        doneSymbols += 1;
        hooks.onSymbolDone?.({
          symbol,
          index: index + 1,
          total: symbols.length,
          savedFacts: 0,
          gapCount: 0,
        });
        continue;
      }

      let symbolSavedFacts = 0;
      let symbolGapCount = 0;
      const rawSnapshotScope = {};
      try {
        for (const year of years) {
          const rawSnapshotPolicy = "PREFER_CACHE" as const;
          // 직전 연도의 주식총수 앵커도 요청한다. 같은 work-unit의 재무·자본변동은
          // source 내부 request cache로 응답을 공유하고, 영속 cache hit는 quota를 쓰지 않는다.
          const shareYears = [year - 1, year];
          const scoped = {
            symbols: [symbol],
            years: [year],
            shareYears,
            consolidated: request.consolidated,
            rawSnapshotScope,
            rawSnapshotPolicy,
          };
          const { financialFacts, actionFacts, financialGaps, actionGaps } =
            await measureAsync(
              "fact_sync.fetch_source",
              () => strategy.fetch(scoped, sourceHooks),
              { itemCount: 1 },
            );
          assertFetchedFactScopes(
            symbol,
            shareYears,
            financialFacts,
            actionFacts,
          );

          // `fetchFinancials` 는 전년도 발행주식수 앵커도 함께 읽을 수 있다. 그 앵커를
          // 이번 재무 연도의 결과처럼 저장하면 전년도 snapshot/manifest가 coverage를
          // 닫지 않은 채 바뀐다. 비자본변동 재무는 정확히 현재 work-unit 연도만
          // 원자적으로 교체한다. 자본변동도 이벤트 연도별 최신 snapshot만 남긴다.
          const financialSnapshot = financialFacts.filter(
            (fact) =>
              fact.field !== CORPORATE_ACTION_FIELD &&
              factPeriodYear(fact) === year,
          );
          const currentFinancialGaps = financialGaps.filter((gap) => {
            const gapYear = /^\d{4}/.test(gap.periodKey)
              ? Number(gap.periodKey.slice(0, 4))
              : null;
            return gapYear === null || gapYear === year;
          });
          const actionSnapshot = actionFacts.filter(
            (fact) =>
              fact.field === CORPORATE_ACTION_FIELD &&
              factPeriodYear(fact) === year,
          );
          const currentActionGaps = actionGapsForYear(actionGaps, year);
          const currentActionGapDetails: CorporateActionGapDetail[] =
            currentActionGaps.map((gap) => ({
              year,
              periodKey: gap.periodKey,
              reason: gap.reason,
              severity: gap.severity,
            }));

          // work unit마다 저장·커버리지를 닫는다 — 다음 연도 전에 quota로 멈춰도 이
          // 연도는 증분 재실행에서 건너뛸 수 있다.
          const fingerprintBefore = await measureAsync(
            "fact_sync.fingerprint_before",
            () => this.storedFactsFingerprint(symbol),
          );
          if (strategy.includeFinancials) {
            await measureAsync("fact_sync.replace_financial", () => this.repository.replaceSymbolFinancialFactsForYear(
              symbol,
              year,
              financialSnapshot,
            ), { itemCount: financialSnapshot.length });
          }
          await measureAsync("fact_sync.replace_actions", () => this.repository.replaceSymbolCorporateActionFactsForYear(
            symbol,
            year,
            actionSnapshot,
          ), { itemCount: actionSnapshot.length });

          // 저장 성공이 리포트의 확정 경계다. 뒤의 coverage나 버전 갱신이 실패해도
          // repository에는 이미 팩트가 남았으므로, 이 수치를 먼저 반영해야 보고서가
          // 실제 영속 상태와 어긋나지 않는다.
          const persistedFactCount =
            financialSnapshot.length + actionSnapshot.length;
          savedFacts += persistedFactCount;
          symbolSavedFacts += persistedFactCount;
          symbolGapCount +=
            currentFinancialGaps.length + currentActionGaps.length;
          gapCount += currentFinancialGaps.length + currentActionGaps.length;
          for (const batch of [currentFinancialGaps, currentActionGaps]) {
            for (const gap of batch) {
              if (gaps.length >= REPORT_GAP_LIMIT) break;
              gaps.push({
                ...gap,
                reason: gap.reason.slice(0, REPORT_GAP_REASON_MAX_CHARS),
              });
            }
          }
          await measureAsync("fact_sync.version_update", () => this.bumpVersionIfChanged(symbol, fingerprintBefore));

          // 파서 재생은 공시 확인이 아니다. 일일 목록 checkpoint를 앞당기지 않는다.
          const coverageTimestamp = coverageWatermarks.get(symbol) ?? 0;
          measureSync("fact_sync.record_coverage", () => strategy.recordCoverage(
            symbol,
            [year],
            currentFinancialGaps,
            currentActionGapDetails,
            coverageTimestamp,
          ), { itemCount: 1 });
          // 연도 저장·버전·coverage를 마친 뒤에만 다른 요청에 실행을 양보한다.
          await yieldToEventLoop();
        }

        doneSymbols += 1;
        hooks.onSymbolDone?.({
          symbol,
          index: index + 1,
          total: symbols.length,
          savedFacts: symbolSavedFacts,
          gapCount: symbolGapCount,
        });
      } catch (error) {
        if (error instanceof ProviderRequestBlockedError) throw error;
        if (isDartDailyQuotaError(error)) {
          stoppedAtSymbol = symbol;
          stopReason = "DAILY_QUOTA";
          this.logger.info(
            {
              module: "facts",
              event: "facts.sync.daily-quota-reached",
              symbol,
              savedFacts,
            },
            "fact sync paused before exceeding the DART daily quota",
          );
          break;
        }

        // 그대로 던지면 지금까지 저장한 것을 알려줄 자리가 없다 — 리포트로 되돌려
        // CLI 가 어디까지 갔는지, 어떻게 이어받는지 말하게 한다.
        stoppedAtSymbol = symbol;
        stopReason = "ERROR";
        failureReason = error instanceof Error ? error.message : String(error);
        this.logger.error(
          {
            module: "facts",
            event: "facts.sync.aborted",
            symbol,
            symbolIndex: index + 1,
            symbolTotal: symbols.length,
            savedFacts,
            err: error,
          },
          "fact sync aborted — earlier symbols are already saved",
        );
        break;
      }
    }

    this.logger.info(
      {
        module: "facts",
        event: "facts.synced",
        savedFacts,
        gapCount,
        stoppedAtSymbol,
        // 중단됐다는 사실만으로는 운영자가 실패와 취소를 구분할 수 없다
        stopReason,
      },
      "fact sync finished",
    );

    return {
      savedFacts,
      gapCount,
      gaps,
      stoppedAtSymbol,
      stopReason,
      failureMessage:
        stoppedAtSymbol === null
          ? null
          : stopReason === "CANCELLED"
            ? `수집이 사용자 요청으로 취소됐습니다 ` +
              `(${doneSymbols}/${symbols.length}종목 완료). ` +
              `수집된 팩트 ${savedFacts}건은 저장됐습니다 — 다시 실행하면 남은 종목만 이어받습니다.`
            : stopReason === "DAILY_QUOTA"
              ? `DART 일일 호출 한도에 도달해 ${stoppedAtSymbol} 수집을 잠시 멈췄습니다 ` +
                `(${doneSymbols}/${symbols.length}종목 완료). ` +
                `여기까지 수집된 팩트 ${savedFacts}건은 이미 저장됐습니다 — 다음 실행은 ` +
                `남은 연도부터 이어받습니다.`
              : `수집이 ${stoppedAtSymbol} 에서 중단됐습니다 ` +
                `(${doneSymbols}/${symbols.length}종목 완료). ` +
                `사유: ${failureReason ?? "알 수 없음"}. ` +
                `여기까지 수집된 팩트 ${savedFacts}건은 이미 저장됐습니다 — 다시 실행하면 ` +
                `남은 구간만 이어받습니다.`,
    };
  }

  /**
   * 저장된 팩트 내용이 실제로 달라졌으면 그 **종목의** 재무 버전을 올린다 (§9.5).
   *
   * 지문(seed)은 "지금 저장소에 들어 있는" 팩트에서 뽑는다 — 이번에 API 가 몇 건을
   * 돌려줬는지가 아니라 저장 결과가 기준이어야 같은 내용을 다시 수집했을 때 버전이
   * 헛돌지 않는다.
   */
  private async bumpVersionIfChanged(
    code: string,
    fingerprintBefore: string,
  ): Promise<void> {
    const fingerprintAfter = await this.storedFactsFingerprint(code);
    if (fingerprintAfter === fingerprintBefore) {
      this.logger.debug(
        { module: "facts", event: "facts.version.unchanged", symbol: code },
        "fact content unchanged — symbol version not bumped",
      );
      return;
    }
    this.versions.bumpVersion(
      code,
      FACTS_SLICE,
      `facts:${fingerprintAfter}`,
      this.clock.now(),
    );
    this.logger.debug(
      { module: "facts", event: "facts.version.bumped", symbol: code },
      "symbol fact version bumped",
    );
  }

  /**
   * 종목 하나의 SYMBOL 스코프 팩트 내용 지문. 정렬 후 해싱하므로 행 순서·수집 순서에
   * 흔들리지 않는다. (MACRO 스코프는 이 수집 경로가 만들지 않는다.)
   */
  private async storedFactsFingerprint(code: string): Promise<string> {
    const facts = await this.repository.getFacts({
      scope: "SYMBOL",
      keys: [code],
    });
    return factsFingerprint(facts);
  }
}

/** 전체 Fact 튜플의 정렬 해시 — 저장 내용의 지문 */
export function factsFingerprint(facts: readonly Fact[]): string {
  // 구성요소 사이에 구분자가 없으면 경계가 다른 두 조합이 같은 문자열로 충돌한다
  // 저장소의 복합키와 같은 이유다 — JSON.stringify 로 이스케이프한다.
  const rows = facts
    .map((fact) =>
      JSON.stringify([
        fact.scope,
        fact.key,
        fact.field,
        fact.periodKey,
        fact.asOfTsMs,
        fact.value,
        fact.unit,
        fact.corporateActionBeforeShares ?? null,
        fact.corporateActionAfterShares ?? null,
      ]),
    )
    .sort();
  // 기존 정렬·개행 계약을 유지하면서 전체 원문 크기의 결합 문자열을 만들지 않는다.
  const hash = createHash("sha256");
  for (const [index, row] of rows.entries()) {
    if (index > 0) hash.update("\n");
    hash.update(row);
  }
  return hash.digest("hex");
}
