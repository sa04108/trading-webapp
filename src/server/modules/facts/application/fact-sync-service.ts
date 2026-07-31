import { createHash } from 'node:crypto';
import type { Clock } from '../../../shared/clock.js';
import type { Logger } from '../../../shared/logger.js';
import type { Fact } from '../domain/fact.js';
import { planFactSync, type FactSyncMode } from '../domain/sync-plan.js';

/** 재무 버전 체인의 슬라이스 자리 — market-data 의 FACTS_SLICE 와 같은 값이어야 한다 */
const FACTS_SLICE = 'FACTS';
import type { FactCoverageStore } from './fact-coverage-store.js';
import type {
  FactIngestionGap,
  FactRepository,
  FactSource,
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
  readonly stopReason: 'ERROR' | 'CANCELLED' | null;
  /** 중단 사유 + 이어받는 방법을 담은 한국어 안내. 완주하면 null */
  readonly failureMessage: string | null;
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
  ) {}

  async sync(request: FactSyncRequest, hooks: FactSyncHooks = {}): Promise<FactSyncReport> {
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
    let stopReason: 'ERROR' | 'CANCELLED' | null = null;
    let failureReason: string | null = null;

    // 계획은 추정 경로와 같은 함수로 만든다 — 화면의 "약 30분" 과 실제 호출이 갈리지
    // 않게 한다 (domain/sync-plan.ts 헤더 참고)
    const plan = planFactSync({
      symbols,
      fromYear: request.fromYear,
      toYear: request.toYear,
      currentYear: new Date(this.clock.now()).getUTCFullYear(),
      coveredBySymbol: this.coverage.getCoveredYears(symbols),
      mode: request.mode,
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
      const shareYears = plan.shareYearsBySymbol.get(symbol) ?? [];
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

      try {
        const scoped = {
          symbols: [symbol],
          years,
          shareYears,
          consolidated: request.consolidated,
        };
        // 종목별 호출이지만 corp_code 매핑과 주식총수(stockTotqySttus) 응답 캐시는 소스
        // 인스턴스 클로저 안에 살아 있다 — 종목마다 다시 내려받지 않는다
        // (dart-fact-source.ts 의 corpCodes·shareRowsCache 참고).
        const financials = await this.source.fetchFinancials(scoped);
        const actions = await this.source.fetchCorporateActions(scoped);
        const facts = [...financials.facts, ...actions.facts];
        const symbolGaps = [...financials.gaps, ...actions.gaps];

        // 종목마다 저장한다 — 뒤에서 터져도 여기까지는 남는다
        const fingerprintBefore = await this.storedFactsFingerprint(symbol);
        await this.repository.saveFacts(facts);
        // 저장 직후에 이력을 남긴다. 순서가 뒤집히면 저장 실패한 연도를
        // 수집했다고 기록해 다음 실행이 그 구간을 건너뛴다.
        this.coverage.addCoveredYears(symbol, years, this.clock.now());
        // 버전도 종목마다 닫는다 — 180/200 에서 멈춘 실행의 앞선 179종목은 버전이
        // 올라가 있어야 그 종목을 쓰는 백테스트가 변경을 인식한다 (§9.5)
        await this.bumpVersionIfChanged(symbol, fingerprintBefore);

        savedFacts += facts.length;
        doneSymbols += 1;
        gaps.push(...symbolGaps);
        hooks.onSymbolDone?.({
          symbol,
          index: index + 1,
          total: symbols.length,
          savedFacts: facts.length,
          gapCount: symbolGaps.length,
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
