import {
  normalizeDateKey,
  parseAmount,
  type DartIssuanceRow,
} from './dart-report-parser.js';

interface DartIssuanceCorrection {
  readonly symbol: string;
  readonly dateKey: string;
  readonly stockKind: string;
  readonly sourceQuantities: readonly number[];
  readonly correctedQuantity: number;
  readonly sourceStyle: string;
  readonly correctedStyle: string;
}

/**
 * OpenDART irdsSttus가 정기보고서 표의 비고·각주를 응답하지 않아 원문의 의미가
 * 사라진 행만 교정한다. 날짜·종류·수량·기존 형태가 모두 맞아야 적용한다 — 다른 회사의
 * '-' 행이나 일반 무상감자를 넓게 무시하면 실제 가격 단위 변경이 조용히 빠질 수 있다.
 *
 * 근거 원문:
 * - 033290 2017 사업보고서(20180402000670): 세 행 모두 자기주식 이익소각. OpenDART
 *   irdsSttus는 실제 주식수보다 1,000배 큰 수량도 반환하므로 검증된 두 값만 실제
 *   발행주식수 단위로 정규화한다.
 * - 068240 2017 기재정정 사업보고서(20180515000605): 로윈 소규모합병 신주 259,973주
 * - 063080 2017 사업보고서(2018-04-02 최초제출, 2020-03-20 최종 정정):
 *   게임빌에버 흡수합병 신주 72,816주. 전량 자기주식으로 편입됐으며 행의 날짜는
 *   합병기일이 아닌 신주상장일이다.
 */
const CORRECTIONS: readonly DartIssuanceCorrection[] = [
  {
    symbol: '033290',
    dateKey: '2017-01-23',
    stockKind: '보통주',
    sourceQuantities: [1_000_000, 1_000_000_000],
    correctedQuantity: 1_000_000,
    sourceStyle: '무상감자',
    correctedStyle: '이익소각',
  },
  {
    symbol: '033290',
    dateKey: '2017-05-26',
    stockKind: '보통주',
    sourceQuantities: [1_064_163, 1_064_163_000],
    correctedQuantity: 1_064_163,
    sourceStyle: '무상감자',
    correctedStyle: '이익소각',
  },
  {
    symbol: '033290',
    dateKey: '2017-12-20',
    stockKind: '보통주',
    sourceQuantities: [500_000, 500_000_000],
    correctedQuantity: 500_000,
    sourceStyle: '무상감자',
    correctedStyle: '이익소각',
  },
  {
    symbol: '068240',
    dateKey: '2017-02-13',
    stockKind: '보통주',
    sourceQuantities: [259_973],
    correctedQuantity: 259_973,
    sourceStyle: '-',
    correctedStyle: '합병',
  },
  {
    symbol: '063080',
    dateKey: '2017-03-07',
    stockKind: '보통주',
    sourceQuantities: [72_816],
    correctedQuantity: 72_816,
    sourceStyle: '-',
    correctedStyle: '합병',
  },
];

function normalizedToken(value: string | undefined): string | null {
  return typeof value === 'string' ? value.replace(/\s/g, '') : null;
}

function matches(row: DartIssuanceRow, correction: DartIssuanceCorrection): boolean {
  const quantity = parseAmount(row.isu_dcrs_qy);
  return normalizeDateKey(row.isu_dcrs_de) === correction.dateKey
    && normalizedToken(row.isu_dcrs_stock_knd) === correction.stockKind
    && quantity !== null
    && correction.sourceQuantities.includes(quantity)
    && normalizedToken(row.isu_dcrs_stle) === correction.sourceStyle;
}

/** 원문 snapshot은 보존하고 파서에 넘기는 행의 유실된 의미·수량 단위만 복구한다. */
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
      : {
          ...row,
          isu_dcrs_stle: correction.correctedStyle,
          isu_dcrs_qy: String(correction.correctedQuantity),
        };
  });
}
