import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { UniverseRebalancingSection } from '@/features/backtests/universe-rebalancing-section';
import type { UniverseRebalancingEntryDto } from '@shared/schemas/universe-rebalancing';

const entries: UniverseRebalancingEntryDto[] = [
  {
    kind: 'INITIAL',
    rebalanceDate: '2026-01-05',
    effectiveDate: '2026-01-02',
    memberCount: 2,
  },
  {
    kind: 'CHANGE',
    rebalanceDate: '2026-02-05',
    effectiveDate: '2026-02-05',
    addedCount: 2,
    removedCount: 1,
    changedCount: 3,
  },
];

describe('UniverseRebalancingSection', () => {
  it('최초 구성과 변동 합계·편입·편출을 사람이 읽는 문구로 표시한다', () => {
    const html = renderToStaticMarkup(<UniverseRebalancingSection entries={entries} />);
    expect(html).toContain('종목 리밸런싱');
    expect(html).toContain('변동 종목 수');
    expect(html).toContain('최초 구성 2종목');
    expect(html).toContain('합계 3종목');
    expect(html).toContain('편입');
    expect(html).toContain('편출');
    expect(html).toContain('(휴장 조정)');
  });

  it('편입 숫자는 gain, 편출 숫자는 loss 색상이고 문구는 색과 별도로 남는다', () => {
    const html = renderToStaticMarkup(<UniverseRebalancingSection entries={entries} />);
    expect(html).toContain('편입 <span class="text-gain tabular-nums">2</span>');
    expect(html).toContain('편출 <span class="text-loss tabular-nums">1</span>');
  });

  it('일정이 없으면 카드를 렌더링하지 않는다', () => {
    expect(renderToStaticMarkup(<UniverseRebalancingSection entries={[]} />)).toBe('');
  });
});
