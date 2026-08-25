import type { z } from 'zod';
import type { Candle } from '../../market-data/domain/candle.js';
import type { OrderIntent, Position, SelectionMetricPin } from '../../backtest/domain/types.js';
import type { Rng } from '../../backtest/domain/seeded-rng.js';
import type { CorporateAction, FundamentalSnapshot } from '../../facts/domain/fact.js';

/** 전략이 보는 포트폴리오 스냅샷 (읽기 전용) */
export interface PortfolioView {
  readonly cash: number;
  readonly equity: number;
  readonly positions: ReadonlyMap<string, Readonly<Position>>;
}

export interface StrategyInitializeContext {
  readonly symbols: readonly string[];
  readonly initialCash: number;
  readonly rng: Rng;
}

export interface StrategyBarContext {
  readonly tsMs: number;
  /** 공유 멤버십 일정이 이 실제 거래 봉에서 처음 활성화됐을 때만 true */
  readonly isRebalanceBar: boolean;
  /** 이번 시점에 확정된 봉 (심볼별) */
  readonly bars: ReadonlyMap<string, Candle>;
  /** 현재 시점까지 확정된 봉 이력 — 미래 봉은 절대 포함되지 않는다 */
  getHistory(symbol: string): readonly Candle[];
  readonly portfolio: PortfolioView;
  readonly rng: Rng;
  /**
   * 현재 시점까지 공시된 재무만. 데이터가 없거나 아직 공시 전이면 null.
   * 미래 공시는 구조적으로 접근 불가다 (PitFactView 커서, §9.4 look-ahead).
   */
  fundamentals(symbol: string): FundamentalSnapshot | null;
  /** 효력 발생일이 현재 시점 이하인 자본변동 이벤트만 (분할 보정용) */
  corporateActions(symbol: string): readonly CorporateAction[];
  /**
   * 멤버십 일정(스펙 2026-08-05, §9.5)의 현재 시점 활성 유니버스 — 전략이 매수 후보를
   * 스스로 걸러낼 수 있게 노출한다. null 이면 일정도 영구 거래 제외도 없어 제한이 없다는
   * 뜻이다. 일정이 없어도 상장폐지 경계를 지난 단축코드가 있으면 나머지 집합으로 구체화된다.
   */
  readonly tradableSymbols: ReadonlySet<string> | null;
  /**
   * 현재 schedule의 활성 멤버십. 거래정지·무거래 종목도 포함하지만, 발행사를 구분할 수
   * 없는 상장폐지 단축코드는 제외한다. 그룹·보유 제약처럼 "유니버스에 속하는가"를 판단할
   * 때 쓰고, 실제 신규 매수 가능 여부는 tradableSymbols를 쓴다.
   */
  readonly activeUniverseSymbols: ReadonlySet<string> | null;
  /** 현재 활성 schedule member에 제출 시점에 pin된 선정 지표 */
  selectionMetric(symbol: string): SelectionMetricPin | null;
}

export interface StrategyDecision {
  readonly orders: readonly OrderIntent[];
}

/** 스펙 §8 전략 Port */
export interface TradingStrategy<TParameters, TState> {
  readonly id: string;
  readonly version: string;
  readonly name: string;
  readonly description: string;
  /**
   * 상장시점 재무 없이는 의미 있는 신호를 낼 수 없는 전략. 제출 검증이 데이터셋의
   * 재무 수집 여부를 확인해 거부한다 — 실행 후 "거래 0건" 으로 끝나면 원인을
   * 알 수 없다. 봉만 쓰는 전략은 이 필드를 생략한다.
   */
  readonly requiresFundamentals?: boolean;
  /** 백테스트 준비 잡이 필요한 최소 데이터 범위를 전략 구현과 같은 곳에서 읽는다. */
  readonly dataRequirements?: {
    readonly fundamentalLookbackQuarters?: number;
    readonly priceWarmupBars?: (parameters: TParameters) => number;
    readonly requiresCorporateActions?: boolean;
  };
  /**
   * 한 리밸런스 신호 뒤 다음 신호 전까지 필요한 비리밸런스 실제 거래 봉 수.
   *
   * 매도와 매수를 서로 다른 봉에서 계획하는 전략은 중간 봉을 매수 단계로 소비한다.
   * 이 제약을 만족하지 않는 일정을 허용하면 다음 리밸런스 신호가 조용히 유실되므로,
   * 제출 검증과 엔진이 같은 값으로 fail-fast한다.
   */
  readonly requiredRebalanceGapBars?: number;
  readonly parameterSchema: z.ZodType<TParameters>;

  initialize(context: StrategyInitializeContext): TState;

  onBars(context: StrategyBarContext, state: TState, parameters: TParameters): StrategyDecision;

  /**
   * 모든 봉 처리가 끝난 뒤 결과에 덧붙일 전략별 진단 경고다.
   * 주문이 한 건도 없었던 이유처럼 봉 처리 중에는 확정할 수 없는 상태를 설명한다.
   */
  completionWarnings?(state: TState, parameters: TParameters): readonly string[];

  /**
   * 보유 종목에 자본변동이 걸린 시점에 엔진이 부르는 선택 훅이다.
   * 엔진은 포지션 수량 조정과 같은 자리에서, 대기 주문 체결보다 먼저 부른다.
   *
   * `context.corporateActions(symbol)` 는 시점까지 누적된 전체 이력을 준다.
   * 이 훅은 방금 이 봉에 반영해야 할 합성 비율(`ratio`) 하나만 정확히 준다.
   * 전략은 봉 사이에 들고 다니는 가격 상태(스톱 레벨 등)를 여기서 고친다.
   *
   * 구현하지 않는 전략에는 영향이 없다.
   */
  onCorporateAction?(symbol: string, ratio: number, state: TState): void;

  /**
   * 엔진이 보유 포지션을 강제로 청산한 직후 부르는 선택 훅이다.
   * 상장폐지 또는 리밸런스 유니버스 이탈 청산에 사용한다.
   *
   * 전략이 낸 매도가 아니므로 전략은 자기가 아직 보유 중이라고 믿는다.
   * 봉 사이에 들고 다니는 스톱 레벨·보유 플래그를 여기서 지우지 않으면
   * 없는 포지션에 매도 주문을 계속 낸다.
   *
   * 구현하지 않는 전략에는 영향이 없다.
   */
  onForcedExit?(symbol: string, state: TState): void;
}

/** preparation·제출·worker·UI가 공유하는 전략 재무 필요 조건. */
export function strategyRequiresFinancialData<TParameters, TState>(
  strategy: Pick<
    TradingStrategy<TParameters, TState>,
    'requiresFundamentals' | 'dataRequirements'
  >,
): boolean {
  return strategy.requiresFundamentals === true
    || (strategy.dataRequirements?.fundamentalLookbackQuarters ?? 0) > 0;
}

/**
 * 레지스트리 저장용 — 파라미터·상태 타입을 지운 형태.
 *
 * `dataRequirements.priceWarmupBars`는 구체 파라미터를 입력으로 받으므로 `unknown`은
 * 함수 매개변수 반공변성상 개별 전략을 담을 수 없다. 레지스트리 경계에서만 타입을
 * 지우고, 실제 호출 전에는 각 전략의 parameterSchema로 검증한다.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyTradingStrategy = TradingStrategy<any, any>;
