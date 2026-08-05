import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, RefreshCw, Trash2, Upload, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { PageSizeInput, Pagination } from '@/components/pagination';
import { Alert, AlertDescription } from '@/components/ui/alert';
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
import { Textarea } from '@/components/ui/textarea';
import { api, postForm, postJson } from '@/lib/api-client';
import { parsePageSize } from '@/lib/page-size';
import { pageWindow } from '@/lib/pagination';
import { useMarketSupport } from '@/lib/use-market-support';
import { useSymbolMetrics } from '@/lib/use-symbol-metrics';
import { CandleInspectDrawer } from './candle-inspect-drawer';
import { parseSymbolCodes, splitRegistered } from './symbol-codes';
import {
  SymbolRowBody,
  SymbolSearchInput,
  SymbolSortNote,
  SymbolSortSelect,
} from './symbol-list';
import { filterSymbols } from './symbol-search';
import { SymbolSelectScopeButtons } from './symbol-select-scope';
import { countWithMetric, sortSymbols, type SymbolSortKey } from './symbol-sort';
import { SyncDialog } from './sync-dialog';
import type {
  DataJob,
  FactsJobState,
  SymbolSummary,
} from './symbol-types';

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

export function SymbolsPanel() {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [syncOpen, setSyncOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  // 봉차트 검증 드로어 대상 — 편집 모드가 아닐 때 행 이름을 눌러 연다
  const [inspect, setInspect] = useState<SymbolSummary | null>(null);
  const [startedJobId, setStartedJobId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(0);
  const [pageSizeText, setPageSizeText] = useState('20');
  // 기본은 가나다순 — 지표가 도착하기 전에 규모순으로 시작하면 목록이 한 번 흔들린다
  const [sortKey, setSortKey] = useState<SymbolSortKey>('NAME');
  const pageSize = parsePageSize(pageSizeText, 20);
  const nowMs = Date.now();

  const { metrics, rankingLimit, unavailable: metricsUnavailable } = useSymbolMetrics();

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

  const all = useMemo(
    () => sortSymbols(symbols.data?.symbols ?? [], sortKey, metrics),
    [symbols.data, sortKey, metrics],
  );
  const registeredCodes = useMemo(() => new Set(all.map((row) => row.code)), [all]);
  const filtered = useMemo(() => filterSymbols(all, query), [all, query]);

  const { pageCount, currentPage, from, to } = pageWindow(filtered.length, pageSize, page);
  const visible = filtered.slice(from, to);

  /**
   * 선택은 **전체 목록** 기준으로 뽑는다. 보이는 페이지에서만 뽑으면 2페이지에서 고른
   * 종목이 1페이지로 넘어간 순간 동기화·제거 대상에서 조용히 빠진다 — 사용자는 「12개
   * 선택」을 보면서 3개만 수집되는 것을 뒤늦게 알게 된다.
   */
  const selectedCodes = useMemo(
    () => all.filter((row) => selected.has(row.code)).map((row) => row.code),
    [all, selected],
  );

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
          {query.trim().length > 0
            ? `${filtered.length}/${all.length}종목`
            : `${all.length}종목`}{' '}
          · 봉과 재무는 종목에 저장되고 데이터셋은 참조만 갖습니다
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

      {/* 검색·정렬·페이지당 표시 수 — 종목 1,000개에서 목록을 훑어 찾는 일을 없앤다.
          데이터셋의 종목 편집이 같은 컴포넌트를 쓴다 (symbol-list.tsx). */}
      <div className="flex flex-wrap items-center gap-2">
        <SymbolSearchInput
          value={query}
          onChange={(next) => {
            setQuery(next);
            setPage(0);
          }}
        />
        <SymbolSortSelect
          value={sortKey}
          unavailable={metricsUnavailable}
          onChange={(next) => {
            setSortKey(next);
            setPage(0);
          }}
        />
        <PageSizeInput
          value={pageSizeText}
          label="종목 페이지당 표시 수"
          unit="종목"
          onChange={(next) => {
            setPageSizeText(next);
            setPage(0);
          }}
        />
      </div>
      <SymbolSortNote
        sortKey={sortKey}
        total={all.length}
        withMetric={countWithMetric(
          all.map((row) => row.code),
          sortKey,
          metrics,
        )}
        rankingLimit={rankingLimit}
        unavailable={metricsUnavailable}
      />

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
      ) : all.length === 0 ? (
        <Alert>
          <AlertDescription>
            등록된 종목이 없습니다. 「추가」로 종목을 등록하거나 CSV 를 가져오세요.
          </AlertDescription>
        </Alert>
      ) : filtered.length === 0 ? (
        <Alert>
          <AlertDescription>
            「{query.trim()}」 와 맞는 종목이 없습니다 — 이름 일부나 코드 앞자리로도 찾을 수
            있습니다.
          </AlertDescription>
        </Alert>
      ) : (
        <Card>
          <CardContent className="divide-y p-0">
            {visible.map((symbol) => (
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
                    <SymbolRowBody
                      symbol={symbol}
                      nowMs={nowMs}
                      name={null}
                      metrics={metrics.get(symbol.code)}
                      sortKey={sortKey}
                    />
                  </label>
                ) : (
                  <div className="min-w-0 flex-1">
                    <SymbolRowBody
                      symbol={symbol}
                      nowMs={nowMs}
                      metrics={metrics.get(symbol.code)}
                      sortKey={sortKey}
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

      <Pagination
        ariaLabel="종목 목록 페이지 이동"
        currentPage={currentPage}
        pageCount={pageCount}
        total={{ count: filtered.length, unit: '종목' }}
        onPageChange={setPage}
      />

      {/* 하단 고정 동작 바 — 종목 200개에서 아래쪽을 체크한 뒤 버튼을 찾아 다시
          올라가야 하는 일을 없앤다. 전체 선택도 여기 있어야 한다.

          모바일에서는 하단 탭바(fixed, z-20) 높이만큼 띄운다. `bottom-0` 이면 뷰포트
          맨 아래에 붙어 탭바가 그 위를 덮고, 동기화·제거를 눌러도 클릭이 탭바로 간다 —
          버튼이 보이는데 안 눌리는 상태였다. */}
      {editing ? (
        <div className="sticky bottom-[calc(3.5rem+env(safe-area-inset-bottom))] z-10 -mx-4 border-t bg-background/95 px-4 py-3 backdrop-blur supports-[backdrop-filter]:bg-background/80 md:bottom-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium">{selectedCodes.length}개 선택</span>
            <SymbolSelectScopeButtons
              filtered={filtered}
              visible={visible}
              pageCount={pageCount}
              selected={selected}
              query={query}
              onChange={setSelected}
            />
            <span className="ml-auto flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                className="h-9"
                disabled={!actionsEnabled}
                onClick={() => setSyncOpen(true)}
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
        </div>
      ) : null}

      <SyncDialog
        open={syncOpen}
        onOpenChange={setSyncOpen}
        symbols={all.filter((symbol) => selected.has(symbol.code))}
        onStarted={(jobId) => {
          setStartedJobId(jobId);
          settledRef.current = null;
        }}
      />

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

      <AddSymbolDialog open={addOpen} onOpenChange={setAddOpen} registered={registeredCodes} />
      <ImportCsvDialog open={importOpen} onOpenChange={setImportOpen} />
      <RemoveDialog
        open={confirmRemove}
        onOpenChange={setConfirmRemove}
        codes={selectedCodes}
        pending={removeMutation.isPending}
        onConfirm={() => removeMutation.mutate()}
      />
    </div>
  );
}

/**
 * 종목 추가 — 코드 하나든 쉼표로 구분한 200개든 같은 입력에 넣는다.
 *
 * CSV 가져오기와 갈라 두는 이유: 저기는 tohlcv 봉 파일을 넣는 자리고, 여기는 "어떤
 * 종목을 등록할지" 의 목록이다. 봉이 없어도 종목은 등록돼야 하고(그 뒤 동기화가 채운다),
 * 목록을 넣으려고 봉 파일을 만들게 할 수는 없다.
 *
 * 이미 등록된 코드는 **보내기 전에** 갈라낸다 — 목록은 이미 받아 둔 것이라 서버에
 * 물어볼 필요가 없고, 20개 중 3개가 중복이라는 사실을 누르기 전에 아는 편이 낫다.
 */
function AddSymbolDialog({
  open,
  onOpenChange,
  registered,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  registered: ReadonlySet<string>;
}) {
  const queryClient = useQueryClient();
  const [text, setText] = useState('');
  const [market, setMarket] = useState('KR');
  const { markets, isError: marketsError } = useMarketSupport();

  const parsed = parseSymbolCodes(text);
  const { fresh, already } = splitRegistered(parsed.codes, registered);

  const mutation = useMutation({
    mutationFn: () =>
      postJson<{ added: SymbolSummary[]; skipped: Array<{ code: string; reason: string }> }>(
        '/symbols',
        { codes: fresh, market },
      ),
    onSuccess: ({ added, skipped }) => {
      // 부분 성공을 성공으로 뭉개지 않는다 — 무엇이 빠졌는지 그 자리에서 말한다
      if (skipped.length > 0) {
        toast.warning(
          `${added.length}종목을 추가했습니다 — ${skipped.map((entry) => entry.code).join(', ')} 는 빠졌습니다`,
        );
      } else {
        toast.success(`${added.length}종목을 추가했습니다`);
      }
      setText('');
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
            코드를 쉼표(또는 줄바꿈)로 구분해 여러 개를 한 번에 등록합니다. 이름은 종목 정보
            소스에서 자동으로 채웁니다.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="new-codes">종목 코드</Label>
            <Textarea
              id="new-codes"
              value={text}
              rows={4}
              placeholder="005930, 000660, 035720"
              onChange={(event) => setText(event.target.value)}
            />
            <AddSymbolPreview parsed={parsed} fresh={fresh} already={already} />
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
          <Button disabled={fresh.length === 0 || mutation.isPending} onClick={() => mutation.mutate()}>
            {fresh.length > 1 ? `${fresh.length}종목 추가` : '추가'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * 붙여넣은 목록을 눌러 보기 전에 요약한다. 200개를 넣고 「추가」를 누른 뒤 토스트로만
 * 결과를 듣는 것과, 누르기 전에 몇 개가 새 종목인지 아는 것은 다른 경험이다.
 */
function AddSymbolPreview({
  parsed,
  fresh,
  already,
}: {
  parsed: ReturnType<typeof parseSymbolCodes>;
  fresh: readonly string[];
  already: readonly string[];
}) {
  if (parsed.codes.length === 0 && parsed.invalid.length === 0) return null;
  return (
    <div className="space-y-0.5 text-xs">
      <p className="text-muted-foreground">
        {fresh.length}종목 추가
        {already.length > 0 ? ` · 이미 등록 ${already.length}종목` : ''}
        {parsed.duplicates > 0 ? ` · 중복 입력 ${parsed.duplicates}건` : ''}
      </p>
      {already.length > 0 ? (
        <p className="text-muted-foreground">이미 등록: {already.join(', ')}</p>
      ) : null}
      {/* 형식 위반은 조용히 버리지 않는다 — 붙여넣은 20개 중 19개만 들어가면 사용자는
          어느 하나가 왜 빠졌는지 알 수 없다 */}
      {parsed.invalid.length > 0 ? (
        <p className="text-destructive">
          형식이 올바르지 않아 제외: {parsed.invalid.join(', ')} (영숫자·. _ - 1~20자)
        </p>
      ) : null}
    </div>
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
 * 제거 확인 — 봉·재무가 함께 지워져 과거 백테스트를 재현할 수 없게 되므로 되돌릴 수
 * 없다는 사실을 먼저 알린다.
 */
function RemoveDialog({
  open,
  onOpenChange,
  codes,
  pending,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  codes: string[];
  pending: boolean;
  onConfirm: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{codes.length}종목을 제거할까요?</DialogTitle>
          <DialogDescription>
            봉과 재무 데이터가 함께 지워집니다. 이 종목을 쓴 과거 백테스트 결과는 재현할 수 없게
            됩니다.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            취소
          </Button>
          <Button
            variant="outline"
            className="text-destructive"
            disabled={pending}
            onClick={onConfirm}
          >
            제거
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
