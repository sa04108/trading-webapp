import { useMutation, useQuery } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { api, postJson } from '@/lib/api-client';
import type { DatasetSlice } from './dataset-slices';
import type { SymbolSummary, SyncEstimateResponse } from './symbol-types';

function duration(ms: number): string {
  if (ms < 60_000) return `약 ${Math.max(1, Math.ceil(ms / 1_000))}초`;
  return `약 ${Math.ceil(ms / 60_000)}분`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : '수집을 시작할 수 없습니다';
}

export function SyncDialog({
  open,
  onOpenChange,
  symbols,
  title = '데이터 동기화',
  onStarted,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  symbols: readonly SymbolSummary[];
  title?: string;
  onStarted?: (jobId: string) => void;
}) {
  const [slice, setSlice] = useState<DatasetSlice>('1d');
  const [includeFacts, setIncludeFacts] = useState(true);
  const codes = symbols.map((symbol) => symbol.code);
  const codesKey = codes.join(',');
  const withFacts = symbols.filter((symbol) => symbol.hasFacts === true).length;

  const estimate = useQuery({
    queryKey: ['symbols', 'sync-estimate', codesKey, slice],
    queryFn: () =>
      api<SyncEstimateResponse>(`/symbols/sync-estimate?codes=${codesKey}&slice=${slice}`),
    enabled: open && codes.length > 0,
  });
  const factsBlockedReason =
    estimate.data?.facts.basis === 'UNSUPPORTED' ? estimate.data.facts.reason : null;
  const effectiveIncludeFacts = includeFacts && factsBlockedReason === null;

  useEffect(() => {
    if (open) {
      setSlice('1d');
      setIncludeFacts(true);
    }
  }, [open]);
  const sync = useMutation({
    mutationFn: () =>
      postJson<{ job: { id: string } }>('/symbols/sync', {
        codes,
        slice,
        includeFacts: effectiveIncludeFacts,
      }),
    onSuccess: ({ job }) => {
      onOpenChange(false);
      onStarted?.(job.id);
      toast.success(`${codes.length}종목 데이터 동기화를 시작했습니다`);
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  const facts = estimate.data?.facts;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>대상 {codes.length}종목의 가격과 재무 데이터를 동기화합니다.</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="sync-slice">가격 데이터</Label>
            <Select value={slice} onValueChange={(value) => setSlice(value as DatasetSlice)}>
              <SelectTrigger id="sync-slice" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="1d">일봉</SelectItem>
                <SelectItem value="1m">분봉</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="rounded-lg border p-3">
            <div className="flex items-start gap-2">
              <Checkbox
                id="sync-facts"
                checked={effectiveIncludeFacts}
                disabled={factsBlockedReason !== null || estimate.isLoading}
                onCheckedChange={(checked) => setIncludeFacts(checked === true)}
              />
              <div className="space-y-1">
                <Label htmlFor="sync-facts">재무 데이터 함께 동기화</Label>
                <p className="text-xs text-muted-foreground">
                  현재 {withFacts}/{codes.length}종목 보유 · 미수집 연도와 현재 연도를 증분 수집합니다.
                </p>
              </div>
            </div>
            {factsBlockedReason ? (
              <p className="mt-2 text-xs text-destructive">{factsBlockedReason}</p>
            ) : facts?.basis === 'PLANNED' ? (
              <p className="mt-2 text-xs text-muted-foreground">
                {facts.fromYear}~{facts.toYear}년 · DART {facts.calls.toLocaleString()}회 · {duration(facts.estimatedMs)}
              </p>
            ) : facts?.basis === 'AFTER_CANDLES' ? (
              <p className="mt-2 text-xs text-muted-foreground">
                가격 수집 후 확보된 기간을 기준으로 재무 범위를 정합니다.
              </p>
            ) : null}
          </div>

          {/* 한도 초과는 경고만 한다 — 실행을 막지 않는다. 한도에 실제로 걸리면 DART 가
              호출을 거부하고 그 시점에 수집이 실패한다 (설계 문서의 원칙과 같다). */}
          {facts?.basis === 'PLANNED' && facts.overDailyLimit && effectiveIncludeFacts ? (
            <Alert variant="destructive">
              <AlertDescription>
                DART 일일 호출 한도를 넘는 작업입니다. 시작은 할 수 있지만 한도에 걸리면 이후
                수집이 실패합니다 — 남은 구간은 다음 날 이어받으세요.
              </AlertDescription>
            </Alert>
          ) : null}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>취소</Button>
          <Button
            disabled={codes.length === 0 || sync.isPending}
            onClick={() => sync.mutate()}
          >
            <RefreshCw data-icon="inline-start" />
            동기화 시작
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
