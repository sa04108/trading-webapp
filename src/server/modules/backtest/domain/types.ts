/** 백테스트 도메인 타입 — 순수 계산 계층, IO·프레임워크 의존 없음 */

export interface CostProfile {
  readonly id: string;
  readonly version: string;
  /** 매수 수수료율 (0.00015 = 0.015%) */
  readonly buyCommissionRate: number;
  /** 매도 수수료율 */
  readonly sellCommissionRate: number;
  /** 매도 관련 세금율 */
  readonly sellTaxRate: number;
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
  /** 최소 호가 단위. 0 이면 반올림 없음 */
  readonly tickSize: number;
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

export interface SymbolMetrics {
  readonly symbol: string;
  readonly tradeCount: number;
  readonly netPnl: number;
  readonly winRate: number | null;
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
