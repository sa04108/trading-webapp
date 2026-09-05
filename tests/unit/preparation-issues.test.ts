import { describe, expect, it } from 'vitest';
import { groupPreparationIssues, splitPreparationWarnings } from '../../src/web/features/backtests/preparation-issues.js';
import { backtestDataExclusionWarnings, type BacktestDataExclusion } from '../../src/server/modules/backtest/application/backtest-data-exclusion.js';

const price = (symbol: string, periodKey = '2026-01-05', days = 20): BacktestDataExclusion => ({
  symbol, category: 'KRX_PRICE', periodKey,
  reason: `DECLINE 계산에 필요한 ${days}개 거래일 일봉 부족`,
});

describe('준비 확인사항 분류', () => {
  it('실제 서버 문구에서 날짜·필요 일수가 달라도 같은 사유의 고유 종목을 센다', () => {
    const warnings = backtestDataExclusionWarnings([
      price('000001'), price('000001', '2026-02-05', 60), price('000002'), price('000002'),
    ]);
    const parsed = splitPreparationWarnings(warnings);
    expect(parsed.otherWarnings).toEqual([]);
    const groups = groupPreparationIssues(parsed.issues);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ reason: '계산에 필요한 거래일 일봉 부족', disposition: 'EXCLUDED' });
    expect(groups[0]?.symbols.map((entry) => entry.symbol)).toEqual(['000001', '000002']);
    expect(groups[0]?.symbols[0]?.details).toEqual([
      { period: '2026-01-05', detail: 'DECLINE 계산에 필요한 20개 거래일 일봉 부족' },
      { period: '2026-02-05', detail: 'DECLINE 계산에 필요한 60개 거래일 일봉 부족' },
    ]);
  });

  it('같은 종목의 다른 사유는 각각 집계하고 발행형태 원문은 상세에 남긴다', () => {
    const warnings = backtestDataExclusionWarnings([
      price('000001'),
      { symbol: '000001', category: 'DART_CORPORATE_ACTION', periodKey: '2025년/2025-01-03', reason: '분류할 수 없는 발행형태: 사유 A / 사유 B; 원문 표기' },
      { symbol: '000002', category: 'DART_CORPORATE_ACTION', periodKey: '2025년/2025-02-03', reason: '분류할 수 없는 발행형태: 사유 C' },
    ]);
    const groups = groupPreparationIssues(splitPreparationWarnings(warnings).issues);
    expect(groups.map((group) => group.symbols.length)).toEqual([1, 2]);
    expect(groups[1]?.reason).toBe('발행형태 분류 불가');
    expect(groups[1]?.symbols[0]?.details[0]?.detail).toBe('분류할 수 없는 발행형태: 사유 A / 사유 B; 원문 표기');
  });

  it('재무 경고에 합쳐진 분기별 다른 원인을 각각 분류한다', () => {
    const warnings = backtestDataExclusionWarnings([{
      symbol: '000001', category: 'DART_FINANCIAL', periodKey: '2025',
      reason: '2025Q1: 매핑되지 않은 계정: 원문 계정 (unknown) / 2025Q2: 금액을 읽을 수 없습니다: 매출',
    }]);
    const parsed = splitPreparationWarnings(warnings);
    expect(parsed.issues.map(({ reason, period }) => ({ reason, period }))).toEqual([
      { reason: '재무 계정 매핑 불가', period: '2025Q1' },
      { reason: '재무 금액 해석 불가', period: '2025Q2' },
    ]);
  });

  it('거래정지·상장폐지 이력을 종목 제외와 구별하고 종목명에 괄호가 있어도 코드를 읽는다', () => {
    const parsed = splitPreparationWarnings([
      '예시(보통주) (000001): 2026-01-05~2026-01-10 기간 중 거래정지·무거래 기록이 3일 있습니다.',
      '000002: 2026-01-07에 상장폐지됐습니다.',
    ]);
    expect(parsed.issues).toMatchObject([
      { symbol: '000001', disposition: 'NOTICE', reason: '거래정지·무거래 이력', period: '2026-01-05~2026-01-10' },
      { symbol: '000002', disposition: 'NOTICE', reason: '상장폐지 이력', period: '2026-01-07' },
    ]);
  });

  it.each([
    ['KRX_CLASSIFICATION', '상장주식수 누락', '상장주식수 누락'],
    ['KRX_CLASSIFICATION', '일별매매에는 존재하지만 종목 기본정보 행 누락', '종목 기본정보 누락'],
    ['KRX_CLASSIFICATION', '종목 분류 필드를 해석할 수 없음', '종목 분류 해석 불가'],
    ['KRX_SELECTION_METRIC', 'MARKET_CAP 행 또는 값 누락', '시가총액 누락'],
    ['KRX_PRICE', '확정 유니버스 활성 기간의 KRX 일봉 13일 누락', '편입 기간의 일봉 누락'],
    ['DART_FINANCIAL', 'DART corp_code 매핑에 없는 종목코드입니다', '기업코드 매핑 없음'],
    ['DART_CORPORATE_ACTION', 'KRX 상장주식수 변경일과 정렬할 수 없는 자본변동', 'KRX 상장주식수 변경일과 대응 불가'],
    ['DART_CORPORATE_ACTION', '같은 기준일의 자본변동 수치가 공시마다 다릅니다 (1 vs 2)', '공시 간 자본변동 수치 불일치'],
    ['DART_CORPORATE_ACTION', '응답 필드를 읽을 수 없습니다: isu_dcrs_stle (발행형태)', '발행형태 필드 누락'],
    ['DART_CORPORATE_ACTION', '응답 필드를 읽을 수 없습니다: isu_dcrs_de (자본변동 일자)', '자본변동 일자 필드 누락'],
  ] as const)('%s의 실제 사유를 구분한다: %s', (category, detail, reason) => {
    const parsed = splitPreparationWarnings(backtestDataExclusionWarnings([{
      symbol: '000001', category, periodKey: '2025', reason: detail,
    }]));
    expect(parsed.issues[0]?.reason).toBe(reason);
  });

  it('결과 전용 경고와 미인식 문구를 준비 제외로 오분류하거나 버리지 않는다', () => {
    const others = [
      '000001 매수 거부: 현금 부족 (2026-01-03T05:00:00.000Z)',
      '상장폐지로 강제 청산한 종목 1건: 000001. 손익 합계 0원.',
      '이 백테스트가 보정하지 않는 것: 배당',
      '새로운 미인식 확인사항',
    ];
    expect(splitPreparationWarnings(others)).toEqual({ issues: [], otherWarnings: others });
  });

  it('알 수 없는 준비 사유도 상세와 집계에서 보존하고 중복 원문은 접는다', () => {
    const warnings = backtestDataExclusionWarnings([{
      symbol: '000001', category: 'DART_FINANCIAL', periodKey: '-', reason: '새로운 데이터 사유',
    }]);
    const groups = groupPreparationIssues(splitPreparationWarnings([...warnings, ...warnings]).issues);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.reason).toBe('새로운 데이터 사유');
    expect(groups[0]?.symbols[0]?.details).toHaveLength(1);
  });
});
