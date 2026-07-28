import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CloudDownload, Plus, RefreshCw, Trash2, Upload, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
  DrawerTrigger,
} from '@/components/ui/drawer';
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
import { api, postForm, postJson } from '@/lib/api-client';
import { formatDate } from '@/lib/format';
import { CandleInspectDrawer } from './candle-inspect-drawer';

interface DatasetSummary {
  id: string;
  name: string;
  market: string;
  timeframe: string;
  symbols: string[];
  latestVersion: number;
  runningSyncJobId: string | null;
}

interface CoverageRow {
  symbol: string;
  firstTsMs: number | null;
  lastTsMs: number | null;
  barCount: number;
  expectedBarCount: number | null;
  missingRanges: Array<{ fromTsMs: number; toTsMs: number }>;
}

interface DataJob {
  id: string;
  status: 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';
  rowsImported: number | null;
  error: string | null;
}

interface StockInfo {
  symbol: string;
  name: string;
  englishName: string | null;
  market: string;
  status: string;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

/** 코드 → 종목명. 소스 미설정이면 빈 결과라 코드만 표시된다. */
function useStockNames(symbols: string[]) {
  const key = symbols.join(',');
  const { data } = useQuery({
    queryKey: ['symbol-info', key],
    queryFn: () => api<{ stocks: StockInfo[] }>(`/symbols/info?symbols=${encodeURIComponent(key)}`),
    enabled: symbols.length > 0,
    staleTime: 60 * 60 * 1000, // 종목명은 사실상 불변
  });
  return new Map(data?.stocks.map((stock) => [stock.symbol, stock]) ?? []);
}

/** 입력 중인 코드의 이름 미리보기 — 500ms 디바운스 */
function useSymbolPreview(input: string) {
  const [debounced, setDebounced] = useState('');
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(input), 500);
    return () => clearTimeout(timer);
  }, [input]);

  const valid = /^[A-Za-z0-9._-]{2,20}$/.test(debounced);
  const { data, isFetching } = useQuery({
    queryKey: ['symbol-info', 'preview', debounced],
    queryFn: () =>
      api<{ stocks: StockInfo[] }>(`/symbols/info?symbols=${encodeURIComponent(debounced)}`),
    enabled: valid,
    staleTime: 60 * 60 * 1000,
  });
  if (!valid || debounced !== input) return null;
  if (isFetching) return { state: 'loading' as const };
  const stock = data?.stocks.find((s) => s.symbol.toUpperCase() === debounced.toUpperCase());
  return stock ? { state: 'found' as const, stock } : { state: 'unknown' as const };
}

