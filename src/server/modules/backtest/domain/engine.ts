import type { Candle } from '../../market-data/domain/candle.js';
import type {
  AnyTradingStrategy,
  PortfolioView,
  StrategyBarContext,
} from '../../strategy/domain/strategy.js';
import { CORPORATE_ACTION_FIELD, type Fact } from '../../facts/domain/fact.js';
import { PitFactView } from '../../facts/domain/pit-fact-view.js';
import { adjustForRatio } from './corporate-action-adjust.js';
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
   * 재무를 쓰지 않는 전략(range-breakout 등)은 넘길 필요가 없다.
   */
  readonly facts?: readonly Fact[];
  /**
   * 멤버십 일정(스펙 2026-08-05, §9.5) — `fromTsMs` 오름차순일 필요는 없다(엔진이 정렬한다).
   * 각 시점에는 `fromTsMs <= 현재 ts` 인 항목 중 가장 늦은 것이 활성 유니버스다.
   * 첫 entry 의 `fromTsMs` 보다 이른 시점도 첫 entry 를 그대로 적용한다 — period.from 이
   * 곧 첫 리밸런스 날짜라 실질적으로 그 이전 봉이 없고, 굳이 "제한 없음"으로 예외를 두면
   * 그 짧은 구간에서만 안전망이 꺼지는 방어 구멍이 된다.
   * 미지정이거나 빈 배열이면 tradableSymbols 는 항상 null(제한 없음) — 기존 전략 동작 불변.
   */
  readonly universeSchedule?: readonly { fromTsMs: number; symbols: readonly string[] }[];
  /**
   * 그 시점에 거래할 수 없었던 종목 (거래정지·무거래). 키는 봉 tsMs 다.
   * 이 종목들은 매수 후보에서 빠진다 — 봉이 없어 체결도 되지 않는다.
   * 보유분 청산(SELL)은 막지 않는다. 유니버스에서 빠진 종목도 항상 팔 수 있어야 한다.
   */
  readonly nonTradingSymbolsByTsMs?: ReadonlyMap<number, ReadonlySet<string>>;
  /**
   * 상장폐지 효력 시각 (심볼 → tsMs). 기간 안에 폐지된 종목만 담는다.
   *
   * 이 맵은 엔진만 본다. `StrategyBarContext` 에 노출하지 않는다 —
   * 전략이 "이 종목이 곧 폐지된다" 를 미리 알 경로를 만들지 않기 위해서다.
   */
  readonly delistedTsMsBySymbol?: ReadonlyMap<string, number>;
  /**
   * 거래불가일이 실제로 채워진 구간. `null` 이면 이 실행 구간에 거래불가 정보가 없다.
   * 행이 없는 것과 아직 모르는 것을 구분하지 않으면 경고가 "반영한다" 고 거짓말한다.
   */
  readonly nonTradingCoveredPeriod?: { readonly from: string; readonly to: string } | null;
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
  /** 상장폐지로 강제 청산한 내역 — 전략이 낸 매도와 구분해 결과 화면에 밝힌다 */
  readonly delistingLiquidations: readonly { symbol: string; tsMs: number; netPnl: number }[];
}

/** 재현성 메타데이터에 기록되는 엔진 버전 (스펙 §9.5) — 체결·지표 로직 변경 시 올린다 */
export const ENGINE_VERSION = '1.5.0';

const PROGRESS_INTERVAL_BARS = 500;

/**
 * 취소 확인 간격(봉 수). `runBacktestCancellable` 만 쓴다.
 * 동기 `runBacktest` 는 이 상수와 무관하게 끝까지 한 호흡에 돈다.
 *
 * 자식 프로세스 실행은 전부 동기(better-sqlite3)다. 그래서 IPC 취소
 * 메시지가 처리될 매크로태스크 경계가 원래 없었다(리뷰 finding, 2026-08-08).
 * 200봉마다 `setImmediate` 로 한 번 양보해 그 경계를 만든다.
 *
 * 200 을 고른 근거: 로컬 측정으로 10만 봉(500회 양보)을 돌려도 동기 실행과
 * 차이가 잡음 수준(수십 ms)이었다 — 대형 백테스트에서 오버헤드가 없다.
 * 봉 수가 200 미만인 실행(흔한 소규모 백테스트)은 양보가 한 번도 걸리지
 * 않는다 — 그런 실행은 어차피 몇 ms 안에 끝나 취소할 틈이 원래 없다.
 */
