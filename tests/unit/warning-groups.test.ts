import { describe, expect, it } from 'vitest';
import { groupWarnings } from '../../src/web/features/backtests/warning-groups.js';

describe('groupWarnings', () => {
  it('종목·시각만 다른 현금 부족 경고를 한 그룹으로 묶고 건수를 센다', () => {
    const groups = groupWarnings([
      '005930 매수 거부: 현금 부족 (2026-01-03T05:00:00.000Z)',
      '000660 매수 거부: 현금 부족 (2026-01-04T02:30:00.000Z)',
      '005930 매수 거부: 현금 부족 (2026-01-05T01:00:00.000Z)',
    ]);
    expect(groups).toEqual([{ label: '매수 거부: 현금 부족 (3건)', count: 3 }]);
  });

  it('1회성 요약 라인은 원본 그대로 count 1 로 남는다', () => {
    const original = '기간 종료 시점에 미청산 포지션 1건이 남아 있습니다 (평가금액에는 반영됨).';
    expect(groupWarnings([original])).toEqual([{ label: original, count: 1 }]);
  });

  it('그룹 순서는 첫 등장 순서를 따른다', () => {
    const groups = groupWarnings([
      '생존 편향, 공휴일 캘린더, 배당, 권리락은 이 백테스트에서 보정하지 않습니다.',
      '005930 매수 거부: 현금 부족 (2026-01-03T05:00:00.000Z)',
      '000660 매수 거부: 현금 부족 (2026-01-04T02:30:00.000Z)',
    ]);
    expect(groups.map((g) => g.count)).toEqual([1, 2]);
    expect(groups[0]?.label).toContain('생존 편향');
  });

  it('빈 배열이면 빈 배열', () => {
    expect(groupWarnings([])).toEqual([]);
  });
});
