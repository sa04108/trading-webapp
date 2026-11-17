import { intradayRequestSchema, type IntradayRequest, type IntradayTimeframe } from "./intraday.js";

export type IntradayStrategyId = IntradayRequest["strategyId"];
export interface IntradayParameterField {
  key: string;
  label: string;
  min: number;
  max: number;
  step?: number;
}
export interface IntradayStrategyDefinition {
  id: IntradayStrategyId;
  version: string;
  defaultTimeframe: IntradayTimeframe;
  timeframes: readonly IntradayTimeframe[];
  name: string;
  regime: string;
  description: string;
  caution: string;
  entry: string;
  exit: string;
  defaults: IntradayRequest["parameters"];
  fields: readonly IntradayParameterField[];
}

/** 수익률 순위가 아닌 서로 다른 장세를 검증하기 위한 기본 전략 구성이다. */
export const INTRADAY_STRATEGIES: readonly IntradayStrategyDefinition[] = [
  {
    id: "intraday-orb",
    version: "2.0.0",
    defaultTimeframe: "5m",
    timeframes: ["1m", "5m", "15m"],
    name: "시초가 범위 돌파",
    regime: "장 초반 추세",
    description:
      "장 초반 가격 범위를 거래량과 함께 돌파하는 종목을 추종합니다.",
    caution: "횡보장의 거짓 돌파와 장 초반 슬리피지에 민감합니다.",
    entry:
      "시초 범위 고점에 돌파 여유를 더한 가격을 종가로 상향 돌파하고, 거래량 조건을 만족한 첫 신호에 진입합니다.",
    exit: "시초 범위 중간값 아래로 종가가 내려오면 청산 신호를 냅니다.",
    defaults: {
      maxDailyEntries: 1,
      cooldownMinutes: 30,
      maxHoldingMinutes: 120,
      openingMinutes: 15,
      entryWindowMinutes: 150,
      breakoutBps: 5,
      volumeMultiplier: 1,
      allocationPct: 50,
      stopLossPct: 1.5,
      takeProfitPct: 3,
    },
    fields: [
      { key: "openingMinutes", label: "시초 범위 (분)", min: 5, max: 60 },
      {
        key: "entryWindowMinutes",
        label: "개장 후 진입 제한 (분)",
        min: 15,
        max: 180,
      },
      {
        key: "breakoutBps",
        label: "돌파 여유 (bps)",
        min: 0,
        max: 100,
        step: 1,
      },
      {
        key: "volumeMultiplier",
        label: "시초 평균 대비 거래량 (배)",
        min: 1,
        max: 5,
        step: 0.1,
      },
    ],
  },
  {
    id: "intraday-vwap-reclaim",
    version: "2.0.0",
    defaultTimeframe: "15m",
    timeframes: ["15m"],
    name: "VWAP 회복",
    regime: "장중 추세 회복",
    description:
      "당일 거래량 가중 평균가격을 회복하는 움직임을 상승 추세와 거래량으로 확인합니다.",
    caution:
      "VWAP 주변 횡보에서는 반복 매매 비용이 커질 수 있습니다. VWAP은 1분봉 대표가격 근사치입니다.",
    entry:
      "15분봉 종가가 당일 VWAP을 아래에서 위로 회복하고, 상승 중인 EMA 위에서 이전 봉 평균 대비 거래량 조건을 만족하면 진입합니다.",
    exit: "종가가 당일 VWAP 아래로 내려가면 청산 신호를 냅니다.",
    defaults: {
      maxDailyEntries: 2,
      cooldownMinutes: 30,
      maxHoldingMinutes: 120,
      trendPeriod: 8,
      volumePeriod: 4,
      volumeMultiplier: 1.3,
      allocationPct: 50,
      stopLossPct: 1.5,
      takeProfitPct: 3,
    },
    fields: [
      { key: "trendPeriod", label: "추세 EMA (봉)", min: 3, max: 120 },
      { key: "volumePeriod", label: "평균 거래량 (봉)", min: 2, max: 60 },
      {
        key: "volumeMultiplier",
        label: "평균 대비 거래량 (배)",
        min: 1,
        max: 5,
        step: 0.1,
      },
    ],
  },
  {
    id: "intraday-bollinger-rsi",
    version: "2.0.0",
    defaultTimeframe: "5m",
    timeframes: ["1m", "5m", "15m"],
    name: "볼린저·RSI 되돌림",
    regime: "횡보장 과매도 회복",
    description:
      "하단 밴드 밖의 과매도가 완화되어 밴드 안으로 돌아오는 움직임을 포착합니다.",
    caution:
      "강한 하락 추세에서는 손실이 이어질 수 있습니다. 충분한 거래량과 손절 조건을 함께 검증하세요.",
    entry:
      "하단 밴드 이하·RSI 과매도를 확인한 뒤 회복 대기 봉 수 안에 중심선 아래에서 밴드 안으로 복귀하고 RSI가 상승하면 한 번 진입합니다.",
    exit: "종가가 볼린저밴드 중심선에 도달하면 청산 신호를 냅니다.",
    defaults: {
      maxDailyEntries: 2,
      cooldownMinutes: 30,
      maxHoldingMinutes: 60,
      bandPeriod: 14,
      bandStdDev: 1.8,
      rsiPeriod: 7,
      oversold: 35,
      recoveryBars: 3,
      allocationPct: 40,
      stopLossPct: 1,
      takeProfitPct: 2,
    },
    fields: [
      { key: "bandPeriod", label: "볼린저 기간 (봉)", min: 3, max: 120 },
      { key: "bandStdDev", label: "표준편차 배수", min: 1, max: 3, step: 0.1 },
      { key: "rsiPeriod", label: "RSI 기간 (봉)", min: 2, max: 60 },
      { key: "oversold", label: "과매도 RSI", min: 5, max: 45 },
      { key: "recoveryBars", label: "회복 대기 (봉)", min: 1, max: 6 },
    ],
  },
  {
    id: "intraday-ema",
    version: "2.0.0",
    defaultTimeframe: "15m",
    timeframes: ["15m"],
    name: "EMA 교차",
    regime: "거래량 확인 추세",
    description:
      "15분봉 EMA 교차를 상승 추세와 거래량 증가로 확인합니다.",
    caution:
      "횡보장에서 신호가 잦아질 수 있습니다. 비용을 반영해 신규 전략과 비교하세요.",
    entry:
      "15분봉에서 단기 EMA가 상승 중인 장기 EMA를 상향 돌파하고, 이전 봉 평균 대비 거래량 조건을 만족하면 진입합니다.",
    exit: "단기 EMA가 장기 EMA 아래로 내려가면 청산 신호를 냅니다.",
    defaults: {
      maxDailyEntries: 2,
      cooldownMinutes: 30,
      maxHoldingMinutes: 120,
      fast: 4,
      slow: 10,
      volumePeriod: 4,
      volumeMultiplier: 1.3,
      allocationPct: 50,
      stopLossPct: 1.5,
      takeProfitPct: 3,
    },
    fields: [
      { key: "fast", label: "단기 EMA", min: 2, max: 119 },
      { key: "slow", label: "장기 EMA", min: 3, max: 120 },
      { key: "volumePeriod", label: "평균 거래량 (봉)", min: 2, max: 60 },
      { key: "volumeMultiplier", label: "평균 대비 거래량 (배)", min: 1, max: 5, step: 0.1 },
    ],
  },
];

