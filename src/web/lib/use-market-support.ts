import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api-client';

export interface MarketSupport {
  market: string;
  datasetsSupported: boolean;
  factsSupported: boolean;
  reason: string | null;
}

export interface MarketSupportResult {
  markets: readonly MarketSupport[];
  /** 영구 실패(재시도 소진) 여부 — 로딩 중과 구분해야 화면이 "왜 잠겨 있는지" 를 말할 수 있다 */
  isError: boolean;
}

/** 지원 시장 목록. 배포마다 고정이라 재조회하지 않는다. */
export function useMarketSupport(): MarketSupportResult {
  const { data, isError } = useQuery({
    queryKey: ['markets'],
    queryFn: () => api<{ markets: MarketSupport[] }>('/markets'),
    staleTime: Infinity,
  });
  return { markets: data?.markets ?? [], isError };
}
