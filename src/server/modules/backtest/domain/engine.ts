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
} from './metrics.js';
import { createRng } from './seeded-rng.js';
import {
  findRebalanceSpacingViolation,
  rebalanceSpacingViolationMessage,
} from './rebalance-spacing.js';
import type {
  BacktestMetrics,
  BacktestUniverseScheduleEntry,
  DrawdownPoint,
  EquityPoint,
  ExecutionProfile,
  Fill,
  MonthlyReturn,
  OpenPositionSnapshot,
  OrderIntent,
  Position,
  SelectionMetricPin,
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
  /** 이 시각 전 봉은 전략 warm-up에만 쓰고 주문·체결·결과 스냅샷을 만들지 않는다. */
  readonly tradeFromTsMs?: number;
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
  readonly universeSchedule?: readonly BacktestUniverseScheduleEntry[];
  /**
   * 그 시점에 거래할 수 없었던 종목 (거래정지·무거래). 키는 봉 tsMs 다.
   * 이 종목들은 매수 후보에서 빠진다 — 봉이 없어 체결도 되지 않는다.
   * 보유분 청산(SELL)은 막지 않는다. 유니버스에서 빠진 종목도 항상 팔 수 있어야 한다.
   */
  readonly nonTradingSymbolsByTsMs?: ReadonlyMap<number, ReadonlySet<string>>;
  /**
   * 상장폐지 효력 시각 (심볼 → tsMs 목록). 기간 안에 폐지된 종목만 담는다.
   *
   * 값이 목록인 이유는 KRX 가 폐지된 여섯 자리 단축코드를 나중에 다른 회사에 다시
   * 주기 때문이다. 한 코드가 실행 기간 안에서 두 번 폐지될 수 있고, 앞 폐지가 먼저
   * 산 포지션이 실제로 맞는 폐지다. 코드당 하나만 담으면 그 포지션이 몇 년 뒤
   * 다른 회사의 종가로 나간다. 순서는 상관없다 — 엔진이 폐지마다 따로 접는다.
   *
   * 이 맵은 엔진만 본다. `StrategyBarContext` 에 노출하지 않는다 —
   * 전략이 "이 종목이 곧 폐지된다" 를 미리 알 경로를 만들지 않기 위해서다.
   */
  readonly delistedTsMsBySymbol?: ReadonlyMap<string, readonly number[]>;
  /**
   * 거래불가일이 실제로 채워진 구간. `null` 이면 이 실행 구간에 거래불가 정보가 없다.
   * 행이 없는 것과 아직 모르는 것을 구분하지 않으면 경고가 "반영한다" 고 거짓말한다.
   *
   * 엔진이 실제로 보는 것은 `null` 인지 아닌지뿐이다. 워커는 실행 기간 **전체**가
   * 덮였을 때만 구간을 채워 넘기므로(backtest-child.ts), 그 구간을 경고에 적으면
   * 전부 반영된 실행을 반쪽처럼 말하게 된다. 구간 값 자체는 부분 커버 구간을
   * 계산할 수 있게 되면 그때 쓴다.
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
  readonly warnings: readonly string[];
  readonly cancelled: boolean;
  readonly processedBars: number;
  /** 상장폐지로 강제 청산한 내역 — 전략이 낸 매도와 구분해 결과 화면에 밝힌다 */
  readonly delistingLiquidations: readonly { symbol: string; tsMs: number; netPnl: number }[];
}

/**
 * 재현성 메타데이터에 기록되는 엔진 버전 (스펙 §9.5) — 체결·지표 로직이 바뀌거나,
 * 워커가 엔진에 넘기는 입력을 조립하는 규칙이 바뀌어 같은 요청의 결과가 달라질 때 올린다.
 *
 * 1.7.0: warm-up 결과 경계를 분리하고 공유 리밸런스 신호·유니버스 이탈 청산·
 * sell-before-buy 대기열을 적용한다.
 * 1.8.0: 거래정지된 이탈 종목의 첫 청산 시도 뒤에는 신규 매수 대기열을 해제한다.
 * 1.9.0: 동시 매수 신호의 현금·포지션 슬롯 배정 순서를 seed 기반으로 무작위화한다.
 * 2.0.0: 미청산 진입비용과 체결일별 세금·KRX 호가단위를 반영한다.
 * 2.1.0: 직전 거래 봉 거래량 기준 participation 한도를 적용한다.
 * 2.2.0: Sortino 하방편차를 전체 관측일 기준으로 계산한다.
 * 2.3.0: 2봉 리밸런스 전략에서 다음 리밸런스 신호가 유실되는 일정을 fail-fast한다.
 */
export const ENGINE_VERSION = '2.3.0';

