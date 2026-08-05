import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { toast } from 'sonner';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { CoverageTimeline } from './coverage-timeline';
import { EventsSidebar } from './events-sidebar';
import { addDays } from './timeline-model';
import { UniverseTable } from './universe-table';
import {
  useSymbolMasterCoverage,
  useSymbolMasterSync,
  useSymbolMasterUniverse,
} from './use-symbol-master';

const AUTO_SYNC_STORAGE_KEY = 'symbolMaster.autoSync';

/** localStorage 접근은 사생활 보호 모드 등에서 던질 수 있어 항상 감싼다 */
function readAutoSync(): boolean {
  try {
    return window.localStorage.getItem(AUTO_SYNC_STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

function writeAutoSync(value: boolean): void {
  try {
    window.localStorage.setItem(AUTO_SYNC_STORAGE_KEY, String(value));
  } catch {
    // 저장 실패는 이번 세션에서만 기본값으로 돌아갈 뿐이라 무시한다
  }
}

/** 사용자 로컬 달력 기준 오늘 — 타임라인 오른쪽 끝은 서버가 아니라 화면을 보는 시점이다 */
function todayIso(): string {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${month}-${day}`;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

/**
 * 종목 마스터 타임머신 패널 — 날짜를 골라 그 시점의 유니버스 스냅샷과 근처 변경
 * 이력을 함께 본다.
 *
 * 날짜를 쿼리스트링(`?date=`)에 두는 이유는 데이터 화면의 `?tab=` 과 같다: 새로고침·
 * 뒤로가기를 해도 보던 시점을 잃지 않는다. 이 조립 컴포넌트는 날짜·자동 동기화
 * 상태만 쥐고, 실제 표시는 세 하위 컴포넌트(타임라인·표·사이드바)에 맡긴다.
 */
export function SymbolMasterPanel() {
  const [params, setParams] = useSearchParams();
  const { coverage, isLoading: coverageLoading } = useSymbolMasterCoverage();
  const [autoSync, setAutoSync] = useState<boolean>(() => readAutoSync());

  useEffect(() => {
    writeAutoSync(autoSync);
  }, [autoSync]);

  const today = todayIso();
  const sortedRanges = useMemo(
    () => [...(coverage?.ranges ?? [])].sort((a, b) => a.startDate.localeCompare(b.startDate)),
    [coverage],
  );
  const hasCoverage = sortedRanges.length > 0;
  const rangeStart = hasCoverage ? sortedRanges[0]!.startDate : today;
  const rangeEnd = today;
  const lastCoveredDate = hasCoverage
    ? sortedRanges.reduce((max, range) => (range.endDate > max ? range.endDate : max), sortedRanges[0]!.endDate)
    : null;

  const dateParam = params.get('date');
  const requestedDate = dateParam ?? lastCoveredDate ?? today;
  // URL 에 낀 날짜가 현재 타임라인 범위 밖일 수 있다(coverage 가 바뀌었거나 손으로 편집) — 안으로 붙인다
  const committedDate =
    requestedDate < rangeStart ? rangeStart : requestedDate > rangeEnd ? rangeEnd : requestedDate;

  const [previewDate, setPreviewDate] = useState<string | null>(null);
  const displayDate = previewDate ?? committedDate;

  const setDate = (next: string): void => {
    const nextParams = new URLSearchParams(params);
    nextParams.set('date', next);
    setParams(nextParams, { replace: true });
  };

  const { universe, isLoading: universeLoading } = useSymbolMasterUniverse(committedDate);
  const syncMutation = useSymbolMasterSync();

  const symbolNames = useMemo(() => {
    const map = new Map<string, string>();
    for (const entry of universe?.symbols ?? []) map.set(entry.standardCode, entry.name);
    return map;
  }, [universe]);

  // 자동 동기화 — 확정 날짜가 미커버이고 스위치가 켜져 있으면 한 번만 시도한다.
  // 날짜별로 한 번만 트리거하는 이유: 동기화가 실패해도(예산 소진 등) 매 렌더마다
  // 다시 부르면 실패 토스트가 반복되고 서버 예산을 헛되이 소모한다 — 사용자가
  // 「지금 동기화」로 직접 재시도하게 둔다.
  const autoSyncAttempted = useRef<string | null>(null);
  useEffect(() => {
    if (universe === null || universe.covered) return;
    if (!autoSync) return;
    if (autoSyncAttempted.current === committedDate) return;
    if (syncMutation.isPending) return;
    autoSyncAttempted.current = committedDate;
    syncMutation.mutate(
      { date: committedDate },
      { onError: (error) => toast.error(errorMessage(error, '자동 동기화에 실패했습니다')) },
    );
  }, [universe, autoSync, committedDate, syncMutation]);

  const autoSyncing =
    autoSync && universe !== null && !universe.covered && autoSyncAttempted.current === committedDate;

  const syncThisDate = (): void => {
    syncMutation.mutate(
      { date: committedDate },
      {
        onSuccess: () => toast.success(`${committedDate} 동기화를 완료했습니다`),
        onError: (error) => toast.error(errorMessage(error, '동기화에 실패했습니다')),
      },
    );
  };

  const prevDisabled = coverageLoading || !hasCoverage || committedDate <= rangeStart;
  const nextDisabled = coverageLoading || !hasCoverage || committedDate >= rangeEnd;

  const backfill = coverage?.backfill ?? null;

  return (
    <div className="space-y-4">
      {backfill?.state === 'RUNNING' ? (
        <Alert>
          <AlertDescription>
            과거 데이터 백필 진행 중 — {backfill.cursorDate ?? '진행 중'}
          </AlertDescription>
        </Alert>
      ) : null}
      {backfill?.state === 'FAILED' ? (
        <Alert variant="destructive">
          <AlertDescription>백필 실패 — {backfill.error ?? '알 수 없는 오류'}</AlertDescription>
        </Alert>
      ) : null}
      {backfill?.state === 'BUDGET_EXHAUSTED' ? (
        <Alert>
          <AlertDescription>오늘 호출 예산 소진 — 내일 자동 재개</AlertDescription>
        </Alert>
      ) : null}

      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-1">
          <Button
            type="button"
            variant="outline"
            size="icon"
            aria-label="이전 날짜"
            disabled={prevDisabled}
            onClick={() => {
              const next = addDays(committedDate, -1);
              setDate(next < rangeStart ? rangeStart : next);
            }}
          >
            <ChevronLeft aria-hidden />
          </Button>
          <span className="min-w-24 text-center text-sm font-medium tabular-nums">
            {displayDate}
          </span>
          <Button
            type="button"
            variant="outline"
            size="icon"
            aria-label="다음 날짜"
            disabled={nextDisabled}
            onClick={() => {
              const next = addDays(committedDate, 1);
              setDate(next > rangeEnd ? rangeEnd : next);
            }}
          >
            <ChevronRight aria-hidden />
          </Button>
        </div>

        <CoverageTimeline
          rangeStart={rangeStart}
          rangeEnd={rangeEnd}
          committedDate={committedDate}
          coverage={coverage}
          disabled={coverageLoading || !hasCoverage}
          onPreview={setPreviewDate}
          onCommit={(next) => {
            setPreviewDate(null);
            setDate(next);
          }}
        />

        <label className="flex items-center gap-1.5 text-sm">
          <Checkbox
            checked={autoSync}
            onCheckedChange={(checked) => setAutoSync(checked === true)}
            aria-label="자동 동기화(KRX)"
          />
          자동 동기화(KRX)
        </label>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={syncMutation.isPending}
          onClick={syncThisDate}
        >
          지금 동기화
        </Button>
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
        <UniverseTable
          date={committedDate}
          universe={universe}
          isLoading={universeLoading}
          coverage={coverage}
          autoSyncing={autoSyncing}
          onSyncThisDate={syncThisDate}
          onJumpToDate={setDate}
        />
        <EventsSidebar date={committedDate} symbolNames={symbolNames} />
      </div>
    </div>
  );
}
