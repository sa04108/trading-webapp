import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api-client';
import type { SortDirection, TradeSortKey } from '../../../shared/schemas/trade-sort.js';
import {
  isTerminal,
  type BacktestMetrics,
  type JobSummary,
  type RunMetadata,
  type SeriesResponse,
  type TradeRow,
} from './types';

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

  return { ...detail, job, run: detail.data?.run ?? null, metrics: detail.data?.metrics ?? null };
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
