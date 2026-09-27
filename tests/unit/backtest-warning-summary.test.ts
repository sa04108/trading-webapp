import { describe, expect, it } from 'vitest';
import { summarizeBacktestWarnings } from '../../src/runtime/modules/backtest/application/backtest-warning-summary.js';

describe('백테스트 경고 표시 요약', () => {
  it('한도 안의 경고와 빈 경고는 원문과 같은 순서를 유지한다', () => {
    const warnings = Array.from({ length: 1000 }, (_, index) => `경고 ${index}`);
    expect(summarizeBacktestWarnings([])).toEqual([]);
    expect(summarizeBacktestWarnings(warnings)).toEqual(warnings);
  });

  it.each([999, 1000, 1001, 1093, 2001])('경고 %i개의 앞뒤와 축약 안내를 한도 안에 담는다', (count) => {
    const warnings = Array.from({ length: count }, (_, index) => `${index}: ${'가'.repeat(4162)}`);
    const summaries = summarizeBacktestWarnings(warnings.values());
    expect(summaries.length).toBeLessThanOrEqual(1000);
    expect(summaries.every(warning => warning.length <= 4000)).toBe(true);
    expect(summaries[0]).toContain(`경고 ${count}개`);
    expect(summaries[1]).toMatch(/^0:/);
    expect(summaries.at(-1)).toMatch(new RegExp(`^${count - 1}:`));
    expect(warnings[0]!.length).toBeGreaterThan(4000);
  });

  it('긴 문자열을 줄일 때 유니코드 문자 쌍을 보존한다', () => {
    const summaries = summarizeBacktestWarnings(['😀'.repeat(2500)]);
    expect(summaries).toHaveLength(2);
    expect(() => encodeURIComponent(summaries[1]!)).not.toThrow();
    expect(summaries[1]!.length).toBeLessThanOrEqual(4000);
    expect(summaries[1]).toContain('전체 경고 원문에서 확인');
  });
});
