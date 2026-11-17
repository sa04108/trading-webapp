import { describe, expect, it } from 'vitest';
import { normalizeDartAccountId, resolveAccount } from '../../src/server/modules/facts/infrastructure/dart/dart-account-map.js';

describe('DART 순이익·자본총계 계정 mapping', () => {
  it.each([
    ['ifrs-full_ProfitLoss', '무관한 계정명', { field: 'NET_INCOME', statement: 'IS' }],
    ['ifrs-full_Equity', '무관한 계정명', { field: 'TOTAL_EQUITY', statement: 'BS' }],
    ['', '당기순이익', { field: 'NET_INCOME', statement: 'IS' }],
    ['', '당기순이익(손실)', { field: 'NET_INCOME', statement: 'IS' }],
    ['', '자본총계', { field: 'TOTAL_EQUITY', statement: 'BS' }],
  ])('%s / %s를 올바른 재무 계정으로 매핑한다', (accountId, accountName, expected) => {
    expect(resolveAccount(accountId, accountName)).toEqual(expected);
  });

  it('정확한 account ID가 이름 fallback보다 우선한다', () => {
    expect(resolveAccount('ifrs-full_Equity', '당기순이익')).toEqual({
      field: 'TOTAL_EQUITY',
      statement: 'BS',
    });
  });

  it('과거 IFRS 접두사를 정규화하고 귀속 순이익은 제외한다', () => {
    expect(normalizeDartAccountId(' ifrs_CurrentAssets ')).toBe('ifrs-full_CurrentAssets');
    expect(normalizeDartAccountId('ifrs-full_Equity')).toBe('ifrs-full_Equity');
    expect(resolveAccount('ifrs_CurrentAssets', '무관')).toEqual({ field: 'CURRENT_ASSETS', statement: 'BS' });
    expect(resolveAccount('ifrs_ProfitLossAttributableToOwnersOfParent', '당기순이익')).toBeNull();
    expect(resolveAccount('ifrs_ProfitLossAttributableToNoncontrollingInterests', '당기순이익')).toBeNull();
    expect(resolveAccount('ifrs_ProfitLoss', '계속영업당기순이익')).toBeNull();
  });

  it.each([
    ['ifrs-full_LongtermBorrowings', '유동성장기부채', 'CURRENT_LONG_TERM_DEBT'],
    ['ifrs-full_ShorttermBorrowings', '유동성장기차입금', 'CURRENT_LONG_TERM_DEBT'],
    ['ifrs_ShorttermBorrowings', '유동성장기차입금 및 유동성사채', 'CURRENT_LONG_TERM_DEBT'],
    ['ifrs-full_LongtermBorrowings', '사채', 'BONDS'],
    ['dart_LongTermBorrowingsGross', '사채', 'BONDS'],
    ['dart_CurrentPortionOfBonds', '무관', 'BONDS'],
    ['ifrs-full_NoncurrentPortionOfNoncurrentBondsIssued', '무관', 'BONDS'],
    ['ifrs-full_NoncurrentPortionOfNoncurrentLoansReceived', '장기차입금', 'LONG_TERM_BORROWINGS'],
    ['dart_LongTermBorrowingsGross', '무관', 'LONG_TERM_BORROWINGS'],
  ])('%s / %s의 확인된 차입금 계정을 구분한다', (id, name, field) => {
    expect(resolveAccount(id, name)).toEqual({ field, statement: 'BS' });
  });

  it('확인되지 않은 일반 차입금은 새 분류를 추측하지 않는다', () => {
    expect(resolveAccount('ifrs-full_Borrowings', '유동차입금')).toBeNull();
    expect(resolveAccount('ifrs-full_LongtermBorrowings', '그 밖의 차입금')).toEqual({ field: 'LONG_TERM_BORROWINGS', statement: 'BS' });
  });
});
