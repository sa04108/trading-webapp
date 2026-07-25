import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Upload } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
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
import { api, postForm } from '@/lib/api-client';
import { formatDate } from '@/lib/format';

interface DatasetSummary {
  id: string;
  name: string;
  market: string;
  timeframe: string;
  symbols: string[];
  latestVersion: number;
}

interface CoverageRow {
  symbol: string;
  firstTsMs: number | null;
  lastTsMs: number | null;
  barCount: number;
  expectedBarCount: number | null;
  missingRanges: Array<{ fromTsMs: number; toTsMs: number }>;
}

function DatasetCard({ dataset }: { dataset: DatasetSummary }) {
  const { data } = useQuery({
    queryKey: ['datasets', dataset.id, 'coverage'],
    queryFn: () =>
      api<{ coverage: CoverageRow[]; note: string }>(`/datasets/${dataset.id}/coverage`),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2 text-base">
          {dataset.name}
          <Badge variant="secondary">{dataset.market}</Badge>
          <Badge variant="secondary">{dataset.timeframe}</Badge>
          <Badge variant="outline">v{dataset.latestVersion}</Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        {data ? (
          <>
            {data.coverage.map((row) => (
              <div key={row.symbol} className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-medium">{row.symbol}</span>
                <span className="text-muted-foreground">
                  {formatDate(row.firstTsMs)} ~ {formatDate(row.lastTsMs)} · {row.barCount}봉
                  {row.expectedBarCount !== null && row.expectedBarCount > row.barCount ? (
                    <Badge variant="destructive" className="ml-2">
                      누락 {row.expectedBarCount - row.barCount}
                    </Badge>
                  ) : null}
                </span>
              </div>
            ))}
            <p className="text-xs text-muted-foreground">{data.note}</p>
          </>
        ) : (
          <Skeleton className="h-10 w-full" />
        )}
      </CardContent>
    </Card>
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
        <Button className="h-11">
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
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">데이터</h2>
        <ImportDrawer />
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
            데이터셋이 없습니다. CSV 를 가져와 시작하세요.
          </CardContent>
        </Card>
      )}
    </div>
  );
}
