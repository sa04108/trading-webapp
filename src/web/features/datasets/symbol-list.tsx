import { ChartCandlestick, FileText, FileX, Search, X } from 'lucide-react';
import type { ReactNode } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { formatRelativeTime } from '@/lib/format';
import { cn } from '@/lib/utils';
import { sliceLabel, type DatasetSlice } from './dataset-slices';
import type { SymbolSummary } from './symbol-types';

/**
 * 종목 목록의 표시 조각들 — 종목 탭과 데이터셋의 「종목 편집」이 **같은 구성**을 쓴다.
 *
 * 두 화면이 각자 행을 그리면 한쪽만 분봉 배지를 빠뜨리거나 수집 시각 형식이 달라진다.
 * 실제로 그런 적이 있다: 데이터셋 쪽 픽커는 보유 봉을 「일봉·분봉」 문자열로, 종목 쪽은
 * 배지로 그려서 같은 사실이 두 모양이었다. 조각을 공유해 그 갈라짐을 없앤다.
 */

const SLICES: DatasetSlice[] = ['1d', '1m'];

/**
 * 봉 보유는 **슬라이스별로** 표시한다. 「봉 있음」 하나로 접으면 *분봉이 없다* 가 숨고,
 * 일봉만 있는 종목으로 분봉 백테스트를 제출하면 그때서야 알게 된다 — D-032·D-033 에서
 * 계속 막아 온 실패 방식이다.
 */
export function SliceBadges({ symbol }: { symbol: SymbolSummary }) {
  return (
    <>
      {SLICES.map((slice) => {
        const state = symbol.slices.find((entry) => entry.slice === slice);
        const has = state?.hasData === true;
        return (
          <Badge
            key={slice}
            variant={has ? 'default' : 'outline'}
            className={cn(!has && 'opacity-60')}
          >
            <ChartCandlestick data-icon="inline-start" aria-hidden />
            {sliceLabel(slice)}
          </Badge>
        );
      })}
    </>
  );
}

/** 재무 보유 — 있고 없음만 본다 (D-033 범위 유지) */
export function FactsBadge({ hasFacts }: { hasFacts?: boolean }) {
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

/** 슬라이스마다 마지막 수집 시각이 다르다 — 하나로 접으면 거짓말이 된다 */
export function SyncTimes({ symbol, nowMs }: { symbol: SymbolSummary; nowMs: number }) {
  const parts = symbol.slices
    .filter((state) => state.hasData || state.lastSyncedAtMs !== null)
    .map((state) => `${sliceLabel(state.slice)} ${formatRelativeTime(state.lastSyncedAtMs, nowMs)}`);
  if (parts.length === 0) return <span>수집 이력 없음</span>;
  return <span>{parts.join(' · ')}</span>;
}

/**
 * 행 본문 — 편집 모드와 조회 모드가 같은 배치를 쓰되 이름만 갈린다.
 * `name` 이 null 이면 순수 텍스트(편집 모드: 클릭은 체크박스 몫), 노드면 그것을 그린다.
 */
export function SymbolRowBody({
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

/** 이름·코드 한 입력으로 찾는 검색 상자 (symbol-search.ts 가 실제 판정을 한다) */
export function SymbolSearchInput({
  value,
  onChange,
  className,
  label = '종목 검색',
}: {
  value: string;
  onChange: (next: string) => void;
  className?: string;
  label?: string;
}) {
  return (
    <div className={cn('relative min-w-56 flex-1', className)}>
      <Search
        className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
        aria-hidden
      />
      <Input
        value={value}
        className="h-11 pl-8"
        placeholder="이름 또는 코드로 검색 (예: 삼성전자, 005930)"
        aria-label={label}
        onChange={(event) => onChange(event.target.value)}
      />
      {value.length > 0 ? (
        <button
          type="button"
          aria-label="검색어 지우기"
          className="absolute top-1/2 right-2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
          onClick={() => onChange('')}
        >
          <X className="size-4" />
        </button>
      ) : null}
    </div>
  );
}

/** 페이지당 표시 수 입력 (파싱은 `@/lib/page-size` 의 `parsePageSize`) */
export function PageSizeInput({
  value,
  onChange,
  label,
}: {
  value: string;
  onChange: (next: string) => void;
  label: string;
}) {
  return (
    <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
      페이지당
      <Input
        type="number"
        min={1}
        max={200}
        value={value}
        className="h-9 w-20"
        aria-label={label}
        onChange={(event) => onChange(event.target.value)}
      />
      종목
    </label>
  );
}

/** 페이지 이동 — 1페이지뿐이면 아무것도 그리지 않는다 */
export function PageNav({
  currentPage,
  pageCount,
  total,
  onChange,
}: {
  currentPage: number;
  pageCount: number;
  total: number;
  onChange: (next: number) => void;
}) {
  if (pageCount <= 1) return null;
  return (
    <div className="flex items-center justify-between">
      <Button
        variant="outline"
        size="sm"
        disabled={currentPage === 0}
        onClick={() => onChange(Math.max(0, currentPage - 1))}
      >
        이전
      </Button>
      <span className="text-xs text-muted-foreground">
        {currentPage + 1} / {pageCount} 페이지 · {total}종목
      </span>
      <Button
        variant="outline"
        size="sm"
        disabled={currentPage >= pageCount - 1}
        onClick={() => onChange(currentPage + 1)}
      >
        다음
      </Button>
    </div>
  );
}
