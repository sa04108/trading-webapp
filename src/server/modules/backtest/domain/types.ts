/** 백테스트 도메인 타입 — 순수 계산 계층, IO·프레임워크 의존 없음 */

export interface CostProfile {
  readonly id: string;
  readonly version: string;
  /** 매수 수수료율 (0.00015 = 0.015%) */
  readonly buyCommissionRate: number;
  /** 매도 수수료율 */
  readonly sellCommissionRate: number;
  /** 일정이 없거나 일정 시작 전인 체결에 적용할 매도 관련 세율 */
  readonly sellTaxRate: number;
  /** 체결 시각별 매도 관련 세율. fromTsMs 오름차순이며 마지막 유효 항목을 쓴다. */
  readonly sellTaxRateSchedule?: readonly {
    readonly fromTsMs: number;
    readonly rate: number;
  }[];
}

export interface SlippageProfile {
  readonly id: string;
  readonly version: string;
  /** 비율 슬리피지 (basis points, 5 = 0.05%) */
  readonly bps: number;
  /** 고정 슬리피지 (가격 단위) */
  readonly fixed: number;
}

export interface ExecutionRules {
  /** 고정 최소 호가 단위. 동적 프로파일이 없고 0 이면 반올림 없음 */
  readonly tickSize: number;
  /** KRX 보통주 체결일·시장·가격대별 호가단위 프로파일 */
  readonly tickSizeProfile?: {
    readonly id: 'krx-equity';
    readonly version: string;
    readonly market: 'KOSPI' | 'KOSDAQ';
  };
  /** 최소 주문 수량 */
  readonly minOrderQty: number;
}

export interface ExecutionProfile {
  readonly cost: CostProfile;
  readonly slippage: SlippageProfile;
  readonly rules: ExecutionRules;
}

export type OrderSide = 'BUY' | 'SELL';

export interface OrderIntent {
  readonly symbol: string;
  readonly side: OrderSide;
  readonly quantity: number;
  readonly reason?: string;
}

/** 제출 시점 유니버스 선정 자료를 그대로 고정한 값 — 실행 중 KRX 표를 다시 읽지 않는다. */
export interface SelectionMetricPin {
  readonly marketCapKrw: string | null;
  readonly volume: number | null;
  readonly tradingValueKrw: string | null;
}

export interface BacktestUniverseScheduleMember extends SelectionMetricPin {
  readonly symbol: string;
}

/**
 * 엔진이 소비하는 pin된 멤버십 일정.
 *
 * `symbols`는 Task 7 이전에 저장된 job과 직접 엔진 호출의 호환 경로다. 새 제출은
 * `members`를 넘겨 `StrategyBarContext.selectionMetric()`까지 재현한다.
 */
export interface BacktestUniverseScheduleEntry {
  readonly fromTsMs: number;
  readonly members?: readonly BacktestUniverseScheduleMember[];
  readonly symbols?: readonly string[];
}

export interface Fill {
  readonly symbol: string;
  readonly side: OrderSide;
  readonly quantity: number;
  /** 체결가 (슬리피지·호가 단위 반영) */
  readonly price: number;
  /** 체결가 × 수량 */
  readonly grossAmount: number;
  readonly commission: number;
  readonly tax: number;
  /** |체결가 - 기준가| × 수량 */
  readonly slippageCost: number;
  readonly tsMs: number;
  readonly reason?: string;
}

export interface Position {
  readonly symbol: string;
  quantity: number;
  avgEntryPrice: number;
  /** 매수 수수료 누적 — 청산 시 비례 배분. 슬리피지는 체결가에 반영되므로 제외 */
  entryCosts: number;
  entryTsMs: number;
}

/** 기간 종료 시점의 미청산 포지션 스냅샷 — 마지막 종가로 평가 (§9.4 경고와 짝) */
export interface OpenPositionSnapshot {
  readonly symbol: string;
  readonly quantity: number;
  readonly avgEntryPrice: number;
  readonly entryTsMs: number;
  readonly lastPrice: number;
  /** `lastPrice` 를 읽은 봉의 시각 — 기간 종료 시각과 벌어져 있으면 stale 이다 */
  readonly lastPriceTsMs: number;
  /** 매수 수수료 포함·매도 비용 미반영 평가손익 — 실현 손익이 아니다 */
  readonly unrealizedPnl: number;
  readonly returnPct: number;
}

/** 완결(청산) 거래 */
export interface Trade {
  readonly symbol: string;
  readonly quantity: number;
  readonly entryTsMs: number;
  readonly exitTsMs: number;
  readonly entryPrice: number;
  readonly exitPrice: number;
  readonly grossPnl: number;
  readonly costs: number;
  readonly netPnl: number;
  readonly returnPct: number;
  readonly holdingTimeMs: number;
  readonly exitReason?: string;
}

export interface EquityPoint {
  readonly tsMs: number;
  readonly equity: number;
}

export interface DrawdownPoint {
  readonly tsMs: number;
  /** 0 ~ -1 (peak 대비 비율) */
  readonly drawdown: number;
}

export interface MonthlyReturn {
  readonly year: number;
  readonly month: number;
  readonly returnPct: number;
}

/** 스펙 §9.6 필수 지표 */
export interface BacktestMetrics {
  readonly initialCash: number;
  readonly finalEquity: number;
  readonly totalReturnPct: number;
  readonly cagrPct: number | null;
  readonly maxDrawdownPct: number;
  readonly maxDrawdownDurationMs: number;
  readonly volatilityPct: number | null;
  readonly sharpe: number | null;
  readonly sortino: number | null;
  readonly calmar: number | null;
  readonly winRate: number | null;
  readonly profitFactor: number | null;
  readonly avgWin: number | null;
  readonly avgLoss: number | null;
  readonly maxConsecutiveWins: number;
  readonly maxConsecutiveLosses: number;
  readonly tradeCount: number;
  readonly avgHoldingTimeMs: number | null;
  readonly maxConcurrentPositions: number;
  readonly totalCommission: number;
  readonly totalTax: number;
  readonly totalSlippage: number;
}
