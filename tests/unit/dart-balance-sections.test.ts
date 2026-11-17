import { describe, expect, it } from 'vitest';
import { parseFinancialRows, receiptDateToAsOfTsMs, type DartFinancialRow } from '../../src/server/modules/facts/infrastructure/dart/dart-report-parser.js';

type Line = readonly [number, string, string, number | string];
function rows(lines: readonly Line[], receipt = '20160330004137'): DartFinancialRow[] {
  return lines.map(([ord, account_id, account_nm, value]) => ({
    rcept_no: receipt, reprt_code: '11011', bsns_year: '2015', sj_div: 'BS',
    ord: String(ord), account_id, account_nm, thstrm_amount: String(value), account_detail: '-', currency: 'KRW',
  }));
}
function parse(input: readonly DartFinancialRow[]) {
  return parseFinancialRows('000880', new Map([['11011', input]]));
}
function values(input: readonly DartFinancialRow[]) {
  return Object.fromEntries(parse(input).facts.map(fact => [fact.field, fact.value]));
}

// 한화 2015 연결재무상태표의 구간·총계·대상 계정만 발췌했다.
// 일반 자산과 금융업 자산의 현금/유형자산을 한쪽만 취하면 과소 계상된다.
const hanwha = rows([
  [1, 'ifrs_CurrentAssets', 'Ⅰ. 유동자산', 11222945000000],
  [2, 'ifrs_CashAndCashEquivalents', '현금및현금성자산', 1182441000000],
  [62, 'ifrs_NoncurrentAssets', 'Ⅱ. 비유동자산', 15476587000000],
  [88, 'ifrs_PropertyPlantAndEquipment', '유형자산', 10406370000000],
  [158, '-표준계정코드 미사용-', 'Ⅲ. 금융업자산', 118922183000000],
  [159, '-표준계정코드 미사용-', '현금및현금성자산', 1061754000000],
  [164, '-표준계정코드 미사용-', '유형자산', 1780003000000],
  [173, 'ifrs_Assets', '자  산  총  계', 145621715000000],
]);

// 유동/비유동 사채의 구분을 검증하는 최소 재무상태표다.
function bonds(current: number, noncurrent: number) {
  return rows([
    [1, 'ifrs-full_CurrentLiabilities', '유동부채', 1000],
    [2, '-표준계정코드 미사용-', '사채', current],
    [3, 'ifrs-full_NoncurrentLiabilities', '비유동부채', 2000],
    [4, 'dart_BondsIssued', '사채', noncurrent],
    [5, 'ifrs-full_Liabilities', '부채총계', 3000],
  ]);
}