function DatasetCard({ dataset }: { dataset: DatasetSummary }) {
  const queryClient = useQueryClient();
  const [startedJobId, setStartedJobId] = useState<string | null>(null);
  const [newSymbol, setNewSymbol] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [inspectSymbol, setInspectSymbol] = useState<string | null>(null);
  // 새로고침·다른 탭에서 시작된 동기화에도 붙는다 — 서버가 실행 중 잡을 알려준다
  const syncJobId = startedJobId ?? dataset.runningSyncJobId;

  const { data } = useQuery({
    queryKey: ['datasets', dataset.id, 'coverage'],
    queryFn: () =>
      api<{ coverage: CoverageRow[]; note: string }>(`/datasets/${dataset.id}/coverage`),
  });
  const coverageBySymbol = new Map(data?.coverage.map((row) => [row.symbol, row]) ?? []);
  const stockNames = useStockNames(dataset.symbols);
  const preview = useSymbolPreview(newSymbol);

  // 동기화는 202 + jobId 로 시작되고 백그라운드로 진행된다 — 종료까지 잡을 폴링
  const syncJob = useQuery({
    queryKey: ['data-jobs', syncJobId],
    queryFn: () => api<{ job: DataJob }>(`/data-jobs/${syncJobId}`),
    enabled: syncJobId !== null,
    refetchInterval: 2000,
  });
  useEffect(() => {
    const job = syncJob.data?.job;
    if (!job || syncJobId === null) return;
    if (job.status === 'COMPLETED') {
      toast.success(`동기화 완료: ${dataset.name} · ${job.rowsImported ?? 0}봉`);
    } else if (job.status === 'FAILED') {
      toast.error(`동기화 실패: ${job.error ?? '원인 미상'}`);
    } else if (job.status === 'CANCELLED') {
      toast.info(`동기화 취소됨: ${dataset.name} — 재실행 시 이어받습니다`);
    } else {
      return; // 진행 중 — 계속 폴링
    }
    setStartedJobId(null);
    void queryClient.invalidateQueries({ queryKey: ['datasets'] });
  }, [syncJob.data, syncJobId, dataset.name, queryClient]);

  const syncMutation = useMutation({
    mutationFn: () => postJson<{ job: { id: string } }>('/datasets/sync', { datasetId: dataset.id }),
    onSuccess: ({ job }) => setStartedJobId(job.id),
    onError: (error: unknown) => toast.error(errorMessage(error, '동기화 시작 실패')),
  });

  const cancelMutation = useMutation({
    mutationFn: () => postJson<{ status: string }>(`/data-jobs/${syncJobId}/cancel`, {}),
    onError: (error: unknown) => toast.error(errorMessage(error, '취소 실패')),
  });

  const symbolsMutation = useMutation({
    mutationFn: (change: { addSymbols?: string[]; removeSymbols?: string[] }) =>
      api<{ dataset: DatasetSummary }>(`/datasets/${dataset.id}`, {
        method: 'PATCH',
        body: JSON.stringify(change),
      }),
    onSuccess: async () => {
      setNewSymbol('');
      await queryClient.invalidateQueries({ queryKey: ['datasets'] });
    },
    onError: (error: unknown) => toast.error(errorMessage(error, '심볼 변경 실패')),
  });

  const deleteMutation = useMutation({
    mutationFn: () => api<void>(`/datasets/${dataset.id}`, { method: 'DELETE' }),
    onSuccess: async () => {
      toast.success(`삭제됨: ${dataset.name}`);
      await queryClient.invalidateQueries({ queryKey: ['datasets'] });
    },
    onError: (error: unknown) => toast.error(errorMessage(error, '삭제 실패')),
  });

  const syncing = syncMutation.isPending || syncJobId !== null;
  const cancelling = cancelMutation.isPending;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2 text-base">
          {dataset.name}
          <Badge variant="secondary">{dataset.market}</Badge>
          <Badge variant="secondary">{dataset.timeframe}</Badge>
          <Badge variant="outline">v{dataset.latestVersion}</Badge>
          <span className="ml-auto flex gap-2">
            {syncJobId !== null ? (
              <Button
                variant="outline"
                size="sm"
                className="h-9"
                disabled={cancelling}
                onClick={() => cancelMutation.mutate()}
              >
                <X data-icon="inline-start" />
                {cancelling ? '취소 중…' : '동기화 취소'}
              </Button>
            ) : (
              <Button
                variant="outline"
                size="sm"
                className="h-9"
                disabled={syncing}
                onClick={() => syncMutation.mutate()}
              >
                <RefreshCw data-icon="inline-start" />
                동기화
              </Button>
            )}
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
      <CardContent className="space-y-3 text-sm">
        {dataset.symbols.map((symbol) => {
          const row = coverageBySymbol.get(symbol);
          return (
            <div key={symbol} className="flex flex-wrap items-center justify-between gap-2">
              <span className="flex items-center gap-1 font-medium">
                <button
                  type="button"
                  className="underline-offset-2 hover:underline"
                  onClick={() => setInspectSymbol(symbol)}
                >
                  {symbol}
                </button>
                {stockNames.get(symbol) ? (
                  <span className="font-normal text-muted-foreground">
                    {stockNames.get(symbol)!.name}
                  </span>
                ) : null}
                <button
                  type="button"
                  aria-label={`${symbol} 수집 제외`}
                  className="text-muted-foreground hover:text-destructive disabled:opacity-50"
                  disabled={symbolsMutation.isPending || dataset.symbols.length <= 1}
                  onClick={() => symbolsMutation.mutate({ removeSymbols: [symbol] })}
                >
                  <X className="size-3.5" />
                </button>
              </span>
              <span className="text-muted-foreground">
                {row && row.barCount > 0 ? (
                  <>
                    {formatDate(row.firstTsMs)} ~ {formatDate(row.lastTsMs)} · {row.barCount}봉
                    {row.expectedBarCount !== null && row.expectedBarCount > row.barCount ? (
                      <Badge variant="destructive" className="ml-2">
                        누락 {row.expectedBarCount - row.barCount}
                      </Badge>
                    ) : null}
                  </>
                ) : (
                  '데이터 없음 — 동기화 또는 CSV 가져오기'
                )}
              </span>
            </div>
          );
        })}

        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <Input
              className="h-9 max-w-44"
              placeholder="종목 코드·티커 (005930)"
              value={newSymbol}
              onChange={(e) => setNewSymbol(e.target.value.trim())}
            />
            <Button
              variant="outline"
              size="sm"
              className="h-9"
              disabled={newSymbol.length === 0 || symbolsMutation.isPending}
              onClick={() => symbolsMutation.mutate({ addSymbols: [newSymbol] })}
            >
              <Plus data-icon="inline-start" />
              추가
            </Button>
          </div>
          {preview ? (
            <p className="text-xs text-muted-foreground">
              {preview.state === 'loading'
                ? '종목 확인 중…'
                : preview.state === 'found'
                  ? `${preview.stock.name} (${preview.stock.market})${preview.stock.status !== 'ACTIVE' ? ' — 거래 불가 상태' : ''}`
                  : '조회되지 않는 코드입니다 — 자격 증명 미설정이거나 없는 종목일 수 있습니다'}
            </p>
          ) : null}
        </div>

        {data ? <p className="text-xs text-muted-foreground">{data.note}</p> : null}
      </CardContent>

      {inspectSymbol !== null ? (
        <CandleInspectDrawer
          datasetId={dataset.id}
          datasetTimeframe={dataset.timeframe}
          symbol={inspectSymbol}
          symbolName={stockNames.get(inspectSymbol)?.name ?? null}
          anchorTsMs={coverageBySymbol.get(inspectSymbol)?.lastTsMs ?? null}
          open
          onOpenChange={(next) => {
            if (!next) setInspectSymbol(null);
          }}
        />
      ) : null}

      <Dialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>데이터셋 삭제</DialogTitle>
            <DialogDescription>
              “{dataset.name}” 의 메타데이터와 저장된 캔들 전체가 삭제됩니다. 완료된 백테스트
              기록은 남지만 같은 데이터로 다시 실행할 수는 없습니다. 되돌릴 수 없습니다.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" className="h-11" onClick={() => setConfirmDelete(false)}>
              취소
            </Button>
            <Button
              variant="destructive"
              className="h-11"
              onClick={() => {
                setConfirmDelete(false);
                deleteMutation.mutate();
              }}
            >
              삭제
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

function BrokerDatasetDrawer() {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [market, setMarket] = useState('KR');
  const [collect, setCollect] = useState('1d');
  const [symbolsInput, setSymbolsInput] = useState('');

  const symbols = symbolsInput
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  const createMutation = useMutation({
    mutationFn: () =>
      postJson<{ dataset: DatasetSummary }>('/datasets', { name, market, collect, symbols }),
    onSuccess: async ({ dataset }) => {
      toast.success(`데이터셋 생성됨: ${dataset.name} — 동기화로 수집을 시작하세요`);
      setOpen(false);
      setName('');
      setSymbolsInput('');
      await queryClient.invalidateQueries({ queryKey: ['datasets'] });
    },
    onError: (error: unknown) => toast.error(errorMessage(error, '생성 실패')),
  });

  return (
    <Drawer open={open} onOpenChange={setOpen}>
      <DrawerTrigger asChild>
        <Button className="h-11">
          <CloudDownload data-icon="inline-start" />
          증권사 데이터셋
        </Button>
      </DrawerTrigger>
      <DrawerContent>
        <DrawerHeader>
          <DrawerTitle>증권사 데이터셋 만들기</DrawerTitle>
          <DrawerDescription>
            증권사 API 에서 캔들을 수집할 데이터셋입니다. 일봉은 보관 깊이까지, 1분봉은
            시간봉으로 자동 집계됩니다. 생성 후 “동기화”로 수집을 시작하세요.
          </DrawerDescription>
        </DrawerHeader>
        <div className="space-y-4 p-4 pb-8">
          <div className="space-y-2">
            <Label htmlFor="brokerDatasetName">데이터셋 이름</Label>
            <Input
              id="brokerDatasetName"
              className="h-11"
              placeholder="KR-일봉"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="brokerMarket">시장</Label>
              <Select value={market} onValueChange={setMarket}>
                <SelectTrigger id="brokerMarket" className="h-11 w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="KR">KR</SelectItem>
                  <SelectItem value="US">US</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="brokerCollect">수집 봉</Label>
              <Select value={collect} onValueChange={setCollect}>
                <SelectTrigger id="brokerCollect" className="h-11 w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="1d">일봉</SelectItem>
                  <SelectItem value="1m">1분봉 (시간봉 자동 집계)</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="brokerSymbols">종목 코드·티커 (쉼표·공백 구분)</Label>
            <Input
              id="brokerSymbols"
              className="h-11"
              placeholder="005930, 000660"
              value={symbolsInput}
              onChange={(e) => setSymbolsInput(e.target.value)}
            />
          </div>
          <Button
            className="h-11 w-full"
            disabled={name.length === 0 || symbols.length === 0 || createMutation.isPending}
            onClick={() => createMutation.mutate()}
          >
            {createMutation.isPending ? '생성 중…' : '만들기'}
          </Button>
        </div>
      </DrawerContent>
    </Drawer>
  );
}

function ImportDrawer() {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [datasetName, setDatasetName] = useState('');
  const [market, setMarket] = useState('KR');
  const [timeframe, setTimeframe] = useState('1m');
  const [symbol, setSymbol] = useState('');
  const [file, setFile] = useState<File | null>(null);

  const importMutation = useMutation({
    mutationFn: async () => {
      if (!file) throw new Error('CSV 파일을 선택하세요');
      const form = new FormData();
      form.set('datasetName', datasetName);
      form.set('market', market);
      form.set('timeframe', timeframe);
      form.set('symbol', symbol);
      form.set('file', file);
      return postForm<{ job: { status: string; rowsImported: number | null; error: string | null } }>(
        '/datasets/import',
        form,
      );
    },
    onSuccess: async ({ job }) => {
      toast.success(`가져오기 완료: ${job.rowsImported ?? 0}봉${job.error ? ` (${job.error})` : ''}`);
      setOpen(false);
      await queryClient.invalidateQueries({ queryKey: ['datasets'] });
    },
    onError: (error: unknown) => {
      toast.error(error instanceof Error ? error.message : '가져오기 실패');
    },
  });

  const canSubmit = datasetName.length > 0 && symbol.length > 0 && file !== null;

  return (
    <Drawer open={open} onOpenChange={setOpen}>
      <DrawerTrigger asChild>
        <Button variant="outline" className="h-11">
          <Upload data-icon="inline-start" />
          CSV 가져오기
        </Button>
      </DrawerTrigger>
      <DrawerContent>
        <DrawerHeader>
          <DrawerTitle>CSV 가져오기</DrawerTitle>
          <DrawerDescription>
            헤더: timestamp,open,high,low,close,volume (UTC). 1m 은 1h 로 자동 집계됩니다.
          </DrawerDescription>
        </DrawerHeader>
        <div className="space-y-4 p-4 pb-8">
          <div className="space-y-2">
            <Label htmlFor="datasetName">데이터셋 이름</Label>
            <Input
              id="datasetName"
              className="h-11"
              placeholder="kr-hourly-v1"
              value={datasetName}
              onChange={(e) => setDatasetName(e.target.value)}
            />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="market">시장</Label>
              <Select value={market} onValueChange={setMarket}>
                <SelectTrigger id="market" className="h-11 w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="KR">KR</SelectItem>
                  <SelectItem value="US">US</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="timeframe">봉 주기</Label>
              <Select value={timeframe} onValueChange={setTimeframe}>
                <SelectTrigger id="timeframe" className="h-11 w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="1m">1분봉</SelectItem>
                  <SelectItem value="1h">1시간봉</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="symbol">종목 코드</Label>
            <Input
              id="symbol"
              className="h-11"
              placeholder="005930"
              value={symbol}
              onChange={(e) => setSymbol(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="file">CSV 파일</Label>
            <Input
              id="file"
              type="file"
              accept=".csv"
              className="h-11"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            />
          </div>
          <Button
            className="h-11 w-full"
            disabled={!canSubmit || importMutation.isPending}
            onClick={() => importMutation.mutate()}
          >
            {importMutation.isPending ? '가져오는 중…' : '가져오기'}
          </Button>
        </div>
      </DrawerContent>
    </Drawer>
  );
}

export function DatasetsPage() {
  const { data, isLoading } = useQuery({
    queryKey: ['datasets'],
    queryFn: () => api<{ datasets: DatasetSummary[] }>('/datasets'),
  });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-semibold">데이터</h2>
        <div className="flex flex-wrap gap-2">
          <BrokerDatasetDrawer />
          <ImportDrawer />
        </div>
      </div>

      {isLoading ? (
        <Skeleton className="h-32 w-full" />
      ) : data && data.datasets.length > 0 ? (
        <div className="space-y-4">
          {data.datasets.map((dataset) => (
            <DatasetCard key={dataset.id} dataset={dataset} />
          ))}
        </div>
      ) : (
        <Card>
          <CardContent className="py-8 text-center text-sm text-muted-foreground">
            데이터셋이 없습니다. 증권사 데이터셋을 만들거나 CSV 를 가져와 시작하세요.
          </CardContent>
        </Card>
      )}
    </div>
  );
}