const CANCEL_YIELD_INTERVAL_BARS = 200;

/**
 * 이벤트 루프 (스펙 §9.2):
 *  0. 이 시점까지 공시된 팩트 흡수 — 전략 호출 전이어야 한다 (PIT 커서, §9.4)
 *  1. 보유 포지션·대기 주문에 자본변동 반영 — 체결보다 먼저다
 *  2. 이전 시점의 대기 주문 체결 (이번 봉 시가)
 *  3. 현금·포지션 갱신
 *  4. 평가금액 갱신
 *  5. 현재까지 확정된 봉을 전략에 전달
 *  6. 신규 주문 의도 생성
 *  7. 리스크 검증
 *  8. 다음 봉 체결 대기열 등록
 *  9. 스냅샷·진행률
 *
 * 전략은 현재 시점까지의 봉만 볼 수 있고(look-ahead 금지, §9.1),
 * 주문은 다음 거래 가능 봉의 시가에서 체결된다.
 *
 * 제너레이터인 이유: `runBacktest`(동기) 와 `runBacktestCancellable`(비동기)이
 * 같은 루프를 공유해야 한다. 로직을 두 벌로 복제하면 한쪽만 고치고 잊기 쉽다.
 * 대신 이 제너레이터 하나를 두 얇은 드라이버가 각자의 방식으로 소진한다
 * (파일 끝 참고).
 */
