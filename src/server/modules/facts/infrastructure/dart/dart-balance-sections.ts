import type { FundamentalField } from "../../../../../runtime/modules/facts/domain/fact.js";
import { normalizeDartAccountId } from "./dart-account-map.js";
import type { DartFinancialRow } from "./dart-report-parser.js";

type Section = "CURRENT_ASSETS" | "NONCURRENT_ASSETS" | "FINANCIAL_ASSETS"
  | "CURRENT_LIABILITIES" | "NONCURRENT_LIABILITIES" | "FINANCIAL_LIABILITIES";
type Boundary = Section | "ASSETS" | "LIABILITIES" | "OTHER";

const BY_ID: Readonly<Record<string, Boundary>> = {
  "ifrs-full_CurrentAssets": "CURRENT_ASSETS",
  "ifrs-full_NoncurrentAssets": "NONCURRENT_ASSETS",
  "ifrs-full_Assets": "ASSETS",
  "ifrs-full_CurrentLiabilities": "CURRENT_LIABILITIES",
  "ifrs-full_NoncurrentLiabilities": "NONCURRENT_LIABILITIES",
  "ifrs-full_Liabilities": "LIABILITIES",
  "ifrs-full_Equity": "OTHER",
  "ifrs-full_EquityAndLiabilities": "OTHER",
  "ifrs-full_EquityAttributableToOwnersOfParent": "OTHER",
  "ifrs-full_NoncontrollingInterests": "OTHER",
};
const BY_NAME: Readonly<Record<string, Boundary>> = {
  유동자산: "CURRENT_ASSETS", 비유동자산: "NONCURRENT_ASSETS", 금융업자산: "FINANCIAL_ASSETS",
  자산총계: "ASSETS", 유동부채: "CURRENT_LIABILITIES", 비유동부채: "NONCURRENT_LIABILITIES",
  금융업부채: "FINANCIAL_LIABILITIES", 부채총계: "LIABILITIES",
  자본총계: "OTHER", 자본과부채총계: "OTHER", 부채와자본총계: "OTHER",
  지배기업주주지분: "OTHER", 비지배지분: "OTHER",
};
const ASSET_FIELDS = new Set<FundamentalField>(["CASH_AND_EQUIVALENTS", "TANGIBLE_ASSETS", "SHORT_TERM_INVESTMENTS"]);
const DEBT_FIELDS = new Set<FundamentalField>(["BONDS", "SHORT_TERM_BORROWINGS", "LONG_TERM_BORROWINGS", "CURRENT_LONG_TERM_DEBT"]);

function boundary(row: DartFinancialRow): Boundary | undefined {
  if (typeof row.account_id !== "string" || typeof row.account_nm !== "string") return undefined;
  const name = row.account_nm.replace(/\s/g, "").replace(/^[ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩIVX\d.()]+/, "");
  return BY_ID[normalizeDartAccountId(row.account_id)] ?? BY_NAME[name];
}

export interface BalanceSections {
  /** 총계와 대조하여 서로 겹치지 않음이 확인된 구간만 반환한다. */
  section(row: DartFinancialRow, field: FundamentalField): Section | undefined;
  label(row: DartFinancialRow): Section | undefined;
  field(row: DartFinancialRow, field: FundamentalField): FundamentalField;
  canAddWithinSection(rows: readonly DartFinancialRow[], field: FundamentalField): boolean;
}

/**
 * DART의 평탄한 행 목록은 표준 태그만으로 합계·구성 요소를 구별할 수 없다.
 * 동일 접수·통화의 명시적 구간, ord, 소계의 합=총계가 모두 확인될 때만 합산한다.
 * 총계는 구간 앞/뒤/사이에 올 수 있으므로 위치와 무관하게 대조한다.
 */
