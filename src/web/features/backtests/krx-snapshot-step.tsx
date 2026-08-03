import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { PageSizeInput, Pagination } from '@/components/pagination';
import { api, ApiError, postJson } from '@/lib/api-client';
import { formatCompactNumber } from '@/lib/format';
import { parsePageSize } from '@/lib/page-size';
import { pageWindow } from '@/lib/pagination';
import { useHistoricalUniverseStatus, useUniverseSnapshots } from '@/lib/use-historical-universe';
import { cn } from '@/lib/utils';
import { filterSymbols } from '@/features/datasets/symbol-search';
import { MAX_UNIVERSE_SYMBOLS } from '../../../shared/schemas/universe-limit.js';
import type {
  HistoricalCandidateDto,
  HistoricalUniversePreviewDto,
  UniverseSnapshotDetailDto,
} from '../../../shared/schemas/historical-universe.js';
import { selectionMethodOf, topNCodes } from './krx-selection';

/** 「시가총액 상위 N종목 선택」의 N — 백테스트 유니버스 상한과 같은 값이다 */
const TOP_N = MAX_UNIVERSE_SYMBOLS;

/**
 * 위저드 2단계의 「과거 KRX 시점」 탭.
 *
 * 흐름은 조회 → 요약 → 후보 목록(검색·페이징·상위 N·수동 체크) → 확정 순서다.
 * 확정하면 서버가 스냅샷을 영구히 만들고, 그 결과를 `onSnapshotReady` 로 위로
 * 올려 위저드 상태(`selectedSnapshot`)에 반영한다. 이 컴포넌트 자신은 확정된
 * 스냅샷을 상태로 갖지 않는다 — 위저드가 유일한 소유자다.
 *
 * `SymbolCheckList` 를 재사용하지 않는 이유: 그 목록은 **등록된 현재 종목**과
 * `useSymbolMetrics()`(거래대금·거래량) 을 전제로 한다. 과거 후보는 시가총액 하나로
 * 정렬이 고정되고 서버가 이미 매긴 rank 를 쓰므로 화면이 다시 정렬할 이유가 없다.
 * 검색·페이징 같은 순수 표현 부품(`filterSymbols`·`Pagination`·`PageSizeInput`)만
 * 공유한다.
 */