describe('재무상태표 구간별 집계', () => {
  it('한화의 금융업 금액을 포함하고 구형 태그·표시 순서·공시 시점을 보존한다', () => {
    for (const input of [hanwha, [...hanwha].reverse()]) {
      expect(values(input)).toMatchObject({
        CURRENT_ASSETS: 11222945000000,
        CASH_AND_EQUIVALENTS: 2244195000000,
        TANGIBLE_ASSETS: 12186373000000,
      });
      expect(parse(input).gaps.filter(gap => gap.severity === 'BLOCKING')).toEqual([]);
      expect(parse(input).facts.every(fact => fact.asOfTsMs === receiptDateToAsOfTsMs('20160330004137'))).toBe(true);
    }
  });

  it.each([
    ['009830', 6073959931089, 12523569833579, 1410042429514, 20007572194182, 6451599071822, 3363729642, 6454962801464],
    ['035720', 4462924201049, 6987572257652, 503649732037, 11954146190738, 430667589746, 5849723753, 436517313499],
    ['377300', 2292025213275, 174464214001, 966219517076, 3432708944352, 17352627719, 11782314064, 29134941783],
  ])('%s의 금융업 유형자산을 포함한다', (_code, current, noncurrent, financial, total, normalPpe, financialPpe, expected) => {
    const input = rows([
      [1, 'ifrs-full_CurrentAssets', '유동자산', current],
      [2, 'ifrs-full_NoncurrentAssets', '비유동자산', noncurrent],
      [3, 'ifrs-full_PropertyPlantAndEquipment', '유형자산', normalPpe],
      [4, '', '금융업자산', financial],
      [5, '', '유형자산', financialPpe],
      [6, 'ifrs-full_Assets', '자산총계', total],
    ]);
    expect(values(input).TANGIBLE_ASSETS).toBe(expected);
    expect(parse(input).gaps.some(gap => gap.kind === 'CONFLICT')).toBe(false);
  });

  it('023590처럼 금융업·총계·유동·비유동 순서로 와도 구간을 구분한다', () => {
    const input = rows([
      [7, '', '금융업자산', 52131318326755],
      [20, '', '유형자산', 183475862639],
      [22, 'ifrs-full_Assets', '자산총계', 53342459330150],
      [23, 'ifrs-full_CurrentAssets', '유동자산', 415124432271],
      [32, 'ifrs-full_NoncurrentAssets', '비유동자산', 796016571124],
      [43, 'ifrs-full_PropertyPlantAndEquipment', '유형자산', 224601311620],
      [46, 'ifrs-full_Equity', '자본총계', 5550533034939],
    ]);
    expect(values(input).TANGIBLE_ASSETS).toBe(408077174259);
    expect(parse(input).gaps.some(gap => gap.kind === 'CONFLICT')).toBe(false);
  });

  it.each([[20, 30, 50], [20, 0, 20], [20, 20, 40]])('유동 사채 %s와 비유동 사채 %s를 합쳐 %s로 저장한다', (current, noncurrent, expected) => {
    expect(values(bonds(current, noncurrent)).BONDS).toBe(expected);
    expect(parse(bonds(current, noncurrent)).gaps.some(gap => gap.kind === 'CONFLICT')).toBe(false);
  });

  it('같은 구간의 다른 값은 표준 태그가 있어도 차단하고 진단에 계정과 순서를 남긴다', () => {
    const input = [...hanwha, { ...hanwha[1]!, ord: '3', account_id: '', thstrm_amount: '999' }];
    expect(parse(input).gaps).toContainEqual(expect.objectContaining({
      field: 'CASH_AND_EQUIVALENTS', kind: 'CONFLICT', severity: 'BLOCKING',
      reason: expect.stringContaining('ord=3'),
    }));
  });

  it('금액이 같아도 합산 근거가 없는 서로 다른 행은 중복으로 버리지 않는다', () => {
    const input = bonds(20, 20).map(row => row.ord === '5' ? { ...row, thstrm_amount: '3001' } : row);
    expect(parse(input).gaps).toContainEqual(expect.objectContaining({ field: 'BONDS', kind: 'CONFLICT' }));
    const distinct = rows([
      [1, '', '단기차입금', 20],
      [2, 'ifrs-full_ShorttermBorrowings', '유동 차입금', 20],
    ]);
    expect(parse(distinct).gaps).toContainEqual(expect.objectContaining({ field: 'SHORT_TERM_BORROWINGS', kind: 'CONFLICT' }));
    expect(parse([distinct[0]!, { ...distinct[0]! }]).gaps.some(gap => gap.kind === 'CONFLICT')).toBe(false);
    const noOrder = distinct.map(() => ({ ...distinct[0]!, ord: undefined }));
    expect(parse(noOrder).gaps).toContainEqual(expect.objectContaining({ field: 'SHORT_TERM_BORROWINGS', kind: 'CONFLICT' }));
  });

  it.each(['총계 불일치', '경계 없음', '중복 순서', '다른 접수', '다른 통화', '상세 범위'])(
    '%s이면 추측해서 합산하지 않는다', scenario => {
      let input = hanwha.map(row => ({ ...row }));
      if (scenario === '총계 불일치') input[7]!.thstrm_amount = '145621715000001';
      if (scenario === '경계 없음') input = input.filter(row => row.ord !== '158');
      if (scenario === '중복 순서') input[5]!.ord = '2';
      if (scenario === '다른 접수') input[5]!.rcept_no = '20160516003484';
      if (scenario === '다른 통화') input[5]!.currency = 'USD';
      if (scenario === '상세 범위') input[5]!.account_detail = '별도 범위';
      expect(parse(input).gaps).toContainEqual(expect.objectContaining({ field: 'CASH_AND_EQUIVALENTS', kind: 'CONFLICT' }));
    },
  );

  it('금융업 금액이 결측이면 일반 부문만을 전사 합계로 저장하지 않는다', () => {
    const input = hanwha.map(row => row.ord === '159' ? { ...row, thstrm_amount: '' } : row);
    expect(values(input).CASH_AND_EQUIVALENTS).toBeUndefined();
    expect(parse(input).gaps).toContainEqual(expect.objectContaining({ field: 'CASH_AND_EQUIVALENTS', kind: 'MISSING' }));
    const withConflict = [...input, { ...hanwha[1]!, ord: '3', thstrm_amount: '999' }];
    expect(parse(withConflict).gaps).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: 'CASH_AND_EQUIVALENTS', kind: 'MISSING' }),
      expect.objectContaining({ field: 'CASH_AND_EQUIVALENTS', kind: 'CONFLICT' }),
    ]));
  });

  it('효성중공업의 유동 구간 장기차입금을 비유동 차입금과 구별한다', () => {
    const input = rows([
      [36, 'ifrs-full_CurrentLiabilities', '유동부채', 2811484808084],
      [37, 'ifrs-full_CurrentBorrowingsAndCurrentPortionOfNoncurrentBorrowings', '장기차입금', 903104096251],
      [44, 'ifrs-full_Liabilities', '부채총계', 3537140808779],
      [45, 'ifrs-full_NoncurrentLiabilities', '비유동부채', 725656000695],
      [46, 'dart_LongTermBorrowingsGross', '장기차입금', 398121187049],
    ]);
    expect(values(input)).toMatchObject({ CURRENT_LONG_TERM_DEBT: 903104096251, LONG_TERM_BORROWINGS: 398121187049 });
    expect(parse(input).gaps.some(gap => gap.kind === 'CONFLICT')).toBe(false);
    const missingCurrent = input.map(row => row.ord === '37' ? { ...row, thstrm_amount: '' } : row);
    expect(values(missingCurrent).LONG_TERM_BORROWINGS).toBe(398121187049);
    expect(values(missingCurrent).CURRENT_LONG_TERM_DEBT).toBeUndefined();
    expect(parse(missingCurrent).gaps).toContainEqual(expect.objectContaining({ field: 'CURRENT_LONG_TERM_DEBT', kind: 'MISSING' }));
  });
});

