import type { FundamentalField } from '../../../../../runtime/modules/facts/domain/fact.js';
import { normalizeDartAccountId, resolveAccount } from './dart-account-map.js';
import type { DartFinancialRow } from './dart-report-parser.js';

/** 검증된 상세 행 관계만 접고 원본 행과 다른 부채 필드는 보존한다. */
export function reconcileBorrowingRows(
  ordered: readonly DartFinancialRow[],
  candidates: readonly DartFinancialRow[],
  field: FundamentalField,
  section: (row: DartFinancialRow, field: FundamentalField) => string | undefined,
  parseAmount: (raw: string) => number | null,
): readonly DartFinancialRow[] | null {
  if (candidates.length !== 2 || (field !== 'LONG_TERM_BORROWINGS' && field !== 'SHORT_TERM_BORROWINGS')) return null;
  const isLong = field === 'LONG_TERM_BORROWINGS';
  const targetSection = isLong ? 'NONCURRENT_LIABILITIES' : 'CURRENT_LIABILITIES';
  const parent = candidates.find(row => typeof row.account_id === 'string' &&
    (isLong ? normalizeDartAccountId(row.account_id) === 'dart_LongTermBorrowingsGross' :
      ['dart_ShortTermBorrowings', 'ifrs-full_ShorttermBorrowings'].includes(normalizeDartAccountId(row.account_id))));
  const child = candidates.find(row => typeof row.account_id === 'string' && row.account_id.trim() === '-표준계정코드 미사용-');
  if (!parent || !child || parent === child || typeof parent.account_nm !== 'string' || typeof child.account_nm !== 'string') return null;
  const name = isLong ? '장기차입금' : '단기차입금';
  if (parent.account_nm.replace(/\s/g, '') !== name || child.account_nm.replace(/\s/g, '') !== name) return null;
  const index = ordered.indexOf(parent);
  if (index < 0 || ordered[index + 1] !== child) return null;
  const component = ordered[index + 2];
  if (!component || typeof component.account_id !== 'string' || component.account_id.trim() !== '-표준계정코드 미사용-' ||
      typeof component.account_nm !== 'string') return null;
  const componentName = isLong ? '(장기차입금현재가치할인차금)' : '유동성장기부채';
  if (component.account_nm.replace(/\s/g, '') !== componentName ||
      [parent, child, component].some(row => section(row, field) !== targetSection)) return null;
  // 금액이 깨진 추가 후보도 빠뜨리지 않는다. 다른 구간에 같은 후보가 있어도 보수적으로 차단한다.
  const relevant = ordered.filter(row => {
    if (typeof row.account_nm !== 'string' || typeof row.account_id !== 'string') return false;
    if (isLong && row.account_nm.replace(/\s/g, '') === componentName) return true;
    const mapped = resolveAccount(row.account_id, row.account_nm);
    return mapped?.field === field || (!isLong && mapped?.field === 'CURRENT_LONG_TERM_DEBT');
  });
  if (relevant.length !== 3 || !relevant.includes(parent) || !relevant.includes(child) || !relevant.includes(component)) return null;
  const amount = (row: DartFinancialRow): number | null => {
    const value = typeof row.thstrm_amount === 'string' ? parseAmount(row.thstrm_amount) : null;
    return value !== null && Number.isSafeInteger(value) && value > 0 ? value : null;
  };
  const parentAmount = amount(parent), childAmount = amount(child), componentAmount = amount(component);
  if (parentAmount === null || childAmount === null || componentAmount === null) return null;
  const calculated = isLong ? childAmount - componentAmount : childAmount + componentAmount;
  if (!Number.isSafeInteger(calculated) || parentAmount !== calculated) return null;
  return [isLong ? parent : child];
}
