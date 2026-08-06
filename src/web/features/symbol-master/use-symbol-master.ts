import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
} from '@tanstack/react-query';
import { type ApiError, api, postJson } from '@/lib/api-client';
import type {
  SymbolMasterCoverageDto,
  SymbolMasterEventDto,
  SymbolMasterUniverseDto,
} from '../../../shared/schemas/symbol-master.js';

/**
 * 종목 마스터 커버리지 — 백필 진행 상태를 화면에 반영해야 해서 staleTime 을
 * 짧게 잡는다. 10초보다 짧으면 화면을 열어둔 채 폴링하듯 다시 물어보게 되고,
 * 길면 백필이 끝나도 한동안 진행 중으로 보인다.
 */
export function useSymbolMasterCoverage(): {
  coverage: SymbolMasterCoverageDto | null;
  isLoading: boolean;
  refetch: () => void;
} {
  const { data, isLoading, refetch } = useQuery({
    queryKey: ['symbol-master', 'coverage'],
    queryFn: () => api<SymbolMasterCoverageDto>('/symbol-master/coverage'),
    staleTime: 10_000,
  });
  return {
    coverage: data ?? null,
    isLoading,
    refetch: () => {
      void refetch();
    },
  };
}

/** 특정 날짜의 유니버스 스냅샷 — date 가 없으면(선택 전) 요청 자체를 보내지 않는다 */
export function useSymbolMasterUniverse(date: string | null): {
  universe: SymbolMasterUniverseDto | null;
  isLoading: boolean;
} {
  const { data, isLoading } = useQuery({
    queryKey: ['symbol-master', 'universe', date],
    queryFn: () => api<SymbolMasterUniverseDto>(`/symbol-master/universe?date=${date}`),
    enabled: date !== null,
  });
  return { universe: data ?? null, isLoading };
}

/** 구간 [from, to] 의 종목 마스터 변경 이벤트 목록 */
export function useSymbolMasterEvents(
  from: string,
  to: string,
): { events: readonly SymbolMasterEventDto[]; isLoading: boolean } {
  const { data, isLoading } = useQuery({
    queryKey: ['symbol-master', 'events', from, to],
    queryFn: () => api<{ events: SymbolMasterEventDto[] }>(`/symbol-master/events?from=${from}&to=${to}`),
  });
  return { events: data?.events ?? [], isLoading };
}

/**
 * 특정 날짜 동기화를 트리거한다.
 *
 * 성공하면 커버리지·유니버스·이벤트가 모두 바뀔 수 있어 'symbol-master' 로
 * 시작하는 쿼리를 통째로 무효화한다 — 어느 쿼리가 영향받는지 개별적으로
 * 추적하는 것보다 한 번에 지우는 편이 안전하다.
 */
export function useSymbolMasterSync(): UseMutationResult<unknown, ApiError, { date: string }> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { date: string }) => postJson<unknown>('/symbol-master/sync', input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['symbol-master'] });
    },
  });
}
