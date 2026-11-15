import type { IntradayRequest } from "./intraday.js";

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
    version: "1.0.0",
    name: "시초가 범위 돌파",
    regime: "장 초반 추세",
    description:
      "장 초반 가격 범위를 거래량과 함께 돌파하는 종목을 추종합니다.",
    caution: "횡보장의 거짓 돌파와 장 초반 슬리피지에 민감합니다.",
    entry:
      "시초 범위 고점에 돌파 여유를 더한 가격을 종가로 상향 돌파하고, 거래량 조건을 만족한 첫 신호에 진입합니다.",
    exit: "시초 범위 중간값 아래로 종가가 내려오면 청산 신호를 냅니다.",
    defaults: {
      openingMinutes: 15,
      entryWindowMinutes: 90,
      breakoutBps: 10,
      volumeMultiplier: 1.5,
      allocationPct: 95,
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
    version: "1.0.0",
    name: "VWAP 회복",
    regime: "장중 추세 회복",
    description:
      "당일 거래량 가중 평균가격을 회복하는 움직임을 상승 추세와 거래량으로 확인합니다.",
    caution:
      "VWAP 주변 횡보에서는 반복 매매 비용이 커질 수 있습니다. VWAP은 1분봉 대표가격 근사치입니다.",
    entry:
      "종가가 당일 VWAP을 아래에서 위로 회복하고, 상승 중인 EMA 위에서 이전 봉 평균 대비 거래량 조건을 만족하면 진입합니다.",
    exit: "종가가 당일 VWAP 아래로 내려가면 청산 신호를 냅니다.",
    defaults: {
      trendPeriod: 20,
      volumePeriod: 10,
      volumeMultiplier: 1.2,
      allocationPct: 95,
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
    version: "1.0.0",
    name: "볼린저·RSI 되돌림",
    regime: "횡보장 과매도 회복",
    description:
      "하단 밴드 밖의 과매도가 완화되어 밴드 안으로 돌아오는 움직임을 포착합니다.",
    caution:
      "강한 하락 추세에서는 손실이 이어질 수 있습니다. 충분한 거래량과 손절 조건을 함께 검증하세요.",
    entry:
      "직전 종가가 하단 밴드 이하이고 RSI가 과매도인 상태에서, 종가가 밴드 안으로 복귀하고 RSI가 상승하면 진입합니다.",
    exit: "종가가 볼린저밴드 중심선에 도달하면 청산 신호를 냅니다.",
    defaults: {
      bandPeriod: 20,
      bandStdDev: 2,
      rsiPeriod: 14,
      oversold: 30,
      allocationPct: 95,
      stopLossPct: 1,
      takeProfitPct: 2,
    },
    fields: [
      { key: "bandPeriod", label: "볼린저 기간 (봉)", min: 3, max: 120 },
      { key: "bandStdDev", label: "표준편차 배수", min: 1, max: 3, step: 0.1 },
      { key: "rsiPeriod", label: "RSI 기간 (봉)", min: 2, max: 60 },
      { key: "oversold", label: "과매도 RSI", min: 5, max: 45 },
    ],
  },
  {
    id: "intraday-ema",
    version: "1.0.0",
    name: "EMA 교차",
    regime: "기존 추세 전략",
    description:
      "단기 EMA가 장기 EMA를 상향 돌파하면 진입하는 기본 추세 전략입니다.",
    caution:
      "횡보장에서 신호가 잦아질 수 있습니다. 비용을 반영해 신규 전략과 비교하세요.",
    entry:
      "장기 EMA 기간만큼 준비한 뒤 단기 EMA가 장기 EMA를 상향 돌파하면 진입합니다.",
    exit: "단기 EMA가 장기 EMA 아래로 내려가면 청산 신호를 냅니다.",
    defaults: {
      fast: 12,
      slow: 26,
      allocationPct: 95,
      stopLossPct: 3,
      takeProfitPct: 6,
    },
    fields: [
      { key: "fast", label: "단기 EMA", min: 2, max: 119 },
      { key: "slow", label: "장기 EMA", min: 3, max: 120 },
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
