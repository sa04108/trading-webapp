import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api-client';
import type { SortDirection, TradeSortKey } from '../../../shared/schemas/trade-sort.js';
import type { ProvenancePin } from '../../../shared/schemas/provenance-pin.js';
import type { UniverseRebalancingEntryDto } from '../../../shared/schemas/universe-rebalancing.js';
import {
  isTerminal,
  type BacktestMetrics,
  type JobSummary,
  type RunMetadata,
  type SeriesResponse,
  type TradeRow,
} from './types';

export interface StrategySummary {
  id: string;
  version: string;
  name: string;
  description: string;
  /**
   * 서버는 항상 boolean 을 내리지만(`toSummary`) 응답을 런타임 검증하지 않으므로
   * 낡은 서버·프록시 응답에서는 없을 수 있다. 없는 것을 false 로 좁히지 않고 그대로
   * 흘려보내 배지가 침묵하게 한다 (`strategyDataRequirement`).
   */
  requiresFundamentals?: boolean;
}

/**
 * 전략 목록. 네 화면(대시보드·목록·상세·위저드)이 공유한다 — 화면마다 같은 useQuery 를
 * 복사하면 캐시 키는 같은데 응답 타입이 갈라진다. 목록은 배포로만 바뀌므로
 * staleTime 을 길게 둔다.
 */
export function useStrategies() {
  return useQuery({
    queryKey: ['strategies'],
    queryFn: () => api<{ strategies: StrategySummary[] }>('/strategies'),
    staleTime: 5 * 60_000,
  });
}

export function useBacktests(refetchIntervalMs?: number) {
  return useQuery({
    queryKey: ['backtests'],
    queryFn: () => api<{ jobs: JobSummary[] }>('/backtests'),
    refetchInterval: refetchIntervalMs ?? false,
  });
}

export interface BacktestDetail {
  job: JobSummary;
  run: RunMetadata | null;
  metrics: BacktestMetrics | null;
  /** 제출 시점부터 서버가 소유하는 유니버스 출처 pin (Task 12) — job 이 생성될 때부터 있다 */
  provenancePin: ProvenancePin | null;
  universeRebalancing: UniverseRebalancingEntryDto[];
}

/**
 * 작업 상세 + 실시간 진행률 (스펙 §14):
 * SSE 를 기본으로 하고, 연결이 실패하면 2초 polling 으로 fallback 한다.
 */
export function useBacktestLive(jobId: string) {
  const queryClient = useQueryClient();
  const [ssePayload, setSsePayload] = useState<JobSummary | null>(null);
  const [sseFailed, setSseFailed] = useState(false);
  const sourceRef = useRef<EventSource | null>(null);

  const detail = useQuery({
    queryKey: ['backtests', jobId],
    queryFn: () => api<BacktestDetail>(`/backtests/${jobId}`),
    refetchInterval: (query) => {
      const status = query.state.data?.job.status;
      if (!status) return false;
      // SSE 실패 시 또는 비종료 상태면 polling fallback
      if (!isTerminal(status) && sseFailed) return 2_000;
      return false;
    },
  });

  const status = ssePayload?.status ?? detail.data?.job.status;

  useEffect(() => {
    if (!status || isTerminal(status)) {
      sourceRef.current?.close();
      sourceRef.current = null;
      return;
    }
    if (sourceRef.current || sseFailed) return;

    const source = new EventSource(`/api/v1/backtests/${jobId}/events`);
    sourceRef.current = source;
    source.onmessage = (event) => {
      const payload = JSON.parse(event.data as string) as JobSummary;
      setSsePayload(payload);
      if (isTerminal(payload.status)) {
        source.close();
        sourceRef.current = null;
        void queryClient.invalidateQueries({ queryKey: ['backtests'] });
      }
    };
    source.onerror = () => {
      source.close();
      sourceRef.current = null;
      setSseFailed(true); // polling fallback 활성화
    };
    return () => {
      source.close();
      sourceRef.current = null;
    };
  }, [jobId, status, sseFailed, queryClient]);

  const job: JobSummary | undefined =
    ssePayload && detail.data && ssePayload.id === detail.data.job.id
      ? { ...detail.data.job, ...ssePayload }
      : detail.data?.job;

  return {
    ...detail,
    job,
    run: detail.data?.run ?? null,
    metrics: detail.data?.metrics ?? null,
    provenancePin: detail.data?.provenancePin ?? null,
    universeRebalancing: detail.data?.universeRebalancing ?? [],
  };
}

export function useBacktestSeries(jobId: string, enabled: boolean) {
  return useQuery({
    queryKey: ['backtests', jobId, 'series'],
    queryFn: () => api<SeriesResponse>(`/backtests/${jobId}/series`),
    enabled,
    staleTime: Infinity,
  });
}

export function useBacktestTrades(
  jobId: string,
  options: {
    limit: number;
    offset: number;
    symbol?: string;
    sort: TradeSortKey;
    dir: SortDirection;
  },
  enabled: boolean,
) {
  // 정렬은 서버가 한다 — 페이징이 서버라 화면에서 정렬하면 보이는 한 페이지만 뒤집힌다
  const params = new URLSearchParams({
    limit: String(options.limit),
    offset: String(options.offset),
    sort: options.sort,
    dir: options.dir,
  });
  if (options.symbol) params.set('symbol', options.symbol);
  return useQuery({
    queryKey: ['backtests', jobId, 'trades', options],
    queryFn: () => api<{ trades: TradeRow[]; total: number }>(`/backtests/${jobId}/trades?${params}`),
    enabled,
    staleTime: Infinity,
  });
}
