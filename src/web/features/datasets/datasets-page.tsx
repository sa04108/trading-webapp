import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Check,
  CloudDownload,
  Info,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
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
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { api, postForm, postJson } from '@/lib/api-client';
import { formatDate } from '@/lib/format';
import { useMarketSupport, type MarketSupport } from '@/lib/use-market-support';
import { useStockNames, type StockInfo } from '@/lib/use-stock-names';
import { cn } from '@/lib/utils';
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
  phase: string | null;
  candlesMs: number | null;
  factsJson: string | null;
}

// 서버 라우트(datasets/coverage, data-jobs)와 타입을 공유할 수 없어(§tsconfig 분리) 여기서 그대로 재선언한다.
type FactsSyncEstimate =
  | { basis: 'UNSUPPORTED'; reason: string }
  | { basis: 'AFTER_CANDLES' }
  | {
      basis: 'PLANNED';
      fromYear: number;
      toYear: number;
      calls: number;
      estimatedMs: number;
      overDailyLimit: boolean;
    };

interface SyncEstimate {
  candles: { basis: 'LAST_RUN'; ms: number } | { basis: 'UNKNOWN' };
  facts: FactsSyncEstimate;
}

interface FactsJobState {
  fromYear: number | null;
  toYear: number | null;
  symbolsDone: number;
  symbolTotal: number;
  savedFacts: number;
  gapCount: number;
  failureMessage: string | null;
  skipReason: string | null;
}

/** ms → "약 5분" / "약 1시간 12분". 1분 미만은 "1분 미만" */
function formatEstimate(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return '1분 미만';
  if (minutes < 60) return `약 ${minutes}분`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `약 ${hours}시간` : `약 ${hours}시간 ${rest}분`;
}

/** 연도 범위 표기 — 한 해면 "2026년 갱신", 여러 해면 "2019~2026년" */
function formatYearRange(fromYear: number, toYear: number): string {
  return fromYear === toYear ? `${fromYear}년 갱신` : `${fromYear}~${toYear}년`;
}

function parseFactsJson(factsJson: string | null | undefined): FactsJobState | null {
  return factsJson ? (JSON.parse(factsJson) as FactsJobState) : null;
}

/** 잡 진행 중 표시 — CANDLES 단계는 봉, FACTS 단계는 재무 진행률 */
function progressLabel(job: DataJob | undefined): string {
  if (job?.phase !== 'FACTS') return '봉 수집 중…';
  const facts = parseFactsJson(job.factsJson);
  return facts
    ? `재무 수집 중 · ${facts.symbolsDone}/${facts.symbolTotal}종목 · ${facts.savedFacts}건`
    : '재무 수집 중…';
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
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

/**
 * "재무" 체크박스 옆 ⓘ 설명 툴팁.
 *
 * param-hint.tsx 와 동일하게 마우스오버가 아니라 클릭(터치 탭)으로만 연다 —
 * 모바일에는 hover 가 없고, Radix 기본 동작은 클릭하면 툴팁을 닫아버려 터치로는
 * 열 방법이 없다. open 을 직접 들고 닫는 경로(재탭·Escape·포커스 이탈·바깥 탭)를 챙긴다.
 */
function FactsInfoTooltip({ factsEstimate }: { factsEstimate: FactsSyncEstimate | undefined }) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent): void => {
      // 트리거 자신은 onClick 토글이 처리한다 — 여기서 닫으면 다시 열려 깜빡인다
      if (triggerRef.current?.contains(event.target as Node)) return;
      setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

  return (
    <Tooltip open={open}>
      <TooltipTrigger asChild>
        <button
          ref={triggerRef}
          type="button"
          aria-label="재무 함께 수집 설명"
          aria-expanded={open}
          className="rounded-full text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onClick={() => setOpen((prev) => !prev)}
          onBlur={() => setOpen(false)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setOpen(false);
          }}
        >
          <Info className="size-3.5" aria-hidden />
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" align="end" className="max-w-xs flex-col items-start gap-1">
        <span>이 데이터셋 종목의 재무제표까지 함께 받습니다.</span>
        {/* 미지원일 때만 띄우면 KR 데이터셋에서는 "재무가 국내 전용" 이라는
            사실이 아예 드러나지 않는다 — 항상 보인다 */}
        <span>국내(KR) 종목만 가능합니다 — DART 는 국내 공시 기관입니다.</span>
        <span>봉만 받는 것보다 오래 걸립니다 — 아래 예상 시간을 확인하세요.</span>
        {factsEstimate?.basis === 'UNSUPPORTED' ? (
          <span className="text-destructive">{factsEstimate.reason}</span>
        ) : null}
      </TooltipContent>
    </Tooltip>
  );
}

