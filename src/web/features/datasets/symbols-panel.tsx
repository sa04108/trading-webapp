import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChartCandlestick, FileText, FileX, Plus, RefreshCw, Trash2, Upload, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { api, postForm, postJson } from '@/lib/api-client';
import { formatRelativeTime } from '@/lib/format';
import { useMarketSupport } from '@/lib/use-market-support';
import { cn } from '@/lib/utils';
import { CandleInspectDrawer } from './candle-inspect-drawer';
import { sliceLabel, type DatasetSlice } from './dataset-slices';
import { sortSymbols } from './symbol-sort';
import type {
  DataJob,
  FactsJobState,
  RemovalImpact,
  SymbolSummary,
  SyncEstimateResponse,
} from './symbol-types';

const SLICES: DatasetSlice[] = ['1d', '1m'];

function parseFacts(json: string | null | undefined): FactsJobState | null {
  if (!json) return null;
  try {
    return JSON.parse(json) as FactsJobState;
  } catch {
    return null;
  }
}

function progressLabel(job: DataJob | undefined): string {
  if (!job) return '진행 중…';
  if (job.phase === 'FACTS') {
    const facts = parseFacts(job.factsJson);
    if (facts) {
      return `재무 수집 ${facts.symbolsDone}/${facts.symbolTotal}종목 · 팩트 ${facts.savedFacts}건`;
    }
    return '재무 수집 중…';
  }
  return `봉 수집 중… ${job.rowsImported ?? 0}봉`;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

/**
 * 봉 보유는 **슬라이스별로** 표시한다. 「봉 있음」 하나로 접으면 *분봉이 없다* 가 숨고,
 * 일봉만 있는 종목으로 분봉 백테스트를 제출하면 그때서야 알게 된다 — D-032·D-033 에서
 * 계속 막아 온 실패 방식이다.
 */
function SliceBadges({ symbol }: { symbol: SymbolSummary }) {
  return (
    <>
      {SLICES.map((slice) => {
        const state = symbol.slices.find((entry) => entry.slice === slice);
        const has = state?.hasData === true;
        return (
          <Badge key={slice} variant={has ? 'default' : 'outline'} className={cn(!has && 'opacity-60')}>
            <ChartCandlestick data-icon="inline-start" aria-hidden />
            {sliceLabel(slice)}
          </Badge>
        );
      })}
    </>
  );
}

/** 재무 보유 — 있고 없음만 본다 (D-033 범위 유지) */
function FactsBadge({ hasFacts }: { hasFacts?: boolean }) {
  if (hasFacts === undefined) return null;
  return hasFacts ? (
    <Badge variant="default">
      <FileText data-icon="inline-start" aria-hidden />
      재무
    </Badge>
  ) : (
    <Badge variant="outline" className="opacity-60">
      <FileX data-icon="inline-start" aria-hidden />
      재무
    </Badge>
  );
}

/**
 * 행 본문 — 편집 모드와 조회 모드가 같은 배치를 쓰되 이름만 갈린다.
 * `name` 이 null 이면 순수 텍스트(편집 모드: 클릭은 체크박스 몫), 노드면 그것을 그린다.
 */
function SymbolRowBody({
  symbol,
  nowMs,
  name,
}: {
  symbol: SymbolSummary;
  nowMs: number;
  name: ReactNode | null;
}) {
  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="font-medium">
          {name ?? (
            <>
              {symbol.name ?? symbol.code}
              {symbol.name ? (
                <span className="ml-1 text-xs font-normal text-muted-foreground">
                  {symbol.code}
                </span>
              ) : null}
            </>
          )}
        </p>
        <span className="flex shrink-0 items-center gap-1">
          <SliceBadges symbol={symbol} />
          <FactsBadge hasFacts={symbol.hasFacts} />
        </span>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        <SyncTimes symbol={symbol} nowMs={nowMs} />
        {' · '}
        {symbol.datasetCount > 0 ? `데이터셋 ${symbol.datasetCount}곳` : '데이터셋에서 미사용'}
      </p>
    </>
  );
}

/** 슬라이스마다 마지막 수집 시각이 다르다 — 하나로 접으면 거짓말이 된다 */
function SyncTimes({ symbol, nowMs }: { symbol: SymbolSummary; nowMs: number }) {
  const parts = symbol.slices
    .filter((state) => state.hasData || state.lastSyncedAtMs !== null)
    .map((state) => `${sliceLabel(state.slice)} ${formatRelativeTime(state.lastSyncedAtMs, nowMs)}`);
  if (parts.length === 0) return <span>수집 이력 없음</span>;
  return <span>{parts.join(' · ')}</span>;
}

