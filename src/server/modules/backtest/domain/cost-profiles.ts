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
    version: '2.0.0',
    buyCommissionRate: 0.00015,
    sellCommissionRate: 0.00015,
    // 일정 밖 직접 엔진 호출의 fallback 겸 현재(2026년) 세율이다.
    sellTaxRate: 0.002,
    sellTaxRateSchedule: [
      { fromTsMs: Date.parse('2010-01-04T00:00:00Z'), rate: 0.003 },
      { fromTsMs: Date.parse('2019-06-03T00:00:00Z'), rate: 0.0025 },
      { fromTsMs: Date.parse('2021-01-01T00:00:00Z'), rate: 0.0023 },
      { fromTsMs: Date.parse('2023-01-01T00:00:00Z'), rate: 0.002 },
      { fromTsMs: Date.parse('2024-01-01T00:00:00Z'), rate: 0.0018 },
      { fromTsMs: Date.parse('2025-01-01T00:00:00Z'), rate: 0.0015 },
      { fromTsMs: Date.parse('2026-01-01T00:00:00Z'), rate: 0.002 },
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

const SLIPPAGE_PROFILES: Record<string, SlippageProfile> = {
  'fixed-5bps': { id: 'fixed-5bps', version: '1.0.0', bps: 5, fixed: 0 },
  'zero-slippage': { id: 'zero-slippage', version: '1.0.0', bps: 0, fixed: 0 },
};

export const DEFAULT_EXECUTION_RULES: ExecutionRules = {
  tickSize: 0,
  minOrderQty: 1,
};

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
