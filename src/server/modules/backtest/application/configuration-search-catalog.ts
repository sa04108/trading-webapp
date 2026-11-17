import { randomInt } from "node:crypto";
import { backtestRequestSchema, MAX_RANDOM_SEED, type BacktestRequest } from "../../../../shared/schemas/backtest-request.js";
import { intradayRequestSchema, type IntradayRequest } from "../../../../shared/schemas/intraday.js";
import { getIntradayStrategy } from "../../../../shared/schemas/intraday-strategies.js";
import type { ConfigurationSearchCatalog, ConfigurationSearchConfig, ConfigurationSearchField, ConfigurationSearchRequest, SearchValue } from "../../../../shared/schemas/configuration-search.js";
import type { StrategyRegistry } from "../../../../runtime/modules/strategy/application/strategy-registry.js";
import { listCostProfiles, listSlippageProfiles } from "../../../../runtime/modules/backtest/domain/cost-profiles.js";

type NumberField = Extract<ConfigurationSearchField, { kind: "number" }>;
const recommendedParameters: Record<string, [number, number]> = {
  lookbackBars: [10, 40], atrPeriod: [7, 21], stopAtrMultiplier: [1, 3], trailAtrMultiplier: [1, 3],
  takeProfitAtrMultiplier: [2, 6], maxHoldBars: [20, 120], riskPerTradePercent: [0.5, 2], maxPositionWeightPercent: [10, 30],
  topN: [10, 40], fastEmaBars: [5, 20], slowEmaBars: [20, 60], entryThresholdPercent: [0.1, 1],
  correlationBars: [40, 120], correlationThreshold: [0.3, 0.7], rsiPeriod: [7, 21], entryRsi: [20, 35], exitRsi: [50, 70],
  formationDays: [126, 252], skipDays: [5, 21], staleQuarters: [1, 4], priceMomentumDays: [60, 180],
  fast: [5, 20], slow: [20, 60], openingMinutes: [5, 30], entryWindowMinutes: [30, 120], breakoutBps: [5, 30],
  volumeMultiplier: [1, 2], trendPeriod: [10, 40], volumePeriod: [5, 20], bandPeriod: [10, 30],
  bandStdDev: [1.5, 2.5], oversold: [20, 35], allocationPct: [50, 95], stopLossPct: [0.5, 3], takeProfitPct: [1, 6],
};
const round = (value: number) => Number(value.toFixed(8));
function numeric(key: string, label: string, group: NumberField["group"], current: SearchValue, min: number, max: number, step: number, recommended?: [number, number], allowUnset = false, description?: string): NumberField {
  const baseline = typeof current === "number" ? current : min + (max - min) / 4;
  const range = recommended ?? [baseline / 2, baseline * 1.5];
  const snap = (value: number) => round(Math.max(min, Math.min(max, Math.round(value / step) * step)));
  return { key, label, group, current, kind: "number", min, max, step, integer: step === 1, recommended: [snap(range[0]), snap(range[1])], ...(allowUnset ? { allowUnset: true } : {}), ...(description ? { description } : {}) };
}
function choice(key: string, label: string, group: ConfigurationSearchField["group"], current: SearchValue, options: [SearchValue, string][], description?: string): ConfigurationSearchField {
  return { key, label, group, current, kind: "choice", options: options.map(([value, label]) => ({ value, label })), recommended: options.map(([value]) => value), ...(description ? { description } : {}) };
}

