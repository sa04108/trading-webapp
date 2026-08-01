import { useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { parsePageSize } from '@/lib/page-size';
import { pageWindow } from '@/lib/pagination';
import { useSymbolMetrics } from '@/lib/use-symbol-metrics';
import {
  PageNav,
  PageSizeInput,
  SymbolRowBody,
  SymbolSearchInput,
  SymbolSortNote,
  SymbolSortSelect,
} from './symbol-list';
import { filterSymbols } from './symbol-search';
import { countWithMetric, sortSymbols, type SymbolSortKey } from './symbol-sort';
import type { SymbolSummary } from './symbol-types';

/**
 * 어떤 종목을 포함할지 고르는 목록 — 데이터셋 만들기와 「종목 편집」이 공유한다.
 *
 * **구성은 종목 탭과 같다**: 같은 행(이름·코드 + 슬라이스별 봉 배지 + 재무 + 마지막
 * 수집 + 참조 데이터셋 수), 같은 검색, 같은 페이징. 여기에 왼쪽 체크박스만 더한다.
 * 두 화면이 갈라지면 한쪽만 분봉 없음을 표시하거나 정렬이 달라진다.
 *
 * **여기 없는 것**: 동기화 버튼, 수집 봉(일/분봉) 선택, 재무 수집 체크박스. 이 화면은
 * 참조를 정하는 곳이고 수집은 종목 탭 소관이다 — 데이터셋에서 수집을 시작하면 "무엇을
 * 수집했나" 의 답이 두 화면에 흩어진다.
 *
 * 페이징이 성능의 전제이기도 하다. 이전 구현은 등록된 종목 **전체**를 한 번에 그려서
 * 1,000종목에서 다이얼로그를 여는 데 1.4초가 걸렸고(long task 773ms) 체크 하나에
 * 126ms 가 들었다. 페이지당 10개면 그리는 행이 10개다.
 */
export function SymbolCheckList({
  symbols,
  selected,
  onChange,
  idPrefix,
  emptyMessage = '등록된 종목이 없습니다 — 종목 탭에서 먼저 추가하세요.',
  defaultPageSize = 10,
}: {
  symbols: readonly SymbolSummary[];
  selected: ReadonlySet<string>;
  onChange: (next: Set<string>) => void;
  /** 같은 화면에 두 목록이 뜰 수 있어 체크박스 id 가 충돌하지 않게 한다 */
  idPrefix: string;
  emptyMessage?: string;
  defaultPageSize?: number;
}) {
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(0);
  const [pageSizeText, setPageSizeText] = useState(String(defaultPageSize));
  const [sortKey, setSortKey] = useState<SymbolSortKey>('NAME');
  const pageSize = parsePageSize(pageSizeText, defaultPageSize);
  const nowMs = Date.now();

  const { metrics, rankingLimit, unavailable: metricsUnavailable } = useSymbolMetrics();

  const all = useMemo(() => sortSymbols(symbols, sortKey, metrics), [symbols, sortKey, metrics]);
  const filtered = useMemo(() => filterSymbols(all, query), [all, query]);
  const { pageCount, currentPage, from, to } = pageWindow(filtered.length, pageSize, page);
  const visible = filtered.slice(from, to);

  /**
   * 두 범위를 따로 둔다. 「전체 선택」은 검색 결과 전체(1,000종목일 수 있다), 「페이지내
   * 전체 선택」은 지금 보이는 것만이다. 하나로 합치면 검색 없이 누른 사용자가 의도보다
   * 훨씬 많이 담게 되거나, 반대로 페이지를 넘겨 가며 100번 눌러야 한다.
   *
   * 범위 밖의 선택은 건드리지 않는다 — 검색어를 바꿔 가며 고른 것을 새 검색이 지우면 안 된다.
   */
  const allFilteredSelected = filtered.length > 0 && filtered.every((s) => selected.has(s.code));
  const allPageSelected = visible.length > 0 && visible.every((s) => selected.has(s.code));

  const setMany = (codes: readonly SymbolSummary[], select: boolean): void => {
    const next = new Set(selected);
    for (const symbol of codes) {
      if (select) next.add(symbol.code);
      else next.delete(symbol.code);
    }
    onChange(next);
  };

  const toggle = (code: string): void => {
    const next = new Set(selected);
    if (next.has(code)) next.delete(code);
    else next.add(code);
    onChange(next);
  };

  if (symbols.length === 0) {
    return <p className="text-sm text-muted-foreground">{emptyMessage}</p>;
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <SymbolSearchInput
          value={query}
          label="포함할 종목 검색"
          onChange={(next) => {
            setQuery(next);
            setPage(0);
          }}
        />
        <SymbolSortSelect
          value={sortKey}
          unavailable={metricsUnavailable}
          label="포함할 종목 정렬"
          onChange={(next) => {
            setSortKey(next);
            setPage(0);
          }}
        />
        <PageSizeInput
          value={pageSizeText}
          label="종목 선택 페이지당 표시 수"
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
          all.map((symbol) => symbol.code),
          sortKey,
          metrics,
        )}
        rankingLimit={rankingLimit}
        unavailable={metricsUnavailable}
      />

      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium">{selected.size}개 선택</span>
        <span className="text-xs text-muted-foreground">
          {query.trim().length > 0 ? `검색 결과 ${filtered.length}/${all.length}종목` : `${all.length}종목`}
        </span>
        <span className="ml-auto flex flex-wrap items-center gap-2">
          {/* 대상이 비면 잠근다 — 「검색 결과 0종목 선택」 은 눌러도 아무 일이 없는 버튼이다 */}
          <Button
            variant="ghost"
            size="sm"
            className="h-9"
            disabled={filtered.length === 0}
            onClick={() => setMany(filtered, !allFilteredSelected)}
          >
            {allFilteredSelected
              ? '전체 해제'
              : query.trim().length > 0
                ? `검색 결과 ${filtered.length}종목 선택`
                : '전체 선택'}
          </Button>
          {/* 페이지가 하나면 「전체 선택」과 같은 동작이라 버튼을 둘 둘 이유가 없다 */}
          {pageCount > 1 ? (
            <Button
              variant="ghost"
              size="sm"
              className="h-9"
              onClick={() => setMany(visible, !allPageSelected)}
            >
              {allPageSelected ? '페이지내 해제' : '페이지내 전체 선택'}
            </Button>
          ) : null}
        </span>
      </div>

      {filtered.length === 0 ? (
        <p className="rounded-md border p-4 text-sm text-muted-foreground">
          「{query.trim()}」 와 맞는 종목이 없습니다 — 이름 일부나 코드 앞자리로도 찾을 수 있습니다.
        </p>
      ) : (
        // 목록만 안에서 스크롤한다 — 다이얼로그 전체가 스크롤되면 검색·전체 선택·저장이
        // 화면 밖으로 밀려 나가고, 그것들이 이 화면에서 가장 자주 쓰는 컨트롤이다
        <div className="max-h-[55vh] divide-y overflow-y-auto rounded-md border">
          {visible.map((symbol) => {
            const id = `${idPrefix}-${symbol.code}`;
            return (
              <div key={symbol.code} className="flex items-start gap-3 p-3">
                <Checkbox
                  id={id}
                  className="mt-1"
                  checked={selected.has(symbol.code)}
                  onCheckedChange={() => toggle(symbol.code)}
                  aria-label={`${symbol.name ?? symbol.code} 선택`}
                />
                <label htmlFor={id} className="min-w-0 flex-1">
                  <SymbolRowBody
                    symbol={symbol}
                    nowMs={nowMs}
                    name={null}
                    metrics={metrics.get(symbol.code)}
                    sortKey={sortKey}
                  />
                </label>
              </div>
            );
          })}
        </div>
      )}

      <PageNav
        currentPage={currentPage}
        pageCount={pageCount}
        total={filtered.length}
        onChange={setPage}
      />
    </div>
  );
}