// 원문의 유동부채 구성 행 전체를 보존하여 별도 차입금 행의 중복 여부를 소계로 검증한다.
const currentBorrowings = [
  { code: '008730', current: 261285720069, noncurrent: 79131334323, total: 340417054392, short: 18446329534, other: 26000000000,
    rest: [119947410931, 38121663722, 50916024465, 322759929, 122261555, 23682293, 7385587640], expected: 44446329534 },
  { code: '326030', current: 359545928285, noncurrent: 93017296429, total: 452563224714, short: 50000000000, other: 97927400000,
    rest: [1198224160, 54870265456, 32212411141, 17382486573, 1539793723, 8228232, 6625987281, 97663083907, 32896284, 85151528], expected: 147927400000 },
];
for (const sample of currentBorrowings) {
  it(`${sample.code}의 별도 유동 차입금 행은 구성 금액의 합계가 맞을 때만 합산한다`, () => {
    const input = rows([
      [1, 'ifrs-full_CurrentLiabilities', '유동부채', sample.current],
      [2, '', '단기차입금', sample.short],
      [3, 'ifrs-full_ShorttermBorrowings', '유동 차입금', sample.other],
      ...sample.rest.map((value, index): Line => [index + 4, 'unmapped', `그 외 구성 항목 ${index}`, value]),
      [30, 'ifrs-full_Liabilities', '부채총계', sample.total],
      [31, 'ifrs-full_NoncurrentLiabilities', '비유동부채', sample.noncurrent],
    ]);
    expect(values(input).SHORT_TERM_BORROWINGS).toBe(sample.expected);
    expect(parse(input).gaps.some(gap => gap.kind === 'CONFLICT')).toBe(false);
    for (const changed of [
      input.filter(row => row.ord !== '4'),
      input.map(row => row.ord === '4' ? { ...row, thstrm_amount: '' } : row),
      input.map(row => row.ord === '4' ? { ...row, thstrm_amount: '1' } : row),
    ]) expect(parse(changed).gaps).toContainEqual(expect.objectContaining({ field: 'SHORT_TERM_BORROWINGS', kind: 'CONFLICT' }));
  });
}