/** 허용값은 실행 스키마에서 가져오고 추천값은 수익률 보장이 아닌 탐색 시작점이다. */
export function dailySearchCatalog(sourceJobId: string, request: BacktestRequest, strategies: StrategyRegistry): ConfigurationSearchCatalog {
  const schema = strategies.getParameterJsonSchema(request.strategyId);
  if (!schema) throw new Error("지원하지 않는 전략입니다.");
  const properties = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
  const fields: ConfigurationSearchField[] = [];
  for (const [key, property] of Object.entries(properties)) {
    const current = (request.parameters[key] ?? property.default ?? null) as SearchValue;
    const label = typeof property.title === "string" ? property.title : key;
    const description = typeof property.description === "string" ? property.description : undefined;
    if (property.type === "boolean") fields.push(choice(`parameters.${key}`, label, "strategy", current, [[true, "사용"], [false, "사용 안 함"]], description));
    else if (Array.isArray(property.enum)) fields.push(choice(`parameters.${key}`, label, "strategy", current, property.enum.map(value => [value as SearchValue, String(value)]), description));
    else if (property.type === "integer" || property.type === "number") {
      const integer = property.type === "integer", step = integer ? 1 : 0.01;
      const min = typeof property.minimum === "number" ? property.minimum : typeof property.exclusiveMinimum === "number" ? property.exclusiveMinimum + step : 0;
      const max = typeof property.maximum === "number" ? property.maximum : typeof property.exclusiveMaximum === "number" ? property.exclusiveMaximum - step : 10000;
      const required = (schema.required as string[] | undefined)?.includes(key) ?? false;
      fields.push(numeric(`parameters.${key}`, label, "strategy", current, min, max, step, recommendedParameters[key], !required && property.default === undefined, description));
    }
  }
  const criteria: [SearchValue, string][] = [["MARKET_CAP", "시가총액"], ["VOLUME", "거래량"], ["TRADING_VALUE", "거래대금"], ["PER", "PER"], ["ROE", "ROE"], ["DECLINE", "하락률"]];
  fields.push(choice("universeRule.markets.0", "시장", "universe", request.universeRule.markets[0]!, [["KOSPI", "KOSPI"], ["KOSDAQ", "KOSDAQ"]]));
  request.universeRule.stages.forEach((stage, index) => {
    const prefix = `universeRule.stages.${index}`, label = `${index + 1}단계`;
    fields.push(choice(`${prefix}.criterion`, `${label} 선별 기준`, "universe", stage.criterion, criteria, "단계 순서는 유지하며 기준이 중복되는 조합은 제외합니다."));
    fields.push(choice(`${prefix}.direction`, `${label} 정렬 방향`, "universe", stage.direction, [["HIGH", "높은 순"], ["LOW", "낮은 순"]]));
    fields.push(numeric(`${prefix}.limit`, `${label} 선별 종목 수`, "universe", stage.limit, 1, 200, 1, [Math.max(1, Math.floor(stage.limit / 2)), stage.limit]));
    fields.push(numeric(`${prefix}.lookbackTradingDays`, `${label} 하락률 산정 거래일`, "universe", stage.criterion === "DECLINE" ? stage.lookbackTradingDays : null, 1, 252, 1, [5, 60], false, "이 단계가 하락률 기준일 때만 적용합니다. 다른 기준에서 하락률로 바꾸면 기본 20거래일을 사용합니다."));
  });
  const interval = request.universeRule.rebalanceInterval;
  fields.push(choice("universeRule.rebalanceInterval.unit", "재선정 주기 단위", "universe", interval.unit, [["NONE", "재선정 없음"], ["DAY", "일"], ["WEEK", "주"], ["MONTH", "월"], ["YEAR", "년"]]));
  fields.push(numeric("universeRule.rebalanceInterval.value", "재선정 주기 간격", "universe", interval.value, 1, 365, 1, [1, 3], false, "일 1~365, 주 1~52, 월 1~12, 년·재선정 없음은 1. 기간을 초과하는 조합은 제외합니다."));
  fields.push(choice("execution.commissionProfileId", "수수료·세금 산정", "execution", request.execution.commissionProfileId, listCostProfiles().map(p => [p.id, p.id === "zero-cost" ? "비용 없음" : "국내 주식 기본"]), "기본 수수료 매수·매도 각 0.015% + 시점별 매도세. 비용 없음은 영향 비교용입니다."));
  fields.push(choice("execution.slippageProfileId", "슬리피지 산정", "execution", request.execution.slippageProfileId, listSlippageProfiles().map(p => [p.id, p.id === "zero-slippage" ? "슬리피지 없음" : `고정 ${p.bps}bps`])));
  fields.push(numeric("risk.maxPositions", "최대 보유 종목 수", "execution", request.risk.maxPositions, 1, 200, 1, [10, 50]));
  fields.push(numeric("risk.maxPositionWeightPercent", "운용 종목별 비중 상한 (%)", "execution", request.risk.maxPositionWeightPercent ?? null, 0.01, 100, 0.01, [5, 30], true, "사용 안 함은 비중 상한 없음입니다. 전략 비중과 별도로 체결 시 적용합니다."));
  if (strategies.describe(request.strategyId)?.supportsRandomSeed !== false) fields.push(numeric("randomSeed", "백테스트 난수 시드", "seed", request.randomSeed, 0, MAX_RANDOM_SEED, 1, [0, MAX_RANDOM_SEED], false, "동률 처리와 매수 순서 등에 사용합니다. 난수 값의 크기에는 우열이 없습니다."));
  return { mode: "daily", sourceJobId, strategyId: request.strategyId, strategyName: strategies.describe(request.strategyId)!.name, period: request.period, fields, maxCount: 100 };
}

