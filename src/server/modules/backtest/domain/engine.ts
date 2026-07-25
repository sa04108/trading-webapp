import type { Candle } from '../../market-data/domain/candle.js';
import type {
  AnyTradingStrategy,
  PortfolioView,
  StrategyBarContext,
} from '../../strategy/domain/strategy.js';
import { proceedsFromSell, requiredCashForBuy, simulateFill } from './execution.js';
import {
  computeDrawdownSeries,
  computeMetrics,
  computeMonthlyReturns,
  computeSymbolMetrics,
} from './metrics.js';
import { createRng } from './seeded-rng.js';
import type {
  BacktestMetrics,
  DrawdownPoint,
  EquityPoint,
  ExecutionProfile,
  Fill,
  MonthlyReturn,
  OrderIntent,
  Position,
  SymbolMetrics,
  Trade,
} from './types.js';

export interface BacktestRunInput {
  /** 기간·심볼 필터가 끝난 확정 봉 전체 (임의 순서 허용 — 엔진이 정렬) */
  readonly candles: readonly Candle[];
  readonly initialCash: number;
  readonly execution: ExecutionProfile;
  /** 전략 parameterSchema 로 검증이 끝난 파라미터 */
  readonly parameters: unknown;
  readonly randomSeed: number;
  /** 동시 보유 종목 상한 (리스크 검증 §9.2-6) */
  readonly maxPositions: number;
}

export interface EngineHooks {
  onProgress?(progress: {
    processedBars: number;
    totalBars: number;
    currentTsMs: number;
  }): void;
  shouldCancel?(): boolean;
}

export interface BacktestRunResult {
  readonly metrics: BacktestMetrics;
  readonly equityPoints: readonly EquityPoint[];
  readonly drawdownPoints: readonly DrawdownPoint[];
  readonly trades: readonly Trade[];
  readonly fills: readonly Fill[];
  readonly monthlyReturns: readonly MonthlyReturn[];
  readonly symbolMetrics: readonly SymbolMetrics[];
  readonly warnings: readonly string[];
  readonly cancelled: boolean;
  readonly processedBars: number;
}

/** 재현성 메타데이터에 기록되는 엔진 버전 (스펙 §9.5) — 체결·지표 로직 변경 시 올린다 */
export const ENGINE_VERSION = '1.0.0';

const PROGRESS_INTERVAL_BARS = 500;

/**
 * 이벤트 루프 (스펙 §9.2):
 *  1. 이전 시점의 대기 주문 체결 (이번 봉 시가)
 *  2. 현금·포지션 갱신
 *  3. 평가금액 갱신
 *  4. 현재까지 확정된 봉을 전략에 전달
 *  5. 신규 주문 의도 생성
 *  6. 리스크 검증
 *  7. 다음 봉 체결 대기열 등록
 *  8. 스냅샷·진행률
 *
 * 전략은 현재 시점까지의 봉만 볼 수 있고(look-ahead 금지, §9.1),
 * 주문은 다음 거래 가능 봉의 시가에서 체결된다.
 */
