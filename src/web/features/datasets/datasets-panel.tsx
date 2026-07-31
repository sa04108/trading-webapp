import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Pencil, Plus, RefreshCw, Trash2, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { api, postJson } from '@/lib/api-client';
import { formatRelativeTime } from '@/lib/format';
import { sliceLabel } from './dataset-slices';
import { sortSymbols } from './symbol-sort';
import type { DatasetSummary, SymbolSummary } from './symbol-types';

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

export function DatasetsPanel() {
  const [createOpen, setCreateOpen] = useState(false);
  const datasets = useQuery({
    queryKey: ['datasets'],
    queryFn: () => api<{ datasets: DatasetSummary[] }>('/datasets'),
  });
  const symbols = useQuery({
    queryKey: ['symbols'],
    queryFn: () =>
      api<{ symbols: SymbolSummary[]; runningSyncJobId: string | null }>('/symbols'),
  });

  const byCode = useMemo(
    () => new Map((symbols.data?.symbols ?? []).map((symbol) => [symbol.code, symbol])),
    [symbols.data],
  );

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          데이터셋은 종목 참조 묶음입니다 — 봉·재무는 종목에 저장됩니다
        </p>
        <Button variant="outline" size="sm" className="h-11" onClick={() => setCreateOpen(true)}>
          <Plus data-icon="inline-start" />
          데이터셋
        </Button>
      </div>

      {datasets.isLoading ? (
        <Skeleton className="h-24 w-full" />
      ) : (datasets.data?.datasets ?? []).length === 0 ? (
        <Alert>
          <AlertDescription>
            데이터셋이 없습니다. 종목을 먼저 등록한 뒤 데이터셋을 만드세요.
          </AlertDescription>
        </Alert>
      ) : (
        (datasets.data?.datasets ?? []).map((dataset) => (
          <DatasetCard key={dataset.id} dataset={dataset} byCode={byCode} />
        ))
      )}

      <CreateDatasetDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        symbols={symbols.data?.symbols ?? []}
      />
    </div>
  );
}

