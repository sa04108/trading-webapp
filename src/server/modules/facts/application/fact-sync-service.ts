import { createHash } from 'node:crypto';
import type { Clock } from '../../../shared/clock.js';
import type { Logger } from '../../../shared/logger.js';
import { addCalendarDays, kstDateOf } from '../../market-data/domain/kst-date.js';
import type { Fact } from '../domain/fact.js';
import {
  planFactSync,
  type FactSyncMode,
  type FactSyncPlan,
} from '../domain/sync-plan.js';
// 원천은 market-data(symbol-service.ts) 쪽이다 — market-data 는 facts 를 몰라도
// 되지만(§7) facts 는 이미 market-data 를 안다(예: exchange-session.js 사용).
// 손으로 맞추던 중복 상수를 없앴다(리뷰 finding, 2026-08-08).
import { FACTS_SLICE } from '../../market-data/application/symbol-service.js';
import type { CorporateActionCoverageStore } from './corporate-action-coverage.js';
import type {
  FactCoverageStore,
  FinancialFilingCheckpoint,
} from './fact-coverage-store.js';
import { DartQuotaError, FactSourceNotConfiguredError } from './ports.js';
import type {
  FactIngestionGap,
  FactRepository,
  FactSource,
  FactSourceRequestHooks,
  FetchFinancialsRequest,
  PeriodicFiling,
  SymbolVersionBumper,
} from './ports.js';

export interface FactSyncRequest {
  readonly symbols: readonly string[];
  readonly fromYear: number;
  readonly toYear: number;
  readonly consolidated: boolean;
  /**
   * FULL = 이력을 무시하고 지정 구간 전체 (CLI). INCREMENTAL = 미수집 연도 +
   * watermark 이후 새 정기공시가 접수된 연도 (웹·준비 잡, detectRedisclosedYears
   * 참고). 웹이 매번 전 구간을 다시 받으면 45분짜리 버튼이 된다.
   */
  readonly mode: FactSyncMode;
}

/**
 * 공시검색(watermark 기반 재수집 판정)의 최대 되짚기 일수. 이보다 오래된 watermark 는
 * 목록 조회 구간이 커져 페이지 상한을 넘을 수 있으므로, 그 종목의 covered 연도를
 * 모두 다시 받는 보수적 규칙으로 되돌린다.
 */
const FILING_LOOKBACK_MAX_DAYS = 90;

/** 실제 DART 요청 직전 quota 예약이 거절됐음을 내부 흐름에 전달한다. */
class DartDailyQuotaReachedError extends Error {
  constructor() {
    super('DART 일일 호출 한도에 도달했습니다.');
    this.name = 'DartDailyQuotaReachedError';
  }
}

function isDartDailyQuotaError(error: unknown): boolean {
  return error instanceof DartDailyQuotaReachedError || error instanceof DartQuotaError;
}

/** 종목 하나가 끝날 때마다 호출된다 — 45분짜리 실행이 조용하지 않게 한다 */
export interface FactSyncProgress {
  readonly symbol: string;
  /** 1부터 시작하는 진행 번호 */
  readonly index: number;
  readonly total: number;
  /** 이 종목에서 저장된 팩트 수 */
  readonly savedFacts: number;
  /** 이 종목에서 남은 누락 수 */
  readonly gapCount: number;
}

export interface FactSyncHooks {
  onSymbolDone?(progress: FactSyncProgress): void;
  /**
   * 종목 경계에서 확인하는 취소 신호. 봉 수집이 페이지 경계에서 확인하는 것과 같은
   * 입자다 — 저장이 종목 단위이므로 여기서 멈추면 저장분과 이력이 정합하게 남는다.
   */
  shouldStop?(): boolean;
  /**
   * 실제 DART HTTP attempt 직전에 1건을 예약한다. 목록 페이지와 재시도도 각각 호출된다.
   */
  beforeDartRequest?(): 'CONTINUE' | 'PAUSE_DAILY_QUOTA';
}

