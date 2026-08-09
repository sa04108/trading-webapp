import type { z } from 'zod';
import type { Candle } from '../../market-data/domain/candle.js';
import type { OrderIntent, Position } from '../../backtest/domain/types.js';
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
   * 스스로 걸러낼 수 있게 노출한다. null 이면 일정이 지정되지 않아 제한이 없다는 뜻이다
   * (엔진의 리스크 검증도 이때는 항상 통과시킨다).
   */
  readonly tradableSymbols: ReadonlySet<string> | null;
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
  readonly parameterSchema: z.ZodType<TParameters>;

  initialize(context: StrategyInitializeContext): TState;

  onBars(context: StrategyBarContext, state: TState, parameters: TParameters): StrategyDecision;

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
   * 지금은 상장폐지 청산 하나뿐이다.
   *
   * 전략이 낸 매도가 아니므로 전략은 자기가 아직 보유 중이라고 믿는다.
   * 봉 사이에 들고 다니는 스톱 레벨·보유 플래그를 여기서 지우지 않으면
   * 없는 포지션에 매도 주문을 계속 낸다.
   *
   * 구현하지 않는 전략에는 영향이 없다.
   */
  onForcedExit?(symbol: string, state: TState): void;
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
