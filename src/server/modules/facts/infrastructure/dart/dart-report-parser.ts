import { KR_SESSION } from '../../../market-data/domain/exchange-session.js';
import type { FactIngestionGap } from '../../application/ports.js';
import { CORPORATE_ACTION_FIELD, type Fact } from '../../domain/fact.js';
import { resolveAccount } from './dart-account-map.js';

/** 정기보고서 코드 (DART reprt_code) */
export type DartReportCode = '11013' | '11012' | '11014' | '11011';

/** 보고서가 커버하는 누적 분기 수. 1Q=1, 반기=2, 3Q=3, 사업보고서=4 */
export const REPORT_CODE_TO_QUARTER: Record<DartReportCode, 1 | 2 | 3 | 4> = {
  '11013': 1,
  '11012': 2,
  '11014': 3,
  '11011': 4,
};

const REPORT_ORDER: readonly DartReportCode[] = ['11013', '11012', '11014', '11011'];

export interface DartFinancialRow {
  readonly rcept_no: string;
  readonly reprt_code: string;
  readonly bsns_year: string;
  /** BS = 재무상태표, IS/CIS = 손익계산서, CF = 현금흐름표, SCE = 자본변동표 */
  readonly sj_div: string;
  readonly account_id: string;
  readonly account_nm: string;
  /** 당기 금액 (보고서에 따라 3개월 또는 누적) */
  readonly thstrm_amount: string;
  /** 당기 누적 금액. 있으면 이것을 누적으로 쓴다 */
  readonly thstrm_add_amount?: string;
}

export interface DartIssuanceRow {
  /** 주식발행·감소 일자. '2025년 03월 14일' / '2025-03-14' 등 표기가 섞인다 */
  readonly isu_dcrs_de: string;
  /** 발행·감소 형태. '주식분할' / '무상증자' / '유상증자(주주배정)' / '주식병합' 등 */
  readonly isu_dcrs_stle: string;
  readonly isu_dcrs_qy: string;
  readonly rcept_no: string;
}

export interface ParsedFinancials {
  readonly facts: readonly Fact[];
  readonly gaps: readonly FactIngestionGap[];
}

const MS_PER_MINUTE = 60_000;
/**
 * 공시 접수일 18:00 KST 를 asOf 로 쓴다. 1d 봉 마감이 15:30 KST 이므로 공시일 당일
 * 봉에는 반영되지 않고 다음 봉부터 쓰인다 — 보수적이고 룩어헤드를 완전히 차단한다.
 */
const AS_OF_MINUTE_OF_DAY = 18 * 60;

export function parseAmount(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed === '' || trimmed === '-') return null;
  const negative = /^\(.*\)$/.test(trimmed);
  const digits = trimmed.replace(/[(),\s]/g, '');
  if (!/^-?\d+(\.\d+)?$/.test(digits)) return null;
  const value = Number(digits);
  if (!Number.isFinite(value)) return null;
  return negative ? -Math.abs(value) : value;
}

/**
 * `Date.parse` 는 '2025-02-30' 같은 존재하지 않는 날짜를 조용히 다음 달로
 * 굴려버린다(→ 3월 2일). 굴러간 결과의 연/월/일이 입력과 다르면 애초에 유효한
 * 달력 날짜가 아니었다는 뜻이므로 null 로 되돌린다 — 틀린 날짜로 asOf 나
 * periodKey 를 만드는 것보다 gap 이 낫다.
 */
function isCalendarDateValid(utcMs: number, year: string, month: string, day: string): boolean {
  const parsed = new Date(utcMs);
  return (
    parsed.getUTCFullYear() === Number(year) &&
    parsed.getUTCMonth() + 1 === Number(month) &&
    parsed.getUTCDate() === Number(day)
  );
}

/** 'YYYYMMDD...' 접수번호 → 접수일 18:00 KST 의 UTC epoch ms */
export function receiptDateToAsOfTsMs(rceptNo: string): number | null {
  const match = /^(\d{4})(\d{2})(\d{2})/.exec(rceptNo.trim());
  if (!match) return null;
  const [, year, month, day] = match as unknown as [string, string, string, string];
  const utcMidnight = Date.parse(`${year}-${month}-${day}T00:00:00Z`);
  if (Number.isNaN(utcMidnight) || !isCalendarDateValid(utcMidnight, year, month, day)) {
    return null;
  }
  // 현지 자정 → UTC 로 옮기고 18:00 만큼 더한다
  return (
    utcMidnight -
    KR_SESSION.utcOffsetMinutes * MS_PER_MINUTE +
    AS_OF_MINUTE_OF_DAY * MS_PER_MINUTE
  );
}

