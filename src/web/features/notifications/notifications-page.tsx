import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CircleAlert, Info } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { api } from '@/lib/api-client';
import { formatRelativeTime } from '@/lib/format';
import { cn } from '@/lib/utils';
import { useNotifications } from './api';
import type { NotificationItem } from './types';

/** 아이콘·제목·본문·상대 시각 — 편집 모드 라벨과 비편집 모드 버튼이 내용을 공유한다 */
function NotificationRowBody({ item }: { item: NotificationItem }) {
  return (
    <>
      {item.severity === 'error' ? (
        <CircleAlert className="mt-0.5 size-4 shrink-0 text-loss" />
      ) : (
        <Info className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      )}
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium">{item.title}</span>
        {item.body && (
          <span className="block truncate text-sm text-muted-foreground">{item.body}</span>
        )}
      </span>
      <span className="shrink-0 text-xs text-muted-foreground">
        {formatRelativeTime(item.createdAtMs, Date.now())}
      </span>
    </>
  );
}

export function NotificationsPage() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { data, isLoading } = useNotifications();
  const notifications = data?.notifications ?? [];

  const [editing, setEditing] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());

  // 진입 시 전체 읽음. 목록 키는 무효화하지 않는다 — 지금 화면의 read=false 는
  // "이번에 새로 온 것" 강조로 쓰이는데, 목록을 다시 받으면 전부 읽음이 돼 사라진다.
  useEffect(() => {
    void api('/notifications/read-all', { method: 'POST' }).then(
      () => queryClient.invalidateQueries({ queryKey: ['notifications', 'unread-count'] }),
      () => {}, // 읽음 처리 실패는 치명적이지 않다 — 다음 진입에 다시 시도된다
    );
  }, [queryClient]);

  const remove = useMutation({
    mutationFn: (ids: string[]) =>
      api('/notifications', { method: 'DELETE', body: JSON.stringify({ ids }) }),
    onSuccess: () => {
      setSelected(new Set());
      setEditing(false);
      void queryClient.invalidateQueries({ queryKey: ['notifications'] });
    },
    onError: (error) => toast.error(error.message),
  });

  const allSelected = notifications.length > 0 && selected.size === notifications.length;

  const toggleAll = () =>
    setSelected(allSelected ? new Set() : new Set(notifications.map((n) => n.id)));

  const toggleOne = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <CardTitle>알림</CardTitle>
        <div className="flex items-center gap-2">
          {editing && (
            <>
              <label className="flex items-center gap-2 text-sm text-muted-foreground">
                <Checkbox checked={allSelected} onCheckedChange={toggleAll} aria-label="전체 선택" />
                전체 선택
              </label>
              <Button
                variant="destructive"
                size="sm"
                disabled={selected.size === 0 || remove.isPending}
                onClick={() => remove.mutate([...selected])}
              >
                삭제 ({selected.size})
              </Button>
            </>
          )}
          {notifications.length > 0 && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setEditing((prev) => !prev);
                setSelected(new Set());
              }}
            >
              {editing ? '완료' : '편집'}
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent className="p-0">
        {isLoading ? (
          <p className="px-6 py-8 text-sm text-muted-foreground">불러오는 중…</p>
        ) : notifications.length === 0 ? (
          <p className="px-6 py-8 text-sm text-muted-foreground">알림이 없습니다.</p>
        ) : (
          <ul className="divide-y">
            {notifications.map((item) => {
              // 행 컨테이너는 button 이 아니라 div 다 — 편집 모드에서 그 안에 Checkbox(button
              // role) 를 넣으면 button 안에 button 이 중첩돼 HTML 상 무효하고 스크린리더·키보드
              // 포커스가 꼬인다. 편집 모드는 label+htmlFor 로, 비편집 모드는 그 자리에만
              // button 을 둬서 인터랙티브 요소가 겹치지 않게 한다.
              const checkboxId = `notification-${item.id}`;
              return (
                <li key={item.id}>
                  <div
                    className={cn(
                      'flex items-start gap-3 px-6 py-3 transition-colors hover:bg-muted/50',
                      !item.read && 'bg-accent/40',
                    )}
                  >
                    {editing ? (
                      <>
                        <Checkbox
                          id={checkboxId}
                          checked={selected.has(item.id)}
                          onCheckedChange={() => toggleOne(item.id)}
                          aria-label={`${item.title} 선택`}
                          className="mt-0.5"
                        />
                        <label
                          htmlFor={checkboxId}
                          className="flex min-w-0 flex-1 items-start gap-3"
                        >
                          <NotificationRowBody item={item} />
                        </label>
                      </>
                    ) : item.link ? (
                      <button
                        type="button"
                        className="flex min-w-0 flex-1 items-start gap-3 text-left"
                        onClick={() => navigate(item.link!)}
                      >
                        <NotificationRowBody item={item} />
                      </button>
                    ) : (
                      <div className="flex min-w-0 flex-1 items-start gap-3">
                        <NotificationRowBody item={item} />
                      </div>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
