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
      '이 백테스트가 보정하는 것: 시점별 유니버스 선정, 상장폐지 청산, 거래불가일(거래정지·무거래) 매수 제외. '
        + '액면분할은 이 실행에서 보정되지 않았습니다 (분할 이력 미수집).',
      '이 백테스트가 보정하지 않는 것: 배당, 유상증자 권리락, 공휴일 캘린더, 과거 지수 구성원 복원. '
        + '손절·익절은 종가로만 판정합니다.',
      '005930 매수 거부: 현금 부족 (2026-01-03T05:00:00.000Z)',
      '000660 매수 거부: 현금 부족 (2026-01-04T02:30:00.000Z)',
    ]);
    // 한글 문장은 SYMBOL_PREFIX·TIMESTAMP_PAREN 어느 패턴에도 걸리지 않아 각자 자기 자신이
    // 키다 — 1회성 요약 두 건 + 현금 부족 묶음(2건)으로 그룹이 셋 나온다.
    expect(groups.map((g) => g.count)).toEqual([1, 1, 2]);
    expect(groups[0]?.label).toContain('이 백테스트가 보정하는 것');
    expect(groups[1]?.label).toContain('이 백테스트가 보정하지 않는 것');
  });

  it('빈 배열이면 빈 배열', () => {
    expect(groupWarnings([])).toEqual([]);
  });
});
