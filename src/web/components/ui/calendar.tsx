import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { addMonths, buildMonthGrid, formatMonth, monthOf } from '@/lib/calendar-month';
import { cn } from '@/lib/utils';

const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'] as const;

/**
 * 날짜 하나를 고르는 달력.
 *
 * 값·경계를 모두 'YYYY-MM-DD' 문자열로 주고받는다 — Date 객체로 오가면 로컬 타임존에서
 * 하루가 밀리고, 이 앱의 날짜는 애초에 URL·API 모두 ISO 문자열이다.
 *
 * 연/월을 드롭다운으로도 고를 수 있게 둔다. 커버리지 구간이 몇 년치라 화살표만으로는
 * 먼 과거로 가는 데 수십 번을 눌러야 한다.
 */
export function Calendar({
  value,
  min,
  max,
  onSelect,
  isMarked,
  isDateDisabled,
  className,
}: {
  /** 선택된 날짜 'YYYY-MM-DD' */
  value: string;
  /** 고를 수 있는 가장 이른 날짜(포함) */
  min: string;
  /** 고를 수 있는 가장 늦은 날짜(포함) */
  max: string;
  onSelect: (date: string) => void;
  /** 칸 아래 점을 찍을 날짜 판정 — 종목 마스터에서는 커버된 날을 표시한다 */
  isMarked?: (date: string) => boolean;
  /** 경계 안이더라도 선택할 수 없는 날짜 판정 */
  isDateDisabled?: (date: string) => boolean;
  className?: string;
}) {
  const [month, setMonth] = useState<string>(() => monthOf(value));

  // 바깥에서 날짜가 바뀌면(화살표 이동·슬라이더 드래그) 보고 있는 달도 따라간다
  useEffect(() => {
    setMonth(monthOf(value));
  }, [value]);

  const cells = useMemo(() => buildMonthGrid(month), [month]);

  const minMonth = monthOf(min);
  const maxMonth = monthOf(max);
  const prevDisabled = month <= minMonth;
  const nextDisabled = month >= maxMonth;

  const minYear = Number(min.slice(0, 4));
  const maxYear = Number(max.slice(0, 4));
  const years = useMemo(
    () => Array.from({ length: maxYear - minYear + 1 }, (_, i) => minYear + i),
    [minYear, maxYear],
  );

  const [year, monthNumber] = [month.slice(0, 4), month.slice(5, 7)];

  /** 연/월 드롭다운으로 만든 달이 경계 밖일 수 있다 — 안으로 붙인다 */
  const goToMonth = (next: string): void => {
    setMonth(next < minMonth ? minMonth : next > maxMonth ? maxMonth : next);
  };

  return (
    <div className={cn('w-full select-none', className)}>
      <div className="flex items-center gap-1.5">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-7"
          aria-label="이전 달"
          disabled={prevDisabled}
          onClick={() => setMonth(addMonths(month, -1))}
        >
          <ChevronLeft aria-hidden />
        </Button>

        <div className="flex flex-1 items-center justify-center gap-1">
          <Select value={year} onValueChange={(next) => goToMonth(`${next}-${monthNumber}`)}>
            <SelectTrigger size="sm" aria-label="연도">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {years.map((y) => (
                <SelectItem key={y} value={String(y)}>
                  {y}년
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={monthNumber} onValueChange={(next) => goToMonth(`${year}-${next}`)}>
            <SelectTrigger size="sm" aria-label="월">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {Array.from({ length: 12 }, (_, i) => String(i + 1).padStart(2, '0')).map((m) => (
                <SelectItem key={m} value={m}>
                  {Number(m)}월
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-7"
          aria-label="다음 달"
          disabled={nextDisabled}
          onClick={() => setMonth(addMonths(month, 1))}
        >
          <ChevronRight aria-hidden />
        </Button>
      </div>

      <div className="mt-2 grid grid-cols-7 gap-0.5" role="grid" aria-label={formatMonth(month)}>
        {WEEKDAYS.map((label) => (
          <div key={label} className="py-1 text-center text-xs text-muted-foreground">
            {label}
          </div>
        ))}
        {cells.map((cell) => {
          const disabled = cell.date < min || cell.date > max || isDateDisabled?.(cell.date) === true;
          const selected = cell.date === value;
          return (
            <button
              key={cell.date}
              type="button"
              role="gridcell"
              // 표에 같은 날짜가 여럿 뜨지 않으므로 ISO 를 그대로 접근성 이름으로 쓴다 —
              // 테스트와 스크린리더 모두 '2026-08-09' 한 가지로 날짜를 집을 수 있다.
              aria-label={cell.date}
              aria-selected={selected}
              disabled={disabled}
              onClick={() => onSelect(cell.date)}
              className={cn(
                'relative flex h-8 items-center justify-center rounded-md text-sm tabular-nums transition-colors',
                'hover:bg-accent hover:text-accent-foreground',
                'focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none',
                cell.outside && 'text-muted-foreground/50',
                disabled && 'pointer-events-none opacity-30',
                selected && 'bg-primary text-primary-foreground hover:bg-primary',
              )}
            >
              {cell.day}
              {isMarked?.(cell.date) === true ? (
                <span
                  aria-hidden
                  className={cn(
                    'absolute bottom-1 size-1 rounded-full',
                    selected ? 'bg-primary-foreground' : 'bg-primary/60',
                  )}
                />
              ) : null}
            </button>
          );
        })}
      </div>
    </div>
  );
}
