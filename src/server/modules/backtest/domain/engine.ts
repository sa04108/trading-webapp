import type { Candle } from '../../market-data/domain/candle.js';
import type {
  AnyTradingStrategy,
  PortfolioView,
  StrategyBarContext,
} from '../../strategy/domain/strategy.js';
import type { Fact } from '../../facts/domain/fact.js';
import { PitFactView } from '../../facts/domain/pit-fact-view.js';
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
  OpenPositionSnapshot,
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
  /**
   * 상장시점 팩트. 미지정이면 전략의 fundamentals/corporateActions 가 항상 비어 있다 —
   * 재무를 쓰지 않는 전략(hourly-breakout 등)은 넘길 필요가 없다.
   */
  readonly facts?: readonly Fact[];
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
  /** 기간 종료 시점 미청산 포지션 — 평가금액에 반영되나 거래내역에는 없는 몫 */
  readonly openPositions: readonly OpenPositionSnapshot[];
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
export const ENGINE_VERSION = '1.2.0';

const PROGRESS_INTERVAL_BARS = 500;

/**
 * 이벤트 루프 (스펙 §9.2):
 *  0. 이 시점까지 공시된 팩트 흡수 — 전략 호출 전이어야 한다 (PIT 커서, §9.4)
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
  /**
   * 동시 보유 상한에 걸려 폐기된 매수 주문 — 종목별 건수. 봉마다 경고를 쌓지 않고
   * 마지막에 한 줄로 접는다: 월간 리밸런스 12년이면 같은 사유가 천 건 넘게 쌓여
   * warningsJson 을 부풀리고 정작 다른 경고를 묻어버린다.
   */
  const buysDroppedByCap = new Map<string, number>();

  const factView = new PitFactView(input.facts ?? []);

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

    // 이 시점까지 공시된 팩트만 흡수한다 — 전략이 미래 공시를 볼 자리를 없앤다 (§9.4)
    factView.advanceTo(tsMs);

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
      fundamentals: (symbol) => factView.fundamentals(symbol),
      corporateActions: (symbol) => factView.corporateActions(symbol, tsMs),
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
  if (buysDroppedByCap.size > 0) {
    // 이 폐기는 지금까지 모든 전략에서 보이지 않았다 — validateOrder 가 null 을
    // 반환하면 호출부가 그대로 버렸다. 전략이 상한보다 많은 종목을 편입하려 하면
    // 초과분만큼 자본이 현금으로 남는데 자산 곡선은 정상처럼 보인다.
    const total = [...buysDroppedByCap.values()].reduce((sum, count) => sum + count, 0);
    const symbols = [...buysDroppedByCap.keys()].sort();
    const shown = symbols.slice(0, 10).join(', ');
    warnings.push(
      `동시 보유 종목 상한(${input.maxPositions})에 걸려 매수 주문 ${total}건이 폐기되었습니다 ` +
        `— 대상 ${symbols.length}종목: ${shown}` +
        (symbols.length > 10 ? ` 외 ${symbols.length - 10}종목` : '') +
        '. 그만큼 자본이 현금으로 남았습니다. 전략의 보유 종목 수를 상한 이하로 줄이거나 상한을 올리세요.',
    );
  }
  warnings.push(
    '생존 편향·공휴일 캘린더·배당·권리락 보정은 MVP 에서 다루지 않습니다 (§9.4). ' +
      ((input.facts?.length ?? 0) > 0
        ? '액면분할은 분할 이력이 수집된 데이터셋에서, 보정을 사용하는 전략의 신호 계산에만 반영됩니다 — 체결가는 실제 거래 가격입니다.'
        : '액면분할도 이 실행에서는 보정되지 않았습니다 (팩트 미제공).'),
  );

  const metrics = computeMetrics(
    equityPoints,
    trades,
    fills,
    input.initialCash,
    maxConcurrentPositions,
  );

  // 미청산 포지션 스냅샷 — 수익률·자산 곡선에는 평가금액으로 반영되지만 거래내역에는
  // 없는 돈이 어디 있는지를 명시적으로 보여준다 (매도 비용 미반영 평가치)
  const openPositions: OpenPositionSnapshot[] = [...positions.values()]
    .filter((position) => position.quantity > 0)
    .map((position) => {
      const lastPrice = lastCloseBySymbol.get(position.symbol) ?? position.avgEntryPrice;
      return {
        symbol: position.symbol,
        quantity: position.quantity,
        avgEntryPrice: position.avgEntryPrice,
        entryTsMs: position.entryTsMs,
        lastPrice,
        unrealizedPnl: position.quantity * (lastPrice - position.avgEntryPrice),
        returnPct: ((lastPrice - position.avgEntryPrice) / position.avgEntryPrice) * 100,
      };
    })
    .sort((a, b) => (a.symbol < b.symbol ? -1 : 1));

  return {
    metrics,
    openPositions,
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

    // BUY: 신규 심볼이면 동시 포지션 상한 확인.
    // 대기 중인 신규 매수도 슬롯을 소비한다 — 같은 봉에서 여러 심볼이 동시에
    // 신호를 내면 보유 수만으로는 상한이 뚫린다.
    if (!positions.has(order.symbol)) {
      const pendingNewBuySymbols = new Set(
        pendingOrders
          .filter((o) => o.side === 'BUY' && !positions.has(o.symbol))
          .map((o) => o.symbol),
      );
      if (
        !pendingNewBuySymbols.has(order.symbol) &&
        positions.size + pendingNewBuySymbols.size >= input.maxPositions
      ) {
        // 조용히 버리지 않는다 — 폐기 사실을 기록해 실행 경고로 접어 올린다
        buysDroppedByCap.set(order.symbol, (buysDroppedByCap.get(order.symbol) ?? 0) + 1);
        return null;
      }
    }
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
