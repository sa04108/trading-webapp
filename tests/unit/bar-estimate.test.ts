import { describe, expect, it } from 'vitest';
import { estimateBars } from '../../src/server/modules/backtest/domain/bar-estimate.js';

const DAY = 86_400_000;

function coverageRow(symbol: string, firstTsMs: number, lastTsMs: number, barCount: number) {
  return { symbol, firstTsMs, lastTsMs, barCount };
}

describe('estimateBars (백테스트 봉 수 상한 추정 — coverage 메타데이터만 사용)', () => {
  it('기간이 커버리지를 완전히 포함하면 barCount 그대로', () => {
    const coverage = [coverageRow('005930', 10 * DAY, 20 * DAY, 700)];
    expect(estimateBars(coverage, ['005930'], 0, 30 * DAY)).toBe(700);
  });

  it('부분 겹침은 겹치는 비율만큼 추정한다', () => {
    // 커버리지 10일 중 5일만 요청 → 절반
    const coverage = [coverageRow('005930', 10 * DAY, 20 * DAY, 700)];
    const estimated = estimateBars(coverage, ['005930'], 15 * DAY, 30 * DAY);
    expect(estimated).toBe(350);
  });

  it('커버리지가 없는 심볼은 0 으로 센다 (제출 거부는 coverage 검사 몫)', () => {
    const coverage = [coverageRow('005930', 10 * DAY, 20 * DAY, 700)];
    expect(estimateBars(coverage, ['없는종목'], 0, 30 * DAY)).toBe(0);
  });

  it('기간이 커버리지 밖이면 0', () => {
    const coverage = [coverageRow('005930', 10 * DAY, 20 * DAY, 700)];
    expect(estimateBars(coverage, ['005930'], 21 * DAY, 30 * DAY)).toBe(0);
  });

  it('여러 심볼은 합산한다', () => {
    const coverage = [
      coverageRow('005930', 10 * DAY, 20 * DAY, 700),
      coverageRow('000660', 10 * DAY, 20 * DAY, 300),
    ];
    expect(estimateBars(coverage, ['005930', '000660'], 0, 30 * DAY)).toBe(1000);
  });

  it('단일 봉 커버리지(first == last)는 겹치면 barCount 로 센다', () => {
    const coverage = [coverageRow('005930', 10 * DAY, 10 * DAY, 1)];
    expect(estimateBars(coverage, ['005930'], 0, 30 * DAY)).toBe(1);
    expect(estimateBars(coverage, ['005930'], 20 * DAY, 30 * DAY)).toBe(0);
  });
});
