import type { CostProfile, ExecutionRules, SlippageProfile } from './types.js';

/**
 * 비용 프로파일 레지스트리 (스펙 §9.3):
 * 수수료·세율은 영구 하드코딩이 아니라 프로파일 id + version 으로 관리한다.
 * 값 변경 시 version 을 올려 재현성 메타데이터와 함께 기록한다.
 */
const COST_PROFILES: Record<string, CostProfile> = {
  'kr-equity-default': {
    id: 'kr-equity-default',
    // 2.0.0: KRX 공식 데이터 시작일(2010-01-04) 이후의 증권거래세와
    // 코스피 농어촌특별세를 합친 실제 매도세를 체결일별로 적용한다.
    // 이 기간에는 코스피·코스닥 합계 세율이 같다.
    version: '2.1.0',
    buyCommissionRate: 0.00015,
    sellCommissionRate: 0.00015,
    // 일정 밖 직접 엔진 호출의 fallback 겸 현재(2026년) 세율이다.
    sellTaxRate: 0.002,
    sellTaxRateSchedule: [
      taxScheduleEntry('2010-01-04', 0.003, 0.0015),
      taxScheduleEntry('2019-05-30', 0.0025, 0.001),
      taxScheduleEntry('2020-12-29', 0.0023, 0.0008),
      taxScheduleEntry('2022-12-28', 0.002, 0.0005),
      taxScheduleEntry('2023-12-27', 0.0018, 0.0003),
      taxScheduleEntry('2024-12-27', 0.0015, 0),
      taxScheduleEntry('2025-12-29', 0.002, 0.0005),
    ],
  },
  'zero-cost': {
    id: 'zero-cost',
    version: '1.0.0',
    buyCommissionRate: 0,
    sellCommissionRate: 0,
    sellTaxRate: 0,
  },
};

function taxScheduleEntry(
  tradeDate: string,
  totalRate: number,
  kospiSecuritiesTaxRate: number,
): NonNullable<CostProfile['sellTaxRateSchedule']>[number] {
  return {
    fromTsMs: Date.parse(`${tradeDate}T00:00:00Z`),
    rate: totalRate,
    kospiSecuritiesTaxRate,
    kospiRuralTaxRate: 0.0015,
  };
}

const SLIPPAGE_PROFILES: Record<string, SlippageProfile> = {
  'fixed-5bps': { id: 'fixed-5bps', version: '1.0.0', bps: 5, fixed: 0 },
  'zero-slippage': { id: 'zero-slippage', version: '1.0.0', bps: 0, fixed: 0 },
};

export const DEFAULT_EXECUTION_RULES: ExecutionRules = {
  tickSize: 0,
  minOrderQty: 1,
};

/**
 * KRX 보통주 호가단위. 2023-01-25 전에는 고가 구간이 시장별로 달랐고 이후 통합됐다.
 * universeRule의 단일 요청 시장을 fallback으로 고정하고, 실제 봉의 venue가 있으면
 * 체결부가 그 값을 우선한다.
 */
export function getKrxExecutionRules(market: 'KOSPI' | 'KOSDAQ'): ExecutionRules {
  return {
    tickSize: 0,
    tickSizeProfile: { id: 'krx-equity', version: '1.0.0', market },
    maxVolumeParticipationRate: 0.1,
    minOrderQty: 1,
  };
}

export function getCostProfile(id: string): CostProfile | null {
  return COST_PROFILES[id] ?? null;
}

export function getSlippageProfile(id: string): SlippageProfile | null {
  return SLIPPAGE_PROFILES[id] ?? null;
}

export function listCostProfiles(): CostProfile[] {
  return Object.values(COST_PROFILES);
}

export function listSlippageProfiles(): SlippageProfile[] {
  return Object.values(SLIPPAGE_PROFILES);
}

/** 체결 시각에 유효한 매도세율. 일정이 없는 사용자 정의 프로파일은 고정 세율을 쓴다. */
export function sellTaxRateAt(profile: CostProfile, tsMs: number): number {
  let rate = profile.sellTaxRate;
  for (const entry of profile.sellTaxRateSchedule ?? []) {
    if (entry.fromTsMs > tsMs) break;
    rate = entry.rate;
  }
  return rate;
}

/**
 * 매도 체결건의 세액. KRX 일정은 실제 매매일 경계이며 원 미만을 절사한다.
 * 일정이 없는 사용자 정의 프로파일은 기존 고정 소수율 동작을 보존한다.
 */
export function sellTaxAmount(
  profile: CostProfile,
  grossAmount: number,
  tsMs: number,
  venue?: 'KOSPI' | 'KOSDAQ',
): number {
  let active: NonNullable<CostProfile['sellTaxRateSchedule']>[number] | undefined;
  for (const entry of profile.sellTaxRateSchedule ?? []) {
    if (entry.fromTsMs > tsMs) break;
    active = entry;
  }
  if (active === undefined) return grossAmount * profile.sellTaxRate;

  if (
    venue === 'KOSPI'
    && active.kospiSecuritiesTaxRate !== undefined
    && active.kospiRuralTaxRate !== undefined
  ) {
    return Math.floor(grossAmount * active.kospiSecuritiesTaxRate)
      + Math.floor(grossAmount * active.kospiRuralTaxRate);
  }
  return Math.floor(grossAmount * active.rate);
}

const KRX_UNIFIED_TICK_FROM_TS_MS = Date.parse('2023-01-25T00:00:00Z');

/** 주문 가격대에 맞는 KRX 보통주 호가단위. */
export function tickSizeAt(
  rules: ExecutionRules,
  price: number,
  tsMs: number,
  venue?: 'KOSPI' | 'KOSDAQ',
): number {
  const profile = rules.tickSizeProfile;
  if (profile === undefined) return rules.tickSize;
  const market = venue ?? profile.market;

  if (tsMs >= KRX_UNIFIED_TICK_FROM_TS_MS) {
    if (price < 2_000) return 1;
    if (price < 5_000) return 5;
    if (price < 20_000) return 10;
    if (price < 50_000) return 50;
    if (price < 200_000) return 100;
    if (price < 500_000) return 500;
    return 1_000;
  }

  if (price < 1_000) return 1;
  if (price < 5_000) return 5;
  if (price < 10_000) return 10;
  if (price < 50_000) return 50;
  if (price < 100_000 || market === 'KOSDAQ') return 100;
  if (price < 500_000) return 500;
  return 1_000;
}
