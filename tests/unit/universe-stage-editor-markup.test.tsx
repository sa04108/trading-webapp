import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { addStage, changeStageLimit } from '@/features/backtests/universe-pipeline';
import { UniverseStageEditor } from '@/features/backtests/universe-stage-editor';
import { UniverseRuleStep } from '@/features/backtests/universe-rule-step';
import { DEFAULT_MAX_POSITIONS, DEFAULT_UNIVERSE_RULE } from '@/features/backtests/new-backtest-wizard';
import { rebalanceIntervalFitsPeriod } from '@shared/schemas/rebalance-interval';
import type { UniverseStage } from '@shared/schemas/universe-rule';

const declineStages: UniverseStage[] = [
  { criterion: 'MARKET_CAP', limit: 200 },
  { criterion: 'DECLINE', limit: 150, lookbackTradingDays: 20 },
];

function renderEditor(stages: readonly UniverseStage[]): string {
  return renderToStaticMarkup(
    <UniverseStageEditor stages={stages} onChange={() => undefined} />,
  );
}

function renderRuleStep(period: { from: string; to: string }): string {
  const client = new QueryClient();
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <UniverseRuleStep
        value={DEFAULT_UNIVERSE_RULE}
        onChange={() => undefined}
        period={period}
        onPreviewResolved={() => undefined}
      />
    </QueryClientProvider>,
  );
}

describe('신규 진입 기본값', () => {
  it('KOSPI / 시가총액 200 / 1개월 / maxPositions 40 이다', () => {
    expect(DEFAULT_UNIVERSE_RULE).toEqual({
      markets: ['KOSPI'],
      stages: [{ criterion: 'MARKET_CAP', limit: 200 }],
      rebalanceInterval: { value: 1, unit: 'MONTH' },
    });
    expect(DEFAULT_MAX_POSITIONS).toBe('40');
  });
});

describe('단계 추가', () => {
  it('PER 단계를 추가하면 N 은 200으로 복사되고 입력 max 도 200이다', () => {
    const update = addStage(DEFAULT_UNIVERSE_RULE.stages, 'PER');
    expect(update.stages[1]).toEqual({ criterion: 'PER', limit: 200 });

    const html = renderEditor(update.stages);
    expect(html).toContain('id="stage-limit-1"');
    expect(html).toContain('max="200"');
  });

  it('첫 N 을 100으로 낮추면 PER N 도 100이 되고 changedIndices 를 반환한다', () => {
    const withPer = addStage(DEFAULT_UNIVERSE_RULE.stages, 'PER');
    const update = changeStageLimit(withPer.stages, 0, 100);
    expect(update.stages).toEqual([
      { criterion: 'MARKET_CAP', limit: 100 },
      { criterion: 'PER', limit: 100 },
    ]);
    expect(update.changedIndices).toEqual([1]);
  });

  it('급하락을 추가하면 lookback input 기본값 20이 보인다', () => {
    const update = addStage(DEFAULT_UNIVERSE_RULE.stages, 'DECLINE');
    const html = renderEditor(update.stages);
    expect(html).toContain('name="lookbackTradingDays"');
    expect(html).toContain('value="20"');
  });
});

describe('접근성', () => {
  it('위/아래 이동 버튼의 접근 가능한 이름과 drag handle 이 markup 에 있다', () => {
    const html = renderEditor(declineStages);
    expect(html).toContain('aria-label="2단계 위로 이동"');
    expect(html).toContain('aria-label="2단계 아래로 이동"');
    expect(html).toContain('aria-label="1단계 드래그하여 순서 변경"');
    expect(html).toContain('name="lookbackTradingDays"');
  });
});

describe('리밸런스 주기와 기간 정합성', () => {
  it('10일짜리 기간에 1개월 주기를 넣으면 rebalanceIntervalFitsPeriod 가 false 다', () => {
    expect(
      rebalanceIntervalFitsPeriod(
        { from: '2026-08-01', to: '2026-08-10' },
        { value: 1, unit: 'MONTH' },
      ),
    ).toBe(false);
  });

  it('그 기간에서는 미리보기 버튼이 비활성화되고 오류가 보인다', () => {
    const html = renderRuleStep({ from: '2026-08-01', to: '2026-08-10' });
    expect(html).toContain('disabled="">미리보기</button>');
    expect(html).toContain('리밸런스 주기');
    expect(html).toContain('role="alert"');
  });

  it('주기가 기간에 맞으면 그 오류가 없다', () => {
    const html = renderRuleStep({ from: '2026-01-01', to: '2026-12-31' });
    expect(html).not.toContain('disabled="">미리보기</button>');
  });
});