function* runBacktestSteps(
  strategy: AnyTradingStrategy,
  input: BacktestRunInput,
  hooks: EngineHooks = {},
): Generator<void, BacktestRunResult, void> {
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

  // 폐지 청산은 "그 종목의 마지막 봉" 에서 일어난다. 봉은 전부 미리 들어와 있으므로
  // 루프 중에 찾을 필요 없이 여기서 한 번에 접는다.
  const lastBarTsMsBySymbol = new Map<string, number>();
  for (const candle of sorted) lastBarTsMsBySymbol.set(candle.symbol, candle.tsMs);

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
  const delistingLiquidations: { symbol: string; tsMs: number; netPnl: number }[] = [];
  /**
   * 동시 보유 상한에 걸려 폐기된 매수 주문 — 종목별 건수. 봉마다 경고를 쌓지 않고
   * 마지막에 한 줄로 접는다: 월간 리밸런스 12년이면 같은 사유가 천 건 넘게 쌓여
   * warningsJson 을 부풀리고 정작 다른 경고를 묻어버린다.
   */
  const buysDroppedByCap = new Map<string, number>();

  // 멤버십 일정 — fromTsMs 오름차순으로 정렬해두고 타임라인을 정방향으로 훑으며
  // 활성 구간 index 만 전진시킨다(타임라인도 오름차순이라 되돌아갈 일이 없다).
  const sortedSchedule = [...(input.universeSchedule ?? [])].sort((a, b) => a.fromTsMs - b.fromTsMs);
  const scheduleSets = sortedSchedule.map((entry) => new Set(entry.symbols));
  let scheduleIndex = 0;
  // 이번 봉에서 매수 가능한 종목 — 일정 미지정/빈 배열이면 계속 null(제한 없음)
  let tradableSymbols: ReadonlySet<string> | null = null;
  // 유니버스 밖 BUY 거부 warning 을 심볼당 한 번만 남기기 위한 추적 집합 — 리밸런스
  // 주기가 짧으면 같은 사유가 봉마다 반복돼 warningsJson 을 부풀린다(buysDroppedByCap 과 같은 이유)
  const universeRejectedSymbols = new Set<string>();

  const factView = new PitFactView(input.facts ?? []);
  /**
   * 종목별 수량 단위 기준 시각이다.
   * 엔진이 들고 있는 그 종목의 수량(포지션·대기 주문)이 어느 시점 주가 단위로
   * 적혀 있는지를 가리킨다.
   *
   * 전진 규칙은 두 자리에만 있고, 각 자리 주석에 근거를 적는다.
   * 하나는 봉 루프의 자본변동 조정 구간이고, 다른 하나는 주문 발행 구간이다.
   * 맵에 없는 심볼은 -1 로 본다.
   */
  const quantityBasisTsMsBySymbol = new Map<string, number>();

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

    // 일정이 없는 실행에서 이전 시점의 거래불가 필터가 남지 않게 매 시점 초기화한다
    if (sortedSchedule.length === 0) tradableSymbols = null;

    // 활성 멤버십 구간 갱신 — fromTsMs <= tsMs 인 항목 중 가장 늦은 것이 활성이다.
    // 첫 entry 이전 시점은 예외 없이 첫 entry(index 0)를 그대로 쓴다(위 jsdoc 참고).
    if (sortedSchedule.length > 0) {
      while (
        scheduleIndex + 1 < sortedSchedule.length &&
        (sortedSchedule[scheduleIndex + 1] as { fromTsMs: number }).fromTsMs <= tsMs
      ) {
        scheduleIndex += 1;
      }
      tradableSymbols = scheduleSets[scheduleIndex] as ReadonlySet<string>;
    }

    // 거래불가 종목을 매수 후보에서 뺀다. 멤버십 일정이 없어도(=제한 없음) 이날
    // 거래불가인 종목이 있으면 전체 심볼에서 그만큼 뺀 집합을 만든다.
    const nonTradingNow = input.nonTradingSymbolsByTsMs?.get(tsMs);
    if (nonTradingNow !== undefined && nonTradingNow.size > 0) {
      const base = tradableSymbols ?? new Set(symbols);
      const filtered = new Set<string>();
      for (const symbol of base) {
        if (!nonTradingNow.has(symbol)) filtered.add(symbol);
      }
      tradableSymbols = filtered;
    }

    // 이 시점까지 공시된 팩트만 흡수한다 — 전략이 미래 공시를 볼 자리를 없앤다 (§9.4)
    factView.advanceTo(tsMs);

    // 자본변동을 포지션·대기 주문에 반영한다 — 체결보다 먼저다.
    // 분할일 매도 신호는 조정된 수량으로 팔아야 한다.
    //
    // (기준 시각, tsMs] 에 효력이 발생한 이벤트만 적용한다.
    //
    // 이 시점에 봉이 있는 종목은 예외 없이 기준 시각을 그 봉으로 전진시킨다.
    // 봉 가격이 곧 그 시점의 수량 단위라, 봉을 처리하면 기준이 그 봉으로 옮겨간다.
    // 조정할 수량이 없는 종목도 똑같이 전진시킨다.
    // 안 그러면 청산으로 비어 있던 동안의 분할이 나중 주문에 다시 걸린다.
    // 그 분할은 이미 그 종목의 시장 가격에 흡수돼 있다.
    //
    // 봉이 없는 종목은 전진시키지 않는다.
    // 액면분할은 주권교체 기간에 매매거래가 정지되는 것이 표준 경로다.
    // 기준 시각을 그대로 둬야 재개 봉에서 밀린 이벤트를 따라잡는다.
    //
    // 수량·평균단가 조정 대상은 포지션이 있는 종목과 대기 주문이 있는 종목이다.
    // 정지 직전에 발행한 신규 진입 BUY 는 포지션이 아직 없어 대기 주문에만 걸린다.
    //
    // 전략 상태 조정은 그 둘로 좁히지 않는다.
    // 전략은 보유하지 않는 종목의 지표도 봉마다 계속 누적한다.
    // 그 상태를 놔두면 분할을 넘긴 종목에서 허위 **진입** 신호가 난다
    // (`rsi-reversion` 의 허위 과매도, `range-breakout` 의 기준선 고착).
    // 그래서 봉이 있는 종목이면 보유 여부와 무관하게 훅을 부른다.
    const pendingSymbols = new Set(pendingOrders.map((order) => order.symbol));
    for (const [symbol, bar] of bars) {
      const basisTsMs = quantityBasisTsMsBySymbol.get(symbol) ?? -1;
      quantityBasisTsMsBySymbol.set(symbol, tsMs);
      const due = factView
        .corporateActions(symbol, tsMs)
        .filter((action) => action.effectiveTsMs > basisTsMs);
      if (due.length === 0) continue;
      // 정지 구간을 건너뛰면 여러 날짜의 이벤트가 한꺼번에 걸릴 수 있다.
      // 곱셈 자체는 순서에 무관하지만 내림은 그렇지 않다.
      // 역분할이 정지 구간에 겹쳐 쌓일 때만 닿는 구석이라 지금은 그대로 둔다.
      const ratio = due.reduce((acc, action) => acc * action.ratio, 1);
      if (ratio === 1) continue;
      // 전략이 봉 사이에 들고 다니는 가격 상태(지표 누적·스톱 레벨)를 같은 자리에서 고친다.
      // 대기 주문 체결보다 먼저 불러야 이번 봉의 스톱 판정이 조정된 값으로 난다.
      // `context.corporateActions()` 는 시점까지 전체 이력을 주지만
      // 이 훅은 방금 확정된 합성 `ratio` 하나만 정확히 준다.
      // 전략마다 커서를 새로 두면 이미 푼 문제를 다시 만든다.
      //
      // 그 종목의 첫 봉에서는 기준 시각이 -1 이라 상장 이후 전체 이력이 한꺼번에 걸린다.
      // 그때는 아직 누적된 상태가 없어 어느 필드를 나눠도 값이 바뀌지 않는다.
      strategy.onCorporateAction?.(symbol, ratio, state);

      if (!positions.has(symbol) && !pendingSymbols.has(symbol)) continue;
      // 이 종목을 겨냥한 대기 주문을 같은 비율로 스케일한다.
      // 발행 시점에 캡처된 수량을 그대로 체결하면 분할 이후 수량이 어긋난다.
      // BUY 도 같은 값 보존 규칙을 적용해야 의도한 투입 금액이 유지된다.
      pendingOrders = pendingOrders
        .map((order) =>
          order.symbol === symbol
            ? { ...order, quantity: adjustForRatio(order.quantity, 0, ratio, 0).quantity }
            : order,
        )
        .filter((order) => order.quantity > 0);

      const position = positions.get(symbol);
      if (!position) continue; // 대기 주문만 있었다 — 주문은 이미 위에서 스케일했다
      const adjusted = adjustForRatio(position.quantity, position.avgEntryPrice, ratio, bar.open);
      cash += adjusted.cashFromFraction;
      if (adjusted.closed) {
        positions.delete(symbol);
        continue;
      }
      position.quantity = adjusted.quantity;
      position.avgEntryPrice = adjusted.avgEntryPrice;
    }

    // 2~3. 대기 주문 체결 + 현금·포지션 갱신
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

    // 상장폐지 청산 — 그 종목의 마지막 봉에서 종가로 전량 나간다.
    //
    // 평가금액 갱신보다 먼저다. 이 시점 자산곡선이 청산 대금을 이미 반영해야
    // 폐지 손실이 곡선에 남는다.
    //
    // 체결가는 이 봉의 종가다. `krx_non_trading_days.lastClose` 는 쓰지 않는다 —
    // 정지 중 가격은 팔 수 있는 가격이 아니다. 정지 상태로 폐지된 종목은
    // 정지 직전 실거래가로 나간다.
    //
    // 정리매매 종가를 따로 추정하지 않는다. KRX 일봉에 정리매매 기간 봉이 들어 있어
    // 마지막 봉이 곧 정리매매 최종가다. 시장이 매긴 회수가치를 그대로 쓴다.
    if (input.delistedTsMsBySymbol !== undefined) {
      for (const [symbol, bar] of bars) {
        if (!input.delistedTsMsBySymbol.has(symbol)) continue;
        if (lastBarTsMsBySymbol.get(symbol) !== tsMs) continue;

        // 대기 주문을 따로 지우지 않는다. 이 시점 pendingOrders 에는 이번 봉에 봉이
        // 없는 종목의 주문만 남아 있어 — 봉이 있는 종목은 위 체결 스텝이 이미 다
        // 처리했다 — 폐지 종목(이번 봉이 있어야 여기 온다) 주문은 애초에 없다.
        // 전략이 이 마지막 봉에서 새로 내는 주문은 이 블록 뒤(전략 호출)에 등록되므로
        // 여기서 손댈 수 없고, 체결될 봉이 다시 오지 않아 기간 종료 폐기 경고로 드러난다.

        const position = positions.get(symbol);
        if (position === undefined || position.quantity <= 0) continue;

        const before = trades.length;
        const fill = executeOrder(
          { symbol, side: 'SELL', quantity: position.quantity, reason: 'DELISTED' },
          bar,
          tsMs,
          bar.close,
        );
        if (fill) fills.push(fill);
        const trade = trades[before];
        if (trade !== undefined) {
          delistingLiquidations.push({ symbol, tsMs, netPnl: trade.netPnl });
        }
        strategy.onForcedExit?.(symbol, state);
      }
    }

    // 4. 평가금액 갱신
    equityPoints.push({ tsMs, equity: markToMarket() });
    maxConcurrentPositions = Math.max(maxConcurrentPositions, positions.size);

    // 5~6. 전략 호출
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
      tradableSymbols,
    };
    const decision = strategy.onBars(context, state, input.parameters);

    // 7~8. 리스크 검증 후 다음 봉 대기열 등록
    for (const order of decision.orders) {
      const validated = validateOrder(order);
      if (!validated) continue;
      pendingOrders.push(validated);
      // 이 종목의 봉을 한 번도 본 적이 없을 때만 기준 시각을 지금으로 놓는다.
      // 참조할 이전 단위가 없으니 발행 시각을 기준으로 삼는다.
      // 기본값 -1 을 그대로 두면 상장 이전의 분할까지 이 주문에 걸린다.
      //
      // 봉을 본 적이 있으면 손대지 않는다.
      // 오늘 봉이 있으면 위 조정 루프가 이미 이 봉 시각을 넣어 뒀다.
      // 정지 중이면 마지막 봉 시각이 남아야 정지 구간의 분할이 이 주문에 적용된다.
      if (!quantityBasisTsMsBySymbol.has(validated.symbol)) {
        quantityBasisTsMsBySymbol.set(validated.symbol, tsMs);
      }
    }

    // 9. 진행률
    processedBars += bars.size;
    if (hooks.onProgress && (processedBars % PROGRESS_INTERVAL_BARS < bars.size || tsMs === timeline[timeline.length - 1])) {
      hooks.onProgress({ processedBars, totalBars, currentTsMs: tsMs });
    }

    // 취소 확인 창. `runBacktest`(동기 드라이버)는 이 yield 를 그냥 흘려보낸다.
    // `runBacktestCancellable` 만 여기서 실제로 이벤트 루프에 양보한다.
    if (processedBars % CANCEL_YIELD_INTERVAL_BARS < bars.size) {
      yield;
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
  // 분할 보정 여부는 "팩트가 있는가" 가 아니라 "**자본변동** 팩트가 있는가" 다 —
  // 재무만 수집된 데이터셋(SPLIT_RATIO 0건)에서 팩트 건수로 판단하면 일어나지 않은
  // 보정을 일어났다고 말한다.
  const hasCorporateActionFacts = (input.facts ?? []).some(
    (fact) => fact.field === CORPORATE_ACTION_FIELD,
  );

  // "생존 편향" 이라는 단일 라벨은 쓰지 않는다. 시점별 유니버스 선정과 상장폐지 청산은
  // 하고, 배당·권리락·과거 지수 구성원은 안 한다 — 예/아니오로 답할 수 없는 상태다.
  // 화면(universe-provenance.ts)이 같은 이유로 "생존자 편향 제거" 표현을 금지한다.
  warnings.push(
    '이 백테스트가 보정하는 것: 시점별 유니버스 선정, 상장폐지 청산, 거래불가일(거래정지·무거래) 매수 제외'
      + (hasCorporateActionFacts
        ? ', 액면분할(보유 수량·평균단가·대기 주문·전략 가격 상태). 보정 종가를 쓰는 전략은 '
          + '신호 계산에도 반영됩니다. 이미 체결된 거래의 체결가는 조정하지 않습니다.'
        : '. 액면분할은 이 실행에서 보정되지 않았습니다 (분할 이력 미수집).'),
  );
  warnings.push(
    '이 백테스트가 보정하지 않는 것: 배당, 유상증자 권리락, 공휴일 캘린더, 과거 지수 구성원 복원. '
      + '손절·익절은 종가로만 판정합니다.',
  );

  if (delistingLiquidations.length > 0) {
    const netPnl = delistingLiquidations.reduce((sum, item) => sum + item.netPnl, 0);
    const symbols = delistingLiquidations.map((item) => item.symbol).sort();
    const shown = symbols.slice(0, 10).join(', ');
    warnings.push(
      `상장폐지로 강제 청산한 종목 ${symbols.length}건: ${shown}`
        + (symbols.length > 10 ? ` 외 ${symbols.length - 10}종목` : '')
        + `. 손익 합계 ${Math.round(netPnl).toLocaleString()}원. `
        + '체결가는 그 종목의 마지막 거래 가능 봉 종가이며, 정리매매가 있었다면 그 가격이 반영됩니다.',
    );
  }

  if (input.nonTradingCoveredPeriod === null) {
    warnings.push(
      '이 실행 구간에는 거래불가일 정보가 없습니다 — 거래정지 종목이 유니버스와 매수 후보에 그대로 들어갔을 수 있습니다. '
        + '`cli krx:backfill-non-trading` 으로 채운 뒤 다시 실행하세요.',
    );
  } else if (input.nonTradingCoveredPeriod !== undefined) {
    warnings.push(
      `거래불가일 정보는 ${input.nonTradingCoveredPeriod.from} ~ ${input.nonTradingCoveredPeriod.to} 구간만 반영됐습니다.`,
    );
  }

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
      const lastPriceTsMs = lastBarTsMsBySymbol.get(position.symbol) ?? position.entryTsMs;
      return {
        symbol: position.symbol,
        quantity: position.quantity,
        avgEntryPrice: position.avgEntryPrice,
        entryTsMs: position.entryTsMs,
        lastPrice,
        lastPriceTsMs,
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
    delistingLiquidations,
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

    // BUY: 활성 멤버십 일정 밖 심볼은 거부한다 — 전략이 유니버스를 스스로 걸러내지
    // 않는 버그를 잡는 안전망이다(§9.5). 보유분 청산(SELL)은 위에서 이미 갈라져
    // 이 검증을 타지 않는다 — 유니버스에서 빠진 종목도 항상 청산할 수 있어야 한다.
    if (tradableSymbols !== null && !tradableSymbols.has(order.symbol)) {
      if (!universeRejectedSymbols.has(order.symbol)) {
        universeRejectedSymbols.add(order.symbol);
        warnings.push(
          `${order.symbol} 매수 거부: 활성 멤버십 일정에 포함되지 않은 종목입니다 (전략 버그 안전망).`,
        );
      }
      return null;
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

  function executeOrder(
    order: OrderIntent,
    bar: Candle,
    tsMs: number,
    basePrice: number = bar.open,
  ): Fill | null {
    if (order.side === 'BUY') {
      let fill = simulateFill(order, basePrice, tsMs, input.execution);
      if (requiredCashForBuy(fill) > cash) {
        // 현금 부족: 감당 가능한 수량으로 축소, 최소 수량 미만이면 거부
        // fill.price 는 이미 체결가라 basePrice 와 다르다 — 그대로 쓴다
        const affordable = Math.floor(
          cash / (fill.price * (1 + input.execution.cost.buyCommissionRate)),
        );
        if (affordable < input.execution.rules.minOrderQty) {
          warnings.push(`${order.symbol} 매수 거부: 현금 부족 (${new Date(tsMs).toISOString()})`);
          return null;
        }
        fill = simulateFill({ ...order, quantity: affordable }, basePrice, tsMs, input.execution);
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
    const fill = simulateFill({ ...order, quantity: sellQty }, basePrice, tsMs, input.execution);

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

/**
 * 동기 실행 — 기존 호출부 전부(직접 엔진 테스트, 단위 테스트)가 이 시그니처를 쓴다.
 * 제너레이터를 끝까지 한 호흡에 비운다 — 동작은 이전 `runBacktest` 와 같다.
 * 제너레이터 프레임 비용은 따로 측정하지 않았다.
 * 위 CANCEL_YIELD_INTERVAL_BARS 주석의 측정은 `runBacktestCancellable` 의
 * setImmediate 양보 비용이지, 이 함수의 제너레이터 호출 자체와는 다른 수치다.
 */
export function runBacktest(
  strategy: AnyTradingStrategy,
  input: BacktestRunInput,
  hooks: EngineHooks = {},
): BacktestRunResult {
  const steps = runBacktestSteps(strategy, input, hooks);
  let step = steps.next();
  while (!step.done) step = steps.next();
  return step.value;
}

/**
 * 비동기 실행 — `backtest-child.ts` 전용.
 * 제너레이터가 내는 yield 마다 실제로 `setImmediate` 를 기다려 양보한다.
 * 그 틈에 부모가 보낸 IPC 취소 메시지가 처리될 수 있다.
 */
export async function runBacktestCancellable(
  strategy: AnyTradingStrategy,
  input: BacktestRunInput,
  hooks: EngineHooks = {},
): Promise<BacktestRunResult> {
  const steps = runBacktestSteps(strategy, input, hooks);
  let step = steps.next();
  while (!step.done) {
    await new Promise<void>((resolve) => setImmediate(resolve));
    step = steps.next();
  }
  return step.value;
}
