import {
  normalizeDateKey,
  parseAmount,
  type DartIssuanceRow,
} from './dart-report-parser.js';

interface DartIssuanceCorrection {
  readonly symbol: string;
  readonly dateKey: string;
  readonly stockKind: string;
  readonly quantity: number;
  readonly sourceStyle: string;
  readonly correctedStyle: string;
}

/**
 * OpenDART irdsSttus가 정기보고서 표의 비고·각주를 응답하지 않아 원문의 의미가
 * 사라진 행만 교정한다. 날짜·종류·수량·기존 형태가 모두 맞아야 적용한다 — 다른 회사의
 * '-' 행이나 일반 무상감자를 넓게 무시하면 실제 가격 단위 변경이 조용히 빠질 수 있다.
 *
 * 근거 원문:
 * - 033290 2017 사업보고서(20180402000670): 세 행 모두 자기주식 이익소각
 * - 068240 2017 기재정정 사업보고서(20180515000605): 로윈 소규모합병 신주 259,973주
 */
const CORRECTIONS: readonly DartIssuanceCorrection[] = [
  {
    symbol: '033290',
    dateKey: '2017-01-23',
    stockKind: '보통주',
    quantity: 1_000_000,
    sourceStyle: '무상감자',
    correctedStyle: '이익소각',
  },
  {
    symbol: '033290',
    dateKey: '2017-05-26',
    stockKind: '보통주',
    quantity: 1_064_163,
    sourceStyle: '무상감자',
    correctedStyle: '이익소각',
  },
  {
    symbol: '033290',
    dateKey: '2017-12-20',
    stockKind: '보통주',
    quantity: 500_000,
    sourceStyle: '무상감자',
    correctedStyle: '이익소각',
  },
  {
    symbol: '068240',
    dateKey: '2017-02-13',
    stockKind: '보통주',
    quantity: 259_973,
    sourceStyle: '-',
    correctedStyle: '합병',
  },
];

function normalizedToken(value: string | undefined): string | null {
  return typeof value === 'string' ? value.replace(/\s/g, '') : null;
}

function matches(row: DartIssuanceRow, correction: DartIssuanceCorrection): boolean {
  return normalizeDateKey(row.isu_dcrs_de) === correction.dateKey
    && normalizedToken(row.isu_dcrs_stock_knd) === correction.stockKind
    && parseAmount(row.isu_dcrs_qy) === correction.quantity
    && normalizedToken(row.isu_dcrs_stle) === correction.sourceStyle;
}

/** 원문 snapshot은 보존하고 파서에 넘기는 행의 유실된 발행형태만 복구한다. */
export function applyDartIssuanceCorrections(
  symbol: string,
  rows: readonly DartIssuanceRow[],
): readonly DartIssuanceRow[] {
  const candidates = CORRECTIONS.filter((correction) => correction.symbol === symbol);
  if (candidates.length === 0) return rows;

  return rows.map((row) => {
    const correction = candidates.find((candidate) => matches(row, candidate));
    return correction === undefined
      ? row
      : { ...row, isu_dcrs_stle: correction.correctedStyle };
  });
}