const PROGRESS_INTERVAL_BARS = 500;
/** 전략에 노출된 RNG 흐름과 매수 우선순위 RNG 흐름을 분리하는 32-bit salt. */
const BUY_PRIORITY_SEED_SALT = 0x9e3779b9;

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
  const totalBars = sorted.filter(
    (candle) => input.tradeFromTsMs === undefined || candle.tsMs >= input.tradeFromTsMs,
  ).length;

  const requiredRebalanceGapBars = strategy.requiredRebalanceGapBars ?? 0;
  if (!Number.isInteger(requiredRebalanceGapBars) || requiredRebalanceGapBars < 0) {
    throw new Error(`${strategy.id} requiredRebalanceGapBars는 0 이상의 정수여야 합니다`);
  }
  const spacingViolation = findRebalanceSpacingViolation(
    timeline,
    input.universeSchedule ?? [],
    requiredRebalanceGapBars,
    input.tradeFromTsMs,
  );
  if (spacingViolation !== null) {
    throw new Error(
      rebalanceSpacingViolationMessage(strategy.name, requiredRebalanceGapBars, spacingViolation),
    );
  }

  // 미청산 포지션 스냅샷이 "마지막으로 확인된 가격이 언제 것인지" 를 적는 데 쓴다.
  const lastBarTsMsBySymbol = new Map<string, number>();
  for (const candle of sorted) lastBarTsMsBySymbol.set(candle.symbol, candle.tsMs);

  // 폐지 청산 시점 — 폐지 하나하나마다 그 효력 시각보다 **앞선** 마지막 봉이다.
  // 실행 전체의 마지막 봉으로 잡으면 안 된다. KRX 는 폐지된 여섯 자리 단축코드를
  // 나중에 다른 회사에 다시 주므로, 같은 코드의 뒷날 봉이 실행 기간에 들어오면
  // 몇 년 뒤 남의 회사 종가로 청산하게 된다. 같은 이유로 폐지를 코드당 하나로
  // 접어서도 안 된다 — 재사용된 코드가 기간 안에서 두 번 폐지되면 먼저 산 포지션은
  // 앞 폐지에서 나가야 한다. 봉은 전부 미리 들어와 있어 여기서 한 번에 접는다.
  const liquidationBarTsMsBySymbol = new Map<string, Set<number>>();
  if (input.delistedTsMsBySymbol !== undefined) {
    // 폐지 대상 종목의 봉 시각만 모은다 — sorted 가 오름차순이라 이 목록도 오름차순이다
    const barTsMsBySymbol = new Map<string, number[]>();
    for (const candle of sorted) {
      if (!input.delistedTsMsBySymbol.has(candle.symbol)) continue;
      const list = barTsMsBySymbol.get(candle.symbol) ?? [];
      list.push(candle.tsMs);
      barTsMsBySymbol.set(candle.symbol, list);
    }
    for (const [symbol, delistedTsMsList] of input.delistedTsMsBySymbol) {
      const barTsMsList = barTsMsBySymbol.get(symbol) ?? [];
      const liquidationTsMsSet = new Set<number>();
      for (const delistedTsMs of delistedTsMsList) {
        let lastBefore: number | undefined;
        for (const barTsMs of barTsMsList) {
          if (barTsMs >= delistedTsMs) break;
          lastBefore = barTsMs;
        }
        // 폐지 시각 이전 봉이 하나도 없으면 청산할 자리가 없다
        if (lastBefore !== undefined) liquidationTsMsSet.add(lastBefore);
      }
      if (liquidationTsMsSet.size > 0) liquidationBarTsMsBySymbol.set(symbol, liquidationTsMsSet);
    }
  }

  const rng = createRng(input.randomSeed);
  // 매수 경쟁이 전략의 RNG 호출 횟수를 바꾸거나, 전략의 난수 사용량이
  // 체결 우선순위를 바꾸지 않도록 같은 seed의 별도 스트림을 쓴다.
  const buyPriorityRng = createRng(input.randomSeed ^ BUY_PRIORITY_SEED_SALT);
  const historyBySymbol = new Map<string, Candle[]>(symbols.map((s) => [s, []]));
  const lastCloseBySymbol = new Map<string, number>();
  const positions = new Map<string, Position>();

  let cash = input.initialCash;
  let pendingOrders: OrderIntent[] = [];
  let deferredRebalanceBuys: OrderIntent[] = [];
  const unresolvedForcedExitSymbols = new Set<string>();
  // 새 이탈 청산이 다음 거래일에 한 번 체결을 시도할 때까지만 신규 매수보다 우선한다.
  // 거래정지로 매도가 오래 남아도 이 장벽까지 계속 유지하면 포트폴리오 전체가 잠긴다.
  let buysAwaitingForcedExitAttempt = false;
  let processedBars = 0;
  let visitedBars = 0;
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
  const liquidityLimitedOrders = new Map<string, number>();
  const liquidityRejectedOrders = new Map<string, number>();

  const maxVolumeParticipationRate = input.execution.rules.maxVolumeParticipationRate;
  if (
    maxVolumeParticipationRate !== undefined
    && (!Number.isFinite(maxVolumeParticipationRate)
      || maxVolumeParticipationRate <= 0
      || maxVolumeParticipationRate > 1)
  ) {
    throw new Error('maxVolumeParticipationRate는 0 초과 1 이하여야 합니다');
  }

  let priorVolumeBySymbolThisBar = new Map<string, number>();
  let volumeUnitRatioBySymbolThisBar = new Map<string, number>();
  let filledQuantityBySymbolThisBar = new Map<string, number>();

  // 멤버십 일정 — fromTsMs 오름차순으로 정렬해두고 타임라인을 정방향으로 훑으며
  // 활성 구간 index 만 전진시킨다(타임라인도 오름차순이라 되돌아갈 일이 없다).
  const sortedSchedule = [...(input.universeSchedule ?? [])].sort((a, b) => a.fromTsMs - b.fromTsMs);
  const scheduleMetricMaps = sortedSchedule.map((entry) => {
    const metrics = new Map<string, SelectionMetricPin | null>();
    if (entry.members !== undefined) {
      for (const member of entry.members) {
        metrics.set(member.symbol, {
          marketCapKrw: member.marketCapKrw,
          volume: member.volume,
          tradingValueKrw: member.tradingValueKrw,
        });
      }
    } else {
      for (const symbol of entry.symbols ?? []) metrics.set(symbol, null);
    }
    return metrics;
  });
  const scheduleSets = scheduleMetricMaps.map((metrics) => new Set(metrics.keys()));
  let scheduleIndex = 0;
  let activatedScheduleIndex = -1;
  let schedulelessRebalanceEmitted = false;
  let activeSelectionMetrics: ReadonlyMap<string, SelectionMetricPin | null> | null = null;
  let activeMembershipSymbols: ReadonlySet<string> | null = null;
  // 이번 봉에서 매수 가능한 종목 — 일정 미지정/빈 배열이면 계속 null(제한 없음)
  let tradableSymbols: ReadonlySet<string> | null = null;
  // 유니버스 밖 BUY 거부 warning 을 심볼당 한 번만 남기기 위한 추적 집합 — 리밸런스
  // 주기가 짧으면 같은 사유가 봉마다 반복돼 warningsJson 을 부풀린다(buysDroppedByCap 과 같은 이유)
  const universeRejectedSymbols = new Set<string>();
  // 거래정지·무거래로 거부한 BUY 는 사유가 다르므로 집합도 따로 둔다 — 하나로 묶으면
  // 정지 한 번이 그 종목의 경고 자리를 다 써버려 나중에 난 진짜 유니버스 위반이 사라진다.
  const nonTradingRejectedSymbols = new Set<string>();
  // 이번 봉에서 거래정지·무거래인 종목 — validateOrder 가 거부 사유를 가르는 데 쓴다
  let nonTradingNow: ReadonlySet<string> | undefined;

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
    priorVolumeBySymbolThisBar = new Map(
      [...bars.keys()].map((symbol) => [
        symbol,
        historyBySymbol.get(symbol)?.at(-1)?.volume ?? 0,
      ]),
    );
    volumeUnitRatioBySymbolThisBar = new Map();
    filledQuantityBySymbolThisBar = new Map();
    const isTradeBar = input.tradeFromTsMs === undefined || tsMs >= input.tradeFromTsMs;
    const promotedBuySymbolsThisBar = new Set<string>();
    visitedBars += bars.size;

    // 일정이 없는 실행에서 이전 시점의 거래불가 필터가 남지 않게 매 시점 초기화한다
    if (sortedSchedule.length === 0) {
      tradableSymbols = null;
      activeMembershipSymbols = null;
      activeSelectionMetrics = null;
    }

    // 활성 멤버십 구간 갱신 — fromTsMs <= tsMs 인 항목 중 가장 늦은 것이 활성이다.
    // 첫 entry 이전 시점은 예외 없이 첫 entry(index 0)를 그대로 쓴다(위 jsdoc 참고).
    if (sortedSchedule.length > 0) {
      while (
        scheduleIndex + 1 < sortedSchedule.length &&
        (sortedSchedule[scheduleIndex + 1] as { fromTsMs: number }).fromTsMs <= tsMs
      ) {
        scheduleIndex += 1;
      }
      activeMembershipSymbols = scheduleSets[scheduleIndex] as ReadonlySet<string>;
      activeSelectionMetrics = scheduleMetricMaps[scheduleIndex] as ReadonlyMap<
        string,
        SelectionMetricPin | null
      >;
      tradableSymbols = activeMembershipSymbols;
    }

    // schedule entry의 달력 날짜가 휴일이면 이 조건은 다음 실제 봉에서 처음 참이 된다.
    // warm-up 봉은 멤버십과 지표만 갱신하고 activation을 소비하지 않는다.
    let isRebalanceBar = false;
    if (isTradeBar) {
      if (sortedSchedule.length === 0) {
        isRebalanceBar = !schedulelessRebalanceEmitted;
        schedulelessRebalanceEmitted = true;
      } else if (
        activatedScheduleIndex !== scheduleIndex
        && (sortedSchedule[scheduleIndex] as BacktestUniverseScheduleEntry).fromTsMs <= tsMs
      ) {
        isRebalanceBar = true;
        activatedScheduleIndex = scheduleIndex;
      }
    }

    // 거래불가 종목을 매수 후보에서 뺀다. 멤버십 일정이 없어도(=제한 없음) 이날
    // 거래불가인 종목이 있으면 전체 심볼에서 그만큼 뺀 집합을 만든다.
    nonTradingNow = input.nonTradingSymbolsByTsMs?.get(tsMs);
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
    const pendingSymbols = new Set(
      [...pendingOrders, ...deferredRebalanceBuys].map((order) => order.symbol),
    );
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
      volumeUnitRatioBySymbolThisBar.set(symbol, ratio);
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
      deferredRebalanceBuys = deferredRebalanceBuys
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

    // 리밸런스 활성화는 D-1 주문의 D0 open 체결보다 먼저 적용한다.
    // 그렇지 않으면 편출 종목 BUY가 한 번 더 체결되고, 이미 D-1에 나온
    // 전략 SELL은 정상 매도로 체결돼 REBALANCE_EXIT 사유와 훅이 유실된다.
    //
    // D0에 처음 만든 forced SELL은 기존 계약대로 D1 open에 체결해야 한다.
    // D-1 SELL을 교체한 건만 기존 D0 체결 자격을 승계하고, 새 forced SELL은
    // 아래 체결 루프가 끝난 뒤 pending queue에 넣는다.
    const forcedExitsForNextOpen: OrderIntent[] = [];
    if (isRebalanceBar && activeMembershipSymbols !== null) {
      const membershipSymbols = activeMembershipSymbols;
      // 지연 청산 중 다음 schedule에 재편입된 종목은 더 이상 이탈이 아니다.
      // 전략에는 실제 청산이 일어나지 않았으므로 onForcedExit를 부르지 않는다.
      for (const symbol of [...unresolvedForcedExitSymbols]) {
        if (membershipSymbols.has(symbol)) resolveForcedExit(symbol, false);
      }

      const sellEligibleNow = new Set(
        pendingOrders.filter((order) => order.side === 'SELL').map((order) => order.symbol),
      );
      for (const [symbol, position] of positions) {
        if (membershipSymbols.has(symbol) || position.quantity <= 0) continue;
        const isNewForcedExit = !unresolvedForcedExitSymbols.has(symbol);
        // 이전 전략 SELL이나 지연된 forced SELL을 전량 engine order 한 건으로 교체한다.
        pendingOrders = pendingOrders.filter(
          (order) => !(order.symbol === symbol && order.side === 'SELL'),
        );
        const forcedExit: OrderIntent = {
          symbol,
          side: 'SELL',
          quantity: position.quantity,
          reason: 'REBALANCE_EXIT',
        };
        if (sellEligibleNow.has(symbol)) pendingOrders.push(forcedExit);
        else forcedExitsForNextOpen.push(forcedExit);
        unresolvedForcedExitSymbols.add(symbol);
        if (isNewForcedExit) buysAwaitingForcedExitAttempt = true;
        if (!quantityBasisTsMsBySymbol.has(symbol)) quantityBasisTsMsBySymbol.set(symbol, tsMs);
      }

      // D-1 BUY는 발행 때의 예전 schedule이 아니라 방금 활성화된 membership으로
      // 다시 판정한다. 편출 BUY는 취소하고, 아직 유효해도 forced exit가 남아
      // 있으면 청산 다음 open까지 미룬다. 이전에 미뤄 둔 BUY도 같은 규칙이다.
      deferredRebalanceBuys = deferredRebalanceBuys.filter(
        (order) => membershipSymbols.has(order.symbol),
      );
      const reconciledPending: OrderIntent[] = [];
      for (const order of pendingOrders) {
        if (order.side !== 'BUY') {
          reconciledPending.push(order);
        } else if (!membershipSymbols.has(order.symbol)) {
          // stale membership에서는 유효했던 주문이므로 전략 버그 warning은 남기지 않는다.
          continue;
        } else if (buysAwaitingForcedExitAttempt) {
          deferBuy(order);
        } else {
          reconciledPending.push(order);
        }
      }
      pendingOrders = reconciledPending;
    }

    // 2~3. 대기 주문 체결 + 현금·포지션 갱신
    const stillPending: OrderIntent[] = [];
    for (const order of pendingOrders) {
      if (order.side === 'BUY' && buysAwaitingForcedExitAttempt) {
        deferBuy(order);
        continue;
      }
      const bar = bars.get(order.symbol);
      if (!bar) {
        stillPending.push(order); // 다음 거래 가능 봉까지 대기 (§9.1)
        continue;
      }
      const executed = executeOrder(order, bar, tsMs);
      if (executed) fills.push(executed);
      if (order.side === 'SELL' && positions.has(order.symbol)) {
        const remainingQuantity = order.reason === 'REBALANCE_EXIT'
          ? positions.get(order.symbol)!.quantity
          : Math.min(
            positions.get(order.symbol)!.quantity,
            order.quantity - (executed?.quantity ?? 0),
          );
        if (remainingQuantity >= input.execution.rules.minOrderQty) {
          stillPending.push({
            ...order,
            quantity: remainingQuantity,
          });
        }
      }
      if (
        order.reason === 'REBALANCE_EXIT'
        && unresolvedForcedExitSymbols.has(order.symbol)
        && !positions.has(order.symbol)
      ) {
        resolveForcedExit(order.symbol, true);
      }
    }
    pendingOrders = stillPending;
    pendingOrders.push(...forcedExitsForNextOpen);

    // 오늘 처음 만든 D1 청산은 아직 시도하지 않았으므로 장벽을 유지한다. 그 밖의 경우는
    // 체결 여부와 무관하게 첫 시도를 마쳤다. 미체결 SELL만 다음 거래 가능 봉까지 남긴다.
    if (buysAwaitingForcedExitAttempt && forcedExitsForNextOpen.length === 0) {
      buysAwaitingForcedExitAttempt = false;
    }

    // 역분할 단주 현금화 등으로 주문 체결 전에 포지션이 사라진 경우도 대기 상태를
    // 영원히 붙들지 않는다. 멤버십 이탈로 전략 보유 상태를 지워야 하므로 훅은 부른다.
    for (const symbol of [...unresolvedForcedExitSymbols]) {
      if (!positions.has(symbol)) resolveForcedExit(symbol, true);
    }

    // 청산을 방금 모두 마쳤다면 미뤄 둔 매수는 **이번** 체결 루프로 되돌리지 않고
    // 다음 봉 대기열에 둔다. 이 줄이 D1 sell → D2 buy 간격을 만든다.
    if (isTradeBar && !buysAwaitingForcedExitAttempt && deferredRebalanceBuys.length > 0) {
      promoteDeferredBuys(promotedBuySymbolsThisBar);
    }

    // 봉 이력·마지막 종가 갱신
    for (const [symbol, bar] of bars) {
      (historyBySymbol.get(symbol) as Candle[]).push(bar);
      lastCloseBySymbol.set(symbol, bar.close);
    }

    if (!isTradeBar) {
      const warmupContext: StrategyBarContext = {
        tsMs,
        isRebalanceBar: false,
        bars,
        getHistory: (symbol) => historyBySymbol.get(symbol) ?? [],
        portfolio: { cash, equity: markToMarket(), positions },
        rng,
        fundamentals: (symbol) => factView.fundamentals(symbol),
        corporateActions: (symbol) => factView.corporateActions(symbol, tsMs),
        tradableSymbols,
        activeUniverseSymbols: activeMembershipSymbols,
        selectionMetric: (symbol) => activeSelectionMetrics?.get(symbol) ?? null,
      };
      // warm-up은 전략 지표/커서 상태만 전진시킨다. 반환 주문은 의도적으로 버린다.
      strategy.onBars(warmupContext, state, input.parameters);
      if (visitedBars % CANCEL_YIELD_INTERVAL_BARS < bars.size) yield;
      continue;
    }

    // 상장폐지 청산 — 폐지 효력 시각 직전 마지막 봉에서 종가로 전량 정산한다.
    // 주문장 체결 모델이 아니므로 participation 한도는 적용하지 않는다.
    //
    // 평가금액 갱신보다 먼저다. 이 시점 자산곡선이 청산 대금을 이미 반영해야
    // 폐지 손실이 곡선에 남는다.
    //
    // 체결가는 이 봉의 종가다. `krx_non_trading_days.lastClose` 는 쓰지 않는다 —
    // 정지 중 가격은 팔 수 있는 가격이 아니다. 정지 상태로 폐지된 종목은
    // 정지 직전 실거래가로 나간다.
    //
    // 정리매매 종가를 따로 추정하지 않는다. KRX 일봉에 정리매매 기간 봉이 들어 있어
    // 폐지 직전 마지막 봉이 곧 정리매매 최종가다. 시장이 매긴 회수가치를 그대로 쓴다.
    if (liquidationBarTsMsBySymbol.size > 0) {
      for (const [symbol, bar] of bars) {
        if (liquidationBarTsMsBySymbol.get(symbol)?.has(tsMs) !== true) continue;

        // D0에 방금 만든 REBALANCE_EXIT가 pendingOrders에 있을 수 있다.
        // 이 폐지 청산이 선행하면 아래 resolveForcedExit가 그 주문도 같이 제거한다.
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
        if (!positions.has(symbol)) {
          strategy.onForcedExit?.(symbol, state);
          if (unresolvedForcedExitSymbols.has(symbol)) resolveForcedExit(symbol, false);
        }
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
      isRebalanceBar,
      bars,
      getHistory: (symbol) => historyBySymbol.get(symbol) ?? [],
      portfolio: portfolioView,
      rng,
      fundamentals: (symbol) => factView.fundamentals(symbol),
      corporateActions: (symbol) => factView.corporateActions(symbol, tsMs),
      tradableSymbols,
      activeUniverseSymbols: activeMembershipSymbols,
      selectionMetric: (symbol) => activeSelectionMetrics?.get(symbol) ?? null,
    };
    const decision = strategy.onBars(context, state, input.parameters);

    // 7~8. 리스크 검증 후 다음 봉 대기열 등록
    //
    // 전략은 동시 신호의 우선순위를 별도 필드로 표현하지 않는다. 반환 배열 순서를
    // 그대로 쓰면 현금이나 maxPositions 슬롯이 부족할 때 종목코드순 같은 구현 상세가
    // 수익률을 결정한다. SELL의 상대 위치는 보존하고, 같은 onBars 호출에서 발행된
    // BUY 슬롯만 seeded Fisher–Yates로 섞어 같은 seed는 재현하고 seed별 실험을 가능하게 한다.
    for (const order of randomizeSimultaneousBuyPriority(decision.orders)) {
      if (
        order.side === 'SELL'
        && unresolvedForcedExitSymbols.has(order.symbol)
      ) {
        continue; // 엔진의 전량 REBALANCE_EXIT 한 건이 같은 symbol 전략 SELL을 대체한다
      }
      const shouldDeferBuy = order.side === 'BUY'
        && (isRebalanceBar || buysAwaitingForcedExitAttempt);
      const validated = validateOrder(order, shouldDeferBuy);
      if (!validated) continue;
      if (shouldDeferBuy) {
        deferBuy(validated);
      } else {
        if (order.side === 'BUY' && promotedBuySymbolsThisBar.has(order.symbol)) {
          // 청산 체결 직후 승격된 BUY를 전략이 같은 봉에서 다시 계산하면 최신 수량 한
          // 건으로 바꾼다. 둘 다 남기면 다음 open에 같은 종목을 두 번 산다.
          pendingOrders = pendingOrders.filter(
            (pending) => !(pending.side === 'BUY' && pending.symbol === order.symbol),
          );
        }
        pendingOrders.push(validated);
      }
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

    // 이 리밸런스에 청산할 이탈 보유분이 없었다면 일반 NEXT_BAR_OPEN과 같은 D1에
    // 매수한다. 이탈 보유분이 있었던 경우에는 위 체결 단계에서 해소되는 D1까지 남는다.
    if (!buysAwaitingForcedExitAttempt && deferredRebalanceBuys.length > 0) {
      promoteDeferredBuys(promotedBuySymbolsThisBar);
    }

    // 9. 진행률
    processedBars += bars.size;
    if (hooks.onProgress && (processedBars % PROGRESS_INTERVAL_BARS < bars.size || tsMs === timeline[timeline.length - 1])) {
      hooks.onProgress({ processedBars, totalBars, currentTsMs: tsMs });
    }

    // 취소 확인 창. `runBacktest`(동기 드라이버)는 이 yield 를 그냥 흘려보낸다.
    // `runBacktestCancellable` 만 여기서 실제로 이벤트 루프에 양보한다.
    if (visitedBars % CANCEL_YIELD_INTERVAL_BARS < bars.size) {
      yield;
    }
  }

  if (unresolvedForcedExitSymbols.size > 0) {
    warnings.push(
      `리밸런스 유니버스 이탈 청산 ${unresolvedForcedExitSymbols.size}건이 기간 종료까지 체결되지 않아 `
        + '미청산 포지션으로 남았습니다.'
        + (deferredRebalanceBuys.length > 0
          ? ` 청산 우선권 때문에 후속 매수 주문 ${deferredRebalanceBuys.length}건도 체결되지 않았습니다.`
          : ''),
    );
  }
  if (pendingOrders.length > 0 || deferredRebalanceBuys.length > 0) {
    warnings.push(
      `기간 종료로 체결되지 않은 주문 ${pendingOrders.length + deferredRebalanceBuys.length}건이 폐기되었습니다.`,
    );
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
  if (maxVolumeParticipationRate !== undefined) {
    const limited = [...liquidityLimitedOrders.values()].reduce((sum, count) => sum + count, 0);
    const rejected = [...liquidityRejectedOrders.values()].reduce((sum, count) => sum + count, 0);
    const symbols = [...new Set([
      ...liquidityLimitedOrders.keys(),
      ...liquidityRejectedOrders.keys(),
    ])].sort();
    warnings.push(
      `유동성 체결 한도: 직전 거래 봉 거래량의 ${maxVolumeParticipationRate * 100}%까지 체결합니다. `
        + '매수 잔량은 폐기하고 매도 잔량은 다음 거래 봉에서 재시도합니다. '
        + '상장폐지 강제정산은 마지막 거래 종가 전량 정산 모델을 유지해 이 한도에서 제외합니다.'
        + (limited + rejected > 0
          ? ` 한도로 축소된 체결 시도 ${limited}건, 거부된 체결 시도 ${rejected}건 — 대상 ${symbols.length}종목: ${symbols.slice(0, 10).join(', ')}`
            + (symbols.length > 10 ? ` 외 ${symbols.length - 10}종목` : '')
            + '.'
          : ''),
    );
  }
  warnings.push(...(strategy.completionWarnings?.(state, input.parameters) ?? []));
  // 분할 보정 여부는 "팩트가 있는가" 가 아니라 "**자본변동** 팩트가 있는가" 다 —
  // 재무만 수집된 데이터셋(SPLIT_RATIO 0건)에서 팩트 건수로 판단하면 일어나지 않은
  // 보정을 일어났다고 말한다.
  const hasCorporateActionFacts = (input.facts ?? []).some(
    (fact) => fact.field === CORPORATE_ACTION_FIELD,
  );

  // "생존 편향" 이라는 단일 라벨은 쓰지 않는다. 시점별 유니버스 선정과 상장폐지 청산은
  // 하고, 배당·권리락·과거 지수 구성원은 안 한다 — 예/아니오로 답할 수 없는 상태다.
  // 화면(universe-provenance.ts)이 같은 이유로 "생존자 편향 제거" 표현을 금지한다.
  //
  // 항목마다 그 보정을 실제로 돌린 입력이 들어왔을 때만 적는다. 전부 적어 두면 백필
  // 전 DB 의 모든 실행이 "거래불가일 매수 제외" 를 보정한다고 말하면서 네 줄 아래에서
  // "거래불가일 정보가 없습니다" 를 함께 내보낸다 — 경고가 다시 거짓말을 하는 자리다
  // (D-046, 설계 §4). 판정 규칙은 액면분할(hasCorporateActionFacts)과 같다.
  const correctedItems: string[] = [];
  // 일정이 비면 엔진은 tradableSymbols 를 계속 null(제한 없음)로 두므로 유니버스 선정이 없다
  if ((input.universeSchedule?.length ?? 0) > 0) correctedItems.push('시점별 유니버스 선정');
  if (input.delistedTsMsBySymbol !== undefined) correctedItems.push('상장폐지 청산');
  // 커버 구간으로만 가른다. 행이 몇 건 있어도 구간이 안 덮였으면 "모르는 날" 이 섞여 있다
  if (input.nonTradingCoveredPeriod != null) {
    correctedItems.push('거래불가일(거래정지·무거래) 매수 제외');
  }
  if (hasCorporateActionFacts) {
    correctedItems.push('액면분할(보유 수량·평균단가·대기 주문·전략 가격 상태)');
  }
  warnings.push(
    '이 백테스트가 보정하는 것: '
      + (correctedItems.length > 0 ? correctedItems.join(', ') : '없습니다')
      + (hasCorporateActionFacts
        ? '. 보정 종가를 쓰는 전략은 신호 계산에도 반영됩니다. '
          + '이미 체결된 거래의 체결가는 조정하지 않습니다.'
        : '. 액면분할은 이 실행에서 보정되지 않았습니다 (분할 이력 미수집).'),
  );
  warnings.push(
    '이 백테스트가 보정하지 않는 것: 배당, 유상증자 권리락, 무상증자·주식배당 권리락, 공휴일 캘린더, '
      + '과거 지수 구성원 복원. 무상증자·주식배당은 주가가 권리락일에 떨어지는데 수량은 신주상장일에 늘어나므로 '
      + '그 사이 구간의 평가금액이 실제보다 낮습니다 (권리락일은 수집하는 데이터에 없습니다). '
      + '손절·익절은 종가로만 판정합니다.',
  );

  if (delistingLiquidations.length > 0) {
    const netPnl = delistingLiquidations.reduce((sum, item) => sum + item.netPnl, 0);
    const symbols = delistingLiquidations.map((item) => item.symbol).sort();
    const shown = symbols.slice(0, 10).join(', ');
    warnings.push(
      `상장폐지로 강제 청산한 종목 ${symbols.length}건: ${shown}`
        + (symbols.length > 10 ? ` 외 ${symbols.length - 10}종목` : '')
        // 로캘을 못박는다. 지정하지 않으면 기계마다 1,234,567 과 1.234.567 로 갈려
        // 같은 실행의 warningsJson 이 달라진다 (재현성 §9.5).
        + `. 손익 합계 ${Math.round(netPnl).toLocaleString('ko-KR')}원. `
        + '체결가는 그 종목의 마지막 거래 가능 봉 종가이며, 정리매매가 있었다면 그 가격이 반영됩니다.',
    );
  }

  // 덮인 경우에는 아무 말도 하지 않는다. 워커는 실행 기간 전체가 덮였을 때만 구간을
  // 넘기므로(backtest-child.ts), 그 구간을 다시 적으면 "만 반영됐다" 가 되어 전부
  // 반영된 실행을 반쪽처럼 읽게 만든다. 위 "보정하는 것" 줄이 이미 거래불가일 반영을
  // 밝히고 있어 덧붙일 사실도 없다.
  if (input.nonTradingCoveredPeriod === null) {
    warnings.push(
      '이 실행 구간에는 거래불가일 정보가 없습니다 — 거래정지 종목이 유니버스와 매수 후보에 그대로 들어갔을 수 있습니다. '
        + '`cli krx:backfill-non-trading` 으로 채운 뒤 다시 실행하세요.',
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
  // 없는 돈이 어디 있는지를 명시적으로 보여준다. 이미 낸 매수 수수료는 평가손익에
  // 포함하고, 아직 발생하지 않은 매도 수수료·세금은 반영하지 않는다.
  const openPositions: OpenPositionSnapshot[] = [...positions.values()]
    .filter((position) => position.quantity > 0)
    .map((position) => {
      const lastPrice = lastCloseBySymbol.get(position.symbol) ?? position.avgEntryPrice;
      const lastPriceTsMs = lastBarTsMsBySymbol.get(position.symbol) ?? position.entryTsMs;
      const costBasis = position.quantity * position.avgEntryPrice;
      const unrealizedPnl = position.quantity * (lastPrice - position.avgEntryPrice)
        - position.entryCosts;
      return {
        symbol: position.symbol,
        quantity: position.quantity,
        avgEntryPrice: position.avgEntryPrice,
        entryTsMs: position.entryTsMs,
        lastPrice,
        lastPriceTsMs,
        unrealizedPnl,
        returnPct: costBasis > 0 ? (unrealizedPnl / costBasis) * 100 : 0,
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
    warnings,
    cancelled,
    processedBars,
    delistingLiquidations,
  };

  // ── 내부 helpers ─────────────────────────────────────────────

  function randomizeSimultaneousBuyPriority(orders: readonly OrderIntent[]): OrderIntent[] {
    const buys = orders.filter((order) => order.side === 'BUY');
    if (buys.length < 2) return [...orders];

    for (let index = buys.length - 1; index > 0; index -= 1) {
      const swapIndex = Math.floor(buyPriorityRng() * (index + 1));
      const current = buys[index] as OrderIntent;
      buys[index] = buys[swapIndex] as OrderIntent;
      buys[swapIndex] = current;
    }

    let buyIndex = 0;
    return orders.map((order) => (
      order.side === 'BUY' ? (buys[buyIndex++] as OrderIntent) : order
    ));
  }

  function deferBuy(order: OrderIntent): void {
    // 같은 이탈 청산을 기다리는 동안 전략이 매 봉 같은 후보를 다시 내도 한 건만 둔다.
    deferredRebalanceBuys = deferredRebalanceBuys.filter(
      (pending) => pending.symbol !== order.symbol,
    );
    deferredRebalanceBuys.push(order);
  }

  function promoteDeferredBuys(promotedSymbols: Set<string>): void {
    const deferred = deferredRebalanceBuys;
    deferredRebalanceBuys = [];
    for (const order of deferred) {
      const validated = validateOrder(order);
      if (validated) {
        pendingOrders.push(validated);
        promotedSymbols.add(validated.symbol);
      }
    }
  }

  function resolveForcedExit(symbol: string, notifyStrategy: boolean): void {
    unresolvedForcedExitSymbols.delete(symbol);
    pendingOrders = pendingOrders.filter(
      (order) => !(order.symbol === symbol && order.reason === 'REBALANCE_EXIT'),
    );
    if (notifyStrategy) strategy.onForcedExit?.(symbol, state);
  }

  function validateOrder(order: OrderIntent, ignorePositionCap = false): OrderIntent | null {
    if (!Number.isFinite(order.quantity) || order.quantity < input.execution.rules.minOrderQty) {
      return null;
    }
    const quantity = Math.floor(order.quantity);

    if (order.side === 'SELL') {
      const position = positions.get(order.symbol);
      if (!position || position.quantity <= 0) return null;
      return { ...order, quantity: Math.min(quantity, position.quantity) };
    }

    // BUY: 그날 거래정지·무거래인 종목은 여기서 먼저 가른다. 거래불가 필터가 이미
    // tradableSymbols 에서 그 종목을 빼 놓기 때문에, 순서를 바꾸면 아래 멤버십 안전망
    // 문구가 나가 멀쩡한 전략을 버그라고 말하게 된다. 보유분 청산(SELL)은 위에서 이미
    // 갈라져 이 검증을 타지 않는다 — 정지 종목이라도 청산은 막지 않는다.
    if (nonTradingNow?.has(order.symbol) === true) {
      if (!nonTradingRejectedSymbols.has(order.symbol)) {
        nonTradingRejectedSymbols.add(order.symbol);
        warnings.push(
          `${order.symbol} 매수 거부: 그날 거래정지·무거래로 매수할 수 없는 종목입니다.`,
        );
      }
      return null;
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
    if (!ignorePositionCap && !positions.has(order.symbol)) {
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
    // 이미 닫힌 포지션의 중복 SELL은 유동성 거부 시도로 세지 않는다.
    // 한도 적용 전 현재 보유 수량으로 먼저 잘라 oversell 요청도 정확히 기록한다.
    let executableOrder = order;
    if (order.side === 'SELL') {
      const position = positions.get(order.symbol);
      if (!position || position.quantity <= 0) return null;
      executableOrder = {
        ...order,
        quantity: Math.min(order.quantity, position.quantity),
      };
    }

    const volumeLimitedOrder = applyVolumeLimit(executableOrder);
    if (volumeLimitedOrder === null) return null;

    if (volumeLimitedOrder.side === 'BUY') {
      let fill = simulateFill(volumeLimitedOrder, basePrice, tsMs, input.execution, bar.venue);
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
        fill = simulateFill(
          { ...volumeLimitedOrder, quantity: affordable },
          basePrice,
          tsMs,
          input.execution,
          bar.venue,
        );
      }

      cash -= requiredCashForBuy(fill);
      recordFilledQuantity(fill);
      const existing = positions.get(volumeLimitedOrder.symbol);
      if (existing) {
        const totalQty = existing.quantity + fill.quantity;
        existing.avgEntryPrice =
          (existing.avgEntryPrice * existing.quantity + fill.price * fill.quantity) / totalQty;
        existing.quantity = totalQty;
        existing.entryCosts += fill.commission;
      } else {
        positions.set(volumeLimitedOrder.symbol, {
          symbol: volumeLimitedOrder.symbol,
          quantity: fill.quantity,
          avgEntryPrice: fill.price,
          entryCosts: fill.commission,
          entryTsMs: tsMs,
        });
      }
      return fill;
    }

    // SELL
    const position = positions.get(volumeLimitedOrder.symbol)!;
    const sellQty = volumeLimitedOrder.quantity;
    const fill = simulateFill(
      { ...volumeLimitedOrder, quantity: sellQty },
      basePrice,
      tsMs,
      input.execution,
      bar.venue,
    );

    cash += proceedsFromSell(fill);
    recordFilledQuantity(fill);

    // 슬리피지는 체결가(entry/exit price)에 이미 반영되어 grossPnl 에 포함된다.
    // 추가로 차감할 비용은 수수료·세금뿐이다 (이중 계산 금지).
    const proportion = sellQty / position.quantity;
    const entryCostsShare = position.entryCosts * proportion;
    const grossPnl = (fill.price - position.avgEntryPrice) * sellQty;
    const totalCosts = entryCostsShare + fill.commission + fill.tax;
    const netPnl = grossPnl - totalCosts;
    const costBasis = position.avgEntryPrice * sellQty;

    trades.push({
      symbol: volumeLimitedOrder.symbol,
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
      ...(volumeLimitedOrder.reason !== undefined ? { exitReason: volumeLimitedOrder.reason } : {}),
    });

    position.quantity -= sellQty;
    position.entryCosts -= entryCostsShare;
    if (position.quantity <= 0) positions.delete(volumeLimitedOrder.symbol);

    return fill;
  }

  function applyVolumeLimit(order: OrderIntent): OrderIntent | null {
    // DELISTED 는 주문장 체결이 아니라 마지막 거래 종가로 전량을
    // 강제정산하는 현재 모델이다. 마지막 봉에서 일부만 체결하면 재시도할
    // 봉이 없어 남은 주식을 낡은 종가로 평가하게 되므로 participation 한도에서 제외한다.
    if (maxVolumeParticipationRate === undefined || order.reason === 'DELISTED') return order;

    const priorVolume = priorVolumeBySymbolThisBar.get(order.symbol) ?? 0;
    const unitRatio = volumeUnitRatioBySymbolThisBar.get(order.symbol) ?? 1;
    const capacity = Math.floor(priorVolume * unitRatio * maxVolumeParticipationRate);
    const used = filledQuantityBySymbolThisBar.get(order.symbol) ?? 0;
    const remaining = Math.max(0, capacity - used);
    const requested = Math.floor(order.quantity);
    const quantity = Math.min(requested, remaining);

    if (quantity < input.execution.rules.minOrderQty) {
      liquidityRejectedOrders.set(
        order.symbol,
        (liquidityRejectedOrders.get(order.symbol) ?? 0) + 1,
      );
      return null;
    }
    if (quantity < requested) {
      liquidityLimitedOrders.set(
        order.symbol,
        (liquidityLimitedOrders.get(order.symbol) ?? 0) + 1,
      );
    }
    return { ...order, quantity };
  }

  function recordFilledQuantity(fill: Fill): void {
    filledQuantityBySymbolThisBar.set(
      fill.symbol,
      (filledQuantityBySymbolThisBar.get(fill.symbol) ?? 0) + fill.quantity,
    );
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
