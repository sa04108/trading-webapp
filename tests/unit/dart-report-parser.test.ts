import { describe, expect, it } from 'vitest';
import { resolveAccount } from '../../src/server/modules/facts/infrastructure/dart/dart-account-map.js';
import {
  parseAmount,
  parseFinancialRows,
  parseIssuanceRows,
  receiptDateToAsOfTsMs,
  type DartFinancialRow,
  type DartIssuanceRow,
  type DartReportCode,
} from '../../src/server/modules/facts/infrastructure/dart/dart-report-parser.js';

describe('resolveAccount', () => {
  it('IFRS 표준 태그를 우선한다', () => {
    expect(resolveAccount('ifrs-full_CurrentAssets', '아무이름')).toEqual({
      field: 'CURRENT_ASSETS',
      statement: 'BS',
    });
  });

  it('표준 태그가 없으면 계정명으로 폴백한다', () => {
    expect(resolveAccount('-표준계정코드 미사용-', '유동부채')).toEqual({
      field: 'CURRENT_LIABILITIES',
      statement: 'BS',
    });
  });

  it('계정명의 공백을 무시한다', () => {
    expect(resolveAccount('', '현금및 현금성 자산')?.field).toBe('CASH_AND_EQUIVALENTS');
  });

  it('부분 일치로 잘못 잡지 않는다', () => {
    // '유동성장기차입금' 이 '단기차입금' 으로 매핑되면 총차입금이 이중 계상된다
    expect(resolveAccount('', '유동성장기차입금')?.field).toBe('CURRENT_LONG_TERM_DEBT');
    expect(resolveAccount('', '기타단기차입금등')).toBeNull();
  });

  it('모르는 계정은 null', () => {
    expect(resolveAccount('unknown_tag', '알수없는계정')).toBeNull();
  });
});

describe('parseAmount', () => {
  it('천 단위 쉼표를 제거한다', () => {
    expect(parseAmount('1,234,567')).toBe(1_234_567);
  });

  it('괄호 음수를 처리한다', () => {
    expect(parseAmount('(1,234)')).toBe(-1_234);
  });

  it('마이너스 부호를 처리한다', () => {
    expect(parseAmount('-1,234')).toBe(-1_234);
  });

  it('빈 값·하이픈은 null', () => {
    expect(parseAmount('')).toBeNull();
    expect(parseAmount('-')).toBeNull();
    expect(parseAmount('  ')).toBeNull();
  });

  it('숫자가 아니면 null', () => {
    expect(parseAmount('해당사항없음')).toBeNull();
  });
});

describe('receiptDateToAsOfTsMs', () => {
  it('접수번호 앞 8자리를 접수일 18:00 KST 로 바꾼다', () => {
    // 2025-05-15 18:00 KST = 2025-05-15 09:00 UTC
    expect(receiptDateToAsOfTsMs('20250515000123')).toBe(Date.UTC(2025, 4, 15, 9, 0));
  });

  it('1d 봉 마감(15:30 KST)보다 늦다 — 공시일 당일 봉에는 반영되지 않는다', () => {
    const asOf = receiptDateToAsOfTsMs('20250515000123') as number;
    const barClose = Date.UTC(2025, 4, 15, 6, 30); // 15:30 KST
    expect(asOf).toBeGreaterThan(barClose);
  });

  it('형식이 다르면 null', () => {
    expect(receiptDateToAsOfTsMs('짧음')).toBeNull();
    expect(receiptDateToAsOfTsMs('99999999000001')).toBeNull();
  });
});

