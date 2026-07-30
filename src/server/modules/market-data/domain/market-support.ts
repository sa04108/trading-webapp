import { ALL_MARKETS, type Market } from './candle.js';
import { hasMarketSession } from './exchange-session.js';

export interface MarketSupport {
  readonly market: Market;
  /** 데이터셋 생성·수집 가능 여부 (거래소 세션 정의 여부와 같다) */
  readonly datasetsSupported: boolean;
  /** DART 재무 수집 대상 시장인지 — DART 는 국내 공시 기관이다 */
  readonly factsSupported: boolean;
  /** 지원되지 않는 이유 (한국어). 전부 지원되면 null */
  readonly reason: string | null;
}

/**
 * 화면이 "무엇을 고를 수 있는지" 를 물어보는 자리.
 *
 * `factsSupported` 는 **시장 자격만** 본다 — DART_API_KEY 설정 여부는 배포 상태이지
 * 시장 속성이 아니다. 그건 데이터셋별 추정기(factsSyncEstimator)가 답한다. 둘을 한
 * 필드에 섞으면 "KR 인데 재무 불가" 의 원인이 시장인지 키인지 구분되지 않는다.
 */
export function listMarketSupport(): readonly MarketSupport[] {
  return ALL_MARKETS.map((market) => {
    const datasetsSupported = hasMarketSession(market);
    // DART 는 국내 공시 기관이다 — US 세션이 정의된 뒤에도 남는 제약이라 세션과
    // 따로 판단한다
    const factsSupported = market === 'KR';
    if (datasetsSupported && factsSupported) {
      return { market, datasetsSupported, factsSupported, reason: null };
    }
    const reasons: string[] = [];
    if (!datasetsSupported) {
      reasons.push('거래소 세션 정의가 없어(DST 미지원) 데이터셋을 만들 수 없습니다');
    }
    if (!factsSupported) {
      reasons.push('DART 재무 수집은 국내 종목 전용입니다');
    }
    return { market, datasetsSupported, factsSupported, reason: `${reasons.join('. ')}.` };
  });
}
