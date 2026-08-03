import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api-client';
import type {
  HistoricalUniverseStatusDto,
  UniverseSnapshotSummaryDto,
} from '../../shared/schemas/historical-universe.js';

/**
 * KRX 과거 시점 유니버스 기능의 가용성 — 인증키·API 이용 승인 상태를 담는다.
 *
 * `available=false` 면 화면은 조회 컨트롤을 비활성화하고 `reason` 을 상시 표시한다
 * (D-027) — 승인 만료 같은 사유는 사용자가 넘겨짚어서 알 수 없다.
 */
export function useHistoricalUniverseStatus(): {
  status: HistoricalUniverseStatusDto | null;
  isLoading: boolean;
} {
  const { data, isLoading } = useQuery({
    queryKey: ['universe', 'historical', 'status'],
    queryFn: () => api<HistoricalUniverseStatusDto>('/universe/historical/status'),
    // 승인 상태는 자주 바뀌지 않는다 — 위저드를 여는 도중 매번 다시 물을 필요는 없다
    staleTime: 60_000,
  });
  return { status: data ?? null, isLoading };
}

/** 이미 만든 유니버스 스냅샷 목록 — 위저드가 새로 만들지 않고 다시 골라 쓸 수 있게 한다 */
export function useUniverseSnapshots(): {
  snapshots: readonly UniverseSnapshotSummaryDto[];
  isLoading: boolean;
} {
  const { data, isLoading } = useQuery({
    queryKey: ['universe', 'snapshots'],
    queryFn: () => api<{ snapshots: UniverseSnapshotSummaryDto[] }>('/universe/snapshots'),
  });
  return { snapshots: data?.snapshots ?? [], isLoading };
}
