import { ChartCandlestick, FileText, FileX, Search, X } from 'lucide-react';
import type { ReactNode } from 'react';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { formatCompactNumber, formatRelativeTime } from '@/lib/format';
import { cn } from '@/lib/utils';
import { sliceLabel, type DatasetSlice } from './dataset-slices';
import {
  metricValue,
  SYMBOL_SORT_KEYS,
  SYMBOL_SORT_LABELS,
  type SymbolMetrics,
  type SymbolSortKey,
} from './symbol-sort';
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

/** 정렬 축에 붙는 단위 — 거래량만 「주」다 */
const METRIC_SUFFIX: Record<SymbolSortKey, string> = {
  MARKET_CAP: '원',
  TRADING_VALUE: '원',
  TRADING_VOLUME: '주',
  NAME: '',
};

/**
 * 정렬 중인 축의 값을 행에 적는다. **정렬한 축만** 보여 준다 — 세 지표를 늘 나열하면
 * 행이 두 배로 길어지는데, 사용자가 확인하려는 것은 "왜 이 종목이 위에 있나" 하나다.
 *
 * 값이 없으면 「집계 없음」이라고 쓴다. 빈칸으로 두면 0원과 구분되지 않는다.
 */
export function MetricValue({
  metrics,
  sortKey,
}: {
  metrics: SymbolMetrics | undefined;
  sortKey: SymbolSortKey;
}) {
  if (sortKey === 'NAME') return null;
  const value = metricValue(metrics, sortKey);
  return (
    <span>
      {SYMBOL_SORT_LABELS[sortKey].replace(/순$/, '')}{' '}
      {value === null ? '집계 없음' : `${formatCompactNumber(value)}${METRIC_SUFFIX[sortKey]}`}
    </span>
  );
}

/**
 * 행 본문 — 편집 모드와 조회 모드가 같은 배치를 쓰되 이름만 갈린다.
 * `name` 이 null 이면 순수 텍스트(편집 모드: 클릭은 체크박스 몫), 노드면 그것을 그린다.
 */
export function SymbolRowBody({
  symbol,
  nowMs,
  name,
  metrics,
  sortKey = 'NAME',
}: {
  symbol: SymbolSummary;
  nowMs: number;
  name: ReactNode | null;
  metrics?: SymbolMetrics;
  sortKey?: SymbolSortKey;
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
        {sortKey !== 'NAME' ? (
          <>
            <MetricValue metrics={metrics} sortKey={sortKey} />
            {' · '}
          </>
        ) : null}
        <SyncTimes symbol={symbol} nowMs={nowMs} />
      </p>
    </>
  );
}

/**
 * 정렬 축 선택 — 종목 탭과 데이터셋의 「종목 편집」이 공유한다.
 *
 * 지표를 하나도 못 받았으면 규모 정렬을 **잠근다**. 누를 수 있게 두면 골랐는데 순서가
 * 그대로인(전부 값이 없어 가나다순으로 떨어진) 상태가 되고, 사용자는 정렬이 고장 났다고
 * 읽는다. 이유는 Select 아래에 상시로 적는다 — 회색 항목만 보이면 왜인지 알 수 없다.
 */
export function SymbolSortSelect({
  value,
  onChange,
  unavailable,
  label = '종목 정렬',
}: {
  value: SymbolSortKey;
  onChange: (next: SymbolSortKey) => void;
  /** 지표 조회가 비어 있는지 (증권사 자격 증명 미설정 등) */
  unavailable: boolean;
  label?: string;
}) {
  return (
    <Select value={value} onValueChange={(next) => onChange(next as SymbolSortKey)}>
      <SelectTrigger className="h-11 w-40" aria-label={label}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {SYMBOL_SORT_KEYS.map((key) => (
          <SelectItem key={key} value={key} disabled={unavailable && key !== 'NAME'}>
            {SYMBOL_SORT_LABELS[key]}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/**
 * 정렬 축이 덮지 못한 종목 수를 적는다. 「거래대금순」인데 1,000종목 중 100종목만
 * 값이 있으면 나머지 900종목의 순서는 가나다순이다 — 그 사실을 말하지 않으면 목록이
 * 거짓말을 한다.
 */
export function SymbolSortNote({
  sortKey,
  total,
  withMetric,
  rankingLimit,
  unavailable,
}: {
  sortKey: SymbolSortKey;
  total: number;
  withMetric: number;
  rankingLimit: number;
  unavailable: boolean;
}) {
  if (unavailable) {
    return (
      <p className="text-xs text-muted-foreground">
        증권사 시세를 받지 못해 규모 정렬을 쓸 수 없습니다 — 설정에서 자격 증명을 확인하세요.
      </p>
    );
  }
  if (sortKey === 'NAME' || total === 0 || withMetric === total) return null;
  const ranked = sortKey !== 'MARKET_CAP' && rankingLimit > 0;
  return (
    <p className="text-xs text-muted-foreground">
      {total - withMetric}종목은 {SYMBOL_SORT_LABELS[sortKey].replace(/순$/, '')} 집계가 없어
      뒤에 가나다순으로 놓입니다
      {ranked ? ` — 거래 지표는 시장 상위 ${rankingLimit}위까지만 제공됩니다` : ''}.
    </p>
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
