import { useMemo, useState } from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { formatCompactNumber, formatDateTime } from '@/lib/format';
import type {
  SymbolMasterCoverageDto,
  SymbolMasterEntryDto,
  SymbolMasterUniverseDto,
} from '../../../shared/schemas/symbol-master.js';
import { findNearestCoveredDate } from './timeline-model';

type MarketFilter = 'ALL' | 'KOSPI' | 'KOSDAQ';
type TypeFilter = 'ALL' | 'COMMON_STOCK' | 'OTHER';

function matchesQuery(entry: SymbolMasterEntryDto, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return true;
  return (
    entry.name.toLowerCase().includes(needle) ||
    entry.shortCode.toLowerCase().includes(needle) ||
    entry.standardCode.toLowerCase().includes(needle)
  );
}

/** 최신 체크포인트 — checkpointDate 문자열 비교로 가장 늦은 것을 고른다(ISO 형식이라 사전식 비교가 곧 시간 순서다) */
function latestCheckpoint(
  checkpoints: SymbolMasterCoverageDto['checkpoints'],
): SymbolMasterCoverageDto['checkpoints'][number] | null {
  return checkpoints.reduce<SymbolMasterCoverageDto['checkpoints'][number] | null>(
    (latest, checkpoint) =>
      latest === null || checkpoint.checkpointDate > latest.checkpointDate ? checkpoint : latest,
    null,
  );
}

/**
 * 종목 마스터 유니버스 표 — 「표」 구획 전체(헤더 요약·필터·행·미커버 빈 상태)를 담당한다.
 *
 * 미커버 상태를 여기서 처리하는 이유: 커버 여부는 표에 무엇을 그릴지의 문제이지
 * 패널 조립과는 별개다. 패널은 날짜·자동 동기화·동기화 뮤테이션만 쥐고 있고,
 * 그 상태를 어떻게 보여줄지는 표가 결정한다.
 */
export function UniverseTable({
  date,
  universe,
  isLoading,
  coverage,
  autoSyncing,
  onSyncThisDate,
  onJumpToDate,
}: {
  date: string;
  universe: SymbolMasterUniverseDto | null;
  isLoading: boolean;
  coverage: SymbolMasterCoverageDto | null;
  /** 자동 동기화가 켜져 있고 지금 이 날짜를 동기화하는 중인지 — 빈 상태 대신 진행 표시를 보여준다 */
  autoSyncing: boolean;
  onSyncThisDate: () => void;
  onJumpToDate: (date: string) => void;
}) {
  const [query, setQuery] = useState('');
  const [market, setMarket] = useState<MarketFilter>('ALL');
  const [type, setType] = useState<TypeFilter>('ALL');

  const filtered = useMemo(() => {
    if (universe === null) return [];
    return universe.symbols.filter((entry) => {
      if (!matchesQuery(entry, query)) return false;
      if (market !== 'ALL' && entry.market !== market) return false;
      if (type === 'COMMON_STOCK' && entry.instrumentType !== 'COMMON_STOCK') return false;
      if (type === 'OTHER' && entry.instrumentType === 'COMMON_STOCK') return false;
      return true;
    });
  }, [universe, query, market, type]);

  if (isLoading) {
    return (
      <div className="space-y-2">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (universe === null) return null;

  if (!universe.covered) {
    if (autoSyncing) {
      return (
        <Alert>
          <AlertDescription>{date} 자동 동기화 중…</AlertDescription>
        </Alert>
      );
    }

    const nearest = findNearestCoveredDate(coverage?.ranges ?? [], date);
    return (
      <Alert>
        <AlertDescription className="space-y-2">
          <p>{date} 데이터 미수집</p>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={onSyncThisDate}>
              이 날짜 동기화
            </Button>
            {nearest !== null ? (
              <Button size="sm" variant="outline" onClick={() => onJumpToDate(nearest)}>
                가장 가까운 수집일({nearest})로 이동
              </Button>
            ) : null}
          </div>
        </AlertDescription>
      </Alert>
    );
  }

  const checkpoint = latestCheckpoint(coverage?.checkpoints ?? []);

  return (
    <div className="space-y-2">
      <p className="text-sm text-muted-foreground">
        {date} 기준 {universe.symbols.length}종목 · 마지막 수집{' '}
        {formatDateTime(coverage?.lastSyncedAtMs ?? null)}
        {checkpoint !== null
          ? ` · 체크포인트 ${checkpoint.checkpointDate} ${checkpoint.verified ? '✓' : '⚠'}`
          : ''}
      </p>

      <div className="flex flex-wrap items-center gap-2">
        <Input
          value={query}
          placeholder="이름 또는 코드로 검색"
          className="h-9 min-w-56 flex-1"
          aria-label="종목 검색"
          onChange={(event) => setQuery(event.target.value)}
        />
        <Select value={market} onValueChange={(value) => setMarket(value as MarketFilter)}>
          <SelectTrigger className="h-9 w-32" aria-label="시장 필터">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="ALL">전체 시장</SelectItem>
            <SelectItem value="KOSPI">KOSPI</SelectItem>
            <SelectItem value="KOSDAQ">KOSDAQ</SelectItem>
          </SelectContent>
        </Select>
        <Select value={type} onValueChange={(value) => setType(value as TypeFilter)}>
          <SelectTrigger className="h-9 w-32" aria-label="유형 필터">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="ALL">전체 유형</SelectItem>
            <SelectItem value="COMMON_STOCK">보통주</SelectItem>
            <SelectItem value="OTHER">그 외</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {filtered.length === 0 ? (
        <Alert>
          <AlertDescription>맞는 종목 없음</AlertDescription>
        </Alert>
      ) : (
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>코드</TableHead>
                <TableHead>이름</TableHead>
                <TableHead>시장</TableHead>
                <TableHead className="text-right">상장주식수</TableHead>
                <TableHead>상장일</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((entry) => (
                <TableRow key={entry.standardCode}>
                  <TableCell className="font-mono text-xs">{entry.shortCode}</TableCell>
                  <TableCell>
                    <span className="font-medium">{entry.name}</span>
                    {entry.instrumentType !== 'COMMON_STOCK' ? (
                      <Badge variant="outline" className="ml-1.5">
                        {entry.instrumentType}
                      </Badge>
                    ) : null}
                  </TableCell>
                  <TableCell>{entry.market}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatCompactNumber(Number(entry.sharesOutstanding))}주
                  </TableCell>
                  <TableCell>{entry.listedDate ?? '-'}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
