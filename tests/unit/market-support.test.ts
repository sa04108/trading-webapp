import { describe, expect, it } from 'vitest';
import {
  KR_SESSION,
  UnsupportedMarketSessionError,
  getSessionForMarket,
  hasMarketSession,
} from '../../src/server/modules/market-data/domain/exchange-session.js';
import { listMarketSupport } from '../../src/server/modules/market-data/domain/market-support.js';

describe('hasMarketSession', () => {
  it('KR 은 세션이 있고 US 는 없다', () => {
    expect(hasMarketSession('KR')).toBe(true);
    expect(hasMarketSession('US')).toBe(false);
  });
});

describe('getSessionForMarket 회귀 (맵 기반으로 바꾼 뒤)', () => {
  it('KR 은 KR_SESSION 을 돌려준다', () => {
    expect(getSessionForMarket('KR')).toBe(KR_SESSION);
  });

  it('US 는 UnsupportedMarketSessionError 를 던진다', () => {
    expect(() => getSessionForMarket('US')).toThrow(UnsupportedMarketSessionError);
  });
});

describe('listMarketSupport', () => {
  it('선언된 모든 시장을 담는다', () => {
    expect(listMarketSupport().map((entry) => entry.market)).toEqual(['KR', 'US']);
  });

  it('KR 은 전부 지원이고 이유가 없다', () => {
    const kr = listMarketSupport().find((entry) => entry.market === 'KR');
    expect(kr).toEqual({
      market: 'KR',
      datasetsSupported: true,
      factsSupported: true,
      reason: null,
    });
  });

  it('US 는 전부 미지원이고 이유에 거래 시간과 재무 두 근거가 다 있다', () => {
    const us = listMarketSupport().find((entry) => entry.market === 'US');
    expect(us?.datasetsSupported).toBe(false);
    expect(us?.factsSupported).toBe(false);
    // 사용자가 "왜 회색인지" 를 이 문구 하나로 알 수 있어야 한다
    expect(us?.reason).toContain('거래 시간');
    expect(us?.reason).toContain('재무');
  });
});
