/** 이 정책 버전은 fixture 로 검증했고 실응답 입증은 scripts/krx-smoke.ts 가 담당한다. 값 추가 시 버전을 올린다. */
export const KRX_FILTER_POLICY_VERSION = 'krx-common-stock-v1';

export type KrxExclusionReason =
  | 'PREFERRED_STOCK'
  | 'REIT'
  | 'SPAC'
  | 'DR'
  | 'FUND_OR_TRUST'
  | 'NON_STOCK_SECURITY'
  | 'FOREIGN_LISTING';

export type KrxFilterDecision =
  | { readonly kind: 'INCLUDE'; readonly instrumentType: 'COMMON_STOCK' }
  | { readonly kind: 'EXCLUDE'; readonly reason: KrxExclusionReason };

export class UnknownKrxClassificationError extends Error {
  constructor(
    readonly field: string,
    readonly value: string,
    readonly shortCode: string,
  ) {
    super(`KRX 분류를 알 수 없습니다: ${field} 값 ${value}, 단축코드 ${shortCode}`);
    this.name = 'UnknownKrxClassificationError';
  }
}

export function classifyKrxIssue(row: {
  securityGroupRaw: string;
  stockKindRaw: string | null;
  sectionRaw: string | null;
  name: string;
  shortCode: string;
}): KrxFilterDecision {
  switch (row.securityGroupRaw) {
    case '부동산투자회사':
      return { kind: 'EXCLUDE', reason: 'REIT' };
    case '주식예탁증권':
      return { kind: 'EXCLUDE', reason: 'DR' };
    case '수익증권':
    case '선박투자회사':
    case '사회간접자본투융자회사':
      return { kind: 'EXCLUDE', reason: 'FUND_OR_TRUST' };
    case '신주인수권증권':
    case '신주인수권증서':
    case 'ETF':
    case 'ETN':
    case 'ELW':
      return { kind: 'EXCLUDE', reason: 'NON_STOCK_SECURITY' };
    case '외국주권':
      return { kind: 'EXCLUDE', reason: 'FOREIGN_LISTING' };
    case '주권':
      break;
    default:
      throw new UnknownKrxClassificationError(
        'securityGroupRaw',
        row.securityGroupRaw,
        row.shortCode,
      );
  }

  if (row.sectionRaw?.includes('SPAC')) {
    return { kind: 'EXCLUDE', reason: 'SPAC' };
  }

  // 이름 fallback은 임시 방어선이다. 운영을 열기 전에 Task 16 smoke test가 KRX 필드 조합을 입증해야 한다.
  if (row.name.includes('스팩')) {
    return { kind: 'EXCLUDE', reason: 'SPAC' };
  }

  switch (row.stockKindRaw) {
    case '보통주':
      return { kind: 'INCLUDE', instrumentType: 'COMMON_STOCK' };
    case '구형우선주':
    case '신형우선주':
    case '우선주':
      return { kind: 'EXCLUDE', reason: 'PREFERRED_STOCK' };
    default:
      throw new UnknownKrxClassificationError(
        'stockKindRaw',
        row.stockKindRaw ?? 'null',
        row.shortCode,
      );
  }
}
