import {
  backtestRequestSchema,
  type BacktestRequest,
} from '../../../../shared/schemas/backtest-request.js';

export type StoredRequestRebase =
  | { readonly ok: true; readonly request: BacktestRequest; readonly warnings: readonly string[] }
  | { readonly ok: false; readonly error: string };

/**
 * I3 이전 요청은 포지션 상한을 parameters.maxPositions 에서 이름으로 찾았고,
 * 없으면 조용히 10 을 썼다. 재기준 시에도 그 작업이 실제로 돌았던 값을 유지한다.
 */
const LEGACY_MAX_POSITIONS = 10;

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
    let carried: number = LEGACY_MAX_POSITIONS;
    if (typeof parameters === 'object' && parameters !== null && !Array.isArray(parameters)) {
      const { maxPositions, ...rest } = parameters as Record<string, unknown>;
      if (typeof maxPositions === 'number') carried = maxPositions;
      draft.parameters = rest;
    }
    draft.risk = { maxPositions: carried };
    warnings.push(`포지션 상한을 risk.maxPositions=${carried} 로 이관했습니다 (구 스키마 요청)`);
  }

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

  const parsed = backtestRequestSchema.safeParse(draft);
  if (!parsed.success) {
    return {
      ok: false,
      error: '저장된 요청을 현재 스키마로 복원할 수 없습니다. 새 백테스트로 다시 생성하세요.',
    };
  }
  return { ok: true, request: parsed.data, warnings };
}
