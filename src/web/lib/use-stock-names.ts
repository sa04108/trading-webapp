import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api-client';

export interface StockInfo {
  symbol: string;
  name: string;
  englishName: string | null;
  market: string;
  status: string;
}

/**
 * 코드 → 종목정보. 소스 미설정이면 빈 Map 이라 코드만 표시된다 —
 * `SymbolInfoService` 는 소스 미설정을 에러가 아니라 빈 결과로 다룬다.
 */
export function useStockNames(symbols: readonly string[]): ReadonlyMap<string, StockInfo> {
  const key = symbols.join(',');
  const { data } = useQuery({
    queryKey: ['symbol-info', key],
    queryFn: () => api<{ stocks: StockInfo[] }>(`/symbols/info?symbols=${encodeURIComponent(key)}`),
    enabled: symbols.length > 0,
    staleTime: 60 * 60 * 1000, // 종목명은 사실상 불변
  });
  return new Map(data?.stocks.map((stock) => [stock.symbol, stock]) ?? []);
}
