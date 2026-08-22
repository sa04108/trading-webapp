import { describe, expect, it } from 'vitest';
import {
  previewRequestStatusMessage,
  sameUniverseParams,
  type PreviewParams,
} from '../../src/web/features/backtests/universe-rule-step.js';
import type { BacktestPreparationJob } from '../../src/web/features/backtests/preparation-live.js';

const baseline: PreviewParams = {
  strategyId: 'range-breakout',
  parameters: { b: 2, nested: { z: true, a: false }, a: 1 },
  period: { from: '2026-01-01', to: '2026-12-31' },
  universeRule: {
    markets: ['KOSPI'],
    stages: [{ criterion: 'MARKET_CAP', direction: 'HIGH', limit: 100 }],
    rebalanceInterval: { value: 1, unit: 'MONTH' },
  },
};

describe('sameUniverseParams', () => {
  it('객체 키 순서가 달라도 서버 준비 hash와 같이 동일하다고 본다', () => {
    expect(sameUniverseParams(baseline, {
      ...baseline,
      parameters: { a: 1, nested: { a: false, z: true }, b: 2 },
    })).toBe(true);
  });

  it('기간·규칙·전략·파라미터 변경은 미리보기를 무효화한다', () => {
    expect(sameUniverseParams(baseline, { ...baseline, period: { ...baseline.period, to: '2027-01-01' } })).toBe(false);
    expect(sameUniverseParams(baseline, { ...baseline, strategyId: 'other' })).toBe(false);
    expect(sameUniverseParams(baseline, { ...baseline, parameters: { a: 2 } })).toBe(false);
    expect(sameUniverseParams(baseline, {
      ...baseline,
      universeRule: { ...baseline.universeRule, stages: [{ criterion: 'MARKET_CAP', direction: 'HIGH', limit: 99 }] },
    })).toBe(false);
  });
});

describe('previewRequestStatusMessage', () => {
  const liveJob: BacktestPreparationJob = {
    id: 'prep_1',
    requestHash: 'hash_1',
    status: 'RUNNING',
    phase: 'MARKET_DATA',
    doneSymbols: 1,
    totalSymbols: 3,
    savedFacts: 0,
    gapCount: 0,
    nextResumeAtMs: null,
    error: null,
  };

  it('첫 요청은 SQLite 저장 상태 확인임을 표시한다', () => {
    expect(previewRequestStatusMessage(true, false, null)).toContain('SQLite');
  });

  it('상세 상태가 없으면 조회 실패일 수 있으므로 진행 상태를 표시하지 않는다', () => {
    expect(previewRequestStatusMessage(false, true, null)).toBeNull();
  });

  it('준비 작업을 받으면 현재 데이터 출처와 phase를 표시한다', () => {
    expect(previewRequestStatusMessage(false, true, liveJob)).toBe('KRX 시장 데이터 수집');
  });

  it('준비 완료와 최종 preview 재조회 사이에는 결과 확인 상태를 표시한다', () => {
    expect(previewRequestStatusMessage(
      false,
      true,
      { ...liveJob, status: 'COMPLETED' },
    )).toContain('미리보기 결과 확인 중');
  });

  it('현재 입력과 무관한 준비 작업은 버튼 상태에 표시하지 않는다', () => {
    expect(previewRequestStatusMessage(false, false, liveJob)).toBeNull();
  });
});
