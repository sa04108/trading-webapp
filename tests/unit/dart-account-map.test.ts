import { describe, expect, it } from 'vitest';
import { resolveAccount } from '../../src/server/modules/facts/infrastructure/dart/dart-account-map.js';

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
});