export function analyzeBalanceSections(
  rows: readonly DartFinancialRow[],
  parseAmount: (raw: string) => number | null,
): BalanceSections {
  const sectionByRow = new Map<DartFinancialRow, Section>();
  const proven = new Set<Section>();
  const children = new Map<Section, DartFinancialRow[]>();
  const headers = new Map<Boundary, DartFinancialRow[]>();
  const bs = rows.filter(row => row.sj_div === "BS");
  const first = bs[0];
  const orders = bs.map(row => typeof row.ord === "string" && /^\d+$/.test(row.ord) ? Number(row.ord) : NaN);
  const valid = first !== undefined && bs.every((row, index) =>
    row.rcept_no === first.rcept_no && row.bsns_year === first.bsns_year && row.reprt_code === first.reprt_code &&
    (row.currency === undefined || row.currency === "KRW") &&
    (row.account_detail === undefined || row.account_detail === "-" || row.account_detail === "") &&
    Number.isSafeInteger(orders[index])) && new Set(orders).size === orders.length;
  const amount = (row: DartFinancialRow | undefined): number | null => {
    const value = typeof row?.thstrm_amount === "string" ? parseAmount(row.thstrm_amount) : null;
    return value !== null && Number.isSafeInteger(value) && value >= 0 ? value : null;
  };
  if (valid) {
    let active: Section | undefined;
    for (const row of [...bs].sort((a, b) => Number(a.ord) - Number(b.ord))) {
      const kind = boundary(row);
      if (kind !== undefined) {
        headers.set(kind, [...(headers.get(kind) ?? []), row]);
        active = kind === "ASSETS" || kind === "LIABILITIES" || kind === "OTHER" ? undefined : kind;
      } else if (active !== undefined) {
        sectionByRow.set(row, active);
        children.set(active, [...(children.get(active) ?? []), row]);
      }
    }
    for (const side of ["ASSETS", "LIABILITIES"] as const) {
      const sections: Section[] = [`CURRENT_${side}`, `NONCURRENT_${side}`];
      if (headers.has(`FINANCIAL_${side}`)) sections.push(`FINANCIAL_${side}`);
      const total = headers.get(side);
      if (total?.length !== 1 || sections.some(section => headers.get(section)?.length !== 1)) continue;
      const values = sections.map(section => amount(headers.get(section)?.[0]));
      const sum = values.reduce<number>((acc, value) => acc + (value ?? 0), 0);
      if (values.some(value => value === null) || !Number.isSafeInteger(sum) || sum !== amount(total[0])) continue;
      for (const section of sections) proven.add(section);
    }
  }
  const section = (row: DartFinancialRow, field: FundamentalField): Section | undefined => {
    const value = sectionByRow.get(row);
    if (value === undefined || !proven.has(value)) return undefined;
    const component = amount(row);
    const subtotal = amount(headers.get(value)?.[0]);
    if (component === null || subtotal === null || component > subtotal) return undefined;
    return (value.endsWith("ASSETS") ? ASSET_FIELDS : DEBT_FIELDS).has(field) ? value : undefined;
  };
  return {
    section,
    label: row => sectionByRow.get(row),
    field(row, field) {
      // 유동부채 아래 '장기차입금'으로 표시된 현재 만기분은 비유동 차입금과 구별한다.
      if (field === "LONG_TERM_BORROWINGS" && proven.has("CURRENT_LIABILITIES") && sectionByRow.get(row) === "CURRENT_LIABILITIES" &&
          normalizeDartAccountId(row.account_id) === "ifrs-full_CurrentBorrowingsAndCurrentPortionOfNoncurrentBorrowings" &&
          row.account_nm.replace(/\s/g, "") === "장기차입금") return "CURRENT_LONG_TERM_DEBT";
      return field;
    },
    canAddWithinSection(candidates, field) {
      // 단기차입금과 '유동 차입금'을 별도 행으로 공시한 사례: 모든 구성 금액이
      // 유동부채 소계와 정확히 일치해야만 둘을 더한다. 같은 이름의 중복은 허용하지 않는다.
      if (field !== "SHORT_TERM_BORROWINGS" || candidates.length !== 2 ||
          candidates.some(row => section(row, field) !== "CURRENT_LIABILITIES")) return false;
      const names = candidates.map(row => row.account_nm.replace(/\s/g, ""));
      if (!names.includes("단기차입금") || !names.includes("유동차입금") ||
          !candidates.some(row => row.account_nm.replace(/\s/g, "") === "유동차입금" &&
            normalizeDartAccountId(row.account_id) === "ifrs-full_ShorttermBorrowings")) return false;
      const values = (children.get("CURRENT_LIABILITIES") ?? []).map(amount);
      const sum = values.reduce<number>((acc, value) => acc + (value ?? 0), 0);
      return values.length > 0 && values.every(value => value !== null) && Number.isSafeInteger(sum) &&
        sum === amount(headers.get("CURRENT_LIABILITIES")?.[0]);
    },
  };
}