export function runBacktest(
  strategy: AnyTradingStrategy,
  input: BacktestRunInput,
  hooks: EngineHooks = {},
): BacktestRunResult {
  const sorted = [...input.candles].sort((a, b) =>
    a.tsMs === b.tsMs ? (a.symbol < b.symbol ? -1 : 1) : a.tsMs - b.tsMs,
  );

  // 타임라인 구성
  const barsByTs = new Map<number, Map<string, Candle>>();
  for (const candle of sorted) {
    const bucket = barsByTs.get(candle.tsMs) ?? new Map<string, Candle>();
    bucket.set(candle.symbol, candle);
    barsByTs.set(candle.tsMs, bucket);
  }
  const timeline = [...barsByTs.keys()].sort((a, b) => a - b);
  const symbols = [...new Set(sorted.map((c) => c.symbol))].sort();
  const totalBars = sorted.length;

  const rng = createRng(input.randomSeed);
  const historyBySymbol = new Map<string, Candle[]>(symbols.map((s) => [s, []]));
  const lastCloseBySymbol = new Map<string, number>();
  const positions = new Map<string, Position>();

  let cash = input.initialCash;
  let pendingOrders: OrderIntent[] = [];
  let processedBars = 0;
  let maxConcurrentPositions = 0;
  let cancelled = false;

  const equityPoints: EquityPoint[] = [];
  const fills: Fill[] = [];
  const trades: Trade[] = [];
  const warnings: string[] = [];

  const state = strategy.initialize({ symbols, initialCash: input.initialCash, rng });

  const markToMarket = (): number => {
    let value = cash;
    for (const position of positions.values()) {
      const lastClose = lastCloseBySymbol.get(position.symbol);
      if (lastClose !== undefined) value += position.quantity * lastClose;
    }
    return value;
  };

  for (const tsMs of timeline) {
    if (hooks.shouldCancel?.()) {
      cancelled = true;
      break;
    }

    const bars = barsByTs.get(tsMs) as Map<string, Candle>;

    // 1~2. 대기 주문 체결 + 현금·포지션 갱신
    const stillPending: OrderIntent[] = [];
    for (const order of pendingOrders) {
      const bar = bars.get(order.symbol);
      if (!bar) {
        stillPending.push(order); // 다음 거래 가능 봉까지 대기 (§9.1)
        continue;
      }
      const executed = executeOrder(order, bar, tsMs);
      if (executed) fills.push(executed);
    }
    pendingOrders = stillPending;

    // 봉 이력·마지막 종가 갱신
    for (const [symbol, bar] of bars) {
      (historyBySymbol.get(symbol) as Candle[]).push(bar);
      lastCloseBySymbol.set(symbol, bar.close);
    }

    // 3. 평가금액 갱신
    equityPoints.push({ tsMs, equity: markToMarket() });
    maxConcurrentPositions = Math.max(maxConcurrentPositions, positions.size);

    // 4~5. 전략 호출
    const portfolioView: PortfolioView = {
      cash,
      equity: equityPoints[equityPoints.length - 1]?.equity ?? cash,
      positions,
    };
    const context: StrategyBarContext = {
      tsMs,
      bars,
      getHistory: (symbol) => historyBySymbol.get(symbol) ?? [],
      portfolio: portfolioView,
      rng,
    };
    const decision = strategy.onBars(context, state, input.parameters);

    // 6~7. 리스크 검증 후 다음 봉 대기열 등록
    for (const order of decision.orders) {
      const validated = validateOrder(order);
      if (validated) pendingOrders.push(validated);
    }

    // 8. 진행률
    processedBars += bars.size;
    if (hooks.onProgress && (processedBars % PROGRESS_INTERVAL_BARS < bars.size || tsMs === timeline[timeline.length - 1])) {
      hooks.onProgress({ processedBars, totalBars, currentTsMs: tsMs });
    }
  }

  if (pendingOrders.length > 0) {
    warnings.push(`기간 종료로 체결되지 않은 주문 ${pendingOrders.length}건이 폐기되었습니다.`);
  }
  if (positions.size > 0) {
    warnings.push(
      `기간 종료 시점에 미청산 포지션 ${positions.size}건이 남아 있습니다 (평가금액에는 반영됨).`,
    );
  }
  warnings.push('생존 편향·공휴일 캘린더·배당/액면분할 보정은 MVP 에서 다루지 않습니다 (§9.4).');

  const metrics = computeMetrics(
    equityPoints,
    trades,
    fills,
    input.initialCash,
    maxConcurrentPositions,
  );

  return {
    metrics,
    equityPoints,
    drawdownPoints: computeDrawdownSeries(equityPoints),
    trades,
    fills,
    monthlyReturns: computeMonthlyReturns(equityPoints, input.initialCash),
    symbolMetrics: computeSymbolMetrics(trades),
    warnings,
    cancelled,
    processedBars,
  };

  // ── 내부 helpers ─────────────────────────────────────────────

  function validateOrder(order: OrderIntent): OrderIntent | null {
    if (!Number.isFinite(order.quantity) || order.quantity < input.execution.rules.minOrderQty) {
      return null;
    }
    const quantity = Math.floor(order.quantity);

    if (order.side === 'SELL') {
      const position = positions.get(order.symbol);
      if (!position || position.quantity <= 0) return null;
      return { ...order, quantity: Math.min(quantity, position.quantity) };
    }

    // BUY: 신규 심볼이면 동시 포지션 상한 확인
    if (!positions.has(order.symbol) && positions.size >= input.maxPositions) return null;
    return { ...order, quantity };
  }

  function executeOrder(order: OrderIntent, bar: Candle, tsMs: number): Fill | null {
    if (order.side === 'BUY') {
      let fill = simulateFill(order, bar.open, tsMs, input.execution);
      if (requiredCashForBuy(fill) > cash) {
        // 현금 부족: 감당 가능한 수량으로 축소, 최소 수량 미만이면 거부
        const affordable = Math.floor(
          cash / (fill.price * (1 + input.execution.cost.buyCommissionRate)),
        );
        if (affordable < input.execution.rules.minOrderQty) {
          warnings.push(`${order.symbol} 매수 거부: 현금 부족 (${new Date(tsMs).toISOString()})`);
          return null;
        }
        fill = simulateFill({ ...order, quantity: affordable }, bar.open, tsMs, input.execution);
      }

      cash -= requiredCashForBuy(fill);
      const existing = positions.get(order.symbol);
      if (existing) {
        const totalQty = existing.quantity + fill.quantity;
        existing.avgEntryPrice =
          (existing.avgEntryPrice * existing.quantity + fill.price * fill.quantity) / totalQty;
        existing.quantity = totalQty;
        existing.entryCosts += fill.commission;
      } else {
        positions.set(order.symbol, {
          symbol: order.symbol,
          quantity: fill.quantity,
          avgEntryPrice: fill.price,
          entryCosts: fill.commission,
          entryTsMs: tsMs,
        });
      }
      return fill;
    }

    // SELL
    const position = positions.get(order.symbol);
    if (!position || position.quantity <= 0) return null;
    const sellQty = Math.min(order.quantity, position.quantity);
    const fill = simulateFill({ ...order, quantity: sellQty }, bar.open, tsMs, input.execution);

    cash += proceedsFromSell(fill);

    // 슬리피지는 체결가(entry/exit price)에 이미 반영되어 grossPnl 에 포함된다.
    // 추가로 차감할 비용은 수수료·세금뿐이다 (이중 계산 금지).
    const proportion = sellQty / position.quantity;
    const entryCostsShare = position.entryCosts * proportion;
    const grossPnl = (fill.price - position.avgEntryPrice) * sellQty;
    const totalCosts = entryCostsShare + fill.commission + fill.tax;
    const netPnl = grossPnl - totalCosts;
    const costBasis = position.avgEntryPrice * sellQty;

    trades.push({
      symbol: order.symbol,
      quantity: sellQty,
      entryTsMs: position.entryTsMs,
      exitTsMs: tsMs,
      entryPrice: position.avgEntryPrice,
      exitPrice: fill.price,
      grossPnl,
      costs: totalCosts,
      netPnl,
      returnPct: costBasis > 0 ? (netPnl / costBasis) * 100 : 0,
      holdingTimeMs: tsMs - position.entryTsMs,
      ...(order.reason !== undefined ? { exitReason: order.reason } : {}),
    });

    position.quantity -= sellQty;
    position.entryCosts -= entryCostsShare;
    if (position.quantity <= 0) positions.delete(order.symbol);

    return fill;
  }
}
