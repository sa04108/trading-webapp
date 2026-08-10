import { createHash } from 'node:crypto';
import type { Clock } from '../../../shared/clock.js';
import type { Logger } from '../../../shared/logger.js';
import type { Fact } from '../domain/fact.js';
import {
  estimateDartCalls,
  planFactSync,
  type FactSyncMode,
  type FactSyncPlan,
  type FactSyncWorkUnit,
} from '../domain/sync-plan.js';
// 원천은 market-data(symbol-service.ts) 쪽이다 — market-data 는 facts 를 몰라도
// 되지만(§7) facts 는 이미 market-data 를 안다(예: exchange-session.js 사용).
// 손으로 맞추던 중복 상수를 없앴다(리뷰 finding, 2026-08-08).
import { FACTS_SLICE } from '../../market-data/application/symbol-service.js';
import type { CorporateActionCoverageStore } from './corporate-action-coverage.js';
import type { FactCoverageStore } from './fact-coverage-store.js';
import type {
  FactIngestionGap,
  FactRepository,
  FactSource,
  FetchFinancialsRequest,
  SymbolVersionBumper,
} from './ports.js';

export interface FactSyncRequest {
  readonly symbols: readonly string[];
  readonly fromYear: number;
  readonly toYear: number;
  readonly consolidated: boolean;
  /**
   * FULL = 이력을 무시하고 지정 구간 전체 (CLI). INCREMENTAL = 미수집 연도 +
   * 현재 연도 (웹). 웹이 매번 전 구간을 다시 받으면 45분짜리 버튼이 된다.
   */
  readonly mode: FactSyncMode;
  /**
   * INCREMENTAL의 기본값은 현재 연도 재수집이다. 영속 준비 잡의 quota/crash 재개는
   * 이미 닫힌 symbol-year를 반복하면 안 되므로 false를 명시해 coverage를 그대로
   * 복구 체크포인트로 쓴다. FULL에는 영향이 없다.
   */
  readonly refreshCurrentYear?: boolean;
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
  /** 다음 종목·연도 외부 호출 전에 일일 quota를 예약한다. */
  beforeWorkUnit?(work: FactSyncWorkUnit): 'CONTINUE' | 'PAUSE_DAILY_QUOTA';
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
  /** 재무까지 받는 경로인지, 자본변동만 받는 경로인지 quota 비용 계산에 쓴다. */
  readonly includeFinancials: boolean;
  /** 증분 계획이 기준으로 삼을 커버리지. 경로마다 다른 저장소를 본다. */
  getCoveredYears(symbols: readonly string[]): ReadonlyMap<string, readonly number[]>;
  /**
   * 종목 하나를 수집한다. `actionGaps` 는 저장·리포트용 `gaps` 와 별도로 돌려준다 —
   * 자본변동 커버리지의 gap 연도는 자본변동 자신의 gap 에서만 뽑아야 하기 때문이다.
   */
  fetch(scoped: FetchFinancialsRequest): Promise<{
    facts: readonly Fact[];
    gaps: readonly FactIngestionGap[];
    actionGaps: readonly FactIngestionGap[];
  }>;
  /** 저장 성공 직후에만 부른다 — 저장 전에 부르면 실패한 연도를 수집했다고 기록한다. */
  recordCoverage(
    symbol: string,
    years: readonly number[],
    actionGapYears: readonly number[],
    nowMs: number,
  ): void;
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
 * 200종목 × 12년 백필(종목·연도당 9회 ≈ 22,400 호출, 일 한도 40,000, rate limiter 로
 * 최소 45분)에서 180번째 종목의 오류 하나가 앞선 179종목의 결과를 통째로 버린다.
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
      fetch: async (scoped) => {
        // 종목별 호출이지만 corp_code 매핑과 주식총수(stockTotqySttus) 응답 캐시는 소스
        // 인스턴스 클로저 안에 살아 있다 — 종목마다 다시 내려받지 않는다
        // (dart-fact-source.ts 의 corpCodes·shareRowsCache 참고).
        const financials = await this.source.fetchFinancials(scoped);
        const actions = await this.source.fetchCorporateActions(scoped);
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
   */
  planFinancialSync(
    symbols: readonly string[],
    fromYear: number,
    toYear: number,
    refreshCurrentYear = true,
  ): FactSyncPlan {
    const unique = [...new Set(symbols)];
    return planFactSync({
      symbols: unique,
      fromYear,
      toYear,
      currentYear: new Date(this.clock.now()).getUTCFullYear(),
      coveredBySymbol: this.coverage.getCoveredYears(unique),
      mode: 'INCREMENTAL',
      refreshCurrentYear,
    });
  }

  /**
   * `syncCorporateActions` 가 실제로 쓸 연도 계획을 미리 본다 (Task 8 게이트 화면).
   * 커버리지 조회(`actionCoverage`)·기준 연도(`clock`)·모드(`INCREMENTAL`)를 실행
   * 경로와 완전히 같게 둔다 — 화면의 예상 호출·시간이 실제 수집과 갈리면 안 된다
   * (`domain/sync-plan.ts` 헤더 참고).
   */
  planCorporateActionSync(
    symbols: readonly string[],
    fromYear: number,
    toYear: number,
    refreshCurrentYear = true,
  ): FactSyncPlan {
    const unique = [...new Set(symbols)];
    return planFactSync({
      symbols: unique,
      fromYear,
      toYear,
      currentYear: new Date(this.clock.now()).getUTCFullYear(),
      coveredBySymbol: this.actionCoverage.getCoveredYears(unique),
      mode: 'INCREMENTAL',
      refreshCurrentYear,
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
      fetch: async (scoped) => {
        const actions = await this.source.fetchCorporateActions(scoped);
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

    const gaps: FactIngestionGap[] = [];
    let savedFacts = 0;
    let doneSymbols = 0;
    let stoppedAtSymbol: string | null = null;
    let stopReason: 'ERROR' | 'CANCELLED' | 'DAILY_QUOTA' | null = null;
    let failureReason: string | null = null;

    // 계획은 추정 경로와 같은 함수로 만든다 — 화면의 "약 30분" 과 실제 호출이 갈리지
    // 않게 한다 (domain/sync-plan.ts 헤더 참고)
    const plan = planFactSync({
      symbols,
      fromYear: request.fromYear,
      toYear: request.toYear,
      currentYear: new Date(this.clock.now()).getUTCFullYear(),
      coveredBySymbol: strategy.getCoveredYears(symbols),
      mode: request.mode,
      refreshCurrentYear: request.refreshCurrentYear,
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
      const requestedShareYears = new Set<number>();
      try {
        for (const year of years) {
          // 단일 연도라도 연초 자본변동의 직전 주식총수 앵커가 필요하다. 소스 캐시가
          // 이전 unit의 응답을 재사용하므로 요청에는 둘 다 넣되 quota에는 새 연도만 센다.
          const shareYears = [year - 1, year];
          const work: FactSyncWorkUnit = {
            symbol,
            year,
            shareYears,
            estimatedDartCalls: estimateDartCalls(
              { symbol, year, shareYears },
              requestedShareYears,
              strategy.includeFinancials,
            ),
          };
          if (hooks.beforeWorkUnit?.(work) === 'PAUSE_DAILY_QUOTA') {
            stoppedAtSymbol = symbol;
            stopReason = 'DAILY_QUOTA';
            break;
          }

          const scoped = {
            symbols: [symbol],
            years: [year],
            shareYears,
            consolidated: request.consolidated,
          };
          const { facts, gaps: workGaps, actionGaps } = await strategy.fetch(scoped);

          // work unit마다 저장·커버리지를 닫는다 — 다음 연도 전에 quota로 멈춰도 이
          // 연도는 증분 재실행에서 건너뛸 수 있다.
          const fingerprintBefore = await this.storedFactsFingerprint(symbol);
          await this.repository.saveFacts(facts);
          // 팩트 0건이어도 시도의 실체(빈 파티션)를 남긴다 — coverage 는 parquet
          // 존재와 교차 확인해서만 읽히므로(parquet-consistent-coverage.ts), 파일이
          // 없으면 아래 recordCoverage 가 다음 조회에서 없던 일이 된다.
          await this.repository.ensurePartition('SYMBOL', symbol);

          // 저장 성공이 리포트의 확정 경계다. 뒤의 coverage나 버전 갱신이 실패해도
          // repository에는 이미 팩트가 남았으므로, 이 수치를 먼저 반영해야 보고서가
          // 실제 영속 상태와 어긋나지 않는다.
          savedFacts += facts.length;
          symbolSavedFacts += facts.length;
          symbolGapCount += workGaps.length;
          gaps.push(...workGaps);

          strategy.recordCoverage(symbol, [year], uniqueYearsFromGaps(actionGaps), this.clock.now());
          await this.bumpVersionIfChanged(symbol, fingerprintBefore);

          for (const shareYear of shareYears) requestedShareYears.add(shareYear);
        }

        if (stopReason === 'DAILY_QUOTA') break;
        doneSymbols += 1;
        hooks.onSymbolDone?.({
          symbol,
          index: index + 1,
          total: symbols.length,
          savedFacts: symbolSavedFacts,
          gapCount: symbolGapCount,
        });
      } catch (error) {
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

/** (key, field, periodKey, asOfTsMs, value) 튜플의 정렬 해시 — 저장 내용의 지문 */
export function factsFingerprint(facts: readonly Fact[]): string {
  // 구성요소 사이에 구분자가 없으면 경계가 다른 두 조합이 같은 문자열로 충돌한다
  // (parquet-fact-repository 의 병합 키와 같은 이유) — JSON.stringify 로 이스케이프한다.
  const rows = facts
    .map((fact) =>
      JSON.stringify([fact.key, fact.field, fact.periodKey, fact.asOfTsMs, fact.value]),
    )
    .sort();
  return createHash('sha256').update(rows.join('\n')).digest('hex');
}
