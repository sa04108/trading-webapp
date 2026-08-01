import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { api } from '@/lib/api-client';
import type { SymbolMetrics, SymbolMetricsMap } from '@/features/datasets/symbol-sort';

interface MetricsRow extends SymbolMetrics {
  code: string;
}

interface MetricsResponse {
  metrics: MetricsRow[];
  /** 거래대금·거래량이 덮는 시장 상위 순위 — 화면이 「상위 N위 밖은 집계 없음」을 적는다 */
  rankingLimit: number;
}

export interface SymbolMetricsState {
  readonly metrics: SymbolMetricsMap;
  readonly rankingLimit: number;
  /** 지표를 하나도 못 받았는지 — 정렬 옵션을 잠글 근거다 */
  readonly unavailable: boolean;
}

const EMPTY: SymbolMetricsMap = new Map();

/**
 * 종목 정렬 지표. **등록 종목 전체**를 한 번에 받는다 — 정렬은 페이지가 아니라 목록
 * 전체를 대상으로 하고, 페이지마다 다시 물으면 스크롤 도중 순서가 바뀐다.
 *
 * 실패해도 조용하다. 서버가 자격 증명 미설정을 200 + null 로 답하므로 에러 경로는
 * 네트워크 장애뿐이고, 그때는 빈 Map 이라 화면이 가나다순으로 돌아간다.
 */
export function useSymbolMetrics(): SymbolMetricsState {
  const { data } = useQuery({
    queryKey: ['symbol-metrics'],
    queryFn: () => api<MetricsResponse>('/symbols/metrics'),
    // 시세는 움직이지만 정렬 순서가 목록을 보는 도중 뒤집히면 읽을 수 없다
    staleTime: 60_000,
  });

  /**
   * Map 을 useMemo 로 못 박는다. 매 렌더 새 Map 을 만들면 이것을 의존성으로 읽는 정렬
   * useMemo 가 전부 무효화돼 1,000종목을 매 렌더 다시 정렬한다.
   */
  return useMemo(() => {
    if (!data) return { metrics: EMPTY, rankingLimit: 0, unavailable: false };
    const metrics: SymbolMetricsMap = new Map(
      data.metrics.map((row) => [
        row.code,
        {
          marketCap: row.marketCap,
          tradingValue: row.tradingValue,
          tradingVolume: row.tradingVolume,
        },
      ]),
    );
    // 「값이 하나도 없다」 와 「아직 안 왔다」 는 다르다 — 전자만 정렬 옵션을 잠근다
    const unavailable =
      data.metrics.length > 0 &&
      data.metrics.every(
        (row) => row.marketCap === null && row.tradingValue === null && row.tradingVolume === null,
      );
    return { metrics, rankingLimit: data.rankingLimit, unavailable };
  }, [data]);
}
