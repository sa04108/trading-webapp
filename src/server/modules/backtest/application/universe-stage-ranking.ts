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

function compareValues(a: number | bigint, b: number | bigint): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
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
    return a.shortCode.localeCompare(b.shortCode);
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