export interface FactSyncReport {
  readonly savedFacts: number;
  readonly gaps: readonly FactIngestionGap[];
  /** 중단된 종목코드. 완주하면 null */
  readonly stoppedAtSymbol: string | null;
  /**
   * 중단 원인. 호출부가 잡 상태를 FAILED/CANCELLED 로 갈라야 하므로
   * stoppedAtSymbol 만으로는 부족하다.
   */
  readonly stopReason: 'ERROR' | 'CANCELLED' | 'DAILY_QUOTA' | null;
  /** 중단 사유 + 이어받는 방법을 담은 한국어 안내. 완주하면 null */
  readonly failureMessage: string | null;
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
  getCoveredYears(symbols: readonly string[]): ReadonlyMap<string, readonly number[]>;
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
    facts: readonly Fact[];
    gaps: readonly FactIngestionGap[];
    actionGaps: readonly FactIngestionGap[];
  }>;
  /** 팩트 저장·버전·공시 체크포인트 성공 뒤에만 수집 완료 연도를 기록한다. */
  recordCoverage(
    symbol: string,
    years: readonly number[],
    actionGapYears: readonly number[],
    nowMs: number,
  ): void;
}

/**
 * 공시검색으로 강제할 연도와, 그 연도를 성공적으로 받은 뒤 닫을 접수번호 체크포인트.
 * 자본변동 전용 경로는 기존 날짜 기반 판정을 유지하므로 pending map이 비어 있다.
 */
interface RedisclosureDetection {
  readonly forcedYearsBySymbol: ReadonlyMap<string, readonly number[]>;
  readonly pendingFinancialFilings: ReadonlyMap<
    string,
    ReadonlyMap<number, readonly FinancialFilingCheckpoint[]>
  >;
}

/**
 * gap 목록에서 연도만 뽑는다. periodKey 형식이 경로마다 다르다 — 재무는 'YYYYQ1',
 * 자본변동은 'YYYY-MM-DD', corp_code 매핑 실패는 '-' 다. 형식을 다 알 필요 없이
 * 맨 앞 네 자리 숫자를 연도로 본다 — 세 형식 모두 연도가 맨 앞에 온다.
 * '-' 처럼 숫자가 없으면 연도를 알 수 없으므로 그 gap 은 건너뛴다. 건너뛴 gap 도
 * `report.gaps` 에는 그대로 남으므로 사용자에게 감춰지지 않는다.
 *
 * 이 결과가 이번에 요청한 연도의 부분집합이라고 가정하면 안 된다.
 * `irdsSttus` 는 자본변동 이력을 보고서 연도 기준으로 누적 반환하므로(dart-fact-source.ts
 * 참고), gap 의 periodKey(이벤트 날짜)가 이번 요청 연도 밖을 가리킬 수 있다.
 */
