import {
  backtestRequestSchema,
  type BacktestRequest,
} from '../../../../shared/schemas/backtest-request.js';
import { PREFERRED_STAGE_DIRECTION } from '../../../../shared/schemas/universe-rule.js';

export type StoredRequestRebase =
  | { readonly ok: true; readonly request: BacktestRequest; readonly warnings: readonly string[] }
  | { readonly ok: false; readonly error: string };

/**
 * I3 이전 요청은 포지션 상한을 parameters.maxPositions 에서 이름으로 찾았고,
 * 없으면 엔진이 조용히 10 을 썼다. 단계형 유니버스 계획(2026-08-09)은 상한이 없는
 * 요청에 신규 기본값 40 을 채우기로 정했다 — 재기준은 재현이 아니라 재실행이므로
 * 옛 암묵값 10 을 복원하지 않고, 기본값을 채웠다는 사실을 경고로 남긴다.
 */
const DEFAULT_MAX_POSITIONS = 40;

function rebaseUniverseRule(draft: Record<string, unknown>, warnings: string[]): void {
  const rawRule = draft.universeRule;
  if (typeof rawRule !== 'object' || rawRule === null || Array.isArray(rawRule)) return;
  const rule = rawRule as Record<string, unknown>;
  if (Array.isArray(rule.stages) && rule.rebalanceInterval !== undefined) return;

  const parameters = draft.parameters;
  const parameterRecord = typeof parameters === 'object' && parameters !== null && !Array.isArray(parameters)
    ? parameters as Record<string, unknown>
    : null;
  const rebalanceMonths = parameterRecord?.rebalanceMonths;
  const months = typeof rebalanceMonths === 'number' ? rebalanceMonths : 1;
  if (parameterRecord !== null) {
    const { rebalanceMonths: _legacyRebalanceMonths, ...rest } = parameterRecord;
    draft.parameters = rest;
  }
  if (typeof rebalanceMonths !== 'number') {
    warnings.push('리밸런싱 주기가 없어 1개월로 재기준했습니다 (구 스키마 요청)');
  }

  draft.universeRule = {
    markets: rule.markets,
    stages: [{ criterion: 'MARKET_CAP', direction: PREFERRED_STAGE_DIRECTION.MARKET_CAP, limit: rule.topN }],
    rebalanceInterval: { value: months, unit: 'MONTH' },
  };
}

/**
 * 저장된 요청을 현재 스키마 기준으로 재기준(rebase)한다.
 *
 * 복제는 스펙 §10 이 지정한 중단 작업의 복구 경로다 — 요청 스키마나 전략 버전이 올라갔다는
 * 이유로 과거 작업의 복구가 막히면 안 된다. 기계적으로 되살릴 수 있는 편차는 되살리고,
 * 무엇이 달라졌는지는 경고로 돌려준다. 재현이 아니라 재실행이라는 판단은 사용자 몫이다.
 */
export function rebaseStoredRequest(
  storedJson: string,
  currentStrategyVersion: string | null,
): StoredRequestRebase {
  let raw: unknown;
  try {
    raw = JSON.parse(storedJson);
  } catch {
    return { ok: false, error: '저장된 요청을 읽을 수 없습니다 (JSON 형식 오류)' };
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, error: '저장된 요청의 형식이 올바르지 않습니다' };
  }

  const draft: Record<string, unknown> = { ...(raw as Record<string, unknown>) };
  const warnings: string[] = [];

  // I3: maxPositions 는 전략 파라미터 네이밍 관례에서 요청의 명시 필드로 옮겨졌다
  if (draft.risk === undefined) {
    const parameters = draft.parameters;
    let carried: number | null = null;
    if (typeof parameters === 'object' && parameters !== null && !Array.isArray(parameters)) {
      const { maxPositions, ...rest } = parameters as Record<string, unknown>;
      if (typeof maxPositions === 'number') carried = maxPositions;
      draft.parameters = rest;
    }
    draft.risk = { maxPositions: carried ?? DEFAULT_MAX_POSITIONS };
    warnings.push(
      carried !== null
        ? `포지션 상한을 risk.maxPositions=${carried} 로 이관했습니다 (구 스키마 요청)`
        : `포지션 상한이 없어 기본값 ${DEFAULT_MAX_POSITIONS} 을 채웠습니다 (구 스키마 요청)`,
    );
  }

  // 단계형 규칙 이전의 topN/sortKey와 전략별 리밸런싱 주기는 저장 원본을 바꾸지
  // 않고, 복제할 요청에만 새 계약으로 승격한다.
  rebaseUniverseRule(draft, warnings);

  // D-029 이전 요청은 전략 버전을 품고 있다. 요청은 더 이상 버전을 나르지 않으므로
  // 필드는 버리되, 그때와 지금의 전략이 다르다는 사실은 경고로 남긴다 — 복제는 재현이
  // 아니라 재실행이고, 결과가 원본과 달라질 수 있다는 것이 사용자가 알아야 할 전부다.
  if (draft.strategyVersion !== undefined) {
    if (currentStrategyVersion !== null && draft.strategyVersion !== currentStrategyVersion) {
      warnings.push(
        `전략 버전 ${String(draft.strategyVersion)} → ${currentStrategyVersion} 으로 재기준했습니다. 결과가 원본과 다를 수 있습니다.`,
      );
    }
    delete draft.strategyVersion;
  }

  // 봉 주기는 KRX 일봉 하나로 좁혀졌다(D-041). 옛 잡의 '1m'·'1h' 는 되살릴 대상이지
  // 거부할 대상이 아니다. 재기준은 재현이 아니라 재실행이다.
  if (draft.timeframe !== undefined && draft.timeframe !== '1d') {
    warnings.push(
      `봉 주기 ${String(draft.timeframe)} 는 더 이상 제공하지 않습니다. 일봉으로 재기준했습니다.`,
    );
    draft.timeframe = '1d';
  }

  const parsed = backtestRequestSchema.safeParse(draft);
  if (!parsed.success) {
    return {
      ok: false,
      error: '저장된 요청을 현재 스키마로 복원할 수 없습니다. 새 백테스트로 다시 생성하세요.',
    };
  }
  return { ok: true, request: parsed.data, warnings };
}
