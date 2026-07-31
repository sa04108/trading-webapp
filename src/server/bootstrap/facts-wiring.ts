/**
 * market-data 와 facts 를 잇는 두 클로저.
 *
 * `market-data` 는 `facts` 를 import 하지 않는다 (§7, `.dependency-cruiser.cjs` 의
 * `market-data-no-facts`). 두 모듈을 잇는 지식은 조립부에만 있고, 그 지식이 바로
 * 이 파일이다.
 *
 * **두 클로저를 한 파일에 둔 이유.** 실행 경로(`factsPhase`)와 추정 경로
 * (`factsSyncEstimator`)는 같은 두 함수 — `deriveFactYearRange` 로 연도를,
 * `planFactSync` 로 호출 수·시간을 — 써야 한다. 갈라지면 화면의 "약 30분" 만 조용히
 * 틀려지고 틀렸다는 사실도 드러나지 않는다 (`facts/domain/sync-plan.ts` 헤더).
 * 나란히 두면 한쪽만 고치는 변경이 눈에 띈다.
 *
 * `container.ts` 안의 인라인 클로저가 아니라 팩토리인 이유는 테스트 가능성이다.
 * 아래 `createFactsPhase` 의 누적은 타입으로 잡히지 않는 종류의 버그를 막고 있어
 * (주석 참고) 주석이 아니라 테스트가 지켜야 한다 — `createContainer` 는 DuckDB·
 * SQLite·DART 클라이언트를 통째로 세우므로 그 경로로는 이 한 줄을 겨눌 수 없다.
 */

import type { Clock } from '../shared/clock.js';
import type { FactCoverageStore } from '../modules/facts/application/fact-coverage-store.js';
import type {
  FactSyncHooks,
  FactSyncReport,
  FactSyncRequest,
} from '../modules/facts/application/fact-sync-service.js';
import { planFactSync } from '../modules/facts/domain/sync-plan.js';
import type { FactsSyncEstimate } from '../modules/market-data/application/dataset-service.js';
import type { Market } from '../modules/market-data/domain/candle.js';
import {
  deriveFactYearRange,
  type FactYearRangeCoverageRow,
} from '../modules/market-data/domain/fact-year-range.js';

/** `FactSyncService.sync` 만 쓴다 — 테스트가 fake 로 대체할 수 있게 좁혀 받는다 */
export interface FactSyncPort {
  sync(request: FactSyncRequest, hooks?: FactSyncHooks): Promise<FactSyncReport>;
}

export interface FactsPhaseDeps {
  readonly factSyncService: FactSyncPort;
}

/**
 * 재무 단계 — `BrokerSyncDeps.factsPhase` 로 주입된다.
 * `config.dartApiKey` 가 없으면 조립부가 아예 만들지 않는다 → `BrokerSyncService` 가
 * skipReason 을 남긴다.
 */
export function createFactsPhase(deps: FactsPhaseDeps) {
  return async (args: {
    codes: readonly string[];
    fromYear: number;
    toYear: number;
    onProgress: (progress: {
      symbolsDone: number;
      symbolTotal: number;
      savedFacts: number;
      gapCount: number;
    }) => void;
    shouldStop: () => boolean;
  }) => {
    // FactPhaseProgress 는 **누적**, FactSyncProgress 는 **종목 단위**다. 필드를
    // 1:1 로 옮기면 (둘 다 number 라 타입으로는 잡히지 않는다) 화면 카운터가
    // 종목마다 12 → 0 → 8 → 0 으로 튄다 — 여기서 누적해서 넘긴다.
    let savedFacts = 0;
    let gapCount = 0;
    const report = await deps.factSyncService.sync(
      {
        symbols: args.codes,
        fromYear: args.fromYear,
        toYear: args.toYear,
        consolidated: true,
        // 웹은 증분이다 — 매번 전 구간을 다시 받으면 45분짜리 버튼이 된다.
        // 과거 연도 정정공시 전체 재수집은 CLI(facts:sync --from --to)가 담당한다.
        mode: 'INCREMENTAL',
      },
      {
        shouldStop: args.shouldStop,
        onSymbolDone: (progress) => {
          savedFacts += progress.savedFacts;
          gapCount += progress.gapCount;
          args.onProgress({
            symbolsDone: progress.index,
            symbolTotal: progress.total,
            savedFacts,
            gapCount,
          });
        },
      },
    );
    return {
      savedFacts: report.savedFacts,
      // 리포트는 누락을 목록으로 돌려준다 — 잡 상태에는 개수만 싣는다
      gapCount: report.gaps.length,
      stopReason: report.stopReason,
      failureMessage: report.failureMessage,
    };
  };
}

