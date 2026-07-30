import { Info } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

/**
 * 설명 툴팁 (ⓘ 아이콘).
 *
 * 마우스오버가 아니라 클릭(터치 탭)으로만 연다 — 모바일에는 hover 가 없고,
 * Radix 기본 동작은 클릭하면 툴팁을 닫아버려 터치로는 열 방법이 없다.
 * 그래서 open 을 직접 들고 Radix 의 자동 개폐를 쓰지 않는다. 대신 닫는 경로를
 * 직접 챙긴다 — 다시 탭, Escape, 포커스 이탈, 바깥 영역 탭.
 */
export function InfoHint({ label, children }: { label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent): void => {
      // 트리거 자신은 onClick 토글이 처리한다 — 여기서 닫으면 다시 열려 깜빡인다
      if (triggerRef.current?.contains(event.target as Node)) return;
      setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

  return (
    <Tooltip open={open}>
      <TooltipTrigger asChild>
        <button
          ref={triggerRef}
          type="button"
          aria-label={label}
          aria-expanded={open}
          className="rounded-full text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onClick={() => setOpen((prev) => !prev)}
          onBlur={() => setOpen(false)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setOpen(false);
          }}
        >
          <Info className="size-3.5" aria-hidden />
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" align="start" className="max-w-xs flex-col items-start gap-1">
        {children}
      </TooltipContent>
    </Tooltip>
  );
}
