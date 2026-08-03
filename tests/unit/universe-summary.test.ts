import { describe, expect, it } from 'vitest';
import { formatUniverseSummary } from '../../src/web/features/backtests/universe-summary.js';

describe('formatUniverseSummary', () => {
  it('데이터셋 이름과 종목 수만 적는다', () => {
    expect(formatUniverseSummary('코스피 대형주', 'ds_abc', 187)).toBe('코스피 대형주 · 187종목');
  });

  it('이름을 찾지 못하면 id 를 쓴다 — 설명이 비지 않는다', () => {
    // 데이터셋을 지운 뒤에도 어느 데이터셋으로 돌렸는지는 남아야 한다
    expect(formatUniverseSummary(null, 'ds_deleted', 3)).toBe('ds_deleted · 3종목');
  });

});
