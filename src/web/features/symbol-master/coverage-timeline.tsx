import { useMemo, useState } from 'react';
import { Slider } from '@/components/ui/slider';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import type { SymbolMasterCoverageDto } from '../../../shared/schemas/symbol-master.js';
import { buildTimelineSegments, dateToPct, dateToUtcMs, pctToDate } from './timeline-model';

/**
 * 커버리지 슬라이더 — 날짜를 정확히(일 단위로) 고르되, 드래그 중에는 아무것도
 * 확정하지 않는다. `onValueChange` 는 미리보기(라벨 갱신)에만 쓰고, 실제 재조회는
 * `onValueCommit`(드래그를 놓는 순간)에서만 일으킨다. 매 픽셀 이동마다 유니버스를
 * 다시 물어보면 서버 호출이 폭주하고 화면도 깜빡인다.
 */
export function CoverageTimeline({
  rangeStart,
  rangeEnd,
  committedDate,
  coverage,
  disabled,
  onPreview,
  onCommit,
  className,
}: {
  rangeStart: string;
  rangeEnd: string;
  committedDate: string;
  coverage: SymbolMasterCoverageDto | null;
  disabled: boolean;
  /** 드래그 중 후보 날짜 — 라벨만 갱신하고 재조회는 하지 않는다 */
  onPreview: (date: string) => void;
  /** 드래그를 놓거나 값이 확정될 때만 호출한다 */
  onCommit: (date: string) => void;
  className?: string;
}) {
  const [previewPct, setPreviewPct] = useState<number | null>(null);

  const segments = useMemo(
    () => buildTimelineSegments(rangeStart, rangeEnd, coverage?.ranges ?? []),
    [rangeStart, rangeEnd, coverage],
  );

  const committedPct = dateToPct(rangeStart, rangeEnd, committedDate);
  const valuePct = previewPct ?? committedPct;

  // 일 단위 이동이 가능하도록 구간 전체 일수에 맞춰 step 을 잡는다. 1% 고정 step 이면
  // 구간이 몇 년치일 때 한 번의 드래그 이동이 수십 일을 건너뛴다.
  const totalDays = Math.max(
    1,
    Math.round((dateToUtcMs(rangeEnd) - dateToUtcMs(rangeStart)) / 86_400_000),
  );
  const step = 100 / totalDays;

  return (
    <div className={cn('relative min-w-48 flex-1 pt-3', className)}>
      {coverage?.checkpoints.map((checkpoint) => {
        const pct = dateToPct(rangeStart, rangeEnd, checkpoint.checkpointDate);
        const color = checkpoint.verified
          ? 'border-b-primary'
          : checkpoint.mismatch
            ? 'border-b-destructive'
            : 'border-b-muted-foreground';
        return (
          <Tooltip key={checkpoint.checkpointDate}>
            <TooltipTrigger asChild>
              <span
                className={cn(
                  'absolute top-0 h-0 w-0 -translate-x-1/2 border-x-4 border-b-4 border-x-transparent',
                  color,
                )}
                style={{ left: `${pct}%` }}
                aria-hidden
              />
            </TooltipTrigger>
            <TooltipContent>
              체크포인트 {checkpoint.checkpointDate} ·{' '}
              {checkpoint.verified ? '검증됨' : checkpoint.mismatch ? '불일치' : '미검증'}
            </TooltipContent>
          </Tooltip>
        );
      })}

      <Slider
        value={[valuePct]}
        min={0}
        max={100}
        step={step}
        disabled={disabled}
        aria-label="커버리지 타임라인"
        onValueChange={([pct]) => {
          if (pct === undefined) return;
          setPreviewPct(pct);
          onPreview(pctToDate(rangeStart, rangeEnd, pct));
        }}
        onValueCommit={([pct]) => {
          if (pct === undefined) return;
          setPreviewPct(null);
          onCommit(pctToDate(rangeStart, rangeEnd, pct));
        }}
      />

      <div className="relative mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-muted">
        {segments.map((segment) => (
          <span
            key={`${segment.startPct}-${segment.endPct}`}
            className={cn('absolute inset-y-0', segment.covered ? 'bg-primary/60' : 'bg-muted')}
            style={{ left: `${segment.startPct}%`, width: `${segment.endPct - segment.startPct}%` }}
          />
        ))}
      </div>
    </div>
  );
}