/** '2025년 03월 14일' / '2025-03-14' / '2025.03.14' → 'YYYY-MM-DD' */
function normalizeDateKey(raw: string): string | null {
  const match = /(\d{4})\D+(\d{1,2})\D+(\d{1,2})/.exec(raw.trim());
  if (!match) return null;
  const [, year, month, day] = match as unknown as [string, string, string, string];
  const key = `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
  const parsedMs = Date.parse(`${key}T00:00:00Z`);
  if (Number.isNaN(parsedMs) || !isCalendarDateValid(parsedMs, year, month, day)) {
    return null;
  }
  return key;
}

function isReportCode(value: string): value is DartReportCode {
  return value in REPORT_CODE_TO_QUARTER;
}

/**
 * 정기보고서 4종을 분기 단독값 팩트로 바꾼다.
 *
 * 손익 계정은 누적이다 — 분기 단독값 = 당기 누적 − 전기 누적. 어느 컬럼이 3개월
 * 금액인지는 제출사마다 갈리므로 누적값만 믿고 차분한다. 중간 보고서가 빠지면 그
 * 뒤 분기를 만들지 않고 gap 으로 남긴다 (틀린 값보다 없는 값이 낫다).
 *
 * 재무상태표 계정은 시점값이라 그대로 쓴다.
 */
export function parseFinancialRows(
  symbol: string,
  rowsByReport: ReadonlyMap<DartReportCode, readonly DartFinancialRow[]>,
): ParsedFinancials {
  const facts: Fact[] = [];
  const gaps: FactIngestionGap[] = [];

  /** field → quarter(1~4) → 누적값 */
  const cumulative = new Map<string, Map<number, number>>();
  /** report → asOfTsMs */
  const asOfByReport = new Map<DartReportCode, number>();

  for (const report of REPORT_ORDER) {
    const rows = rowsByReport.get(report);
    if (!rows || rows.length === 0) continue;
    const quarter = REPORT_CODE_TO_QUARTER[report];
    const year = rows[0]?.bsns_year ?? '';
    const periodKey = `${year}Q${quarter}`;

    const asOf = receiptDateToAsOfTsMs(rows[0]?.rcept_no ?? '');
    if (asOf === null) {
      gaps.push({ symbol, periodKey, reason: `접수번호를 읽을 수 없습니다: ${rows[0]?.rcept_no}` });
      continue;
    }
    asOfByReport.set(report, asOf);

    for (const row of rows) {
      // row.reprt_code 가 버킷 키(report)와 다르면 호출자가 잘못 묶은 것이다 —
      // 엉뚱한 분기로 계상하는 대신 gap 으로 남긴다
      if (!isReportCode(row.reprt_code) || row.reprt_code !== report) {
        gaps.push({
          symbol,
          periodKey,
          reason: `보고서 코드가 일치하지 않습니다: ${row.reprt_code} (기대값 ${report})`,
        });
        continue;
      }

      const rule = resolveAccount(row.account_id, row.account_nm);
      if (!rule) {
        gaps.push({
          symbol,
          periodKey,
          reason: `매핑되지 않은 계정: ${row.account_nm} (${row.account_id})`,
        });
        continue;
      }

      if (rule.statement === 'BS') {
        const amount = parseAmount(row.thstrm_amount);
        if (amount === null) {
          gaps.push({ symbol, periodKey, reason: `금액을 읽을 수 없습니다: ${row.account_nm}` });
          continue;
        }
        facts.push({
          scope: 'SYMBOL',
          key: symbol,
          field: rule.field,
          periodKey,
          asOfTsMs: asOf,
          value: amount,
          unit: 'KRW',
        });
        continue;
      }

      // IS — 누적값을 모아두고 아래에서 차분한다
      const amount = parseAmount(row.thstrm_add_amount ?? row.thstrm_amount);
      if (amount === null) {
        gaps.push({ symbol, periodKey, reason: `금액을 읽을 수 없습니다: ${row.account_nm}` });
        continue;
      }
      const byQuarter = cumulative.get(rule.field) ?? new Map<number, number>();
      byQuarter.set(quarter, amount);
      cumulative.set(rule.field, byQuarter);
    }
  }

  for (const [field, byQuarter] of cumulative) {
    for (const report of REPORT_ORDER) {
      const quarter = REPORT_CODE_TO_QUARTER[report];
      const current = byQuarter.get(quarter);
      const asOf = asOfByReport.get(report);
      if (current === undefined || asOf === undefined) continue;

      const year = (rowsByReport.get(report) ?? [])[0]?.bsns_year ?? '';
      const periodKey = `${year}Q${quarter}`;

      if (quarter === 1) {
        facts.push({
          scope: 'SYMBOL',
          key: symbol,
          field,
          periodKey,
          asOfTsMs: asOf,
          value: current,
          unit: 'KRW',
        });
        continue;
      }

      const previous = byQuarter.get(quarter - 1);
      if (previous === undefined) {
        gaps.push({
          symbol,
          periodKey,
          reason: `직전 분기 누적값이 없어 ${field} 단독값을 만들 수 없습니다`,
        });
        continue;
      }
      facts.push({
        scope: 'SYMBOL',
        key: symbol,
        field,
        periodKey,
        asOfTsMs: asOf,
        value: current - previous,
        unit: 'KRW',
      });
    }
  }

  return { facts, gaps };
}

/**
 * 증자·감자 현황을 가격 보정 비율로 바꾼다.
 *
 * 비율 = (직전 발행주식수 ± 변동 수량) / 직전 발행주식수. 분할·무상증자·병합은
 * 주주가 낸 돈 없이 주식수만 바뀌므로 가격을 이 비율로 보정해야 과거·현재를 비교할
 * 수 있다. **유상증자는 제외한다** — 현금이 들어온 것이라 가격 보정 대상이 아니다.
 *
 * `sharesBefore` 는 이벤트 직전 발행주식수를 준다. 분기 공시값을 쓰므로 같은 분기에
 * 여러 이벤트가 있으면 근사가 된다 — 이 한계는 결과 화면 경고에 남는다.
 */
export function parseIssuanceRows(
  symbol: string,
  rows: readonly DartIssuanceRow[],
  sharesBefore: (dateKey: string) => number | null,
): ParsedFinancials {
  const facts: Fact[] = [];
  const gaps: FactIngestionGap[] = [];

  for (const row of rows) {
    const style = row.isu_dcrs_stle.replace(/\s/g, '');
    // 유상증자는 가격 보정 대상이 아니다 — 의도된 제외이므로 gap 을 남기지 않는다
    if (style.includes('유상')) continue;

    const isSplitLike = style.includes('분할') || style.includes('무상');
    const isMerge = style.includes('병합') || style.includes('감자');
    if (!isSplitLike && !isMerge) continue;

    const dateKey = normalizeDateKey(row.isu_dcrs_de);
    if (dateKey === null) {
      gaps.push({
        symbol,
        periodKey: row.isu_dcrs_de,
        reason: `자본변동 일자를 읽을 수 없습니다: ${row.isu_dcrs_de}`,
      });
      continue;
    }

    const quantity = parseAmount(row.isu_dcrs_qy);
    if (quantity === null || quantity <= 0) {
      gaps.push({ symbol, periodKey: dateKey, reason: `변동 수량을 읽을 수 없습니다: ${row.isu_dcrs_qy}` });
      continue;
    }

    const prior = sharesBefore(dateKey);
    if (prior === null || prior <= 0) {
      gaps.push({
        symbol,
        periodKey: dateKey,
        reason: '이벤트 직전 발행주식수를 알 수 없어 보정 비율을 만들 수 없습니다',
      });
      continue;
    }

    const ratio = isMerge ? (prior - quantity) / prior : (prior + quantity) / prior;
    if (!Number.isFinite(ratio) || ratio <= 0) {
      gaps.push({ symbol, periodKey: dateKey, reason: `보정 비율이 유효하지 않습니다: ${ratio}` });
      continue;
    }

    const asOf = receiptDateToAsOfTsMs(row.rcept_no);
    if (asOf === null) {
      gaps.push({ symbol, periodKey: dateKey, reason: `접수번호를 읽을 수 없습니다: ${row.rcept_no}` });
      continue;
    }

    facts.push({
      scope: 'SYMBOL',
      key: symbol,
      field: CORPORATE_ACTION_FIELD,
      periodKey: dateKey,
      asOfTsMs: asOf,
      value: ratio,
      unit: 'RATIO',
    });
  }

  return { facts, gaps };
}