export function SymbolsPanel() {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [includeFacts, setIncludeFacts] = useState(false);
  const [slice, setSlice] = useState<DatasetSlice>('1d');
  const [addOpen, setAddOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  // 봉차트 검증 드로어 대상 — 편집 모드가 아닐 때 행 이름을 눌러 연다
  const [inspect, setInspect] = useState<SymbolSummary | null>(null);
  const [startedJobId, setStartedJobId] = useState<string | null>(null);
  const nowMs = Date.now();

  const symbols = useQuery({
    queryKey: ['symbols'],
    queryFn: () =>
      api<{ symbols: SymbolSummary[]; runningSyncJobId: string | null }>('/symbols'),
    refetchInterval: 5_000,
  });

  const syncJobId = startedJobId ?? symbols.data?.runningSyncJobId ?? null;
  const syncJob = useQuery({
    queryKey: ['data-jobs', syncJobId],
    queryFn: () => api<{ job: DataJob }>(`/data-jobs/${syncJobId}`),
    enabled: syncJobId !== null,
    refetchInterval: 1_000,
  });

  // 잡이 끝나면 목록을 다시 읽어 배지·수집 시각을 갱신한다
  const settledRef = useRef<string | null>(null);
  useEffect(() => {
    const job = syncJob.data?.job;
    if (!job || job.status === 'RUNNING' || job.status === 'QUEUED') return;
    if (settledRef.current === job.id) return;
    settledRef.current = job.id;
    setStartedJobId(null);
    void queryClient.invalidateQueries({ queryKey: ['symbols'] });
    void queryClient.invalidateQueries({ queryKey: ['datasets'] });
    if (job.status === 'COMPLETED') toast.success(`수집 완료 — ${job.rowsImported ?? 0}봉`);
    else if (job.status === 'CANCELLED') toast.info('수집이 취소되었습니다');
    else toast.error(job.error ?? '수집이 실패했습니다');
  }, [syncJob.data, queryClient]);

  const rows = useMemo(() => sortSymbols(symbols.data?.symbols ?? []), [symbols.data]);
  const selectedCodes = useMemo(
    () => rows.filter((row) => selected.has(row.code)).map((row) => row.code),
    [rows, selected],
  );

  // 재무는 국내(KR) 전용이고 DART 키가 필요하다 (D-027) — 선택이 바뀔 때마다 다시 묻는다
  const estimate = useQuery({
    queryKey: ['symbols', 'sync-estimate', selectedCodes.join(','), slice],
    queryFn: () =>
      api<SyncEstimateResponse>(
        `/symbols/sync-estimate?codes=${selectedCodes.join(',')}&slice=${slice}`,
      ),
    enabled: selectedCodes.length > 0,
  });
  const factsBlockedReason =
    estimate.data?.facts.basis === 'UNSUPPORTED' ? estimate.data.facts.reason : null;
  useEffect(() => {
    if (factsBlockedReason !== null && includeFacts) setIncludeFacts(false);
  }, [factsBlockedReason, includeFacts]);

  const impact = useQuery({
    queryKey: ['symbols', 'removal-impact', selectedCodes.join(',')],
    queryFn: () =>
      postJson<{ impacts: RemovalImpact[] }>('/symbols/removal-impact', { codes: selectedCodes }),
    enabled: confirmRemove && selectedCodes.length > 0,
  });

  const syncMutation = useMutation({
    mutationFn: () =>
      postJson<{ job: { id: string } }>('/symbols/sync', {
        codes: selectedCodes,
        slice,
        includeFacts,
      }),
    onSuccess: ({ job }) => {
      setStartedJobId(job.id);
      settledRef.current = null;
      toast.success(`${selectedCodes.length}종목 수집을 시작했습니다`);
    },
    onError: (error) => toast.error(errorMessage(error, '수집을 시작할 수 없습니다')),
  });

  const removeMutation = useMutation({
    mutationFn: () => postJson<void>('/symbols/remove', { codes: selectedCodes }),
    onSuccess: () => {
      toast.success(`${selectedCodes.length}종목을 제거했습니다`);
      setSelected(new Set());
      setConfirmRemove(false);
      void queryClient.invalidateQueries({ queryKey: ['symbols'] });
      void queryClient.invalidateQueries({ queryKey: ['datasets'] });
    },
    onError: (error) => toast.error(errorMessage(error, '제거할 수 없습니다')),
  });

  const cancelMutation = useMutation({
    mutationFn: () => postJson<void>(`/data-jobs/${syncJobId}/cancel`, {}),
    onError: (error) => toast.error(errorMessage(error, '취소할 수 없습니다')),
  });

  const toggle = (code: string): void => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(code)) next.delete(code);
      else next.add(code);
      return next;
    });
  };
  const allSelected = rows.length > 0 && rows.every((row) => selected.has(row.code));
  const toggleAll = (): void => {
    setSelected(allSelected ? new Set() : new Set(rows.map((row) => row.code)));
  };
  const leaveEditing = (): void => {
    setEditing(false);
    setSelected(new Set());
  };

  const syncing = syncJobId !== null;
  const actionsEnabled = selectedCodes.length > 0 && !syncing;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          {rows.length}종목 · 봉과 재무는 종목에 저장되고 데이터셋은 참조만 갖습니다
        </p>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" className="h-11" onClick={() => setImportOpen(true)}>
            <Upload data-icon="inline-start" />
            CSV
          </Button>
          <Button variant="outline" size="sm" className="h-11" onClick={() => setAddOpen(true)}>
            <Plus data-icon="inline-start" />
            추가
          </Button>
          <Button
            variant={editing ? 'default' : 'outline'}
            size="sm"
            className="h-11"
            onClick={() => (editing ? leaveEditing() : setEditing(true))}
          >
            {editing ? '완료' : '편집'}
          </Button>
        </div>
      </div>

      {syncing ? (
        <Alert>
          <AlertDescription className="flex items-center justify-between gap-2">
            <span aria-live="polite">{progressLabel(syncJob.data?.job)}</span>
            <Button
              variant="outline"
              size="sm"
              disabled={cancelMutation.isPending}
              onClick={() => cancelMutation.mutate()}
            >
              <X data-icon="inline-start" />
              취소
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}

      {symbols.isLoading ? (
        <div className="space-y-2">
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
        </div>
      ) : rows.length === 0 ? (
        <Alert>
          <AlertDescription>
            등록된 종목이 없습니다. 「추가」로 종목을 등록하거나 CSV 를 가져오세요.
          </AlertDescription>
        </Alert>
      ) : (
        <Card>
          <CardContent className="divide-y p-0">
            {rows.map((symbol) => (
              <div key={symbol.code} className="flex items-start gap-3 p-4">
                {editing ? (
                  <Checkbox
                    id={`sel-${symbol.code}`}
                    className="mt-1"
                    checked={selected.has(symbol.code)}
                    onCheckedChange={() => toggle(symbol.code)}
                    aria-label={`${symbol.name ?? symbol.code} 선택`}
                  />
                ) : null}
                {/* 편집 모드에서만 <label> 이다 — 아닐 때 label 로 감싸면 안에 둔
                    버튼의 접근성 이름이 배지·수집 시각까지 삼켜 "삼성전자" 로 찾을 수
                    없게 된다 (e2e 가 잡았다). 구조를 모드별로 갈라 둔다. */}
                {editing ? (
                  <label htmlFor={`sel-${symbol.code}`} className="min-w-0 flex-1">
                    <SymbolRowBody symbol={symbol} nowMs={nowMs} name={null} />
                  </label>
                ) : (
                  <div className="min-w-0 flex-1">
                    <SymbolRowBody
                      symbol={symbol}
                      nowMs={nowMs}
                      name={
                        <button
                          type="button"
                          className="underline-offset-2 hover:underline"
                          onClick={() => setInspect(symbol)}
                        >
                          {symbol.name ?? symbol.code}
                          {symbol.name ? (
                            <span className="ml-1 text-xs font-normal text-muted-foreground">
                              {symbol.code}
                            </span>
                          ) : null}
                        </button>
                      }
                    />
                  </div>
                )}
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {/* 하단 고정 동작 바 — 종목 200개에서 아래쪽을 체크한 뒤 버튼을 찾아 다시
          올라가야 하는 일을 없앤다. 전체 선택도 여기 있어야 한다. */}
      {editing ? (
        <div className="sticky bottom-0 z-10 -mx-4 border-t bg-background/95 px-4 py-3 backdrop-blur supports-[backdrop-filter]:bg-background/80">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium">{selectedCodes.length}개 선택</span>
            <Button variant="ghost" size="sm" onClick={toggleAll}>
              {allSelected ? '전체 해제' : '전체 선택'}
            </Button>
            <span className="ml-auto flex flex-wrap items-center gap-2">
              <Select value={slice} onValueChange={(value) => setSlice(value as DatasetSlice)}>
                <SelectTrigger className="h-9 w-24" aria-label="수집 봉">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="1d">일봉</SelectItem>
                  <SelectItem value="1m">분봉</SelectItem>
                </SelectContent>
              </Select>
              <span className="flex items-center gap-1.5">
                <Checkbox
                  id="include-facts"
                  checked={includeFacts}
                  disabled={!actionsEnabled || factsBlockedReason !== null}
                  onCheckedChange={(checked) => setIncludeFacts(checked === true)}
                />
                <label htmlFor="include-facts" className="text-sm text-muted-foreground">
                  재무
                </label>
                {factsBlockedReason !== null ? (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span
                        tabIndex={0}
                        aria-label="재무 수집 불가 이유"
                        className="cursor-help text-muted-foreground"
                      >
                        ⓘ
                      </span>
                    </TooltipTrigger>
                    <TooltipContent>{factsBlockedReason}</TooltipContent>
                  </Tooltip>
                ) : null}
              </span>
              <Button
                size="sm"
                className="h-9"
                disabled={!actionsEnabled || syncMutation.isPending}
                onClick={() => syncMutation.mutate()}
              >
                <RefreshCw data-icon="inline-start" />
                동기화
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="h-9 text-destructive"
                disabled={!actionsEnabled}
                onClick={() => setConfirmRemove(true)}
              >
                <Trash2 data-icon="inline-start" />
                제거
              </Button>
            </span>
          </div>
          {factsBlockedReason !== null ? (
            <p className="mt-2 text-xs text-muted-foreground">{factsBlockedReason}</p>
          ) : null}
        </div>
      ) : null}

      {inspect ? (
        <CandleInspectDrawer
          slices={inspect.slices.map((entry) => ({ slice: entry.slice, hasData: entry.hasData }))}
          slice={inspect.slices.find((entry) => entry.hasData)?.slice ?? '1d'}
          symbol={inspect.code}
          symbolName={inspect.name}
          anchorTsMs={
            inspect.slices.find((entry) => entry.hasData)?.lastTsMs ?? null
          }
          open={inspect !== null}
          onOpenChange={(next) => {
            if (!next) setInspect(null);
          }}
        />
      ) : null}

      <AddSymbolDialog open={addOpen} onOpenChange={setAddOpen} />
      <ImportCsvDialog open={importOpen} onOpenChange={setImportOpen} />
      <RemoveDialog
        open={confirmRemove}
        onOpenChange={setConfirmRemove}
        codes={selectedCodes}
        impacts={impact.data?.impacts ?? []}
        pending={removeMutation.isPending}
        onConfirm={() => removeMutation.mutate()}
      />
    </div>
  );
}

function AddSymbolDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const [code, setCode] = useState('');
  const [market, setMarket] = useState('KR');
  const { markets, isError: marketsError } = useMarketSupport();

  const mutation = useMutation({
    mutationFn: () => postJson<unknown>('/symbols', { code: code.trim(), market }),
    onSuccess: () => {
      toast.success(`${code.trim()} 을 추가했습니다`);
      setCode('');
      onOpenChange(false);
      void queryClient.invalidateQueries({ queryKey: ['symbols'] });
    },
    onError: (error) => toast.error(errorMessage(error, '종목을 추가할 수 없습니다')),
  });

  // 이유는 **선택과 무관하게** 보여야 한다 (D-027 "이유를 Select 아래에 상시 표시").
  // 고른 시장에만 붙이면 US 가 왜 회색인지 묻는 사용자가 그걸 고를 수 없어 못 읽는다.
  const unsupportedMarkets = markets.filter(
    (entry) => !entry.datasetsSupported && entry.reason !== null,
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>종목 추가</DialogTitle>
          <DialogDescription>
            코드와 시장을 등록합니다. 이름은 종목 정보 소스에서 자동으로 채웁니다.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="new-code">종목 코드</Label>
            <Input
              id="new-code"
              value={code}
              placeholder="005930"
              onChange={(event) => setCode(event.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="new-market">시장</Label>
            <Select value={market} onValueChange={setMarket}>
              <SelectTrigger id="new-market">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {markets.map((entry) => (
                  <SelectItem
                    key={entry.market}
                    value={entry.market}
                    disabled={!entry.datasetsSupported}
                  >
                    {entry.market}
                    {entry.datasetsSupported ? '' : ' (지원 예정)'}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {unsupportedMarkets.map((entry) => (
              <p key={entry.market} className="text-xs text-muted-foreground">
                {entry.market} 는 아직 지원하지 않습니다 — {entry.reason}
              </p>
            ))}
            {marketsError ? (
              <p className="text-xs text-muted-foreground">
                시장 목록을 불러오지 못했습니다 — 지원 여부를 확인할 수 없습니다.
              </p>
            ) : null}
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            취소
          </Button>
          <Button
            disabled={code.trim().length === 0 || mutation.isPending}
            onClick={() => mutation.mutate()}
          >
            추가
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ImportCsvDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const [symbol, setSymbol] = useState('');
  const [market, setMarket] = useState('KR');
  const [timeframe, setTimeframe] = useState<'1d' | '1m'>('1d');
  const [file, setFile] = useState<File | null>(null);

  const mutation = useMutation({
    mutationFn: () => {
      const form = new FormData();
      form.set('market', market);
      form.set('timeframe', timeframe);
      form.set('symbol', symbol.trim());
      form.set('csv', file as File);
      return postForm<{ job: DataJob }>('/symbols/import', form);
    },
    onSuccess: ({ job }) => {
      if (job.status === 'FAILED') toast.error(job.error ?? 'CSV 가져오기가 실패했습니다');
      else toast.success(`${job.rowsImported ?? 0}봉을 가져왔습니다`);
      onOpenChange(false);
      setFile(null);
      void queryClient.invalidateQueries({ queryKey: ['symbols'] });
    },
    onError: (error) => toast.error(errorMessage(error, 'CSV 를 가져올 수 없습니다')),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>CSV 가져오기</DialogTitle>
          <DialogDescription>
            timestamp,open,high,low,close,volume 형식. 봉은 종목에 저장되고, 등록되지 않은 종목은
            함께 등록됩니다.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="csv-symbol">종목 코드</Label>
            <Input
              id="csv-symbol"
              value={symbol}
              placeholder="005930"
              onChange={(event) => setSymbol(event.target.value)}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label htmlFor="csv-market">시장</Label>
              <Select value={market} onValueChange={setMarket}>
                <SelectTrigger id="csv-market">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="KR">KR</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="csv-timeframe">봉</Label>
              <Select
                value={timeframe}
                onValueChange={(value) => setTimeframe(value as '1d' | '1m')}
              >
                <SelectTrigger id="csv-timeframe">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="1d">일봉</SelectItem>
                  <SelectItem value="1m">분봉</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="space-y-1">
            <Label htmlFor="csv-file">CSV 파일</Label>
            <Input
              id="csv-file"
              type="file"
              accept=".csv"
              onChange={(event) => setFile(event.target.files?.[0] ?? null)}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            취소
          </Button>
          <Button
            disabled={symbol.trim().length === 0 || file === null || mutation.isPending}
            onClick={() => mutation.mutate()}
          >
            가져오기
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * 제거 확인 — 영향받는 데이터셋을 먼저 보여준다. 비게 되는 데이터셋이 있으면 서버가
 * 409 로 막으므로 여기서도 실행 버튼을 잠그고 이유를 말한다.
 */
function RemoveDialog({
  open,
  onOpenChange,
  codes,
  impacts,
  pending,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  codes: string[];
  impacts: RemovalImpact[];
  pending: boolean;
  onConfirm: () => void;
}) {
  const wouldEmpty = [
    ...new Map(
      impacts.flatMap((impact) => impact.wouldEmpty.map((entry) => [entry.id, entry])),
    ).values(),
  ];
  const affected = [
    ...new Map(
      impacts.flatMap((impact) => impact.datasets.map((entry) => [entry.id, entry])),
    ).values(),
  ];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{codes.length}종목을 제거할까요?</DialogTitle>
          <DialogDescription>
            봉과 재무 데이터가 함께 지워지고 데이터셋 참조도 끊어집니다. 이 종목을 쓴 과거
            백테스트 결과는 재현할 수 없게 됩니다.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2 text-sm">
          {affected.length === 0 ? (
            <p className="text-muted-foreground">참조하는 데이터셋이 없습니다.</p>
          ) : (
            <ul className="space-y-1">
              {affected.map((entry) => (
                <li key={entry.id} className="flex items-center justify-between gap-2">
                  <span>{entry.name}</span>
                  <span className="text-muted-foreground">
                    {entry.remaining === 0 ? '비게 됨' : `${entry.remaining}종목 남음`}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {wouldEmpty.length > 0 ? (
            <Alert variant="destructive">
              <AlertDescription>
                {wouldEmpty.map((entry) => entry.name).join(', ')} 가 빈 데이터셋이 됩니다 —
                데이터셋을 먼저 삭제하거나 선택에서 일부 종목을 빼세요.
              </AlertDescription>
            </Alert>
          ) : null}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            취소
          </Button>
          <Button
            variant="outline"
            className="text-destructive"
            disabled={pending || wouldEmpty.length > 0}
            onClick={onConfirm}
          >
            제거
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
