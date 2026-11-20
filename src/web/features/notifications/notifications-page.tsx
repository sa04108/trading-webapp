import { useMutation, useQueryClient } from "@tanstack/react-query";
import { CircleAlert, ExternalLink, Info, Minus, Plus } from "lucide-react";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { useListSelection, type ListSelectionRequest } from "@/components/use-list-selection";
import { api, ApiError } from "@/lib/api-client";
import { formatRelativeTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import { notificationsQueryOptions, useNotifications } from "./api";
import { targetApiPath } from "./link-target";
import {
  clearTargetMissing,
  markTargetMissing,
  useMissingTargets,
} from "./missing-targets";
import type { NotificationItem } from "./types";

/** 본문은 선택 가능한 텍스트로 두고, 화면 이동은 제목 옆 버튼으로 분리한다. */
function NotificationRowBody({
  item,
  expanded,
  missing,
  checking,
  onOpen,
}: {
  item: NotificationItem;
  expanded: boolean;
  missing: boolean;
  checking: boolean;
  onOpen?: () => void;
}) {
  return (
    <>
      {item.severity === "error" ? (
        <CircleAlert className="mt-0.5 size-4 shrink-0 text-destructive" />
      ) : (
        <Info className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      )}
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1 text-sm font-medium">
          <span className="min-w-0 wrap-anywhere">{item.title}</span>
          {onOpen && (
            <Button
              variant="ghost"
              size="icon-xs"
              disabled={checking}
              aria-busy={checking}
              aria-label={`${item.title} 관련 화면으로 이동`}
              title="관련 화면으로 이동"
              onClick={onOpen}
            >
              <ExternalLink />
            </Button>
          )}
        </span>
        {item.body && (
          <span
            className={cn(
              "block text-sm text-muted-foreground",
              // 펼치면 끝까지 보여야 한다 — 본문에는 실패 사유가 통째로 들어간다.
              // wrap-anywhere 인 이유: 종목 코드·에러 문자열은 공백이 없어 한 줄을 넘겨도
              // break-words 로는 쪼개지지 않는다.
              expanded ? "whitespace-pre-wrap wrap-anywhere" : "truncate",
            )}
          >
            {item.body}
          </span>
        )}
        {missing && (
          <span className="mt-1 block text-xs text-loss">
            정보를 찾을 수 없습니다 — 대상이 삭제되었습니다
          </span>
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
  const [filter, setFilter] = useState<"all" | "error">("all");
  const selection = useListSelection();
  const { data, isLoading, isPlaceholderData, isError, error, refetch } = useNotifications(filter === "error" ? "error" : undefined, selection.excludeIds);
  const notifications = data?.notifications ?? [];
  const missingTargets = useMissingTargets();

  const [editing, setEditing] = useState(false);
  const selected = selection.forList(notifications, data?.total ?? 0, data?.selectionCount ?? 0);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [checking, setChecking] = useState<string | null>(null);

  // 진입 시 전체 읽음. 목록 키는 무효화하지 않는다 — 지금 화면의 read=false 는
  // "이번에 새로 온 것" 강조로 쓰이는데, 목록을 다시 받으면 전부 읽음이 돼 사라진다.
  useEffect(() => {
    void api("/notifications/read-all", { method: "POST" }).then(
      () =>
        queryClient.invalidateQueries({
          queryKey: ["notifications", "unread-count"],
        }),
      () => {}, // 읽음 처리 실패는 치명적이지 않다 — 다음 진입에 다시 시도된다
    );
  }, [queryClient]);

  const remove = useMutation({
    mutationFn: (request: ListSelectionRequest) =>
      api("/notifications", {
        method: "DELETE",
        body: JSON.stringify("all" in request && filter === "error" ? { ...request, severity: "error" } : request),
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["notifications"] });
      if (selection.excludeIds.length) await queryClient.fetchQuery(notificationsQueryOptions(filter === "error" ? "error" : undefined));
      selection.clear();
      setEditing(false);
    },
    onError: (error) => toast.error(error.message),
  });

  const toggleExpanded = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  /**
   * 이동 전에 대상이 아직 있는지 묻는다. 없으면 표시를 남기고 그래도 이동한다 —
   * 이동을 막으면 눌러도 아무 일이 없어 고장으로 읽힌다. 간 화면이 「불러올 수 없습니다」
   * 를 말하고, 알림 목록에는 「정보를 찾을 수 없습니다」가 남는다.
   */
  const open = async (item: NotificationItem) => {
    const link = item.link;
    if (!link) return;
    const probe = targetApiPath(link);
    if (probe === null) {
      void navigate(link);
      return;
    }
    setChecking(item.id);
    try {
      await queryClient.fetchQuery({
        queryKey: ["notifications", "target", probe],
        queryFn: () => api(probe),
        // 응답 없음·오류 코드 판정에 재시도를 끼우면 클릭이 몇 초씩 멎는다
        retry: false,
        staleTime: 0,
      });
      clearTargetMissing(link);
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) markTargetMissing(link);
      else {
        toast.error("관련 화면을 확인하지 못했습니다. 다시 시도해 주세요.");
        return;
      }
    } finally {
      setChecking(null);
    }
    void navigate(link);
  };

  return (
    <Card>
      <CardHeader className="gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle>알림</CardTitle>
          <div className="flex flex-wrap items-center gap-2">
            {editing && (
              <>
                <label className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Checkbox
                    checked={selected.checked}
                    onCheckedChange={selection.toggleAll}
                    disabled={remove.isPending || isPlaceholderData}
                    aria-label="전체 선택"
                  />
                  전체 선택
                </label>
                <Button
                  variant="destructive"
                  size="sm"
                  disabled={selected.count === 0 || remove.isPending || isPlaceholderData}
                  onClick={() => remove.mutate(selected.request())}
                >
                  삭제 ({selected.count})
                </Button>
              </>
            )}
            {notifications.length > 0 && (
              <Button
                variant="outline"
                size="sm"
                disabled={remove.isPending || isPlaceholderData}
                onClick={() => {
                  setEditing((prev) => !prev);
                  selection.clear();
                }}
              >
                {editing ? "완료" : "편집"}
              </Button>
            )}
          </div>
        </div>
        <div className="flex gap-2" role="group" aria-label="알림 필터">
          {(["all", "error"] as const).map(value => (
            <Button
              key={value}
              size="sm"
              variant={filter === value ? "secondary" : "ghost"}
              className={value === "error" ? cn(
                "text-destructive hover:text-destructive",
                filter === value && "bg-destructive/10 hover:bg-destructive/20",
              ) : undefined}
              aria-pressed={filter === value}
              disabled={remove.isPending || isPlaceholderData}
              onClick={() => {
                setFilter(value);
                selection.clear();
                setEditing(false);
              }}
            >
              {value === "all" ? "전체" : "오류"}
            </Button>
          ))}
        </div>
      </CardHeader>
      <CardContent className="p-0">
        {isError && (
          <div role="alert" className="flex flex-wrap items-center gap-2 px-6 py-3 text-sm wrap-anywhere text-destructive">
            <span>알림을 불러오지 못했습니다: {error.message}</span>
            <Button size="sm" variant="outline" onClick={() => void refetch()}>다시 불러오기</Button>
          </div>
        )}
        {isLoading && (
          <p className="px-6 py-8 text-sm text-muted-foreground">
            불러오는 중…
          </p>
        )}
        {!isLoading && !isError && notifications.length === 0 && (
          <p className="px-6 py-8 text-sm text-muted-foreground">
            {filter === "error" ? "오류 알림이 없습니다." : "알림이 없습니다."}
          </p>
        )}
        {notifications.length > 0 && (
          <ul className="divide-y">
            {notifications.map((item) => {
              const isExpanded = expanded.has(item.id);
              const isMissing =
                item.link !== null && missingTargets.has(item.link);
              return (
                <li key={item.id}>
                  <div
                    className={cn(
                      "flex items-start gap-3 px-6 py-3 select-text",
                      !item.read && "bg-accent/40",
                    )}
                  >
                    {editing && (
                      <Checkbox
                        checked={selection.isSelected(item.id)}
                        onCheckedChange={(checked) => selection.toggle(item.id, checked)}
                        disabled={remove.isPending || isPlaceholderData}
                        aria-label={`${item.title} 선택`}
                        className="mt-0.5"
                      />
                    )}
                    <div className="flex min-w-0 flex-1 items-start gap-3">
                      <NotificationRowBody
                        item={item}
                        expanded={isExpanded}
                        missing={isMissing}
                        checking={checking === item.id}
                        onOpen={!editing && item.link ? () => void open(item) : undefined}
                      />
                    </div>
                    {item.body ? (
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        className="-my-0.5 shrink-0"
                        aria-expanded={isExpanded}
                        aria-label={`${item.title} 설명 ${isExpanded ? "접기" : "자세히 보기"}`}
                        onClick={() => toggleExpanded(item.id)}
                      >
                        {isExpanded ? <Minus /> : <Plus />}
                      </Button>
                    ) : null}
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