describe('parseFinancialRows — 누적값 차분', () => {
  const RECEIPTS: Record<DartReportCode, string> = {
    '11013': '20250515000001', // 1Q
    '11012': '20250814000001', // 반기
    '11014': '20251114000001', // 3Q
    '11011': '20260316000001', // 사업보고서
  };

  function incomeRow(report: DartReportCode, cumulative: number): DartFinancialRow {
    return {
      rcept_no: RECEIPTS[report],
      reprt_code: report,
      bsns_year: '2025',
      sj_div: 'IS',
      account_id: 'ifrs-full_ProfitLossFromOperatingActivities',
      account_nm: '영업이익',
      thstrm_amount: '0',
      thstrm_add_amount: String(cumulative),
    };
  }

  function balanceRow(report: DartReportCode, amount: number): DartFinancialRow {
    return {
      rcept_no: RECEIPTS[report],
      reprt_code: report,
      bsns_year: '2025',
      sj_div: 'BS',
      account_id: 'ifrs-full_CurrentAssets',
      account_nm: '유동자산',
      thstrm_amount: String(amount),
    };
  }

  it('손익 계정은 누적 차분으로 분기 단독값을 만든다', () => {
    const rows = new Map<DartReportCode, DartFinancialRow[]>([
      ['11013', [incomeRow('11013', 100)]],
      ['11012', [incomeRow('11012', 250)]],
      ['11014', [incomeRow('11014', 420)]],
      ['11011', [incomeRow('11011', 600)]],
    ]);
    const { facts } = parseFinancialRows('005930', rows);
    const income = facts
      .filter((fact) => fact.field === 'OPERATING_INCOME')
      .sort((a, b) => (a.periodKey < b.periodKey ? -1 : 1));

    expect(income.map((fact) => [fact.periodKey, fact.value])).toEqual([
      ['2025Q1', 100],
      ['2025Q2', 150],
      ['2025Q3', 170],
      ['2025Q4', 180],
    ]);
  });

  it('중간 보고서가 없으면 그 뒤 분기를 만들지 않고 gap 으로 남긴다', () => {
    const rows = new Map<DartReportCode, DartFinancialRow[]>([
      ['11013', [incomeRow('11013', 100)]],
      // 반기 누락
      ['11014', [incomeRow('11014', 420)]],
    ]);
    const { facts, gaps } = parseFinancialRows('005930', rows);
    const periods = facts.filter((f) => f.field === 'OPERATING_INCOME').map((f) => f.periodKey);
    expect(periods).toEqual(['2025Q1']);
    expect(gaps.some((gap) => gap.periodKey === '2025Q3')).toBe(true);
  });

  it('재무상태표 계정은 차분하지 않고 시점값을 그대로 쓴다', () => {
    const rows = new Map<DartReportCode, DartFinancialRow[]>([
      ['11013', [balanceRow('11013', 500)]],
      ['11012', [balanceRow('11012', 520)]],
    ]);
    const { facts } = parseFinancialRows('005930', rows);
    const assets = facts
      .filter((fact) => fact.field === 'CURRENT_ASSETS')
      .sort((a, b) => (a.periodKey < b.periodKey ? -1 : 1));
    expect(assets.map((fact) => [fact.periodKey, fact.value])).toEqual([
      ['2025Q1', 500],
      ['2025Q2', 520],
    ]);
  });

  it('각 분기의 asOfTsMs 는 그 분기 보고서의 접수일이다', () => {
    const rows = new Map<DartReportCode, DartFinancialRow[]>([
      ['11013', [incomeRow('11013', 100)]],
      ['11012', [incomeRow('11012', 250)]],
    ]);
    const { facts } = parseFinancialRows('005930', rows);
    const q2 = facts.find((f) => f.periodKey === '2025Q2' && f.field === 'OPERATING_INCOME');
    // Q2 단독값은 반기보고서가 나온 뒤에야 알 수 있다
    expect(q2?.asOfTsMs).toBe(receiptDateToAsOfTsMs('20250814000001'));
  });

  it('thstrm_add_amount 가 없으면 thstrm_amount 를 누적으로 본다', () => {
    const rows = new Map<DartReportCode, DartFinancialRow[]>([
      [
        '11013',
        [
          {
            rcept_no: RECEIPTS['11013'],
            reprt_code: '11013',
            bsns_year: '2025',
            sj_div: 'IS',
            account_id: 'ifrs-full_ProfitLossFromOperatingActivities',
            account_nm: '영업이익',
            thstrm_amount: '100',
          },
        ],
      ],
    ]);
    const { facts } = parseFinancialRows('005930', rows);
    expect(facts.find((f) => f.periodKey === '2025Q1')?.value).toBe(100);
  });

  it('매핑되지 않는 계정은 조용히 버리지 않고 gap 으로 남긴다', () => {
    const rows = new Map<DartReportCode, DartFinancialRow[]>([
      [
        '11013',
        [
          {
            rcept_no: RECEIPTS['11013'],
            reprt_code: '11013',
            bsns_year: '2025',
            sj_div: 'BS',
            account_id: 'unknown_tag',
            account_nm: '알수없는계정',
            thstrm_amount: '1',
          },
        ],
      ],
    ]);
    const { facts, gaps } = parseFinancialRows('005930', rows);
    expect(facts).toEqual([]);
    expect(gaps).toHaveLength(1);
    expect(gaps[0]?.reason).toContain('알수없는계정');
  });

  it('금액이 파싱되지 않으면 gap 으로 남긴다', () => {
    const rows = new Map<DartReportCode, DartFinancialRow[]>([
      ['11013', [{ ...balanceRow('11013', 0), thstrm_amount: '해당사항없음' }]],
    ]);
    const { facts, gaps } = parseFinancialRows('005930', rows);
    expect(facts).toEqual([]);
    expect(gaps).toHaveLength(1);
  });
});