export function intradaySearchCatalog(sourceJobId: string, request: IntradayRequest): ConfigurationSearchCatalog {
  const strategy = getIntradayStrategy(request.strategyId), fields: ConfigurationSearchField[] = [];
  const parameters = [...strategy.fields, { key: "allocationPct", label: "투자 비율 (%)", min: 1, max: 100, step: 0.1 }, { key: "stopLossPct", label: "손절 (%)", min: 0.1, max: 50, step: 0.1 }, { key: "takeProfitPct", label: "익절 (%)", min: 0.1, max: 100, step: 0.1 }];
  for (const field of parameters) fields.push(numeric(`parameters.${field.key}`, field.label, "strategy", (request.parameters as unknown as Record<string, number>)[field.key]!, field.min, field.max, field.step ?? 1, recommendedParameters[field.key]));
  const executionFields: [keyof IntradayRequest["execution"], string, number, number, number, [number, number]][] = [
    ["commissionBps", "수수료 (bps)", 0, 100, 0.01, [0, 5]], ["taxBps", "매도세 (bps)", 0, 100, 0.01, [15, 30]], ["slippageBps", "슬리피지 (bps)", 0, 100, 0.01, [0, 10]],
    ["latencyMs", "주문 지연 (ms)", 1, 60000, 1, [100, 2000]], ["orderExpiryMinutes", "주문 유효 기간 (분)", 1, 10, 1, [1, 5]], ["maxParticipationPct", "거래량 참여 상한 (%)", 0.1, 10, 0.1, [0.1, 2]],
  ];
  for (const [key, label, min, max, step, recommended] of executionFields) fields.push(numeric(`execution.${key}`, label, "execution", request.execution[key], min, max, step, recommended));
  return { mode: "intraday", sourceJobId, strategyId: request.strategyId, strategyName: strategy.name, period: request.period, fields, maxCount: 100 };
}

function setValue(request: ConfigurationSearchRequest, key: string, value: SearchValue): void {
  const path = key.split(".");
  let target: Record<string, unknown> = request as unknown as Record<string, unknown>;
  for (const part of path.slice(0, -1)) target = target[part] as Record<string, unknown>;
  const last = path.at(-1)!;
  if (value === null) delete target[last]; else target[last] = value;
}
function getValue(request: ConfigurationSearchRequest, key: string): SearchValue {
  let value: unknown = request;
  for (const part of key.split(".")) value = (value as Record<string, unknown> | undefined)?.[part];
  return value === undefined ? null : value as SearchValue;
}
function normalize(request: ConfigurationSearchRequest, strategies: StrategyRegistry): ConfigurationSearchRequest {
  if (request.mode === "intraday") return intradayRequestSchema.parse(request);
  for (const stage of request.universeRule.stages) {
    const record = stage as unknown as Record<string, unknown>;
    if (stage.criterion !== "DECLINE") delete record.lookbackTradingDays;
    else record.lookbackTradingDays ??= 20;
  }
  const checked = strategies.validateParameters(request.strategyId, request.parameters);
  if (!checked.ok) throw new Error(checked.error);
  return backtestRequestSchema.parse({ ...request, parameters: checked.value });
}

