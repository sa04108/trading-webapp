import type { CostProfile, ExecutionRules, SlippageProfile } from './types.js';

/**
 * 비용 프로파일 레지스트리 (스펙 §9.3):
 * 수수료·세율은 영구 하드코딩이 아니라 프로파일 id + version 으로 관리한다.
 * 값 변경 시 version 을 올려 재현성 메타데이터와 함께 기록한다.
 */
const COST_PROFILES: Record<string, CostProfile> = {
  'kr-equity-default': {
    id: 'kr-equity-default',
    // 1.1.0: 증권거래세 0.18% → 0.15% (2025년부터 코스피·코스닥 공통).
    // 구버전 실행은 재현성 메타데이터의 kr-equity-default@1.0.0 으로 구분된다.
    version: '1.1.0',
    buyCommissionRate: 0.00015,
    sellCommissionRate: 0.00015,
    sellTaxRate: 0.0015,
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
