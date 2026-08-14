import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { toast } from 'sonner';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { api, postJson } from '@/lib/api-client';
import {
  BENCHMARK_IDS,
  BENCHMARK_NAMES,
  type BenchmarkId,
} from '../../../shared/schemas/benchmark.js';

interface BenchmarkResponse {
  benchmarkId: BenchmarkId;
  points: Array<{ date: string; close: number }>;
  covered: boolean;
  missingTradingDays: number;
  tradingDays: number;
  backfill: {
    state: 'IDLE' | 'RUNNING' | 'FAILED';
    cursorDate: string | null;
    error: string | null;
  };
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function yearAgoIso(): string {
  const date = new Date();
  date.setUTCFullYear(date.getUTCFullYear() - 1);
  return date.toISOString().slice(0, 10);
}

export function BenchmarkPanel() {
  const queryClient = useQueryClient();
  const [benchmarkId, setBenchmarkId] = useState<BenchmarkId>('KOSPI');
  const [from, setFrom] = useState(yearAgoIso);
  const [to, setTo] = useState(todayIso);
  const validPeriod = from !== '' && to !== '' && from <= to;
  const params = new URLSearchParams({ benchmarkId, from, to });
  const query = useQuery({
    queryKey: ['benchmarks', benchmarkId, from, to],
    queryFn: () => api<BenchmarkResponse>(`/benchmarks?${params}`),
    enabled: validPeriod,
    refetchInterval: (current) => current.state.data?.backfill.state === 'RUNNING' ? 1_000 : false,
  });
  const backfill = useMutation({
    mutationFn: () => postJson('/benchmarks/backfill', { from, to }),
    onSuccess: () => {
      toast.success('벤치마크 기간 수집을 시작했습니다');
      void queryClient.invalidateQueries({ queryKey: ['benchmarks'] });
    },
    onError: (error: unknown) => toast.error(error instanceof Error ? error.message : '수집 시작에 실패했습니다'),
  });

  const points = query.data?.points ?? [];
  const first = points[0];
  const last = points.at(-1);
  const returnPct = first && last ? (last.close / first.close - 1) * 100 : null;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader><CardTitle className="text-base">KRX 벤치마크</CardTitle></CardHeader>
        <CardContent className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <div className="space-y-1">
            <Label htmlFor="benchmark-id">지수</Label>
            <Select value={benchmarkId} onValueChange={(value) => setBenchmarkId(value as BenchmarkId)}>
              <SelectTrigger id="benchmark-id" className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                {BENCHMARK_IDS.map((id) => <SelectItem key={id} value={id}>{BENCHMARK_NAMES[id]}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="benchmark-from">시작일</Label>
            <Input id="benchmark-from" type="date" value={from} onChange={(event) => setFrom(event.target.value)} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="benchmark-to">종료일</Label>
            <Input id="benchmark-to" type="date" value={to} onChange={(event) => setTo(event.target.value)} />
          </div>
          <div className="sm:col-span-3">
            <Button
              type="button"
              disabled={!validPeriod || backfill.isPending || query.data?.backfill.state === 'RUNNING'}
              onClick={() => backfill.mutate()}
            >
              기간 수집
            </Button>
          </div>
        </CardContent>
      </Card>

      {query.data?.backfill.state === 'RUNNING' ? (
        <Alert><AlertDescription>수집 중 — {query.data.backfill.cursorDate ?? '준비 중'}</AlertDescription></Alert>
      ) : null}
      {query.data?.backfill.state === 'FAILED' ? (
        <Alert variant="destructive"><AlertDescription>수집 실패 — {query.data.backfill.error}</AlertDescription></Alert>
      ) : null}
      {query.isError ? (
        <Alert variant="destructive">
          <AlertDescription>{query.error instanceof Error ? query.error.message : '조회에 실패했습니다.'}</AlertDescription>
        </Alert>
      ) : null}
      {query.data && (query.data.tradingDays === 0 || query.data.missingTradingDays > 0) ? (
        <Alert>
          <AlertDescription>
            {query.data.tradingDays === 0
              ? '종목 마스터 거래일 데이터가 없어 기간 커버 여부를 판단할 수 없습니다.'
              : `${query.data.missingTradingDays}거래일의 벤치마크 데이터가 부족합니다.`}
          </AlertDescription>
        </Alert>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            {BENCHMARK_NAMES[benchmarkId]} · {points.length.toLocaleString()}건
            {returnPct === null ? '' : ` · 기간 수익률 ${returnPct >= 0 ? '+' : ''}${returnPct.toFixed(2)}%`}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {query.isLoading ? <p className="text-sm text-muted-foreground">조회 중...</p> : null}
          {!query.isLoading && points.length === 0 ? <p className="text-sm text-muted-foreground">저장된 데이터가 없습니다.</p> : null}
          {points.length > 0 ? (
            <div className="h-80 w-full" role="img" aria-label={`${BENCHMARK_NAMES[benchmarkId]} 종가 차트`}>
              <ResponsiveContainer>
                <LineChart data={points} margin={{ top: 4, right: 8, bottom: 0, left: 4 }}>
                  <CartesianGrid stroke="var(--border)" strokeDasharray="2 4" vertical={false} />
                  <XAxis
                    dataKey="date"
                    tickFormatter={(date: string) => date.slice(2)}
                    tick={{ fontSize: 11, fill: 'var(--muted-foreground)' }}
                    tickLine={false}
                    axisLine={{ stroke: 'var(--border)' }}
                    minTickGap={48}
                  />
                  <YAxis
                    tickFormatter={(value: number) => value.toLocaleString()}
                    tick={{ fontSize: 11, fill: 'var(--muted-foreground)' }}
                    tickLine={false}
                    axisLine={false}
                    width={64}
                    domain={['auto', 'auto']}
                  />
                  <Tooltip
                    contentStyle={{
                      backgroundColor: 'var(--popover)',
                      border: '1px solid var(--border)',
                      borderRadius: 8,
                      color: 'var(--popover-foreground)',
                      fontSize: 12,
                    }}
                    formatter={(value) => [Number(value).toLocaleString(), '종가']}
                  />
                  <Line
                    type="monotone"
                    dataKey="close"
                    stroke="var(--primary)"
                    strokeWidth={2}
                    dot={false}
                    isAnimationActive={false}
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}