/** 작은 이산 공간은 전부 검증하고 큰 공간은 횟수를 제한한 무작위 추출로 유효 조합을 찾는다. */
export function sampleConfigurations(source: ConfigurationSearchRequest, catalog: ConfigurationSearchCatalog, config: ConfigurationSearchConfig, strategies: StrategyRegistry): { request: ConfigurationSearchRequest; values: Record<string, SearchValue> }[] {
  const fields = new Map(catalog.fields.map(field => [field.key, field]));
  const domains = Object.entries(config.settings).sort(([a], [b]) => a.localeCompare(b)).map(([key, setting]) => {
    const field = fields.get(key);
    if (!field) throw new Error(`탐색할 수 없는 설정입니다: ${key}`);
    if (field.kind === "choice") {
      if (setting.kind !== "CHOICE" || setting.values.some(value => !field.options.some(option => option.value === value))) throw new Error(`${field.label}: 허용된 선택지를 지정하세요.`);
      const values = [...new Set(setting.values)];
      return { key, count: values.length, at: (index: number) => values[index]! };
    }
    if (setting.kind !== "RANGE") throw new Error(`${field.label}: 숫자 범위를 지정하세요.`);
    const aligned = (value: number) => Math.abs(value / field.step - Math.round(value / field.step)) < 0.00001;
    if (setting.min < field.min || setting.max > field.max || !aligned(setting.min) || !aligned(setting.max)) throw new Error(`${field.label}: ${field.min}~${field.max} 범위에서 ${field.step} 단위로 지정하세요.`);
    if (setting.includeUnset && !field.allowUnset) throw new Error(`${field.label}: 사용 안 함을 선택할 수 없습니다.`);
    const count = Math.round((setting.max - setting.min) / field.step) + 1;
    return { key, count: count + (setting.includeUnset ? 1 : 0), at: (index: number): SearchValue => index === count ? null : round(setting.min + index * field.step) };
  });
  const size = domains.reduce((total, domain) => Math.min(10001, total * domain.count), 1);
  const result: { request: ConfigurationSearchRequest; values: Record<string, SearchValue> }[] = [], seen = new Set<string>();
  let rejection = "";
  const candidate = (indices: number[]) => {
    const request = structuredClone(source);
    domains.forEach((domain, index) => setValue(request, domain.key, domain.at(indices[index]!)));
    try {
      const checked = normalize(request, strategies), signature = JSON.stringify(checked);
      if (seen.has(signature)) return;
      seen.add(signature);
      result.push({ request: checked, values: Object.fromEntries(domains.map(domain => [domain.key, getValue(checked, domain.key)])) });
    } catch (error) { rejection = error instanceof Error ? error.message : String(error); }
  };
  if (size <= 10000) {
    for (let index = 0; index < size; index++) {
      let rest = index;
      candidate(domains.map(domain => { const value = rest % domain.count; rest = Math.floor(rest / domain.count); return value; }));
    }
    for (let index = result.length - 1; index > 0; index--) { const other = randomInt(index + 1); [result[index], result[other]] = [result[other]!, result[index]!]; }
  } else {
    for (let attempt = 0; attempt < 10000 && result.length < config.count; attempt++) candidate(domains.map(domain => randomInt(domain.count)));
  }
  if (result.length < config.count) throw new Error(`서로 다른 유효 조합을 ${result.length}개 찾았습니다. 요청 개수(${config.count})를 줄이거나 범위를 조절하세요.${rejection ? ` 제외 사유 예시: ${rejection.slice(0, 500)}` : ""}`);
  return result.slice(0, config.count);
}