export interface FactsSyncEstimatorDeps {
  /** null 이면 이 배포에 DART 가 설정되지 않았다 */
  readonly dartApiKey: string | null;
  readonly symbolService: {
    listSymbols(): ReadonlyArray<{ readonly code: string; readonly market: Market }>;
    getCoverage(
      codes?: readonly string[],
    ): ReadonlyArray<Omit<FactYearRangeCoverageRow, 'symbol'> & { readonly code: string }>;
  };
  readonly factCoverageStore: Pick<FactCoverageStore, 'getCoveredYears'>;
  readonly clock: Clock;
}

/**
 * 재무 수집 예상. 실행 경로(`BrokerSyncService` → `factsPhase`)와 **같은 두 함수** 를
 * 부른다 — `deriveFactYearRange` 로 연도를, `planFactSync` 로 호출 수·시간을.
 */
export function createFactsSyncEstimator(
  deps: FactsSyncEstimatorDeps,
): (codes: readonly string[]) => FactsSyncEstimate {
  return (codes: readonly string[]): FactsSyncEstimate => {
    if (!deps.dartApiKey) {
      return { basis: 'UNSUPPORTED', reason: 'DART 인증키가 설정되지 않아 재무를 수집할 수 없습니다.' };
    }
    if (codes.length === 0) return { basis: 'UNSUPPORTED', reason: '선택된 종목이 없습니다.' };
    const known = deps.symbolService.listSymbols().filter((symbol) => codes.includes(symbol.code));
    if (known.length === 0) {
      return { basis: 'UNSUPPORTED', reason: '등록되지 않은 종목입니다.' };
    }
    const foreign = known.filter((symbol) => symbol.market !== 'KR');
    if (foreign.length > 0) {
      return {
        basis: 'UNSUPPORTED',
        reason: `재무 데이터 수집은 국내(KR) 종목만 지원합니다 — ${foreign
          .map((symbol) => symbol.code)
          .join(', ')} 는 대상이 아닙니다.`,
      };
    }
    const coverage = deps.symbolService
      .getCoverage(codes)
      .map((row) => ({ ...row, symbol: row.code }));
    const range = deriveFactYearRange(coverage, 'KR');
    if (range === null) return { basis: 'AFTER_CANDLES' };

    // 호출 수·시간은 plan 이 준 값을 그대로 쓴다 — 상수로 다시 계산하면 앵커가
    // 연속 구간마다 붙는 불연속 증분에서 과소 추정이 된다 (sync-plan.ts 참고).
    const plan = planFactSync({
      symbols: codes,
      fromYear: range.fromYear,
      toYear: range.toYear,
      currentYear: new Date(deps.clock.now()).getUTCFullYear(),
      coveredBySymbol: deps.factCoverageStore.getCoveredYears(codes),
      mode: 'INCREMENTAL',
    });
    return {
      basis: 'PLANNED',
      fromYear: range.fromYear,
      toYear: range.toYear,
      calls: plan.calls,
      estimatedMs: plan.estimatedMs,
      overDailyLimit: plan.overDailyLimit,
    };
  };
}
