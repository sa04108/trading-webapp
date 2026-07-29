import { cn } from '@/lib/utils';

/**
 * `이름 (코드)` 렌더. **코드는 절대 잘리지 않는다.**
 *
 * 이름 쪽만 `truncate` + `max-w-40` 으로 줄어들고, 코드 쪽은 `shrink-0` 으로 flex
 * 축소 대상에서 빠진다 — 코드가 잘리면 종목을 식별할 유일한 수단이 사라진다.
 * 문자 수로 자르는 방식은 한글·영문 혼용 이름(`HD현대일렉트릭`)에서 실제 픽셀 폭과
 * 어긋나므로 쓰지 않는다.
 *
 * 같은 규칙의 문자열 버전이 `features/backtests/symbol-summary.ts` 의
 * `formatSymbolLabel` 이다 — 그쪽은 문단용(줄바꿈), 이쪽은 표용(잘림)이라 형태가
 * 다르다. 규칙이 갈리지 않는지는 두 곳의 "이름 없으면 코드만" 분기로 확인한다:
 * `formatSymbolLabel` 이 단위 테스트로 그 분기를 지킨다.
 */
export function SymbolLabel({
  symbol,
  name,
  className,
}: {
  symbol: string;
  name: string | null;
  className?: string;
}) {
  if (!name) return <span className={className}>{symbol}</span>;
  return (
    <span className={cn('flex items-baseline gap-1', className)}>
      <span className="max-w-40 truncate" title={name}>
        {name}
      </span>
      <span className="shrink-0 text-muted-foreground">({symbol})</span>
    </span>
  );
}
