import { CalendarDays as CalendarIcon, ChevronLeft, ChevronRight } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';
import { toast } from 'sonner';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Calendar } from '@/components/ui/calendar';
import { Checkbox } from '@/components/ui/checkbox';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
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
 * 날짜를 쿼리스트링(`?date=`)에 두는 이유: 새로고침해도 보던 시점을 잃지 않고 링크로
 * 공유할 수 있다. 구획 이동과 달리 `replace` 로 덮어쓴다 — 타임라인 슬라이더를 한 번
 * 끌면 날짜가 여러 번 바뀌므로 push 로 두면 이력이 그만큼 쌓여 뒤로가기가 이 화면을
 * 벗어나지 못한다(설계 2026-08-07-step-urls-design 의 범위 참고).
 *
 * 이 조립 컴포넌트는 날짜·자동 동기화 상태만 쥐고, 실제 표시는 세 하위
 * 컴포넌트(타임라인·표·사이드바)에 맡긴다.
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

  // 자동 동기화 — 확정 날짜가 미커버이고 스위치가 켜져 있으면 날짜당 한 번만 시도한다.
  // 상태를 날짜와 함께 묶어 두는 이유: ref 로 "시도했는지"만 기록하면 실패한 뒤에도
  // 영원히 "시도했음"으로 남아 화면이 진행 중인 척 멈춰 버린다(리뷰에서 지적된
  // 고착 버그). 성공/실패를 구분해야 실패 시 빈 상태(수동 버튼 2개)로 돌아갈 수 있다.
  const [autoSyncState, setAutoSyncState] = useState<{
    date: string;
    status: 'pending' | 'error';
  } | null>(null);

  useEffect(() => {
    if (universe === null || universe.covered) return;
    if (!autoSync) return;
    if (autoSyncState !== null && autoSyncState.date === committedDate) return;
    if (syncMutation.isPending) return;
    setAutoSyncState({ date: committedDate, status: 'pending' });
    syncMutation.mutate(
      { date: committedDate },
      {
        // 성공 시 status 를 여기서 지우지 않는다 — invalidateQueries 가 universe
        // 재조회를 이제 막 걸었을 뿐이라 이 클로저의 universe 는 아직 갱신 전이다.
        // 지금 null 로 되돌리면 재조회가 끝나기 전에 위 guard 를 다시 통과해
        // 같은 날짜를 한 번 더 동기화하게 된다. covered:true 가 실제로 도착하면
        // 첫 줄 guard 가 알아서 멈춘다.
        onError: (error) => {
          setAutoSyncState({ date: committedDate, status: 'error' });
          toast.error(errorMessage(error, '자동 동기화 실패'));
        },
      },
    );
  }, [universe, autoSync, committedDate, syncMutation, autoSyncState]);

  const autoSyncing =
    autoSyncState !== null && autoSyncState.date === committedDate && autoSyncState.status === 'pending';

  const syncThisDate = (): void => {
    syncMutation.mutate(
      { date: committedDate },
      {
        onSuccess: () => toast.success(`${committedDate} 동기화 완료`),
        onError: (error) => toast.error(errorMessage(error, '동기화 실패')),
      },
    );
  };

  const prevDisabled = coverageLoading || !hasCoverage || committedDate <= rangeStart;
  const nextDisabled = coverageLoading || !hasCoverage || committedDate >= rangeEnd;

  const [calendarOpen, setCalendarOpen] = useState(false);
  // 달력 칸에 커버 여부 점을 찍는다 — 어느 날에 데이터가 있는지 슬라이더 막대에만
  // 있던 정보를 달력에서도 잃지 않게 한다. ISO 문자열은 사전순 비교가 곧 날짜 비교다.
  const isCovered = useMemo(
    () => (date: string) =>
      sortedRanges.some((range) => range.startDate <= date && date <= range.endDate),
    [sortedRanges],
  );

  const backfill = coverage?.backfill ?? null;

  return (
    <div className="space-y-4">
      {backfill?.state === 'RUNNING' ? (
        <Alert>
          <AlertDescription>
            과거 데이터 백필 진행 중 — {backfill.cursorDate ?? '진행 중'}. 수집은 서버에서
            진행되므로 화면을 나가거나 브라우저를 닫아도 계속됩니다.
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
          <Popover open={calendarOpen} onOpenChange={setCalendarOpen}>
            <PopoverTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                aria-label="날짜 선택"
                disabled={coverageLoading}
                className="min-w-28 font-medium tabular-nums"
              >
                <CalendarIcon aria-hidden />
                {displayDate}
              </Button>
            </PopoverTrigger>
            <PopoverContent align="start" className="w-auto p-3">
              <Calendar
                value={committedDate}
                min={rangeStart}
                max={rangeEnd}
                isMarked={isCovered}
                onSelect={(next) => {
                  setPreviewDate(null);
                  setDate(next);
                  setCalendarOpen(false);
                }}
              />
            </PopoverContent>
          </Popover>
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

      {/* grid-cols-1 을 기본으로 명시한다 — 지정하지 않으면 lg 미만에서 암시적 grid
          트랙이 콘텐츠(표의 넓은 열)에 맞춰 늘어나 390px 화면에 가로 스크롤을
          만든다(스펙 §38). minmax(0,1fr) 이 있어야 1fr 트랙이 콘텐츠 폭 대신
          컨테이너 폭에 맞춰 줄어들고, 넘치는 표 자체는 안쪽 overflow-x-auto 가 맡는다. */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
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
