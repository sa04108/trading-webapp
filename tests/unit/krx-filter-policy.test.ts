import { describe, expect, it } from 'vitest';
import {
  classifyKrxIssue,
  KRX_FILTER_POLICY_VERSION,
  UnknownKrxClassificationError,
} from '../../src/server/modules/market-data/domain/krx-filter-policy.js';

const base = {
  securityGroupRaw: '주권',
  stockKindRaw: '보통주',
  sectionRaw: null,
  name: '삼성전자',
  shortCode: '005930',
};

describe('KRX 보통주 필터 정책 v2', () => {
  it('정책 버전은 krx-common-stock-v2 이다', () => {
    expect(KRX_FILTER_POLICY_VERSION).toBe('krx-common-stock-v2');
  });

  it('주권·보통주는 포함한다', () => {
    expect(classifyKrxIssue(base)).toEqual({ kind: 'INCLUDE', instrumentType: 'COMMON_STOCK' });
  });

  it.each(['구형우선주', '신형우선주', '우선주', '종류주권'])('주식종류 %s 는 우선주로 제외한다', (kind) => {
    expect(classifyKrxIssue({ ...base, stockKindRaw: kind })).toEqual({
      kind: 'EXCLUDE',
      reason: 'PREFERRED_STOCK',
    });
  });

  it.each([
    ['부동산투자회사', 'REIT'],
    ['주식예탁증권', 'DR'],
    ['수익증권', 'FUND_OR_TRUST'],
    ['선박투자회사', 'FUND_OR_TRUST'],
    ['사회간접자본투융자회사', 'FUND_OR_TRUST'],
    ['신주인수권증권', 'NON_STOCK_SECURITY'],
    ['신주인수권증서', 'NON_STOCK_SECURITY'],
    ['ETF', 'NON_STOCK_SECURITY'],
    ['ETN', 'NON_STOCK_SECURITY'],
    ['ELW', 'NON_STOCK_SECURITY'],
    ['외국주권', 'FOREIGN_LISTING'],
  ])('증권그룹 %s 는 %s 로 제외한다', (group, reason) => {
    expect(classifyKrxIssue({ ...base, securityGroupRaw: group })).toEqual({
      kind: 'EXCLUDE',
      reason,
    });
  });

  it('소속부에 SPAC 이 있으면 SPAC 으로 제외한다', () => {
    expect(classifyKrxIssue({ ...base, sectionRaw: 'SPAC(소속부없음)' })).toEqual({
      kind: 'EXCLUDE',
      reason: 'SPAC',
    });
  });

  it('종목명에 스팩이 있으면 SPAC 으로 제외한다 — 필드 조합은 smoke test 로 입증한다', () => {
    expect(classifyKrxIssue({ ...base, name: '하나32호스팩' })).toEqual({
      kind: 'EXCLUDE',
      reason: 'SPAC',
    });
  });

  it('모르는 증권그룹은 조용히 제외하지 않고 전체 실패시킨다', () => {
    expect(() => classifyKrxIssue({ ...base, securityGroupRaw: '신종증권' })).toThrow(
      UnknownKrxClassificationError,
    );
  });

  it('모르는 주식종류도 전체 실패시킨다', () => {
    expect(() => classifyKrxIssue({ ...base, stockKindRaw: '전환주' })).toThrow(
      UnknownKrxClassificationError,
    );
  });

  it('모르는 증권그룹 오류는 이름과 원인 필드·값·종목코드를 보존한다', () => {
    try {
      classifyKrxIssue({ ...base, securityGroupRaw: '신종증권' });
      throw new Error('분류 오류가 발생해야 한다');
    } catch (error) {
      expect(error).toBeInstanceOf(UnknownKrxClassificationError);
      expect(error).toMatchObject({
        name: 'UnknownKrxClassificationError',
        field: 'securityGroupRaw',
        value: '신종증권',
        shortCode: '005930',
      });
    }
  });

  it('null 주식종류도 안전한 문자열로 보존하고 전체 실패시킨다', () => {
    try {
      classifyKrxIssue({ ...base, stockKindRaw: null });
      throw new Error('분류 오류가 발생해야 한다');
    } catch (error) {
      expect(error).toBeInstanceOf(UnknownKrxClassificationError);
      expect(error).toMatchObject({
        field: 'stockKindRaw',
        value: 'null',
        shortCode: '005930',
      });
    }
  });

  it('증권그룹은 SPAC 이름보다 먼저 분류한다', () => {
    expect(classifyKrxIssue({ ...base, securityGroupRaw: 'ETF', name: '가상스팩ETF' })).toEqual({
      kind: 'EXCLUDE',
      reason: 'NON_STOCK_SECURITY',
    });
  });

  it('주권 SPAC 은 알 수 없는 주식종류보다 먼저 제외한다', () => {
    expect(
      classifyKrxIssue({ ...base, sectionRaw: 'SPAC(소속부없음)', stockKindRaw: '전환주' }),
    ).toEqual({ kind: 'EXCLUDE', reason: 'SPAC' });
  });
});
