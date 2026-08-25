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

  it('쉼표 없는 순수 숫자를 받는다 — fnlttSinglAcntAll 의 실제 금액 형식이다', () => {
    // 운영 장애(2026-08-10): 쉼표 묶음만 허용하는 검증이 실제 응답의 전 계정을
    // gap 으로 버려 재무 팩트가 저장소에 거의 남지 않았다.
    expect(parseAmount('9251406000000')).toBe(9_251_406_000_000);
    expect(parseAmount('-123456')).toBe(-123_456);
    expect(parseAmount('(1234)')).toBe(-1_234);
    expect(parseAmount('0')).toBe(0);
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

  it('괄호 짝이 안 맞거나 중간에 공백·괄호가 섞이면 null (부호·자릿수를 뒤집지 않는다)', () => {
    expect(parseAmount('(1,234')).toBeNull();
    expect(parseAmount('1(234)')).toBeNull();
    expect(parseAmount('1,2,3')).toBeNull();
    expect(parseAmount('12,34,567')).toBeNull();
    expect(parseAmount('1 234')).toBeNull();
  });

  it('괄호+마이너스 조합·괄호 뒤 잔여문자·중복 부호·지수표기는 기존 규칙대로 처리한다', () => {
    expect(parseAmount('(-1,234)')).toBe(-1_234);
    expect(parseAmount('(1,234)-')).toBeNull();
    expect(parseAmount('--1')).toBeNull();
    expect(parseAmount('1e3')).toBeNull();
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

  it('존재하지 않는 달력 날짜(2월 30일)는 다음 달로 굴리지 않고 null', () => {
    expect(receiptDateToAsOfTsMs('20250230000001')).toBeNull();
  });

  it('윤년의 2월 29일은 유효한 날짜다', () => {
    expect(receiptDateToAsOfTsMs('20240229000001')).not.toBeNull();
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

  it('순이익은 IS 누적 차분을 거치고 자본총계는 BS 시점값으로 저장한다', () => {
    const netIncome = (report: DartReportCode, cumulative: number): DartFinancialRow => ({
      ...incomeRow(report, cumulative),
      account_id: 'ifrs-full_ProfitLoss',
      account_nm: '당기순이익',
    });
    const totalEquity = (report: DartReportCode, value: number): DartFinancialRow => ({
      ...balanceRow(report, value),
      account_id: 'ifrs-full_Equity',
      account_nm: '자본총계',
      thstrm_amount: value.toLocaleString('en-US'),
    });
    const rows = new Map<DartReportCode, DartFinancialRow[]>([
      ['11013', [netIncome('11013', 100), totalEquity('11013', 900)]],
      ['11012', [netIncome('11012', 250), totalEquity('11012', 1_000)]],
    ]);

    const { facts } = parseFinancialRows('005930', rows);
    expect(
      facts.filter((entry) => entry.field === 'NET_INCOME').map((entry) => [entry.periodKey, entry.value]),
    ).toEqual([
      ['2025Q1', 100],
      ['2025Q2', 150],
    ]);
    expect(
      facts.filter((entry) => entry.field === 'TOTAL_EQUITY').map((entry) => [entry.periodKey, entry.value]),
    ).toEqual([
      ['2025Q1', 900],
      ['2025Q2', 1_000],
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
    expect(gaps[0]?.severity).toBe('INFORMATIONAL');
  });

  it('금액이 파싱되지 않으면 gap 으로 남긴다', () => {
    const rows = new Map<DartReportCode, DartFinancialRow[]>([
      ['11013', [{ ...balanceRow('11013', 0), thstrm_amount: '해당사항없음' }]],
    ]);
    const { facts, gaps } = parseFinancialRows('005930', rows);
    expect(facts).toEqual([]);
    expect(gaps).toHaveLength(1);
    expect(gaps[0]?.severity).toBe('BLOCKING');
  });

  it('손익 계정의 누적값이 파싱되지 않으면(IS 쪽도) gap 으로 남긴다', () => {
    const rows = new Map<DartReportCode, DartFinancialRow[]>([
      ['11013', [{ ...incomeRow('11013', 0), thstrm_add_amount: '해당사항없음' }]],
    ]);
    const { facts, gaps } = parseFinancialRows('005930', rows);
    expect(facts).toEqual([]);
    expect(gaps).toHaveLength(1);
  });

  it('thstrm_add_amount 가 빈 문자열이면(undefined 아님) thstrm_amount 를 누적으로 본다', () => {
    const rows = new Map<DartReportCode, DartFinancialRow[]>([
      ['11013', [{ ...incomeRow('11013', 999), thstrm_add_amount: '', thstrm_amount: '100' }]],
    ]);
    const { facts } = parseFinancialRows('005930', rows);
    expect(facts.find((f) => f.periodKey === '2025Q1')?.value).toBe(100);
  });

  /**
   * asOf 는 **행 단위** 로 구해야 한다 — 정정공시 등으로 한 버킷 안에 rcept_no 가 섞이면
   * `rows[0]` 하나를 대표로 쓰는 구현은 다른 행에 남의 접수일을 물려 PIT 컷오프를
   * 틀리게 만든다. 코드 주석이 정확히 그 버그를 막고 있다고 말하는데, 기존 픽스처는 한
   * 버킷의 모든 행이 같은 rcept_no 를 써서 `rows[0]` 로 되돌려도 전부 통과했다.
   */
  it('버킷 안에 접수번호가 섞이면 각 행이 자기 접수일을 asOf 로 쓴다 (정정공시)', () => {
    const CORRECTED = '20250901000009'; // 원 공시(0515)보다 늦게 접수된 정정공시
    const rows = new Map<DartReportCode, DartFinancialRow[]>([
      [
        '11013',
        [
          balanceRow('11013', 500), // rcept_no = 20250515000001
          {
            ...balanceRow('11013', 700),
            account_id: 'ifrs-full_PropertyPlantAndEquipment',
            account_nm: '유형자산',
            rcept_no: CORRECTED,
          },
        ],
      ],
    ]);
    const { facts } = parseFinancialRows('005930', rows);

    const assets = facts.find((fact) => fact.field === 'CURRENT_ASSETS');
    const tangible = facts.find((fact) => fact.field === 'TANGIBLE_ASSETS');
    expect(assets?.asOfTsMs).toBe(receiptDateToAsOfTsMs('20250515000001'));
    // rows[0] 을 대표로 쓰면 이 값이 원 공시의 asOf 로 잘못 내려앉는다
    expect(tangible?.asOfTsMs).toBe(receiptDateToAsOfTsMs(CORRECTED));
    expect(tangible?.asOfTsMs).not.toBe(assets?.asOfTsMs);
  });

  it('손익 계정도 정정공시 행의 접수일을 자기 asOf 로 쓴다', () => {
    const CORRECTED = '20250901000009';
    const rows = new Map<DartReportCode, DartFinancialRow[]>([
      ['11013', [incomeRow('11013', 100)]],
      // 반기 버킷의 손익 행이 정정공시로 다시 접수됐다
      ['11012', [{ ...incomeRow('11012', 250), rcept_no: CORRECTED }]],
    ]);
    const { facts } = parseFinancialRows('005930', rows);
    const q2 = facts.find((f) => f.periodKey === '2025Q2' && f.field === 'OPERATING_INCOME');
    expect(q2?.value).toBe(150);
    expect(q2?.asOfTsMs).toBe(receiptDateToAsOfTsMs(CORRECTED));
  });

  it('행의 접수번호를 읽을 수 없으면 그 행만 gap 으로 남기고 값을 만들지 않는다', () => {
    const rows = new Map<DartReportCode, DartFinancialRow[]>([
      ['11013', [{ ...incomeRow('11013', 100), rcept_no: '짧음' }]],
    ]);
    const { facts, gaps } = parseFinancialRows('005930', rows);
    expect(facts).toEqual([]);
    expect(gaps.some((g) => g.reason.includes('접수번호'))).toBe(true);
  });

  it('행의 reprt_code 가 버킷 키와 다르면 gap 으로 남기고 그 분기로 계상하지 않는다', () => {
    const rows = new Map<DartReportCode, DartFinancialRow[]>([
      ['11013', [{ ...incomeRow('11013', 100), reprt_code: '11012' }]],
    ]);
    const { facts, gaps } = parseFinancialRows('005930', rows);
    expect(facts).toEqual([]);
    expect(gaps.some((g) => g.reason.includes('보고서 코드가 일치하지 않습니다'))).toBe(true);
  });

  it('버킷 기준 연도와 다른 사업연도 행이 섞이면 gap 으로 남기고 그 행은 쓰지 않는다', () => {
    const rows = new Map<DartReportCode, DartFinancialRow[]>([
      ['11013', [incomeRow('11013', 100), { ...incomeRow('11013', 999), bsns_year: '2024' }]],
    ]);
    const { facts, gaps } = parseFinancialRows('005930', rows);
    const q1 = facts.filter((f) => f.periodKey === '2025Q1' && f.field === 'OPERATING_INCOME');
    expect(q1.map((f) => f.value)).toEqual([100]);
    expect(gaps.some((g) => g.reason.includes('사업연도'))).toBe(true);
  });

  it('직전 분기 누적값이 다른 사업연도에서 온 것이면 차분하지 않고 gap 으로 남긴다', () => {
    // '11013' 버킷이 잘못 채워져 2024년 자료가 들어간 상황 — 반기(2025)에서 이 값을
    // 전기 누적으로 빼면 서로 다른 회계연도를 차분한 가짜 숫자가 나온다
    const rows = new Map<DartReportCode, DartFinancialRow[]>([
      ['11013', [{ ...incomeRow('11013', 100), bsns_year: '2024' }]],
      ['11012', [incomeRow('11012', 250)]], // bsns_year 기본값 '2025'
    ]);
    const { facts, gaps } = parseFinancialRows('005930', rows);
    const q2 = facts.find((f) => f.periodKey === '2025Q2' && f.field === 'OPERATING_INCOME');
    expect(q2).toBeUndefined();
    expect(gaps.some((g) => g.reason.includes('다른 사업연도'))).toBe(true);
  });

  it('계정은 매핑되지만 sj_div 가 기대 계정유형과 다르면 gap 으로 남긴다', () => {
    const rows = new Map<DartReportCode, DartFinancialRow[]>([
      ['11013', [{ ...balanceRow('11013', 500), sj_div: 'IS' }]],
    ]);
    const { facts, gaps } = parseFinancialRows('005930', rows);
    expect(facts).toEqual([]);
    expect(gaps.some((g) => g.reason.includes('계정 유형이 일치하지 않습니다'))).toBe(true);
  });

  it('소비하지 않는 재무제표(CF)는 매핑되지 않아도 gap 없이 조용히 제외한다', () => {
    const rows = new Map<DartReportCode, DartFinancialRow[]>([
      [
        '11013',
        [
          {
            rcept_no: RECEIPTS['11013'],
            reprt_code: '11013',
            bsns_year: '2025',
            sj_div: 'CF',
            account_id: 'unknown_cf_tag',
            account_nm: '영업활동현금흐름',
            thstrm_amount: '12345',
          },
        ],
      ],
    ]);
    const { facts, gaps } = parseFinancialRows('005930', rows);
    expect(facts).toEqual([]);
    expect(gaps).toEqual([]);
  });

  it('같은 보고서 안에서 같은 BS 계정이 서로 다른 값으로 중복되면 gap 으로 남기고 처음 값만 쓴다', () => {
    const rows = new Map<DartReportCode, DartFinancialRow[]>([
      ['11013', [balanceRow('11013', 500), balanceRow('11013', 600)]],
    ]);
    const { facts, gaps } = parseFinancialRows('005930', rows);
    const assetFacts = facts.filter((f) => f.field === 'CURRENT_ASSETS');
    expect(assetFacts).toHaveLength(1);
    expect(assetFacts[0]?.value).toBe(500);
    expect(gaps.some((g) => g.reason.includes('서로 다릅니다'))).toBe(true);
  });

  it('같은 보고서 안에서 같은 손익 계정이 서로 다른 누적값으로 중복되면(IS·CIS) gap 으로 남기고 처음 값만 쓴다', () => {
    const rows = new Map<DartReportCode, DartFinancialRow[]>([
      ['11013', [incomeRow('11013', 100), { ...incomeRow('11013', 999), sj_div: 'CIS' }]],
    ]);
    const { facts, gaps } = parseFinancialRows('005930', rows);
    const q1 = facts.find((f) => f.periodKey === '2025Q1' && f.field === 'OPERATING_INCOME');
    expect(q1?.value).toBe(100);
    expect(gaps.some((g) => g.reason.includes('서로 다릅니다'))).toBe(true);
  });

  it('버킷 연도 불일치 gap 의 묶음 라벨은 값이 섞이지 않아 안정적이다 (CLI 사유별 집계)', () => {
    // CLI 는 첫 ':' 또는 '(' 앞까지를 버킷 라벨로 쓴다 — 앞부분에 연도·계정명이 섞이면
    // 같은 실패 유형이 값마다 다른 버킷으로 쪼개져 200종목 백필에서 리포트가 커진다.
    const bucketOf = (reason: string): string => {
      const cuts = [reason.indexOf(':'), reason.indexOf('(')].filter((index) => index >= 0);
      return reason.slice(0, cuts.length > 0 ? Math.min(...cuts) : reason.length).trim();
    };
    const first = parseFinancialRows(
      '005930',
      new Map<DartReportCode, DartFinancialRow[]>([
        ['11013', [incomeRow('11013', 100), { ...incomeRow('11013', 999), bsns_year: '2024' }]],
      ]),
    ).gaps.find((gap) => gap.reason.includes('사업연도'));
    const second = parseFinancialRows(
      '000660',
      new Map<DartReportCode, DartFinancialRow[]>([
        ['11013', [incomeRow('11013', 100), { ...incomeRow('11013', 999), bsns_year: '2019' }]],
      ]),
    ).gaps.find((gap) => gap.reason.includes('사업연도'));

    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(bucketOf(first!.reason)).toBe(bucketOf(second!.reason));
    // 라벨이 '행의 사업연도' 같은 조각이 아니라 문장이어야 리포트를 읽을 수 있다
    expect(bucketOf(first!.reason)).toBe('행의 사업연도가 버킷 기준 연도와 다릅니다');
  });
});

/**
 * 이 파일이 다루는 DART 필드 이름은 API 키 발급 후 실제 응답으로 검증해 조정한다고
 * 명시돼 있다 — 이름이 어긋난 첫 실행이 가장 있을 법한 결과다. 그때 `.replace`/`.trim`
 * 이 던지는 영어 bare TypeError 가 몇 시간짜리 백필 전체를 죽이면 안 된다.
 * 필드가 사라진 행은 예외가 아니라 그 **필드 이름을 밝히는 gap** 이어야 한다.
 */
describe('parseFinancialRows — 필드 이름이 바뀐 응답 (bare TypeError 금지)', () => {
  const base: DartFinancialRow = {
    rcept_no: '20250515000001',
    reprt_code: '11013',
    bsns_year: '2025',
    sj_div: 'BS',
    account_id: 'ifrs-full_CurrentAssets',
    account_nm: '유동자산',
    thstrm_amount: '500,000',
  };

  /** 필드 하나를 이름만 바꿔(값은 그대로) 지운 행 */
  function renamed(field: keyof DartFinancialRow): DartFinancialRow {
    const { [field]: value, ...rest } = base;
    return { ...rest, [`${field}_v2`]: value } as unknown as DartFinancialRow;
  }

  const cases: Array<[keyof DartFinancialRow, string]> = [
    ['rcept_no', 'rcept_no'],
    ['account_id', 'account_id'],
    ['account_nm', 'account_nm'],
    ['thstrm_amount', 'thstrm_amount'],
  ];

  for (const [field, named] of cases) {
    it(`${field} 이 사라지면 던지지 않고 그 필드 이름을 밝히는 gap 을 남긴다`, () => {
      const rows = new Map<DartReportCode, DartFinancialRow[]>([['11013', [renamed(field)]]]);
      let result: ReturnType<typeof parseFinancialRows> | null = null;
      expect(() => {
        result = parseFinancialRows('005930', rows);
      }).not.toThrow();
      expect(result!.facts).toEqual([]);
      expect(result!.gaps.some((gap) => gap.reason.includes(named))).toBe(true);
    });
  }

  it('손익 계정의 thstrm_amount 가 사라져도(누적 컬럼도 없이) 던지지 않는다', () => {
    const incomeBase = {
      rcept_no: '20250515000001',
      reprt_code: '11013',
      bsns_year: '2025',
      sj_div: 'IS',
      account_id: 'ifrs-full_ProfitLossFromOperatingActivities',
      account_nm: '영업이익',
    } as unknown as DartFinancialRow;
    const rows = new Map<DartReportCode, DartFinancialRow[]>([['11013', [incomeBase]]]);
    let result: ReturnType<typeof parseFinancialRows> | null = null;
    expect(() => {
      result = parseFinancialRows('005930', rows);
    }).not.toThrow();
    expect(result!.facts).toEqual([]);
    expect(result!.gaps.some((gap) => gap.reason.includes('thstrm_amount'))).toBe(true);
  });
});

describe('parseIssuanceRows — 필드 이름이 바뀐 응답 (bare TypeError 금지)', () => {
  const priorShares = () => 1_000_000;
  const base: DartIssuanceRow = {
    isu_dcrs_de: '2025-03-14',
    isu_dcrs_stle: '주식분할',
    isu_dcrs_qy: '1,000,000',
    rcept_no: '20250320000001',
  };

  const fields: Array<keyof DartIssuanceRow> = [
    'isu_dcrs_stle',
    'isu_dcrs_de',
    'isu_dcrs_qy',
    'rcept_no',
  ];

  for (const field of fields) {
    it(`${field} 이 사라지면 던지지 않고 그 필드 이름을 밝히는 gap 을 남긴다`, () => {
      const { [field]: value, ...rest } = base;
      const row = { ...rest, [`${field}_v2`]: value } as unknown as DartIssuanceRow;
      let result: ReturnType<typeof parseIssuanceRows> | null = null;
      expect(() => {
        result = parseIssuanceRows('005930', [row], priorShares);
      }).not.toThrow();
      expect(result!.facts).toEqual([]);
      expect(result!.gaps.some((gap) => gap.reason.includes(field))).toBe(true);
    });
  }
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
    expect(gaps[0]?.severity).toBe('BLOCKING');
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

  it('존재하지 않는 날짜(2월 30일)는 gap 으로 남긴다', () => {
    const rows: DartIssuanceRow[] = [
      {
        isu_dcrs_de: '2025-02-30',
        isu_dcrs_stle: '주식분할',
        isu_dcrs_qy: '100,000',
        rcept_no: '20250520000001',
      },
    ];
    const { facts, gaps } = parseIssuanceRows('005930', rows, priorShares);
    expect(facts).toEqual([]);
    expect(gaps).toHaveLength(1);
  });

  it('변동 수량이 0이면 gap 으로 남긴다', () => {
    const rows: DartIssuanceRow[] = [
      { isu_dcrs_de: '2025-06-02', isu_dcrs_stle: '주식분할', isu_dcrs_qy: '0', rcept_no: '20250520000001' },
    ];
    const { facts, gaps } = parseIssuanceRows('005930', rows, priorShares);
    expect(facts).toEqual([]);
    expect(gaps).toHaveLength(1);
    expect(gaps[0]?.reason).toContain('변동 수량');
  });

  it('주식병합 변동 수량이 직전 발행주식수와 같으면(비율 0) gap 으로 남긴다', () => {
    const rows: DartIssuanceRow[] = [
      {
        isu_dcrs_de: '2025-06-02',
        isu_dcrs_stle: '주식병합',
        isu_dcrs_qy: '1,000,000',
        rcept_no: '20250520000001',
      },
    ];
    const { facts, gaps } = parseIssuanceRows('005930', rows, priorShares);
    expect(facts).toEqual([]);
    expect(gaps).toHaveLength(1);
    expect(gaps[0]?.reason).toContain('보정 비율');
  });

  it('이벤트의 접수번호를 읽을 수 없으면 gap 으로 남긴다', () => {
    const rows: DartIssuanceRow[] = [
      { isu_dcrs_de: '2025-06-02', isu_dcrs_stle: '주식분할', isu_dcrs_qy: '100,000', rcept_no: '짧음' },
    ];
    const { facts, gaps } = parseIssuanceRows('005930', rows, priorShares);
    expect(facts).toEqual([]);
    expect(gaps).toHaveLength(1);
    expect(gaps[0]?.reason).toContain('접수번호');
  });
});

describe('parseIssuanceRows — 발행형태 분류 (전수 테이블)', () => {
  const priorShares = () => 1_000_000;

  const cases: ReadonlyArray<{ style: string; direction: 'increase' | 'decrease' | 'skip' }> = [
    { style: '주식분할', direction: 'increase' },
    { style: '무상증자', direction: 'increase' },
    { style: '주식배당', direction: 'increase' },
    { style: '주식병합', direction: 'decrease' },
    { style: '무상감자', direction: 'decrease' },
    { style: '유상증자(주주배정)', direction: 'skip' },
    // 유상감자 — classifyCapitalChange 의 첫 두 검사 순서를 뒤집으면(유상 검사를 감자
    // 검사 뒤로 옮기면) 이 행이 DECREASE 로 분류돼 가격을 보정하는 가짜 SPLIT_RATIO 를
    // 낸다. 함수 주석이 "이 순서를 테스트 없이 바꾸면 안 된다" 고 못박고 있는데 정작
    // 그 순서를 지키는 행이 없었다.
    { style: '유상감자', direction: 'skip' },
    { style: '유상감자(주주배정)', direction: 'skip' },
  ];

  for (const { style, direction } of cases) {
    it(`'${style}' 는 ${direction} 로 분류된다`, () => {
      const rows: DartIssuanceRow[] = [
        {
          isu_dcrs_de: '2025-06-02',
          isu_dcrs_stle: style,
          isu_dcrs_qy: '100,000',
          rcept_no: '20250520000001',
        },
      ];
      const { facts, gaps } = parseIssuanceRows('005930', rows, priorShares);

      if (direction === 'skip') {
        expect(facts).toEqual([]);
        expect(gaps).toEqual([]); // 유상감자와 마찬가지로 현금이 오간 것이라 의도된 제외
        return;
      }

      expect(facts).toHaveLength(1);
      if (direction === 'increase') {
        expect(facts[0]?.value).toBeGreaterThan(1);
      } else {
        expect(facts[0]?.value).toBeLessThan(1);
      }
    });
  }

  it('알 수 없는 발행형태는 조용히 버리지 않고 gap 으로 남긴다', () => {
    const rows: DartIssuanceRow[] = [
      {
        isu_dcrs_de: '2025-06-02',
        isu_dcrs_stle: '알수없는형태',
        isu_dcrs_qy: '100,000',
        rcept_no: '20250520000001',
      },
    ];
    const { facts, gaps } = parseIssuanceRows('005930', rows, priorShares);
    expect(facts).toEqual([]);
    expect(gaps).toHaveLength(1);
    expect(gaps[0]?.reason).toContain('알수없는형태');
  });
});
