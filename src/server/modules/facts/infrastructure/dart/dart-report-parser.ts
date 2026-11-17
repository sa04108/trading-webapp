import { KR_SESSION } from "../../../../../runtime/modules/market-data/domain/exchange-session.js";
import type { FactIngestionGap } from "../../../../../runtime/modules/facts/application/ports.js";
import {
  CORPORATE_ACTION_FIELD,
  type Fact,
  type FundamentalField,
} from "../../../../../runtime/modules/facts/domain/fact.js";
import { normalizeDartAccountId, resolveAccount } from "./dart-account-map.js";
import { analyzeBalanceSections, type BalanceSections } from "./dart-balance-sections.js";

/** 정기보고서 코드 (DART reprt_code) */
export type DartReportCode = "11013" | "11012" | "11014" | "11011";

/** 보고서가 커버하는 누적 분기 수. 1Q=1, 반기=2, 3Q=3, 사업보고서=4 */
export const REPORT_CODE_TO_QUARTER: Record<DartReportCode, 1 | 2 | 3 | 4> = {
  "11013": 1,
  "11012": 2,
  "11014": 3,
  "11011": 4,
};

/** 분기 순서(1Q→반기→3Q→사업보고서). `Object.keys(REPORT_CODE_TO_QUARTER)` 는 키가
 *  숫자처럼 보여 사전식이 아니라 수치 순으로 정렬되므로(사업보고서 코드가 가장 먼저 옴)
 *  호출부가 분기 순서를 원하면 이 상수를 써야 한다. */
export const REPORT_ORDER: readonly DartReportCode[] = [
  "11013",
  "11012",
  "11014",
  "11011",
];

/** 이 파서가 실제로 소비하는 재무제표 구분. CF(현금흐름표)·SCE(자본변동표)는 의도된 제외다 */
const CONSUMED_STATEMENTS: ReadonlySet<string> = new Set(["BS", "IS", "CIS"]);

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
  /** 재무제표 안의 표시 순서와 범위. 구간 합산 근거로만 사용한다. */
  readonly ord?: string;
  readonly account_detail?: string;
  readonly currency?: string;
}

export interface DartIssuanceRow {
  /** 주식발행·감소 일자. '2025년 03월 14일' / '2025-03-14' 등 표기가 섞인다 */
  readonly isu_dcrs_de: string;
  /** 발행·감소 형태. '주식분할' / '무상증자' / '유상증자(주주배정)' / '주식병합' 등 */
  readonly isu_dcrs_stle: string;
  /** 발행·감소 주식 종류. 예전 픽스처·일부 구형 응답에는 없을 수 있다. */
  readonly isu_dcrs_stock_knd?: string;
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
 *
 * 쉼표 없는 순수 숫자(`9251406000000`)를 반드시 허용한다 — fnlttSinglAcntAll 의
 * 실제 금액 형식이다. 쉼표 묶음만 허용했던 검증이 실제 응답의 전 계정을 gap 으로
 * 버려 재무 팩트가 저장소에 거의 남지 않았다 (운영 장애 2026-08-10).
 * 쉼표를 쓰려면 세 자리 묶음이 완전해야 한다('12,34,567' 은 여전히 거부).
 */
const AMOUNT_PATTERN = /^-?(\d{1,3}(,\d{3})*|\d+)(\.\d+)?$/;

export function parseAmount(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed === "") return null;

  const hasOpenParen = trimmed.startsWith("(");
  const hasCloseParen = trimmed.endsWith(")");
  if (hasOpenParen !== hasCloseParen) return null; // 괄호가 한쪽만 있으면 형식 오류
  const negative = hasOpenParen;

  const inner = negative ? trimmed.slice(1, -1) : trimmed;
  if (inner.includes("(") || inner.includes(")")) return null; // 괄호가 양끝이 아닌 곳에 있으면 형식 오류
  if (!AMOUNT_PATTERN.test(inner)) return null;

  const value = Number(inner.replace(/,/g, ""));
  if (!Number.isFinite(value)) return null;
  return negative ? -Math.abs(value) : value;
}