function DatasetCard({
  dataset,
  byCode,
}: {
  dataset: DatasetSummary;
  byCode: Map<string, SymbolSummary>;
}) {
  const queryClient = useQueryClient();
  const [nameDraft, setNameDraft] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const nowMs = Date.now();

  const members = dataset.symbols.map((code) => byCode.get(code)).filter((s): s is SymbolSummary => s !== undefined);
  const missing = dataset.symbols.filter((code) => !byCode.has(code));

  /**
   * 카드의 마지막 수집은 참조 종목 중 **가장 오래된** 값이다 — 묵음은 가장 약한 고리가
   * 정한다. 최신값을 쓰면 한 종목만 방금 받아도 데이터셋 전체가 신선해 보인다.
   */
  const oldestSync = useMemo(() => {
    const times = members.flatMap((symbol) =>
      symbol.slices.filter((slice) => slice.hasData).map((slice) => slice.lastSyncedAtMs),
    );
    if (times.length === 0) return null;
    if (times.some((time) => time === null)) return null;
    return Math.min(...(times as number[]));
  }, [members]);

  const renameMutation = useMutation({
    mutationFn: (name: string) => postJson<unknown>(`/datasets/${dataset.id}`, { name }),
    onSuccess: () => {
      setNameDraft(null);
      void queryClient.invalidateQueries({ queryKey: ['datasets'] });
    },
    onError: (error) => toast.error(errorMessage(error, '이름을 바꿀 수 없습니다')),
  });

  const deleteMutation = useMutation({
    mutationFn: () => api<void>(`/datasets/${dataset.id}`, { method: 'DELETE' }),
    onSuccess: () => {
      toast.success(`${dataset.name} 을 삭제했습니다`);
      void queryClient.invalidateQueries({ queryKey: ['datasets'] });
      void queryClient.invalidateQueries({ queryKey: ['symbols'] });
    },
    onError: (error) => toast.error(errorMessage(error, '삭제할 수 없습니다')),
  });

  // 「이 데이터셋 종목 동기화」 — 참조 종목을 그대로 종목 단위 경로에 넘긴다.
  // 실행 경로를 하나로 유지하면서 "이 데이터셋에 필요한 것 전부" 라는 편의를 남긴다.
  const syncMutation = useMutation({
    mutationFn: () =>
      postJson<{ job: { id: string } }>('/symbols/sync', {
        codes: dataset.symbols,
        slice: '1d',
      }),
    onSuccess: () => {
      toast.success(`${dataset.symbols.length}종목 수집을 시작했습니다 — 종목 탭에서 진행을 봅니다`);
      void queryClient.invalidateQueries({ queryKey: ['symbols'] });
    },
    onError: (error) => toast.error(errorMessage(error, '수집을 시작할 수 없습니다')),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2 text-base">
          {nameDraft === null ? (
            <>
              <span>{dataset.name}</span>
              <button
                type="button"
                aria-label="이름 수정"
                className="text-muted-foreground hover:text-foreground"
                onClick={() => setNameDraft(dataset.name)}
              >
                <Pencil className="size-4" />
              </button>
            </>
          ) : (
            <span className="flex items-center gap-1">
              <Input
                value={nameDraft}
                className="h-8 w-48"
                onChange={(event) => setNameDraft(event.target.value)}
              />
              <button
                type="button"
                aria-label="이름 저장"
                className="text-muted-foreground hover:text-foreground"
                disabled={nameDraft.trim().length === 0 || renameMutation.isPending}
                onClick={() => renameMutation.mutate(nameDraft.trim())}
              >
                <Check className="size-4" />
              </button>
              <button
                type="button"
                aria-label="이름 수정 취소"
                className="text-muted-foreground hover:text-foreground"
                onClick={() => setNameDraft(null)}
              >
                <X className="size-4" />
              </button>
            </span>
          )}
          <Badge variant="outline">{dataset.symbols.length}종목</Badge>
          <span className="ml-auto flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              className="h-9"
              disabled={syncMutation.isPending || dataset.symbols.length === 0}
              onClick={() => syncMutation.mutate()}
            >
              <RefreshCw data-icon="inline-start" />
              종목 동기화
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-9 text-destructive"
              disabled={deleteMutation.isPending}
              onClick={() => setConfirmDelete(true)}
            >
              <Trash2 data-icon="inline-start" />
              삭제
            </Button>
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        <p className="text-xs text-muted-foreground">
          마지막 수집 {formatRelativeTime(oldestSync, nowMs)}
          {members.length > 1 ? ' (가장 오래된 종목 기준)' : ''}
        </p>
        <div className="flex flex-wrap gap-1">
          {sortSymbols(members).map((symbol) => (
            <Badge key={symbol.code} variant="secondary">
              {symbol.name ?? symbol.code}
              <span className="ml-1 text-[10px] opacity-70">
                {symbol.slices
                  .filter((slice) => slice.hasData)
                  .map((slice) => sliceLabel(slice.slice))
                  .join('·') || '데이터 없음'}
              </span>
            </Badge>
          ))}
          {missing.map((code) => (
            <Badge key={code} variant="destructive">
              {code} (없는 종목)
            </Badge>
          ))}
        </div>
      </CardContent>

      <Dialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{dataset.name} 을 삭제할까요?</DialogTitle>
            <DialogDescription>
              참조만 끊습니다 — 종목의 봉과 재무 데이터는 그대로 남습니다.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmDelete(false)}>
              취소
            </Button>
            <Button
              variant="outline"
              className="text-destructive"
              disabled={deleteMutation.isPending}
              onClick={() => deleteMutation.mutate()}
            >
              삭제
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

function CreateDatasetDialog({
  open,
  onOpenChange,
  symbols,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  symbols: SymbolSummary[];
}) {
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const mutation = useMutation({
    mutationFn: () =>
      postJson<unknown>('/datasets', { name: name.trim(), symbols: [...selected] }),
    onSuccess: () => {
      toast.success(`${name.trim()} 을 만들었습니다`);
      setName('');
      setSelected(new Set());
      onOpenChange(false);
      void queryClient.invalidateQueries({ queryKey: ['datasets'] });
      void queryClient.invalidateQueries({ queryKey: ['symbols'] });
    },
    onError: (error) => toast.error(errorMessage(error, '데이터셋을 만들 수 없습니다')),
  });

  const toggle = (code: string): void => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(code)) next.delete(code);
      else next.add(code);
      return next;
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>데이터셋 만들기</DialogTitle>
          <DialogDescription>
            이미 등록된 종목만 참조합니다 — 종목 탭에서 먼저 추가하세요.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="ds-name">이름</Label>
            <Input
              id="ds-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="kr-core"
            />
          </div>
          <div className="space-y-1">
            <Label>종목 ({selected.size}개 선택)</Label>
            {symbols.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                등록된 종목이 없습니다 — 종목 탭에서 먼저 추가하세요.
              </p>
            ) : (
              <div className="max-h-64 space-y-1 overflow-y-auto rounded-md border p-2">
                {sortSymbols(symbols).map((symbol) => (
                  <div key={symbol.code} className="flex items-center gap-2">
                    <Checkbox
                      id={`ds-sym-${symbol.code}`}
                      checked={selected.has(symbol.code)}
                      onCheckedChange={() => toggle(symbol.code)}
                    />
                    <label htmlFor={`ds-sym-${symbol.code}`} className="text-sm">
                      {symbol.name ?? symbol.code}{' '}
                      <span className="text-xs text-muted-foreground">{symbol.code}</span>
                    </label>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            취소
          </Button>
          <Button
            disabled={name.trim().length === 0 || selected.size === 0 || mutation.isPending}
            onClick={() => mutation.mutate()}
          >
            만들기
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
