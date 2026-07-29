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

/** 이 파서가 실제로 소비하는 재무제표 구분. CF(현금흐름표)·SCE(자본변동표)는 의도된 제외다 */
const CONSUMED_STATEMENTS: ReadonlySet<string> = new Set(['BS', 'IS', 'CIS']);

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

/**
 * 전체 토큰을 한 번에 검증한다 — 부분적으로 유효해 보이는 조각을 이어붙이면
 * '(1,234' 같은 괄호 짝이 안 맞는 입력이나 '1 234' 같은 중간 공백이 섞인 입력이
 * 조용히 통과해 부호나 자릿수가 틀린 값을 만들 수 있다.
 */
const AMOUNT_PATTERN = /^-?\d{1,3}(,\d{3})*(\.\d+)?$/;

export function parseAmount(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed === '') return null;

  const hasOpenParen = trimmed.startsWith('(');
  const hasCloseParen = trimmed.endsWith(')');
  if (hasOpenParen !== hasCloseParen) return null; // 괄호가 한쪽만 있으면 형식 오류
  const negative = hasOpenParen;

  const inner = negative ? trimmed.slice(1, -1) : trimmed;
  if (inner.includes('(') || inner.includes(')')) return null; // 괄호가 양끝이 아닌 곳에 있으면 형식 오류
  if (!AMOUNT_PATTERN.test(inner)) return null;

  const value = Number(inner.replace(/,/g, ''));
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

/** 분기 하나의 손익 누적값 — 어느 보고서(행)에서 왔는지 asOf 도 함께 들고 다닌다 */
interface CumulativePoint {
  readonly value: number;
  readonly asOfTsMs: number;
}

/**
 * 정기보고서 4종을 분기 단독값 팩트로 바꾼다.
 *
 * 손익 계정은 누적이다 — 분기 단독값 = 당기 누적 − 전기 누적. 어느 컬럼이 3개월
 * 금액인지는 제출사마다 갈리므로 누적값만 믿고 차분한다. 중간 보고서가 빠지면 그
 * 뒤 분기를 만들지 않고 gap 으로 남긴다 (틀린 값보다 없는 값이 낫다). 전기 누적값이
 * 다른 사업연도에서 온 것이면(버킷이 잘못 채워진 경우) 역시 차분하지 않고 gap 으로
 * 남긴다.
 *
 * 재무상태표 계정은 시점값이라 그대로 쓴다.
 *
 * 행 하나하나에 대해: reprt_code·bsns_year 가 버킷과 일치하는지, sj_div 가 이
 * 파서가 소비하는 재무제표(BS/IS/CIS)인지, 매핑된 계정의 statement 와 실제 sj_div
 * 가 맞는지를 차례로 확인한다 — 어느 하나라도 어긋나면 그 행은 gap 이거나(구조적
 * 불일치) 조용히 제외된다(CF·SCE 처럼 애초에 소비 대상이 아닌 경우). 같은 보고서
 * 안에서 같은 계정이 서로 다른 값으로 두 번 잡히면(예: IS·CIS 중복) 조용히
 * 덮어쓰지 않고 gap 을 남긴다.
 */