export function KrxSnapshotStep({
  selectedSnapshot,
  onSnapshotReady,
}: {
  selectedSnapshot: UniverseSnapshotDetailDto | null;
  onSnapshotReady: (snapshot: UniverseSnapshotDetailDto) => void;
}) {
  const { status, isLoading: statusLoading } = useHistoricalUniverseStatus();
  const { snapshots } = useUniverseSnapshots();
  const queryClient = useQueryClient();

  const [date, setDate] = useState('');
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(0);
  const [pageSizeText, setPageSizeText] = useState('20');

  const previewMutation = useMutation({
    mutationFn: (requestedDate: string) =>
      postJson<HistoricalUniversePreviewDto>('/universe/historical/preview', {
        date: requestedDate,
      }),
    onSuccess: () => {
      // 새 조회는 이전 선택의 근거(이전 previewId)를 무효화한다 — 선택도 함께 비운다
      setSelected(new Set());
      setQuery('');
      setPage(0);
    },
  });

  const createMutation = useMutation({
    mutationFn: (body: {
      previewId: string;
      standardCodes: string[];
      selectionMethod: 'TOP_MARKET_CAP_N' | 'MANUAL_FROM_KRX_SNAPSHOT';
      selectionN?: number;
    }) => postJson<{ snapshot: UniverseSnapshotDetailDto }>('/universe/snapshots', body),
    onSuccess: (data) => {
      void queryClient.invalidateQueries({ queryKey: ['universe', 'snapshots'] });
      onSnapshotReady(data.snapshot);
    },
  });

  const loadMutation = useMutation({
    mutationFn: (snapshotId: string) =>
      api<{ snapshot: UniverseSnapshotDetailDto }>(`/universe/snapshots/${snapshotId}`),
    onSuccess: (data) => onSnapshotReady(data.snapshot),
  });

  const preview = previewMutation.data ?? null;
  const candidates: readonly HistoricalCandidateDto[] = preview?.candidates ?? [];

  // filterSymbols 는 SearchableSymbol(code·name) 을 기대한다 — 단축코드를 code 로 얹는다
  const searchable = useMemo(
    () => candidates.map((candidate) => ({ ...candidate, code: candidate.shortCode })),
    [candidates],
  );
  const filtered = useMemo(() => filterSymbols(searchable, query), [searchable, query]);
  const pageSize = parsePageSize(pageSizeText, 20);
  const { pageCount, currentPage, from, to } = pageWindow(filtered.length, pageSize, page);
  const visible = filtered.slice(from, to);

  const toggle = (standardCode: string): void => {
    const next = new Set(selected);
    if (next.has(standardCode)) next.delete(standardCode);
    else next.add(standardCode);
    setSelected(next);
  };

  const topDisabledReason =
    preview === null
      ? '먼저 조회하세요'
      : preview.unknownMarketCapCount > 0
        ? `시가총액을 확인할 수 없는 종목이 ${preview.unknownMarketCapCount}개 있어 ` +
          `상위 ${TOP_N}종목을 자동으로 고를 수 없습니다 — 수동으로 선택하세요`
        : null;

  const selectTopN = (): void => {
    if (preview === null || topDisabledReason !== null) return;
    setSelected(new Set(topNCodes(candidates, TOP_N)));
  };

  const confirm = (): void => {
    if (preview === null || selected.size === 0) return;
    const method = selectionMethodOf(selected, candidates, TOP_N);
    // 적격 후보가 TOP_N 보다 적으면 실제 상위 선택 크기는 TOP_N 이 아니라 selected.size 다 —
    // 서버는 selectionN 을 그대로 상위 N 크기로 검증하므로 상수 TOP_N 을 보내면
    // 후보 부족 상황에서 정당한 확정이 거부된다.
    createMutation.mutate({
      previewId: preview.previewId,
      standardCodes: Array.from(selected),
      selectionMethod: method,
      ...(method === 'TOP_MARKET_CAP_N' ? { selectionN: selected.size } : {}),
    });
  };

  if (statusLoading) return <Skeleton className="h-48 w-full" />;

  const unavailable = status?.available === false;

  return (
    <div className="space-y-3">
      {/* D-027 — 이유는 툴팁 뒤가 아니라 항상 눈에 보이는 자리에 둔다 */}
      {unavailable ? (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{status?.reason ?? 'KRX 과거 시점 조회를 쓸 수 없습니다'}</AlertDescription>
        </Alert>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">과거 기준일 조회</CardTitle>
          <CardDescription>KOSPI·KOSDAQ 보통주를 그 시점 시가총액순으로 조회합니다.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-end gap-2">
            <div className="space-y-1">
              <Label htmlFor="krx-date">기준일</Label>
              <Input
                id="krx-date"
                type="date"
                className="h-11"
                value={date}
                disabled={unavailable}
                onChange={(e) => setDate(e.target.value)}
              />
            </div>
            <Button
              className="h-11"
              disabled={!date || unavailable || previewMutation.isPending}
              onClick={() => previewMutation.mutate(date)}
            >
              {previewMutation.isPending ? '조회 중…' : '조회'}
            </Button>
          </div>
          {previewMutation.isError ? (
            <Alert variant="destructive" role="alert">
              <AlertDescription>
                {previewMutation.error instanceof ApiError
                  ? previewMutation.error.message
                  : '조회에 실패했습니다'}
              </AlertDescription>
            </Alert>
          ) : null}
        </CardContent>
      </Card>

      {preview ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              요청 {preview.requestedDate} → 적용 {preview.effectiveTradingDate}
            </CardTitle>
            <CardDescription>출처: {preview.attribution}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-1 text-sm text-muted-foreground">
            <p>
              원시{' '}
              {Object.values(preview.rawCounts).reduce((sum, count) => sum + count, 0)}종목 · 보통주
              적격 {preview.eligibleCount}종목 · 시가총액 확인 불가{' '}
              {preview.unknownMarketCapCount}종목
            </p>
            <p>
              유형별 제외{' '}
              {Object.entries(preview.excludedByType)
                .map(([type, count]) => `${type} ${count}`)
                .join(', ') || '없음'}
            </p>
          </CardContent>
        </Card>
      ) : null}

      {preview ? (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <Input
              value={query}
              placeholder="이름 또는 코드로 검색"
              className="h-11 min-w-56 flex-1"
              aria-label="후보 종목 검색"
              onChange={(e) => {
                setQuery(e.target.value);
                setPage(0);
              }}
            />
            <PageSizeInput
              value={pageSizeText}
              label="후보 목록 페이지당 표시 수"
              unit="종목"
              onChange={(next) => {
                setPageSizeText(next);
                setPage(0);
              }}
            />
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium">{selected.size}개 선택</span>
            <span className="text-xs text-muted-foreground">
              {query.trim().length > 0
                ? `검색 결과 ${filtered.length}/${candidates.length}종목`
                : `${candidates.length}종목`}
            </span>
            <span className="ml-auto">
              <Button
                type="button"
                variant="outline"
                size="sm"
                // 검색 결과가 아니라 전체 적격 후보 기준 상위 N 이다 — 지금 보이는 페이지와 무관하다
                aria-disabled={topDisabledReason !== null}
                title={topDisabledReason ?? undefined}
                onClick={selectTopN}
              >
                시가총액 상위 {TOP_N}종목 선택
              </Button>
            </span>
          </div>

          {/* 선택이 상한을 넘어도 확정은 허용한다 — 제출은 서버가 막는다. 이 문구는 상시 표시다 */}
          {selected.size > MAX_UNIVERSE_SYMBOLS ? (
            <Alert variant="destructive" role="alert">
              <AlertDescription>현재 백테스트 상한 200종목을 초과합니다</AlertDescription>
            </Alert>
          ) : null}

          {filtered.length === 0 ? (
            <p className="rounded-md border p-4 text-sm text-muted-foreground">
              「{query.trim()}」 와 맞는 후보가 없습니다.
            </p>
          ) : (
            <div className="max-h-[45vh] divide-y overflow-y-auto rounded-md border">
              {visible.map((candidate) => {
                const id = `krx-candidate-${candidate.standardCode}`;
                const marketCap =
                  candidate.marketCapKrw === null
                    ? '확인 불가'
                    : `${formatCompactNumber(Number(candidate.marketCapKrw))}원`;
                return (
                  <div key={candidate.standardCode} className="flex items-start gap-3 p-3">
                    <Checkbox
                      id={id}
                      className="mt-1"
                      checked={selected.has(candidate.standardCode)}
                      onCheckedChange={() => toggle(candidate.standardCode)}
                      aria-label={`${candidate.name} 선택`}
                    />
                    <label htmlFor={id} className="min-w-0 flex-1">
                      <p className="font-medium">
                        {candidate.name}{' '}
                        <span className="text-xs text-muted-foreground">{candidate.shortCode}</span>
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {candidate.market} · 시가총액 {marketCap}
                        {candidate.rank !== null ? ` · ${candidate.rank}위` : ''}
                      </p>
                    </label>
                  </div>
                );
              })}
            </div>
          )}

          <Pagination
            ariaLabel="후보 목록 페이지 이동"
            currentPage={currentPage}
            pageCount={pageCount}
            total={{ count: filtered.length, unit: '종목' }}
            onPageChange={setPage}
          />

          <Button className="h-11" disabled={selected.size === 0 || createMutation.isPending} onClick={confirm}>
            {createMutation.isPending ? '확정 중…' : '스냅샷 확정'}
          </Button>
          {createMutation.isError ? (
            <Alert variant="destructive" role="alert">
              <AlertDescription>
                {createMutation.error instanceof ApiError
                  ? createMutation.error.message
                  : '스냅샷 확정에 실패했습니다'}
              </AlertDescription>
            </Alert>
          ) : null}
        </div>
      ) : null}

      {selectedSnapshot ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              적용 {selectedSnapshot.effectiveTradingDate} · {selectedSnapshot.selectedCount}종목
            </CardTitle>
            <CardDescription>
              <Badge>고정 유니버스</Badge>
            </CardDescription>
          </CardHeader>
        </Card>
      ) : null}

      {snapshots.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">기존 스냅샷 다시 쓰기</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {snapshots.map((snapshot) => (
              <div
                key={snapshot.id}
                className={cn(
                  'flex items-center justify-between gap-2 rounded-lg border p-3',
                  selectedSnapshot?.id === snapshot.id ? 'border-primary bg-muted/50' : '',
                )}
              >
                <div className="text-sm">
                  <p>
                    적용 {snapshot.effectiveTradingDate} · {snapshot.selectedCount}종목
                  </p>
                  <p className="text-xs text-muted-foreground">
                    요청 {snapshot.requestedDate} ·{' '}
                    {snapshot.selectionMethod === 'TOP_MARKET_CAP_N'
                      ? `시가총액 상위 ${snapshot.selectionN ?? TOP_N}`
                      : '수동 선택'}
                  </p>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={loadMutation.isPending}
                  onClick={() => loadMutation.mutate(snapshot.id)}
                >
                  선택
                </Button>
              </div>
            ))}
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