function uniqueYearsFromGaps(gaps: readonly FactIngestionGap[]): number[] {
  const years = new Set<number>();
  for (const gap of gaps) {
    const match = /^(\d{4})/.exec(gap.periodKey);
    if (match) years.add(Number(match[1]));
  }
  return [...years].sort((a, b) => a - b);
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
  async sync(request: FactSyncRequest, hooks: FactSyncHooks = {}): Promise<FactSyncReport> {
    return this.runSync(request, hooks, {
      includeFinancials: true,
      getCoveredYears: (symbols) => this.coverage.getCoveredYears(symbols),
      getUpdatedAtMs: (symbols) => this.coverage.getUpdatedAtMs(symbols),
      fetch: async (scoped, sourceHooks) => {
        // 종목별 호출이지만 corp_code 매핑과 주식총수(stockTotqySttus) 응답 캐시는 소스
        // 인스턴스 클로저 안에 살아 있다 — 종목마다 다시 내려받지 않는다
        // (dart-fact-source.ts 의 corpCodes·shareRowsCache 참고).
        const financials = await this.source.fetchFinancials(scoped, sourceHooks);
        const actions = await this.source.fetchCorporateActions(scoped, sourceHooks);
        return {
          facts: [...financials.facts, ...actions.facts],
          gaps: [...financials.gaps, ...actions.gaps],
          actionGaps: actions.gaps,
        };
      },
      recordCoverage: (symbol, years, actionGapYears, nowMs) => {
        this.coverage.addCoveredYears(symbol, years, nowMs);
        this.actionCoverage.addCoveredYears(symbol, years, nowMs);
        this.actionCoverage.addGapYears(symbol, actionGapYears, nowMs);
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
    return planFactSync({
      symbols: unique,
      fromYear,
      toYear,
      todayKstDate: kstDateOf(this.clock.now()),
      coveredBySymbol: this.coverage.getCoveredYears(unique),
      mode: 'INCREMENTAL',
    });
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
    return planFactSync({
      symbols: unique,
      fromYear,
      toYear,
      todayKstDate: kstDateOf(this.clock.now()),
      coveredBySymbol: this.actionCoverage.getCoveredYears(unique),
      mode: 'INCREMENTAL',
    });
  }

  /**
   * 자본변동만 받는다 — 재무(`fnlttSinglAcntAll`·`irdsSttus`)는 부르지 않는다.
   * 재무는 캐시가 없어 종목마다 그대로 다시 쏘지만, 자본변동이 쓰는 발행주식수
   * (`stockTotqySttus`)는 `shareRowsCache` 로 캐시된다. 분할 보정만 필요한 전략에
   * 재무 수집 비용을 물리지 않으려고 이 경로를 둔다.
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
      getCoveredYears: (symbols) => this.actionCoverage.getCoveredYears(symbols),
      getUpdatedAtMs: (symbols) => this.actionCoverage.getUpdatedAtMs(symbols),
      fetch: async (scoped, sourceHooks) => {
        const actions = await this.source.fetchCorporateActions(scoped, sourceHooks);
        return { facts: actions.facts, gaps: actions.gaps, actionGaps: actions.gaps };
      },
      recordCoverage: (symbol, years, actionGapYears, nowMs) => {
        this.actionCoverage.addCoveredYears(symbol, years, nowMs);
        this.actionCoverage.addGapYears(symbol, actionGapYears, nowMs);
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
     * 호출이 계획의 `calls` 를 넘고(`fnlttSinglAcntAll`·`irdsSttus` 에는 캐시가 없어
     * 그대로 다시 쏜다) 화면의 예상 시간과 실행이 갈라진다. total 도 고유 종목 수여야
     * 진행률이 100% 에 닿는다 (설계 §3).
     */
    const symbols = [...new Set(request.symbols)];
    const todayKstDate = kstDateOf(this.clock.now());

    const gaps: FactIngestionGap[] = [];
    let savedFacts = 0;
    let doneSymbols = 0;
    let stoppedAtSymbol: string | null = null;
    let stopReason: 'ERROR' | 'CANCELLED' | 'DAILY_QUOTA' | null = null;
    let failureReason: string | null = null;
    const sourceHooks: FactSourceRequestHooks =
      hooks.beforeDartRequest === undefined
        ? {}
        : {
            beforeRequest: () => {
              if (hooks.beforeDartRequest?.() === 'PAUSE_DAILY_QUOTA') {
                throw new DartDailyQuotaReachedError();
              }
            },
          };

    // 증분 계획에 필요한 공시 목록부터 실제 요청 단위 quota를 적용한다. 목록 오류는
    // 최신 여부를 증명할 수 없으므로 명시적으로 중단한다. 단, 키 자체를 의도적으로
    // 설정하지 않은 환경은 이미 커버된 데이터 사용을 허용하는 기존 계약을 유지한다.
    const coveredBySymbol = strategy.getCoveredYears(symbols);
    const coverageWatermarks = strategy.getUpdatedAtMs(symbols);
    let redisclosures: RedisclosureDetection | undefined;
    try {
      redisclosures =
        request.mode === 'INCREMENTAL'
          ? await this.detectRedisclosedYears(
              symbols,
              coveredBySymbol,
              coverageWatermarks,
              strategy.includeFinancials,
              sourceHooks,
            )
          : undefined;
    } catch (error) {
      if (error instanceof FactSourceNotConfiguredError) {
        this.logger.warn(
          {
            module: 'facts',
            event: 'facts.filings.lookup-skipped-unconfigured',
          },
          'DART is not configured — skipping filing freshness lookup for already covered data',
        );
        redisclosures = undefined;
      } else {
        return this.reportPlanningFailure(symbols, error);
      }
    }

    const plan = planFactSync({
      symbols,
      fromYear: request.fromYear,
      toYear: request.toYear,
      todayKstDate,
      coveredBySymbol,
      mode: request.mode,
      forcedYearsBySymbol: redisclosures?.forcedYearsBySymbol,
    });

    for (const [index, symbol] of symbols.entries()) {
      // 취소는 종목을 시작하기 전에 확인한다 — 시작한 종목을 중간에 버리면
      // 저장분과 이력이 어긋난다
      if (hooks.shouldStop?.()) {
        stoppedAtSymbol = symbol;
        stopReason = 'CANCELLED';
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
      try {
        for (const [yearIndex, year] of years.entries()) {
          // 직전 연도의 주식총수 앵커도 요청하되, 소스 캐시는 이미 받은 응답을 재사용한다.
          // quota는 캐시 miss를 포함한 실제 HTTP 시도마다 sourceHooks가 정확히 예약한다.
          const shareYears = [year - 1, year];
          const scoped = {
            symbols: [symbol],
            years: [year],
            shareYears,
            consolidated: request.consolidated,
          };
          const { facts, gaps: workGaps, actionGaps } = await strategy.fetch(scoped, sourceHooks);

          // work unit마다 저장·커버리지를 닫는다 — 다음 연도 전에 quota로 멈춰도 이
          // 연도는 증분 재실행에서 건너뛸 수 있다.
          const fingerprintBefore = await this.storedFactsFingerprint(symbol);
          await this.repository.saveFacts(facts);

          // 저장 성공이 리포트의 확정 경계다. 뒤의 coverage나 버전 갱신이 실패해도
          // repository에는 이미 팩트가 남았으므로, 이 수치를 먼저 반영해야 보고서가
          // 실제 영속 상태와 어긋나지 않는다.
          savedFacts += facts.length;
          symbolSavedFacts += facts.length;
          symbolGapCount += workGaps.length;
          gaps.push(...workGaps);

          // gap 연도는 이번에 요청한 연도로 한정한다. irdsSttus 가 누적 이력을 주므로
          // 요청 밖 연도의 이벤트 gap(앵커 부재 등)이 딸려 오는데, 그 연도를 적으면
          // 해당 연도 자체 수집이 성공했어도 gap 이 남고 어떤 sync 도 지우지 못해
          // (covered 연도는 증분 계획에서 제외) 준비 작업이 무한 반복하다 실패한다.
          const gapYears = uniqueYearsFromGaps(actionGaps).filter((gapYear) => gapYear === year);
          await this.bumpVersionIfChanged(symbol, fingerprintBefore);

          const completedAtMs = this.clock.now();
          if (strategy.includeFinancials) {
            // 접수번호를 먼저 닫는다. 여기서 실패했는데 coverage watermark부터 전진하면
            // 다음 날 조회 하한 밖으로 밀려 실패한 체크포인트를 다시 볼 수 없다.
            this.coverage.addProcessedFilings(
              redisclosures?.pendingFinancialFilings.get(symbol)?.get(year) ?? [],
              completedAtMs,
            );
          }
          // 연도 coverage는 work unit마다 닫되 종목 단일 watermark는 이 종목의 계획을
          // 모두 마친 마지막 연도에서만 전진시킨다. 중간에 quota/오류가 나면 아직
          // 처리하지 못한 새 공시를 watermark가 앞질러 영구히 숨길 수 있기 때문이다.
          const coverageTimestamp = yearIndex === years.length - 1
            ? completedAtMs
            : (coverageWatermarks.get(symbol) ?? 0);
          strategy.recordCoverage(symbol, [year], gapYears, coverageTimestamp);
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
        if (isDartDailyQuotaError(error)) {
          stoppedAtSymbol = symbol;
          stopReason = 'DAILY_QUOTA';
          this.logger.info(
            {
              module: 'facts',
              event: 'facts.sync.daily-quota-reached',
              symbol,
              savedFacts,
            },
            'fact sync paused before exceeding the DART daily quota',
          );
          break;
        }

        // 그대로 던지면 지금까지 저장한 것을 알려줄 자리가 없다 — 리포트로 되돌려
        // CLI 가 어디까지 갔는지, 어떻게 이어받는지 말하게 한다.
        stoppedAtSymbol = symbol;
        stopReason = 'ERROR';
        failureReason = error instanceof Error ? error.message : String(error);
        this.logger.error(
          {
            module: 'facts',
            event: 'facts.sync.aborted',
            symbol,
            symbolIndex: index + 1,
            symbolTotal: symbols.length,
            savedFacts,
            err: error,
          },
          'fact sync aborted — earlier symbols are already saved',
        );
        break;
      }
    }

    this.logger.info(
      {
        module: 'facts',
        event: 'facts.synced',
        savedFacts,
        gapCount: gaps.length,
        stoppedAtSymbol,
        // 중단됐다는 사실만으로는 운영자가 실패와 취소를 구분할 수 없다
        stopReason,
      },
      'fact sync finished',
    );

    return {
      savedFacts,
      gaps,
      stoppedAtSymbol,
      stopReason,
      failureMessage:
        stoppedAtSymbol === null
          ? null
          : stopReason === 'CANCELLED'
            ? `수집이 사용자 요청으로 취소됐습니다 ` +
              `(${doneSymbols}/${symbols.length}종목 완료). ` +
              `수집된 팩트 ${savedFacts}건은 저장됐습니다 — 다시 실행하면 남은 종목만 이어받습니다.`
            : stopReason === 'DAILY_QUOTA'
              ? `DART 일일 호출 한도에 도달해 ${stoppedAtSymbol} 수집을 잠시 멈췄습니다 ` +
                `(${doneSymbols}/${symbols.length}종목 완료). ` +
                `여기까지 수집된 팩트 ${savedFacts}건은 이미 저장됐습니다 — 다음 실행은 ` +
                `남은 연도부터 이어받습니다.`
            : `수집이 ${stoppedAtSymbol} 에서 중단됐습니다 ` +
              `(${doneSymbols}/${symbols.length}종목 완료). ` +
              `사유: ${failureReason ?? '알 수 없음'}. ` +
              `여기까지 수집된 팩트 ${savedFacts}건은 이미 저장됐습니다 — 다시 실행하면 ` +
              `남은 구간만 이어받습니다.`,
    };
  }

  /** 증분 계획 단계의 실패도 성공 보고서로 위장하지 않고 호출부에 명확히 전달한다. */
  private reportPlanningFailure(
    symbols: readonly string[],
    error: unknown,
  ): FactSyncReport {
    const stoppedAtSymbol = symbols[0] ?? null;
    if (isDartDailyQuotaError(error)) {
      this.logger.info(
        {
          module: 'facts',
          event: 'facts.sync.daily-quota-reached',
          stage: 'planning',
          stoppedAtSymbol,
        },
        'fact sync planning paused before exceeding the DART daily quota',
      );
      return {
        savedFacts: 0,
        gaps: [],
        stoppedAtSymbol,
        stopReason: 'DAILY_QUOTA',
        failureMessage:
          'DART 일일 호출 한도에 도달해 증분 수집 계획 생성을 멈췄습니다. ' +
          '한도 초과 요청은 보내지 않았습니다 — 다음 실행에서 공시 목록 조회부터 다시 시작합니다.',
      };
    }

    const reason = error instanceof Error ? error.message : String(error);
    this.logger.error(
      {
        module: 'facts',
        event: 'facts.sync.planning-failed',
        stoppedAtSymbol,
        err: error,
      },
      'fact sync planning failed — fact collection was not started',
    );
    return {
      savedFacts: 0,
      gaps: [],
      stoppedAtSymbol,
      stopReason: 'ERROR',
      failureMessage:
        '증분 수집 계획 생성 중 정기공시 목록 또는 워터마크 조회에 실패했습니다. ' +
        `사유: ${reason}. 팩트 수집은 시작하지 않았습니다 — 원인을 해결한 뒤 다시 실행하세요.`,
    };
  }

  /**
   * 이미 covered 인 연도 중 다시 받아야 할 것을 공시검색으로 알아낸다.
   *
   * 예전의 "현재 연도는 항상 다시 받는다" 는 유니버스 전체 × 연도당 최대 12회를
   * 공시가 없어도 태웠다. 여기서는 종목별 coverage 기록 시각(watermark) 이후 접수된
   * 정기공시가 있는 종목·사업연도만 돌려준다 — 공시 없는 종목은 0 호출이다.
   * 재무 경로에서는 처리한 접수번호를 제외해 같은 날 같은 공시를 다시 받지 않는다.
   *
   * watermark가 조회 하한보다 오래된 종목은 공시 목록으로 판정할 수 없으므로 그
   * 종목의 covered 연도를 모두 다시 받는다. 수집 당시 진행 중이던 해를 연도 전체
   * covered로 닫은 뒤 90일이 지나도, 나중에 제출된 분기·사업보고서를 놓치지 않는다.
   * 반대로 목록 조회 자체가 실패하면 최신 여부를 확인할 수 없으므로 실패를 호출부까지
   * 전파한다.
   */
  private async detectRedisclosedYears(
    symbols: readonly string[],
    coveredBySymbol: ReadonlyMap<string, readonly number[]>,
    watermarks: ReadonlyMap<string, number>,
    trackFinancialReceipts: boolean,
    sourceHooks: FactSourceRequestHooks,
  ): Promise<RedisclosureDetection | undefined> {
    if (watermarks.size === 0) return undefined; // 수집 이력이 없다 — 증분 계획이 전부 받는다

    const today = kstDateOf(this.clock.now());
    const lookbackFloor = addCalendarDays(today, -FILING_LOOKBACK_MAX_DAYS);

    const forced = new Map<string, number[]>();
    const pending = new Map<string, Map<number, FinancialFilingCheckpoint[]>>();
    const addForced = (symbol: string, year: number): void => {
      const years = forced.get(symbol) ?? [];
      if (!years.includes(year)) years.push(year);
      forced.set(symbol, years);
    };
    const addPending = (checkpoint: FinancialFilingCheckpoint): void => {
      const byYear = pending.get(checkpoint.symbol) ?? new Map<number, FinancialFilingCheckpoint[]>();
      const filings = byYear.get(checkpoint.businessYear) ?? [];
      if (!filings.some((filing) => filing.receiptNo === checkpoint.receiptNo)) {
        filings.push(checkpoint);
      }
      byYear.set(checkpoint.businessYear, filings);
      pending.set(checkpoint.symbol, byYear);
    };

    const watermarkDates = new Map<string, string>();
    let fromDate: string | null = null;
    for (const [symbol, updatedAtMs] of watermarks) {
      const date = kstDateOf(updatedAtMs);
      if (date < lookbackFloor) {
        // 어느 covered 연도에 후속 공시가 생겼는지 목록으로 판별할 수 없다. 일부만
        // 갱신한 뒤 종목 watermark를 오늘로 옮기면 나머지 연도의 과거 공시가 영구히
        // 숨으므로, 이 종목의 covered 연도를 모두 한 번 다시 닫는다.
        for (const year of coveredBySymbol.get(symbol) ?? []) {
          addForced(symbol, year);
        }
        continue;
      }
      watermarkDates.set(symbol, date);
      if (fromDate === null || date < fromDate) fromDate = date;
    }

    if (fromDate !== null) {
      let filings: readonly PeriodicFiling[];
      try {
        filings = await this.source.listRecentPeriodicFilings(fromDate, today, sourceHooks);
      } catch (error) {
        // 일부 종목은 stale이고 일부는 fresh인 혼합 요청에서 DART 미설정 오류를 바깥
        // catch로 보내면, 이미 계산한 stale 강제 연도까지 통째로 사라진다. fresh 종목은
        // 기존 캐시를 쓸 수 있어도 stale 종목은 후속 보고서 누락 여부를 증명할 수 없으므로
        // forced 계획을 보존해 실제 fetch 단계에서 명시적으로 실패하게 한다.
        if (error instanceof FactSourceNotConfiguredError && forced.size > 0) {
          return { forcedYearsBySymbol: forced, pendingFinancialFilings: pending };
        }
        throw error;
      }
      const candidates = filings.flatMap((filing) => {
        const watermarkDate = watermarkDates.get(filing.stockCode);
        if (watermarkDate === undefined) return []; // 이번 요청 밖 종목이거나 blanket 처리됨
        // 접수일만 주는 API라 watermark 당일은 반드시 포함한다. 재무 경로의 중복은
        // 날짜 경계를 버리는 대신 아래의 영속 접수번호 체크포인트로 제거한다.
        if (filing.receiptDate < watermarkDate) return [];
        if (filing.businessYear === null) {
          throw new Error(
            `DART 정기공시 ${filing.receiptNo}의 사업연도를 보고서명에서 확인할 수 없습니다. `
              + '어느 covered 연도를 다시 받아야 하는지 추정하지 않고 팩트 준비를 중단합니다.',
          );
        }
        return [{ filing, businessYear: filing.businessYear }];
      });
      const processedReceiptNos = trackFinancialReceipts
        ? this.coverage.getProcessedFilingReceiptNos(
            candidates.map(({ filing }) => filing.receiptNo),
          )
        : new Set<string>();
      const seenReceiptNos = new Set<string>();

      for (const { filing, businessYear } of candidates) {
        if (seenReceiptNos.has(filing.receiptNo)) continue;
        seenReceiptNos.add(filing.receiptNo);
        if (processedReceiptNos.has(filing.receiptNo)) continue;

        addForced(filing.stockCode, businessYear);
        if (trackFinancialReceipts) {
          addPending({
            receiptNo: filing.receiptNo,
            symbol: filing.stockCode,
            businessYear,
            receiptDate: filing.receiptDate,
          });
        }
      }
    }

    return { forcedYearsBySymbol: forced, pendingFinancialFilings: pending };
  }

  /**
   * 저장된 팩트 내용이 실제로 달라졌으면 그 **종목의** 재무 버전을 올린다 (§9.5).
   *
   * 지문(seed)은 "지금 저장소에 들어 있는" 팩트에서 뽑는다 — 이번에 API 가 몇 건을
   * 돌려줬는지가 아니라 저장 결과가 기준이어야 같은 내용을 다시 수집했을 때 버전이
   * 헛돌지 않는다.
   */
  private async bumpVersionIfChanged(code: string, fingerprintBefore: string): Promise<void> {
    const fingerprintAfter = await this.storedFactsFingerprint(code);
    if (fingerprintAfter === fingerprintBefore) {
      this.logger.info(
        { module: 'facts', event: 'facts.version.unchanged', symbol: code },
        'fact content unchanged — symbol version not bumped',
      );
      return;
    }
    this.versions.bumpVersion(code, FACTS_SLICE, `facts:${fingerprintAfter}`, this.clock.now());
    this.logger.info(
      { module: 'facts', event: 'facts.version.bumped', symbol: code },
      'symbol fact version bumped',
    );
  }

  /**
   * 종목 하나의 SYMBOL 스코프 팩트 내용 지문. 정렬 후 해싱하므로 행 순서·수집 순서에
   * 흔들리지 않는다. (MACRO 스코프는 이 수집 경로가 만들지 않는다.)
   */
  private async storedFactsFingerprint(code: string): Promise<string> {
    const facts = await this.repository.getFacts({ scope: 'SYMBOL', keys: [code] });
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
      ]),
    )
    .sort();
  return createHash('sha256').update(rows.join('\n')).digest('hex');
}