/**
 * `Date.parse` 는 '2025-02-30' 같은 존재하지 않는 날짜를 조용히 다음 달로
 * 굴려버린다(→ 3월 2일). 굴러간 결과의 연/월/일이 입력과 다르면 애초에 유효한
 * 달력 날짜가 아니었다는 뜻이므로 null 로 되돌린다 — 틀린 날짜로 asOf 나
 * periodKey 를 만드는 것보다 gap 이 낫다.
 */
function isCalendarDateValid(
  utcMs: number,
  year: string,
  month: string,
  day: string,
): boolean {
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
  const [, year, month, day] = match as unknown as [
    string,
    string,
    string,
    string,
  ];
  const utcMidnight = Date.parse(`${year}-${month}-${day}T00:00:00Z`);
  if (
    Number.isNaN(utcMidnight) ||
    !isCalendarDateValid(utcMidnight, year, month, day)
  ) {
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
export function normalizeDateKey(raw: string): string | null {
  const match = /(\d{4})\D+(\d{1,2})\D+(\d{1,2})/.exec(raw.trim());
  if (!match) return null;
  const [, year, month, day] = match as unknown as [
    string,
    string,
    string,
    string,
  ];
  const key = `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
  const parsedMs = Date.parse(`${key}T00:00:00Z`);
  if (
    Number.isNaN(parsedMs) ||
    !isCalendarDateValid(parsedMs, year, month, day)
  ) {
    return null;
  }
  return key;
}

function isReportCode(value: string): value is DartReportCode {
  return value in REPORT_CODE_TO_QUARTER;
}

/**
 * 응답 행에서 문자열 필드를 읽는다. 필드 이름이 바뀌었거나 값이 문자열이 아니면 null.
 *
 * 이 파일이 다루는 DART 필드 이름은 **API 키 발급 후 실제 응답으로 검증해 조정한다** 고
 * 명시되어 있다 — 즉 이름이 어긋난 첫 실행이 가장 있을 법한 결과다. 그 상태에서
 * `.replace`/`.trim` 을 바로 부르면 영어 bare TypeError 가 올라가 수집 전체가 죽는다.
 * dart-fact-source.ts 가 `se`·`istc_totqy` 에 이미 세워둔 방어선("bare TypeError 로
 * 전체 수집이 죽지 않게")을 이 파서의 필드에도 같은 모양으로 세운다 — 어긋난 필드는
 * 예외가 아니라 그 필드 이름을 밝히는 gap 이 된다.
 */
function readString(row: unknown, field: string): string | null {
  if (typeof row !== "object" || row === null) return null;
  const value = (row as Record<string, unknown>)[field];
  return typeof value === "string" ? value : null;
}

/** 분기 하나의 손익 누적값 — 어느 보고서(행)에서 왔는지 asOf 도 함께 들고 다닌다 */
interface CumulativePoint {
  readonly value: number;
  readonly asOfTsMs: number;
}

interface BalancePoint extends CumulativePoint {
  readonly row: DartFinancialRow;
}

function combineBalancePoints(
  symbol: string,
  periodKey: string,
  field: FundamentalField,
  points: readonly BalancePoint[],
  sections: BalanceSections,
  gaps: FactIngestionGap[],
): CumulativePoint | undefined {
  const first = points[0];
  if (first === undefined) return undefined;
  const canPartition = points.every(point => sections.section(point.row, field) !== undefined);
  const groups = new Map<string, BalancePoint[]>();
  for (const point of points) {
    const key = canPartition ? sections.section(point.row, field)! : "UNKNOWN";
    groups.set(key, [...(groups.get(key) ?? []), point]);
  }
  let sum = 0;
  let conflict = false;
  for (const group of groups.values()) {
    const base = group[0]!;
    const selected = sections.reconcileWithinSection(group.map(point => point.row), field);
    if (selected !== null) {
      // 원문에서 확인한 총액·상세 산식만 선택하며 원본 행과 기존 오류는 보존한다.
      sum += group.filter(point => selected.includes(point.row)).reduce((total, point) => total + point.value, 0);
      continue;
    }
    if (sections.canAddWithinSection(group.map(point => point.row), field)) {
      sum += group.reduce((total, point) => total + point.value, 0);
      continue;
    }
    sum += base.value;
    for (const point of group.slice(1)) {
      if (base.value === point.value && base.row.rcept_no === point.row.rcept_no &&
          typeof base.row.ord === "string" && /^\d+$/.test(base.row.ord) && Number.isSafeInteger(Number(base.row.ord)) &&
          base.row.ord === point.row.ord && base.row.currency === point.row.currency &&
          base.row.account_detail === point.row.account_detail &&
          normalizeDartAccountId(base.row.account_id) === normalizeDartAccountId(point.row.account_id) &&
          base.row.account_nm.replace(/\s/g, "") === point.row.account_nm.replace(/\s/g, "") &&
          sections.label(base.row) === sections.label(point.row)) continue;
      const describe = (row: DartFinancialRow) =>
        `${row.account_nm} [${row.account_id}, ord=${row.ord ?? "없음"}, 구간=${sections.label(row) ?? "미확인"}]`;
      gaps.push({
        symbol, periodKey, field, asOfTsMs: point.asOfTsMs,
        reason: `같은 보고서 안에서 ${field} ${base.value === point.value ? "동일 금액의 중복 범위를 확인할 수 없습니다" : "값이 서로 다릅니다"} (${base.value} vs ${point.value}); 합산 근거 미확인: ${describe(base.row)} / ${describe(point.row)}`,
        severity: "BLOCKING", kind: "CONFLICT",
      });
      conflict = true;
    }
  }
  // 실제 충돌은 종전처럼 최초 값과 차단 gap을 함께 남긴다. 검증된 구간만 합산한다.
  return conflict ? first : { value: sum, asOfTsMs: first.asOfTsMs };
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
  const cumulative = new Map<FundamentalField, Map<number, CumulativePoint>>();
  /** report → bsns_year — 분기 간 사업연도가 섞여 차분되는 것을 막는다 */
  const yearByReport = new Map<DartReportCode, string>();

  for (const report of REPORT_ORDER) {
    const rows = rowsByReport.get(report);
    if (!rows || rows.length === 0) continue;
    const quarter = REPORT_CODE_TO_QUARTER[report];
    const year = rows[0]?.bsns_year ?? "";
    const periodKey = `${year}Q${quarter}`;
    yearByReport.set(report, year);

    const sections = analyzeBalanceSections(rows, parseAmount);
    const balancePoints = new Map<FundamentalField, BalancePoint[]>();
    const invalidBalanceFields = new Set<FundamentalField>();

    for (const row of rows) {
      // row.reprt_code 가 버킷 키(report)와 다르면 호출자가 잘못 묶은 것이다 —
      // 엉뚱한 분기로 계상하는 대신 gap 으로 남긴다. asOf 를 구하기 전에 확인한다.
      if (!isReportCode(row.reprt_code) || row.reprt_code !== report) {
        gaps.push({
          symbol,
          periodKey,
          reason: `보고서 코드가 일치하지 않습니다: ${row.reprt_code} (기대값 ${report})`,
          severity: "BLOCKING",
          kind: "INVALID",
        });
        continue;
      }

      // 버킷의 기준 연도(rows[0].bsns_year)와 다른 사업연도 행이 섞이면 엉뚱한
      // 분기로 표기되므로 gap 으로 남긴다
      if (row.bsns_year !== year) {
        gaps.push({
          symbol,
          periodKey,
          reason: `행의 사업연도가 버킷 기준 연도와 다릅니다: ${row.bsns_year} vs ${year}, ${readString(row, "account_nm") ?? "계정명 없음"}`,
          severity: "BLOCKING",
          kind: "INVALID",
        });
        continue;
      }

      // CF·SCE 등 이 파서가 소비하지 않는 재무제표는 의도된 제외다 — 매핑 여부와
      // 무관하게 gap 을 남기지 않는다 (그렇지 않으면 보고서마다 무관한 계정 수백
      // 개가 '매핑되지 않은 계정' gap 노이즈를 만든다)
      if (!CONSUMED_STATEMENTS.has(row.sj_div)) continue;

      // asOf 는 행 단위로 구한다 — 정정공시 등으로 버킷 안에 rcept_no 가 섞일 수
      // 있어 rows[0] 하나만 대표로 쓰면 다른 행의 asOf 를 잘못 물려받는다
      const rceptNo = readString(row, "rcept_no");
      if (rceptNo === null) {
        gaps.push({
          symbol,
          periodKey,
          reason: "응답 필드를 읽을 수 없습니다: rcept_no",
          severity: "BLOCKING",
          kind: "INVALID",
        });
        continue;
      }
      const asOf = receiptDateToAsOfTsMs(rceptNo);
      if (asOf === null) {
        gaps.push({
          symbol,
          periodKey,
          reason: `접수번호를 읽을 수 없습니다: ${rceptNo}`,
          severity: "BLOCKING",
          kind: "INVALID",
        });
        continue;
      }

      // account_id·account_nm 은 resolveAccount 안에서 .trim()/.replace() 를 타므로
      // 여기서 문자열임을 확인한다 — 이름이 바뀐 필드는 gap 이지 예외가 아니다
      const accountId = readString(row, "account_id");
      const accountName = readString(row, "account_nm");
      if (accountId === null || accountName === null) {
        gaps.push({
          symbol,
          periodKey,
          reason: `응답 필드를 읽을 수 없습니다: ${accountId === null ? "account_id" : "account_nm"}`,
          asOfTsMs: asOf,
          severity: "BLOCKING",
          kind: "INVALID",
        });
        continue;
      }

      const resolved = resolveAccount(accountId, accountName);
      const rule = resolved?.statement === "BS"
        ? { ...resolved, field: sections.field(row, resolved.field) }
        : resolved;
      if (!rule) {
        gaps.push({
          symbol,
          periodKey,
          reason: `매핑되지 않은 계정: ${accountName} (${accountId})`,
          severity: "INFORMATIONAL",
        });
        continue;
      }

      const statementMatches =
        rule.statement === "BS"
          ? row.sj_div === "BS"
          : row.sj_div === "IS" || row.sj_div === "CIS";
      if (!statementMatches) {
        gaps.push({
          symbol,
          periodKey,
          field: rule.field,
          asOfTsMs: asOf,
          reason: `계정 유형이 일치하지 않습니다: ${accountName} (sj_div=${row.sj_div}, 기대값=${rule.statement})`,
          severity: "BLOCKING",
          kind: "INVALID",
        });
        continue;
      }

      if (rule.statement === "BS") {
        const rawAmount = readString(row, "thstrm_amount");
        const amount = rawAmount === null ? null : parseAmount(rawAmount);
        if (amount === null) {
          invalidBalanceFields.add(rule.field);
          gaps.push({
            symbol,
            periodKey,
            field: rule.field,
            asOfTsMs: asOf,
            reason:
              `금액을 읽을 수 없습니다: ${accountName}` +
              (rawAmount === null ? " (thstrm_amount 필드 확인)" : ""),
            severity: "BLOCKING",
            kind: rawAmount !== null && ["", "-"].includes(rawAmount.trim()) ? "MISSING" : "INVALID",
          });
          continue;
        }
        const points = balancePoints.get(rule.field) ?? [];
        points.push({ row, value: amount, asOfTsMs: asOf });
        balancePoints.set(rule.field, points);
        continue;
      }

      // IS/CIS — 누적값을 모아두고 아래에서 차분한다. thstrm_add_amount 가 빈
      // 문자열인 제출사도 있어 '있으면 쓴다' 가 아니라 '내용이 있으면 쓴다' 로 판단한다
      const addAmount = readString(row, "thstrm_add_amount");
      const cumulativeRaw = addAmount?.trim()
        ? addAmount
        : readString(row, "thstrm_amount");
      const amount = cumulativeRaw === null ? null : parseAmount(cumulativeRaw);
      if (amount === null) {
        gaps.push({
          symbol,
          periodKey,
          field: rule.field,
          asOfTsMs: asOf,
          reason:
            `금액을 읽을 수 없습니다: ${accountName}` +
            (cumulativeRaw === null ? " (thstrm_amount 필드 확인)" : ""),
          severity: "BLOCKING",
          kind: cumulativeRaw !== null && ["", "-"].includes(cumulativeRaw.trim()) ? "MISSING" : "INVALID",
        });
        continue;
      }
      const byQuarter =
        cumulative.get(rule.field) ?? new Map<number, CumulativePoint>();
      const existing = byQuarter.get(quarter);
      if (existing !== undefined) {
        if (existing.value !== amount) {
          gaps.push({
            symbol,
            periodKey,
            field: rule.field,
            asOfTsMs: asOf,
            reason: `같은 보고서 안에서 ${rule.field} 누적값이 서로 다릅니다 (${existing.value} vs ${amount})`,
            severity: "BLOCKING",
            kind: "CONFLICT",
          });
        }
        continue;
      }
      byQuarter.set(quarter, { value: amount, asOfTsMs: asOf });
      cumulative.set(rule.field, byQuarter);
    }
    for (const [field, points] of balancePoints) {
      const combined = combineBalancePoints(symbol, periodKey, field, points, sections, gaps);
      // 일부 구간이 결측이면 나머지만 전사 합계로 저장하지 않는다.
      // 유효 행끼리의 실제 충돌은 결측과 함께 있어도 차단 gap으로 남긴다.
      if (invalidBalanceFields.has(field)) continue;
      if (combined === undefined) continue;
      facts.push({ scope: "SYMBOL", key: symbol, field, periodKey,
        asOfTsMs: combined.asOfTsMs, value: combined.value, unit: "KRW" });
    }
  }

  for (const [field, byQuarter] of cumulative) {
    for (const report of REPORT_ORDER) {
      const quarter = REPORT_CODE_TO_QUARTER[report];
      const current = byQuarter.get(quarter);
      if (current === undefined) continue;

      const year = yearByReport.get(report) ?? "";
      const periodKey = `${year}Q${quarter}`;

      if (quarter === 1) {
        facts.push({
          scope: "SYMBOL",
          key: symbol,
          field,
          periodKey,
          asOfTsMs: current.asOfTsMs,
          value: current.value,
          unit: "KRW",
        });
        continue;
      }

      const previous = byQuarter.get(quarter - 1);
      if (previous === undefined) {
        gaps.push({
          symbol,
          periodKey,
          field,
          asOfTsMs: current.asOfTsMs,
          reason: `직전 분기 누적값이 없어 ${field} 단독값을 만들 수 없습니다`,
          severity: "BLOCKING",
          kind: "MISSING",
        });
        continue;
      }

      // 전기 누적값이 다른 사업연도에서 온 것이면(버킷 배정 오류) 차분하지 않는다
      const previousReport = REPORT_ORDER[quarter - 2];
      const previousYear =
        previousReport !== undefined
          ? yearByReport.get(previousReport)
          : undefined;
      if (previousYear === undefined || previousYear !== year) {
        gaps.push({
          symbol,
          periodKey,
          field,
          asOfTsMs: current.asOfTsMs,
          reason: `직전 분기가 다른 사업연도입니다 (${previousYear ?? "알수없음"} → ${year}) — ${field} 단독값을 만들 수 없습니다`,
          severity: "BLOCKING",
          kind: "INVALID",
        });
        continue;
      }

      facts.push({
        scope: "SYMBOL",
        key: symbol,
        field,
        periodKey,
        asOfTsMs: current.asOfTsMs,
        value: current.value - previous.value,
        unit: "KRW",
      });
    }
  }

  return { facts, gaps };
}

type CapitalChangeDirection = "INCREASE" | "DECREASE" | "SKIP";
type PriceActionDirection = Exclude<CapitalChangeDirection, "SKIP">;

export interface IssuanceParsingOptions {
  /** 분기 주식수 snapshot이 DART의 모호한 '주식분할' 증감 방향을 입증한 경우만 덮는다. */
  readonly directionForRow?: (
    row: DartIssuanceRow,
  ) => PriceActionDirection | undefined;
}

// 기존 주주의 보유 수량은 바꾸지 않지만 이후 사건의 발행주식수 분모에는 반영한다.
const NON_HOLDER_INCREASE = [
  "유상증자",
  "전환권행사",
  "현물출자",
  "출자전환",
  "신주인수권행사",
  "주식매수선택권행사",
  "합병",
];
const NON_HOLDER_DECREASE = ["소각", "상환"];

function normalizedStyle(row: DartIssuanceRow): string | null {
  return readString(row, "isu_dcrs_stle")?.replace(/\s/g, "") ?? null;
}

function isCommonIssuanceRow(row: DartIssuanceRow): boolean {
  const kind = readString(row, "isu_dcrs_stock_knd");
  return kind === null || kind.replace(/\s/g, "").includes("보통");
}

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
  if (style.includes("유상")) return "SKIP";
  if (style.includes("병합") || style.includes("감자")) return "DECREASE";
  if (
    style.includes("분할") ||
    style.includes("무상") ||
    style.includes("주식배당")
  )
    return "INCREASE";
  if (NON_HOLDER_INCREASE.some((token) => style.includes(token))) return "SKIP";
  if (NON_HOLDER_DECREASE.some((token) => style.includes(token))) return "SKIP";
  return null;
}

export interface IssuedShareChange {
  readonly dateKey: string;
  /** null이면 날짜는 알지만 발행주식수 증감을 재생할 수 없는 행이다. */
  readonly delta: number | null;
}

/** 분기 스냅샷 이후의 모든 보통주 발행·감소를 다음 이벤트의 분모에 재생한다. */
export function issuedShareChange(
  row: DartIssuanceRow,
  directionOverride?: PriceActionDirection,
): IssuedShareChange | null {
  if (!isCommonIssuanceRow(row)) return null;
  const rawDate = readString(row, "isu_dcrs_de");
  if (rawDate === null) return null;
  const dateKey = normalizeDateKey(rawDate);
  if (dateKey === null) return null;

  const style = normalizedStyle(row);
  const rawQuantity = readString(row, "isu_dcrs_qy");
  const quantity = rawQuantity === null ? null : parseAmount(rawQuantity);
  if (
    style === null ||
    classifyCapitalChange(style) === null ||
    quantity === null ||
    quantity <= 0
  ) {
    return { dateKey, delta: null };
  }
  const decrease =
    directionOverride === "DECREASE" ||
    (directionOverride === undefined &&
      (style.includes("병합") ||
        style.includes("감자") ||
        style.includes("소각") ||
        style.includes("상환")));
  return { dateKey, delta: decrease ? -quantity : quantity };
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
 * `sharesBefore` 는 분기 기준일 이후의 중간 발행·감소까지 재생한 이벤트 직전
 * 발행주식수를 준다.
 */
export function parseIssuanceRows(
  symbol: string,
  rows: readonly DartIssuanceRow[],
  sharesBefore: (dateKey: string, row: DartIssuanceRow) => number | null,
  options: IssuanceParsingOptions = {},
): ParsedFinancials {
  const facts: Fact[] = [];
  const gaps: FactIngestionGap[] = [];

  for (const row of rows) {
    if (!isCommonIssuanceRow(row)) continue;
    // 필드 이름이 어긋난 첫 실행에서 bare TypeError 로 수집 전체가 죽지 않게 한다
    // (readString 주석 참고). 날짜부터 읽는 이유: gap 의 periodKey 에 쓰인다.
    const rawDate = readString(row, "isu_dcrs_de");
    const gapPeriodKey = rawDate ?? "-";

    const rawStyle = readString(row, "isu_dcrs_stle");
    // DART가 누적 표의 첫 줄에 넣는 '-/-'는 상장 전·표 시작 시점의 기준 주식수다.
    // 증감 사건이 아니므로 발행형태 미분류 gap으로 만들지 않는다.
    if (rawDate?.trim() === "-" && rawStyle?.trim() === "-") continue;

    if (rawStyle === null) {
      gaps.push({
        symbol,
        periodKey: gapPeriodKey,
        reason: "응답 필드를 읽을 수 없습니다: isu_dcrs_stle (발행형태)",
        severity: "BLOCKING",
      });
      continue;
    }
    const style = rawStyle.replace(/\s/g, "");
    const direction =
      options.directionForRow?.(row) ?? classifyCapitalChange(style);

    if (direction === null) {
      gaps.push({
        symbol,
        periodKey: gapPeriodKey,
        reason: `분류할 수 없는 발행형태: ${rawStyle}`,
        severity: "BLOCKING",
      });
      continue;
    }
    // 유상증자·유상감자는 현금이 오간 것이라 의도된 제외다 — gap 을 남기지 않는다
    if (direction === "SKIP") continue;

    if (rawDate === null) {
      gaps.push({
        symbol,
        periodKey: gapPeriodKey,
        reason: "응답 필드를 읽을 수 없습니다: isu_dcrs_de (자본변동 일자)",
        severity: "BLOCKING",
      });
      continue;
    }
    const dateKey = normalizeDateKey(rawDate);
    if (dateKey === null) {
      gaps.push({
        symbol,
        periodKey: rawDate,
        reason: `자본변동 일자를 읽을 수 없습니다: ${rawDate}`,
        severity: "BLOCKING",
      });
      continue;
    }

    const rawQuantity = readString(row, "isu_dcrs_qy");
    if (rawQuantity === null) {
      gaps.push({
        symbol,
        periodKey: dateKey,
        reason: "응답 필드를 읽을 수 없습니다: isu_dcrs_qy (변동 수량)",
        severity: "BLOCKING",
      });
      continue;
    }
    const quantity = parseAmount(rawQuantity);
    if (quantity === null || quantity <= 0) {
      gaps.push({
        symbol,
        periodKey: dateKey,
        reason: `변동 수량을 읽을 수 없습니다: ${rawQuantity}`,
        severity: "BLOCKING",
      });
      continue;
    }

    const prior = sharesBefore(dateKey, row);
    if (prior === null || prior <= 0) {
      gaps.push({
        symbol,
        periodKey: dateKey,
        reason:
          "이벤트 직전 발행주식수를 알 수 없어 보정 비율을 만들 수 없습니다",
        severity: "BLOCKING",
      });
      continue;
    }

    const afterShares =
      direction === "DECREASE" ? prior - quantity : prior + quantity;
    const ratio = afterShares / prior;
    if (!Number.isFinite(ratio) || ratio <= 0) {
      gaps.push({
        symbol,
        periodKey: dateKey,
        reason: `보정 비율이 유효하지 않습니다: ${ratio}`,
        severity: "BLOCKING",
      });
      continue;
    }

    const rceptNo = readString(row, "rcept_no");
    if (rceptNo === null) {
      gaps.push({
        symbol,
        periodKey: dateKey,
        reason: "응답 필드를 읽을 수 없습니다: rcept_no (접수번호)",
        severity: "BLOCKING",
      });
      continue;
    }
    const asOf = receiptDateToAsOfTsMs(rceptNo);
    if (asOf === null) {
      gaps.push({
        symbol,
        periodKey: dateKey,
        reason: `접수번호를 읽을 수 없습니다: ${rceptNo}`,
        severity: "BLOCKING",
      });
      continue;
    }

    facts.push({
      scope: "SYMBOL",
      key: symbol,
      field: CORPORATE_ACTION_FIELD,
      periodKey: dateKey,
      asOfTsMs: asOf,
      value: ratio,
      unit: "RATIO",
      corporateActionBeforeShares: prior,
      corporateActionAfterShares: afterShares,
    });
  }

  return { facts, gaps };
}
