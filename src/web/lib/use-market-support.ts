import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api-client';

export interface MarketSupport {
  market: string;
  datasetsSupported: boolean;
  factsSupported: boolean;
  reason: string | null;
}

/** 지원 시장 목록. 배포마다 고정이라 재조회하지 않는다. */
export function useMarketSupport(): readonly MarketSupport[] {
  const { data } = useQuery({
    queryKey: ['markets'],
    queryFn: () => api<{ markets: MarketSupport[] }>('/markets'),
    staleTime: Infinity,
  });
  return data?.markets ?? [];
}