export function getIntradayStrategy(
  id: IntradayStrategyId,
): IntradayStrategyDefinition {
  const strategy = INTRADAY_STRATEGIES.find((candidate) => candidate.id === id);
  if (!strategy) throw new Error(`지원하지 않는 분봉 전략입니다: ${id}`);
  return strategy;
}

export const INTRADAY_TRADE_CONTROL_FIELDS: readonly IntradayParameterField[] = [
  { key: "maxDailyEntries", label: "하루 최대 진입 (회)", min: 1, max: 10 },
  { key: "cooldownMinutes", label: "청산 후 재진입 대기 (분)", min: 0, max: 180 },
  { key: "maxHoldingMinutes", label: "최대 보유 (분)", min: 5, max: 380 },
];

export function resolveIntradayRequest(request: IntradayRequest): IntradayRequest {
  return intradayRequestSchema.parse({
    ...request,
    parameters: { ...getIntradayStrategy(request.strategyId).defaults, ...request.parameters },
  });
}

/** 새 실행에만 최신 기본값·봉 주기 제약을 적용하고 기존 저장 결과는 원형대로 읽는다. */
export const intradayRunRequestSchema = intradayRequestSchema
  .transform(resolveIntradayRequest)
  .superRefine((request, ctx) => {
    const strategy = getIntradayStrategy(request.strategyId);
    if (!strategy.timeframes.includes(request.timeframe)) ctx.addIssue({
      code: "custom", path: ["timeframe"],
      message: `${strategy.name}의 새 실행은 15분봉을 사용합니다. 재설정 및 복제에서 봉 주기와 지표 기간을 확인해 주세요.`,
    });
    if (request.strategyId === "intraday-bollinger-rsi" && request.parameters.bandStdDev > Math.sqrt(request.parameters.bandPeriod - 1)) ctx.addIssue({
      code: "custom", path: ["parameters", "bandStdDev"],
      message: "이 볼린저 기간과 표준편차 배수로는 하단 밴드에 도달할 수 없습니다. 기간을 늘리거나 배수를 줄여 주세요.",
    });
  });
