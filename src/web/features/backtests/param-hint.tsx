import { Info } from 'lucide-react';
import { useRef, useState } from 'react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { paramLabel, paramMetaLine, type NumberParamSpec } from './param-specs';

/**
 * 파라미터 설명 툴팁 (ⓘ 아이콘).
 *
 * Radix 기본 동작은 클릭하면 툴팁을 닫아버려 터치 기기에서 열 방법이 없다.
 * 그래서 open 을 직접 들고 마우스는 hover·포커스, 터치는 탭 토글로 나눈다.
 * 마지막 포인터 종류를 기억해 마우스 클릭이 hover 로 열린 툴팁을 닫지 않게 한다.
 */
export function ParamHint({ spec }: { spec: NumberParamSpec }) {
  const [open, setOpen] = useState(false);
  const lastPointerType = useRef<string>('mouse');
  if (!spec.help) return null;

  return (
    <Tooltip open={open}>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={`${paramLabel(spec)} 설명`}
          className="text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-full"
          onPointerDown={(e) => {
            lastPointerType.current = e.pointerType;
          }}
          onPointerEnter={(e) => {
            if (e.pointerType === 'mouse') setOpen(true);
          }}
          onPointerLeave={(e) => {
            if (e.pointerType === 'mouse') setOpen(false);
          }}
          onClick={() => {
            // 마우스는 hover 가 이미 열어둔 상태 — 클릭으로 닫지 않는다
            setOpen((prev) => (lastPointerType.current === 'mouse' ? true : !prev));
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setOpen(false)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setOpen(false);
          }}
        >
          <Info className="size-3.5" aria-hidden />
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" align="start" className="max-w-xs flex-col items-start gap-1">
        <p className="leading-relaxed">{spec.help}</p>
        <p className="font-mono text-[10px] opacity-70">{paramMetaLine(spec)}</p>
      </TooltipContent>
    </Tooltip>
  );
}
