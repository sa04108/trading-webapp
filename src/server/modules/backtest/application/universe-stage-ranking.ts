import type {
  UniverseCriterion,
  UniverseStage,
} from '../../../../shared/schemas/universe-rule.js';

export interface UniverseStageValue {
  readonly standardCode: string;
  readonly shortCode: string;
  readonly value: number | bigint | null;
}

export interface UniverseStageDiagnostic {
  readonly criterion: UniverseCriterion;
  readonly inputCount: number;
  readonly eligibleCount: number;
  readonly selectedCount: number;
  readonly excludedMissingCount: number;
}

function isEligibleValue(stage: UniverseStage, value: number | bigint | null): value is number | bigint {
  if (value === null) return false;
  if (stage.criterion === 'PER' || stage.criterion === 'DECLINE') {
    return typeof value === 'number' && Number.isFinite(value);
  }
  return typeof value === 'bigint' || Number.isFinite(value);
}

/**
 * 같은 stage 의 값은 전부 bigint 이거나 전부 number 다 — 혼합 비교는 `1n === 1` 이
 * false 라 잘못된 순서를 조용히 돌려주므로 버그로 취급해 던진다.
 */
function compareValues(a: number | bigint, b: number | bigint): number {
  if (typeof a !== typeof b) {
    throw new Error('유니버스 stage 값의 타입이 섞였습니다 (bigint/number 혼합 비교)');
  }
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/** 코드 tie-break 은 ICU collation 이 아니라 codepoint 비교 — 환경 간 재현성이 목적이다. */
export function compareShortCodes(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

export function rankUniverseStage(
  stage: UniverseStage,
  rows: readonly UniverseStageValue[],
): { selectedCodes: string[]; diagnostic: UniverseStageDiagnostic } {
  const eligible = rows.filter((row) => isEligibleValue(stage, row.value));
  const ascending = stage.criterion === 'PER' || stage.criterion === 'DECLINE';
  eligible.sort((a, b) => {
    const valueOrder = compareValues(a.value as number | bigint, b.value as number | bigint);
    if (valueOrder !== 0) return ascending ? valueOrder : -valueOrder;
    return compareShortCodes(a.shortCode, b.shortCode);
  });
  const selected = eligible.slice(0, stage.limit);

  return {
    selectedCodes: selected.map((row) => row.standardCode),
    diagnostic: {
      criterion: stage.criterion,
      inputCount: rows.length,
      eligibleCount: eligible.length,
      selectedCount: selected.length,
      excludedMissingCount: rows.length - eligible.length,
    },
  };
}
