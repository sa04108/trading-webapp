import { describe, expect, it } from 'vitest';
import { applyDartIssuanceCorrections } from '../../src/server/modules/facts/infrastructure/dart/dart-issuance-corrections.js';
import type { DartIssuanceRow } from '../../src/server/modules/facts/infrastructure/dart/dart-report-parser.js';

function row(overrides: Partial<DartIssuanceRow>): DartIssuanceRow {
  return {
    isu_dcrs_de: '2017-01-23',
    isu_dcrs_stle: '무상감자',
    isu_dcrs_stock_knd: '보통주',
    isu_dcrs_qy: '1,000,000,000',
    rcept_no: '20180402000670',
    ...overrides,
  };
}

describe('applyDartIssuanceCorrections', () => {
  it('033290의 자기주식 이익소각 3건을 가격 보정 대상 감자와 구분한다', () => {
    const rows = [
      row({}),
      row({ isu_dcrs_de: '2017.05.26', isu_dcrs_qy: '1,064,163,000' }),
      row({ isu_dcrs_de: '2017년 12월 20일', isu_dcrs_qy: '500000000' }),
    ];

    expect(applyDartIssuanceCorrections('033290', rows).map((candidate) => ({
      style: candidate.isu_dcrs_stle,
      quantity: candidate.isu_dcrs_qy,
    }))).toEqual([
      { style: '이익소각', quantity: '1000000' },
      { style: '이익소각', quantity: '1064163' },
      { style: '이익소각', quantity: '500000' },
    ]);
  });

  it('033290의 원문 수량이 이미 정상 단위여도 같은 공식 수량으로 보존한다', () => {
    const corrected = applyDartIssuanceCorrections('033290', [row({
      isu_dcrs_qy: '1,000,000',
    })]);

    expect(corrected[0]).toMatchObject({
      isu_dcrs_stle: '이익소각',
      isu_dcrs_qy: '1000000',
    });
  });

  it('068240의 발행형태 누락 행을 로윈 합병신주로 복구한다', () => {
    const corrected = applyDartIssuanceCorrections('068240', [row({
      isu_dcrs_de: '2017.02.13',
      isu_dcrs_stle: '-',
      isu_dcrs_qy: '259,973',
      rcept_no: '20180515000605',
    })]);

    expect(corrected[0]?.isu_dcrs_stle).toBe('합병');
  });

  it('종목·날짜·종류·수량·기존 형태 중 하나라도 다르면 교정하지 않는다', () => {
    const source = row({
      isu_dcrs_de: '2017.02.13',
      isu_dcrs_stle: '-',
      isu_dcrs_qy: '259,974',
    });

    expect(applyDartIssuanceCorrections('068240', [source])[0]).toBe(source);
    expect(applyDartIssuanceCorrections('999999', [{
      ...source,
      isu_dcrs_qy: '259,973',
    }])[0]?.isu_dcrs_stle).toBe('-');
    const unexpectedScale = row({ isu_dcrs_qy: '2,000,000,000' });
    expect(applyDartIssuanceCorrections('033290', [unexpectedScale])[0])
      .toBe(unexpectedScale);
  });
});
