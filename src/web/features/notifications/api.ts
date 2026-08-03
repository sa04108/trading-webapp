import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api-client';
import type { NotificationItem } from './types';

export function useNotifications() {
  return useQuery({
    queryKey: ['notifications', 'list'],
    queryFn: () => api<{ notifications: NotificationItem[] }>('/notifications'),
  });
}

export function useUnreadCount(pollingFallback: boolean) {
  return useQuery({
    queryKey: ['notifications', 'unread-count'],
    queryFn: () => api<{ count: number }>('/notifications/unread-count'),
    // SSE 가 죽었을 때만 폴링 — 평소에는 push 가 invalidate 한다
    refetchInterval: pollingFallback ? 60_000 : false,
  });
}

/**
 * 전역 알림 SSE (스펙 §14 의 backtest SSE 와 같은 패턴). shell 에서 한 번만 구독한다.
 * 연결이 실패하면 true 를 돌려 호출부가 unread-count 폴링으로 내려앉는다.
 */
export function useNotificationStream(): boolean {
  const queryClient = useQueryClient();
  const [sseFailed, setSseFailed] = useState(false);
  const sourceRef = useRef<EventSource | null>(null);

  useEffect(() => {
    if (sourceRef.current || sseFailed) return;
    const source = new EventSource('/api/v1/notifications/events');
    sourceRef.current = source;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    source.onmessage = () => {
      // 내용은 쓰지 않는다 — 목록·카운트 쿼리를 무효화하면 화면이 알아서 당겨 온다
      void queryClient.invalidateQueries({ queryKey: ['notifications'] });
    };
    source.onerror = () => {
      source.close();
      sourceRef.current = null;
      setSseFailed(true); // polling fallback 활성화
      // backtest SSE(§14)는 짧은 페이지라 영구 latch 로 충분하지만, 이 벨은 세션 내내
      // 마운트된 채라 한 번 latch 되면 재연결 기회가 영영 없다 — 30초 뒤 재무장한다
      retryTimer = setTimeout(() => setSseFailed(false), 30_000);
    };
    return () => {
      source.close();
      sourceRef.current = null;
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [sseFailed, queryClient]);

  return sseFailed;
}