describe('parseIssuanceRows — 자본변동', () => {
  const priorShares = () => 1_000_000;

  it('무상증자·분할은 비율 팩트가 된다', () => {
    const rows: DartIssuanceRow[] = [
      {
        isu_dcrs_de: '2025년 03월 14일',
        isu_dcrs_stle: '주식분할',
        isu_dcrs_qy: '4,000,000',
        rcept_no: '20250310000001',
      },
    ];
    const { facts } = parseIssuanceRows('005930', rows, priorShares);
    expect(facts).toHaveLength(1);
    expect(facts[0]).toMatchObject({
      scope: 'SYMBOL',
      key: '005930',
      field: 'SPLIT_RATIO',
      periodKey: '2025-03-14',
      unit: 'RATIO',
    });
    // (1,000,000 + 4,000,000) / 1,000,000 = 5
    expect(facts[0]?.value).toBe(5);
    expect(facts[0]?.asOfTsMs).toBe(receiptDateToAsOfTsMs('20250310000001'));
  });

  it('무상증자도 같은 방식으로 보정한다', () => {
    const rows: DartIssuanceRow[] = [
      {
        isu_dcrs_de: '2025-06-02',
        isu_dcrs_stle: '무상증자',
        isu_dcrs_qy: '100,000',
        rcept_no: '20250520000001',
      },
    ];
    const { facts } = parseIssuanceRows('005930', rows, priorShares);
    expect(facts[0]?.value).toBeCloseTo(1.1);
  });

  it('주식병합은 비율이 1 보다 작다', () => {
    const rows: DartIssuanceRow[] = [
      {
        isu_dcrs_de: '2025-06-02',
        isu_dcrs_stle: '주식병합',
        isu_dcrs_qy: '500,000',
        rcept_no: '20250520000001',
      },
    ];
    const { facts } = parseIssuanceRows('005930', rows, priorShares);
    expect(facts[0]?.value).toBeCloseTo(0.5);
  });

  it('유상증자는 가격 보정 대상이 아니다 — 팩트를 만들지 않는다', () => {
    const rows: DartIssuanceRow[] = [
      {
        isu_dcrs_de: '2025-06-02',
        isu_dcrs_stle: '유상증자(주주배정)',
        isu_dcrs_qy: '100,000',
        rcept_no: '20250520000001',
      },
    ];
    const { facts, gaps } = parseIssuanceRows('005930', rows, priorShares);
    expect(facts).toEqual([]);
    expect(gaps).toEqual([]); // 의도된 제외이므로 gap 도 아니다
  });

  it('이벤트 직전 발행주식수를 모르면 gap 으로 남긴다', () => {
    const rows: DartIssuanceRow[] = [
      {
        isu_dcrs_de: '2025-06-02',
        isu_dcrs_stle: '주식분할',
        isu_dcrs_qy: '100,000',
        rcept_no: '20250520000001',
      },
    ];
    const { facts, gaps } = parseIssuanceRows('005930', rows, () => null);
    expect(facts).toEqual([]);
    expect(gaps).toHaveLength(1);
    expect(gaps[0]?.reason).toContain('발행주식수');
  });

  it('날짜를 읽을 수 없으면 gap 으로 남긴다', () => {
    const rows: DartIssuanceRow[] = [
      {
        isu_dcrs_de: '미정',
        isu_dcrs_stle: '주식분할',
        isu_dcrs_qy: '100,000',
        rcept_no: '20250520000001',
      },
    ];
    const { facts, gaps } = parseIssuanceRows('005930', rows, priorShares);
    expect(facts).toEqual([]);
    expect(gaps).toHaveLength(1);
  });
});
