import type { UniverseRebalancingEntryDto } from '../../../../shared/schemas/universe-rebalancing.js';
import type { LegacyUniverseScheduleEntry } from './universe-rule-resolver.js';

function differenceCount(left: ReadonlySet<string>, right: ReadonlySet<string>): number {
  let count = 0;
  for (const symbol of left) {
    if (!right.has(symbol)) count += 1;
  }
  return count;
}

export function summarizeUniverseRebalancing(
  schedule: readonly LegacyUniverseScheduleEntry[],
): UniverseRebalancingEntryDto[] {
  let previous: ReadonlySet<string> | null = null;

  return schedule.map((entry) => {
    const current = new Set(entry.symbols);
    if (previous === null) {
      previous = current;
      return {
        kind: 'INITIAL',
        rebalanceDate: entry.rebalanceDate,
        effectiveDate: entry.effectiveTradingDate,
        memberCount: current.size,
      };
    }

    const addedCount = differenceCount(current, previous);
    const removedCount = differenceCount(previous, current);
    previous = current;
    return {
      kind: 'CHANGE',
      rebalanceDate: entry.rebalanceDate,
      effectiveDate: entry.effectiveTradingDate,
      addedCount,
      removedCount,
      changedCount: addedCount + removedCount,
    };
  });
}
