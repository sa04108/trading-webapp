import { describe, expect, it } from 'vitest';
import {
  summarizeUniverseRebalancing,
} from '../../src/server/modules/backtest/application/universe-rebalancing.js';
import type {
  LegacyUniverseScheduleEntry,
} from '../../src/server/modules/backtest/application/universe-rule-resolver.js';

function scheduleEntry(
  rebalanceDate: string,
  effectiveTradingDate: string,
  symbols: readonly string[],
): LegacyUniverseScheduleEntry {
  return { rebalanceDate, effectiveTradingDate, symbols, excludedNonTradingCount: 0 };
}

describe('summarizeUniverseRebalancing', () => {
  it('첫 일정은 중복 code를 한 번만 센 최초 구성이다', () => {
    expect(
      summarizeUniverseRebalancing([
        scheduleEntry('2026-01-05', '2026-01-02', ['A', 'B', 'B']),
      ]),
    ).toEqual([
      {
        kind: 'INITIAL',
        rebalanceDate: '2026-01-05',
        effectiveDate: '2026-01-02',
        memberCount: 2,
      },
    ]);
  });

  it('같은 크기 교체는 편입과 편출을 각각 세고 합산한다', () => {
    const result = summarizeUniverseRebalancing([
      scheduleEntry('2026-01-05', '2026-01-05', ['A', 'B', 'C']),
      scheduleEntry('2026-02-05', '2026-02-05', ['B', 'C', 'D']),
    ]);
    expect(result[1]).toEqual({
      kind: 'CHANGE',
      rebalanceDate: '2026-02-05',
      effectiveDate: '2026-02-05',
      addedCount: 1,
      removedCount: 1,
      changedCount: 2,
    });
  });

  it('유니버스 크기가 바뀌면 서로 다른 편입·편출 수를 보존한다', () => {
    const result = summarizeUniverseRebalancing([
      scheduleEntry('2026-01-05', '2026-01-05', ['A', 'B']),
      scheduleEntry('2026-02-05', '2026-02-05', ['B', 'C', 'D']),
      scheduleEntry('2026-03-05', '2026-03-05', ['D']),
    ]);
    expect(result[1]).toMatchObject({ addedCount: 2, removedCount: 1, changedCount: 3 });
    expect(result[2]).toMatchObject({ addedCount: 0, removedCount: 2, changedCount: 2 });
  });

  it('멤버십이 같으면 변경 수를 모두 0으로 반환한다', () => {
    const result = summarizeUniverseRebalancing([
      scheduleEntry('2026-01-05', '2026-01-05', ['A', 'B']),
      scheduleEntry('2026-02-05', '2026-02-05', ['B', 'A']),
    ]);
    expect(result[1]).toMatchObject({ addedCount: 0, removedCount: 0, changedCount: 0 });
  });
});