function DatasetCard({ dataset }: { dataset: DatasetSummary }) {
  const queryClient = useQueryClient();
  const [startedJobId, setStartedJobId] = useState<string | null>(null);
  const [newSymbol, setNewSymbol] = useState('');
  // null = 보기 모드, 문자열 = 편집 중인 입력값
  const [nameDraft, setNameDraft] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [inspectSymbol, setInspectSymbol] = useState<string | null>(null);
  // 기본 해제이고 기억하지 않는다 — 저장하면 데이터셋을 갱신할 때마다 의도 없이
  // 45분짜리 재무 수집이 걸린다
  const [includeFacts, setIncludeFacts] = useState(false);
  // 새로고침·다른 탭에서 시작된 동기화에도 붙는다 — 서버가 실행 중 잡을 알려준다
  const syncJobId = startedJobId ?? dataset.runningSyncJobId;

  const { data } = useQuery({
    queryKey: ['datasets', dataset.id, 'coverage'],
    queryFn: () =>
      api<{ coverage: CoverageRow[]; syncEstimate: SyncEstimate; note: string }>(
        `/datasets/${dataset.id}/coverage`,
      ),
  });
  const coverageBySymbol = new Map(data?.coverage.map((row) => [row.symbol, row]) ?? []);
  const syncEstimate = data?.syncEstimate;
  const factsEstimate = syncEstimate?.facts;
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
    const facts = parseFactsJson(job.factsJson);
    if (job.status === 'COMPLETED') {
      const factsPart =
        facts === null
          ? ''
          : ` · 재무 ${facts.savedFacts}건${facts.gapCount > 0 ? ` (누락 ${facts.gapCount}건)` : ''}`;
      toast.success(`동기화 완료: ${dataset.name} · ${job.rowsImported ?? 0}봉${factsPart}`);
      // 재무를 요청했는데 건너뛴 경우는 성공 토스트만으로는 드러나지 않는다 —
      // 사용자는 재무를 받았다고 믿는다
      if (facts?.skipReason) toast.warning(`재무 미수집: ${facts.skipReason}`);
    } else if (job.status === 'FAILED') {
      toast.error(`동기화 실패: ${job.error ?? '원인 미상'}`);
    } else if (job.status === 'CANCELLED') {
      toast.info(`동기화 취소됨: ${dataset.name} — 재실행 시 이어받습니다`);
    } else {
      return; // 진행 중 — 계속 폴링
    }
    setStartedJobId(null);
    void queryClient.invalidateQueries({ queryKey: ['datasets'] });
    void queryClient.invalidateQueries({ queryKey: ['datasets', dataset.id, 'coverage'] });
  }, [syncJob.data, syncJobId, dataset.name, dataset.id, queryClient]);

  const syncMutation = useMutation({
    mutationFn: () =>
      postJson<{ job: { id: string } }>('/datasets/sync', {
        datasetId: dataset.id,
        includeFacts,
      }),
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

  const renameMutation = useMutation({
    mutationFn: (name: string) =>
      api<{ dataset: DatasetSummary }>(`/datasets/${dataset.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ name }),
      }),
    onSuccess: async () => {
      setNameDraft(null);
      await queryClient.invalidateQueries({ queryKey: ['datasets'] });
    },
    onError: (error: unknown) => toast.error(errorMessage(error, '이름 변경 실패')),
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
  const trimmedDraft = nameDraft?.trim() ?? '';
  const canSaveName =
    trimmedDraft.length > 0 && trimmedDraft !== dataset.name && !renameMutation.isPending;
  const saveName = () => {
    if (trimmedDraft === dataset.name) setNameDraft(null);
    else if (canSaveName) renameMutation.mutate(trimmedDraft);
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2 text-base">
          {nameDraft === null ? (
            <>
              {dataset.name}
              <button
                type="button"
                aria-label="데이터셋 이름 수정"
                className="text-muted-foreground hover:text-foreground"
                onClick={() => setNameDraft(dataset.name)}
              >
                <Pencil className="size-3.5" />
              </button>
            </>
          ) : (
            <span className="flex items-center gap-1">
              <Input
                className="h-9 max-w-56"
                value={nameDraft}
                maxLength={64}
                autoFocus
                disabled={renameMutation.isPending}
                onChange={(e) => setNameDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') saveName();
                  if (e.key === 'Escape') setNameDraft(null);
                }}
              />
              <button
                type="button"
                aria-label="이름 저장"
                className="text-muted-foreground hover:text-foreground disabled:opacity-50"
                disabled={!canSaveName}
                onClick={saveName}
              >
                <Check className="size-4" />
              </button>
              <button
                type="button"
                aria-label="이름 수정 취소"
                className="text-muted-foreground hover:text-foreground"
                disabled={renameMutation.isPending}
                onClick={() => setNameDraft(null)}
              >
                <X className="size-4" />
              </button>
            </span>
          )}
          <Badge variant="secondary">{dataset.market}</Badge>
          {/* 1h 데이터셋의 실체는 1m 수집 + 1h 집계 (§11 관례) — 1h 만 표시하면 수집 봉과 불일치 */}
          <Badge variant="secondary">
            {dataset.timeframe === '1h' ? '1m→1h' : dataset.timeframe}
          </Badge>
          <Badge variant="outline">v{dataset.latestVersion}</Badge>
          <span className="ml-auto flex items-center gap-2">
            {syncJobId === null ? (
              <span className="flex items-center gap-1.5">
                <Checkbox
                  id={`facts-${dataset.id}`}
                  checked={includeFacts}
                  // 추정을 아직 못 받았으면 잠가 둔다 — 열어 두면 UNSUPPORTED 데이터셋에서
                  // 체크가 가능해지고, 라우트가 400 으로 막을 때까지 알 수 없다
                  disabled={factsEstimate === undefined || factsEstimate.basis === 'UNSUPPORTED'}
                  onCheckedChange={(checked) => setIncludeFacts(checked === true)}
                />
                <label htmlFor={`facts-${dataset.id}`} className="text-sm text-muted-foreground">
                  재무
                </label>
                <FactsInfoTooltip factsEstimate={factsEstimate} />
              </span>
            ) : null}
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
        {syncJobId !== null ? (
          <p className="text-xs text-muted-foreground" aria-live="polite">
            {progressLabel(syncJob.data?.job)}
          </p>
        ) : syncEstimate ? (
          <p
            className={cn(
              'text-xs',
              factsEstimate?.basis === 'PLANNED' && factsEstimate.overDailyLimit
                ? 'text-destructive'
                : 'text-muted-foreground',
            )}
          >
            {syncEstimate.candles.basis === 'LAST_RUN'
              ? `봉 ${formatEstimate(syncEstimate.candles.ms)} (직전 실행 기준)`
              : '첫 수집은 소요 시간을 예측할 수 없습니다'}
            {includeFacts && factsEstimate?.basis === 'PLANNED'
              ? ` + 재무 ${formatYearRange(factsEstimate.fromYear, factsEstimate.toYear)} · ${formatEstimate(factsEstimate.estimatedMs)}`
              : ''}
            {includeFacts && factsEstimate?.basis === 'AFTER_CANDLES'
              ? ' + 재무 범위는 봉 수집 후 결정됩니다'
              : ''}
            {includeFacts && factsEstimate?.basis === 'PLANNED' && factsEstimate.overDailyLimit
              ? ' · DART 일일 한도(40,000회)를 넘습니다 — 남은 구간은 다음 날 이어받으세요'
              : ''}
          </p>
        ) : null}
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

/** 시장 선택 + 미지원 시장 사유. 두 dialog 가 같은 규칙을 쓰게 묶는다. */
function MarketSelect({
  id,
  value,
  onChange,
  markets,
  isError,
}: {
  id: string;
  value: string;
  onChange: (market: string) => void;
  markets: readonly MarketSupport[];
  isError: boolean;
}) {
  // 목록이 아직 도착하지 않은 순간(로딩 중이거나 영구 실패) — SelectContent 가 비어 있으면
  // 선택된 값과 일치하는 SelectItem 이 없어 트리거가 설명 없이 텅 비어 보인다.
  // 목록이 올 때까지(혹은 영영 안 올 때까지) 잠가 두고 현재 값만 그대로 보여준다.
  if (markets.length === 0) {
    return (
      <>
        <Select value={value} disabled>
          <SelectTrigger id={id} className="h-11 w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={value}>{value}</SelectItem>
          </SelectContent>
        </Select>
        {isError ? (
          // 로딩 중은 곧 지나가니 말이 필요 없지만, 실패는 영구적이다 — 잠긴 채로
          // 이유 없이 두면 이 태스크의 취지(고를 수 없는 이유는 항상 보여야 한다)를
          // 스스로 어기게 된다
          <p className="text-xs text-muted-foreground">
            시장 목록을 불러오지 못했습니다 — 새로고침 후 다시 시도하세요. 목록이 올 때까지
            시장을 바꿀 수 없습니다.
          </p>
        ) : null}
      </>
    );
  }

  const unsupported = markets.filter((entry) => !entry.datasetsSupported);
  return (
    <>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger id={id} className="h-11 w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {markets.map((entry) => (
            <SelectItem
              key={entry.market}
              value={entry.market}
              // 고를 수 있게 두고 400 을 받게 하는 것은 명시가 아니다 —
              // 사용자는 종목을 다 넣은 뒤에야 알게 된다
              disabled={!entry.datasetsSupported}
            >
              {entry.market}
              {entry.datasetsSupported ? '' : ' (지원 예정)'}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {unsupported.map((entry) => (
        <p key={entry.market} className="text-xs text-muted-foreground">
          {entry.market} 는 아직 지원하지 않습니다 — {entry.reason}
        </p>
      ))}
    </>
  );
}

function BrokerDatasetDrawer() {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [market, setMarket] = useState('KR');
  const { markets, isError: marketsError } = useMarketSupport();
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
              <MarketSelect
                id="brokerMarket"
                value={market}
                onChange={setMarket}
                markets={markets}
                isError={marketsError}
              />
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
  // 기존 이름 자동완성 — import 는 이름이 upsert key 라 오타·옛 이름이 새 데이터셋을 만든다
  const { data: existing } = useQuery({
    queryKey: ['datasets'],
    queryFn: () => api<{ datasets: DatasetSummary[] }>('/datasets'),
  });
  const [market, setMarket] = useState('KR');
  const { markets, isError: marketsError } = useMarketSupport();
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
              list="import-dataset-names"
              value={datasetName}
              onChange={(e) => setDatasetName(e.target.value)}
            />
            <datalist id="import-dataset-names">
              {existing?.datasets.map((d) => <option key={d.id} value={d.name} />)}
            </datalist>
            <p className="text-xs text-muted-foreground">
              기존 이름을 선택하면 그 데이터셋에 추가되고, 새 이름이면 새로 만듭니다.
            </p>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="market">시장</Label>
              <MarketSelect
                id="market"
                value={market}
                onChange={setMarket}
                markets={markets}
                isError={marketsError}
              />
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