export function parseFinancialRows(
  symbol: string,
  rowsByReport: ReadonlyMap<DartReportCode, readonly DartFinancialRow[]>,
): ParsedFinancials {
  const facts: Fact[] = [];
  const gaps: FactIngestionGap[] = [];

  /** field → quarter(1~4) → 누적값(+asOf) */
  const cumulative = new Map<string, Map<number, CumulativePoint>>();
  /** report → bsns_year — 분기 간 사업연도가 섞여 차분되는 것을 막는다 */
  const yearByReport = new Map<DartReportCode, string>();

  for (const report of REPORT_ORDER) {
    const rows = rowsByReport.get(report);
    if (!rows || rows.length === 0) continue;
    const quarter = REPORT_CODE_TO_QUARTER[report];
    const year = rows[0]?.bsns_year ?? '';
    const periodKey = `${year}Q${quarter}`;
    yearByReport.set(report, year);

    /** 같은 보고서 안에서 계정이 두 번 잡히면 값이 다를 때만 gap 을 남긴다 */
    const seenBsInReport = new Map<string, number>();

    for (const row of rows) {
      // row.reprt_code 가 버킷 키(report)와 다르면 호출자가 잘못 묶은 것이다 —
      // 엉뚱한 분기로 계상하는 대신 gap 으로 남긴다. asOf 를 구하기 전에 확인한다.
      if (!isReportCode(row.reprt_code) || row.reprt_code !== report) {
        gaps.push({
          symbol,
          periodKey,
          reason: `보고서 코드가 일치하지 않습니다: ${row.reprt_code} (기대값 ${report})`,
        });
        continue;
      }

      // 버킷의 기준 연도(rows[0].bsns_year)와 다른 사업연도 행이 섞이면 엉뚱한
      // 분기로 표기되므로 gap 으로 남긴다
      if (row.bsns_year !== year) {
        gaps.push({
          symbol,
          periodKey,
          reason: `행의 사업연도(${row.bsns_year})가 버킷 기준 연도(${year})와 다릅니다: ${row.account_nm}`,
        });
        continue;
      }

      // CF·SCE 등 이 파서가 소비하지 않는 재무제표는 의도된 제외다 — 매핑 여부와
      // 무관하게 gap 을 남기지 않는다 (그렇지 않으면 보고서마다 무관한 계정 수백
      // 개가 '매핑되지 않은 계정' gap 노이즈를 만든다)
      if (!CONSUMED_STATEMENTS.has(row.sj_div)) continue;

      // asOf 는 행 단위로 구한다 — 정정공시 등으로 버킷 안에 rcept_no 가 섞일 수
      // 있어 rows[0] 하나만 대표로 쓰면 다른 행의 asOf 를 잘못 물려받는다
      const asOf = receiptDateToAsOfTsMs(row.rcept_no);
      if (asOf === null) {
        gaps.push({ symbol, periodKey, reason: `접수번호를 읽을 수 없습니다: ${row.rcept_no}` });
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

      const statementMatches =
        rule.statement === 'BS' ? row.sj_div === 'BS' : row.sj_div === 'IS' || row.sj_div === 'CIS';
      if (!statementMatches) {
        gaps.push({
          symbol,
          periodKey,
          reason: `계정 유형이 일치하지 않습니다: ${row.account_nm} (sj_div=${row.sj_div}, 기대값=${rule.statement})`,
        });
        continue;
      }

      if (rule.statement === 'BS') {
        const amount = parseAmount(row.thstrm_amount);
        if (amount === null) {
          gaps.push({ symbol, periodKey, reason: `금액을 읽을 수 없습니다: ${row.account_nm}` });
          continue;
        }
        const previouslySeen = seenBsInReport.get(rule.field);
        if (previouslySeen !== undefined) {
          if (previouslySeen !== amount) {
            gaps.push({
              symbol,
              periodKey,
              reason: `같은 보고서 안에서 ${rule.field} 값이 서로 다릅니다 (${previouslySeen} vs ${amount})`,
            });
          }
          continue;
        }
        seenBsInReport.set(rule.field, amount);
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

      // IS/CIS — 누적값을 모아두고 아래에서 차분한다. thstrm_add_amount 가 빈
      // 문자열인 제출사도 있어 '있으면 쓴다' 가 아니라 '내용이 있으면 쓴다' 로 판단한다
      const cumulativeRaw = row.thstrm_add_amount?.trim() ? row.thstrm_add_amount : row.thstrm_amount;
      const amount = parseAmount(cumulativeRaw);
      if (amount === null) {
        gaps.push({ symbol, periodKey, reason: `금액을 읽을 수 없습니다: ${row.account_nm}` });
        continue;
      }
      const byQuarter = cumulative.get(rule.field) ?? new Map<number, CumulativePoint>();
      const existing = byQuarter.get(quarter);
      if (existing !== undefined) {
        if (existing.value !== amount) {
          gaps.push({
            symbol,
            periodKey,
            reason: `같은 보고서 안에서 ${rule.field} 누적값이 서로 다릅니다 (${existing.value} vs ${amount})`,
          });
        }
        continue;
      }
      byQuarter.set(quarter, { value: amount, asOfTsMs: asOf });
      cumulative.set(rule.field, byQuarter);
    }
  }

  for (const [field, byQuarter] of cumulative) {
    for (const report of REPORT_ORDER) {
      const quarter = REPORT_CODE_TO_QUARTER[report];
      const current = byQuarter.get(quarter);
      if (current === undefined) continue;

      const year = yearByReport.get(report) ?? '';
      const periodKey = `${year}Q${quarter}`;

      if (quarter === 1) {
        facts.push({
          scope: 'SYMBOL',
          key: symbol,
          field,
          periodKey,
          asOfTsMs: current.asOfTsMs,
          value: current.value,
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

      // 전기 누적값이 다른 사업연도에서 온 것이면(버킷 배정 오류) 차분하지 않는다
      const previousReport = REPORT_ORDER[quarter - 2];
      const previousYear = previousReport !== undefined ? yearByReport.get(previousReport) : undefined;
      if (previousYear === undefined || previousYear !== year) {
        gaps.push({
          symbol,
          periodKey,
          reason: `직전 분기가 다른 사업연도입니다 (${previousYear ?? '알수없음'} → ${year}) — ${field} 단독값을 만들 수 없습니다`,
        });
        continue;
      }

      facts.push({
        scope: 'SYMBOL',
        key: symbol,
        field,
        periodKey,
        asOfTsMs: current.asOfTsMs,
        value: current.value - previous.value,
        unit: 'KRW',
      });
    }
  }

  return { facts, gaps };
}

type CapitalChangeDirection = 'INCREASE' | 'DECREASE' | 'SKIP_PAID';

/**
 * 발행형태 문자열을 분류한다. 분할·무상증자·주식배당은 주주가 낸 돈 없이 주식수만
 * 늘어나므로 증가로, 병합·감자(무상감자 포함)는 감소로 분류한다. '유상' 이 포함되면
 * (유상증자·유상감자 모두) 현금이 오간 것이라 의도된 제외다. 병합/감자 판정을
 * 증가 판정보다 먼저 확인해야 '무상감자' 처럼 두 조건에 다 걸리는 표기가 항상
 * 감소로 분류된다 — 이 순서를 호출부의 삼항 연산자에 맡기면 나중에 누군가 조건
 * 순서를 바꿨을 때 테스트 없이 부호가 뒤집힐 수 있으므로 분류를 함수 하나로 고정한다.
 * 어느 쪽에도 속하지 않으면 null 을 반환해 호출자가 gap 으로 남기게 한다 — 조용히
 * 버리면 앞으로 추가되거나 이름이 바뀐 발행형태가 가격 보정 없이 새어나간다.
 */
function classifyCapitalChange(style: string): CapitalChangeDirection | null {
  if (style.includes('유상')) return 'SKIP_PAID';
  if (style.includes('병합') || style.includes('감자')) return 'DECREASE';
  if (style.includes('분할') || style.includes('무상') || style.includes('주식배당')) return 'INCREASE';
  return null;
}

/**
 * 증자·감자 현황을 가격 보정 비율로 바꾼다.
 *
 * 비율 = (직전 발행주식수 ± 변동 수량) / 직전 발행주식수. 분할·무상증자·주식배당·
 * 병합은 주주가 낸 돈 없이 주식수만 바뀌므로 가격을 이 비율로 보정해야 과거·현재를
 * 비교할 수 있다. **유상증자·유상감자는 제외한다** — 현금이 오간 것이라(증자는
 * 유입, 감자는 유출) 가격 보정 대상이 아니다. 분류할 수 없는 발행형태는 조용히
 * 버리지 않고 gap 으로 남긴다.
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
    const direction = classifyCapitalChange(style);

    if (direction === null) {
      gaps.push({
        symbol,
        periodKey: row.isu_dcrs_de,
        reason: `분류할 수 없는 발행형태: ${row.isu_dcrs_stle}`,
      });
      continue;
    }
    // 유상증자·유상감자는 현금이 오간 것이라 의도된 제외다 — gap 을 남기지 않는다
    if (direction === 'SKIP_PAID') continue;

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

    const ratio = direction === 'DECREASE' ? (prior - quantity) / prior : (prior + quantity) / prior;
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
