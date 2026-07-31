import { FileText, FileX } from 'lucide-react';
import { Badge } from '@/components/ui/badge';

/**
 * 재무 보유 배지. **있고 없음만** 말한다 — 종목별·연도별 충족도는 묻지 않는다(D-033).
 *
 * 채운 배지 = 재무가 있다. 전략 카드의 「재무 필요」와 같은 무게·같은 아이콘을 쓴다 —
 * 두 카드를 나란히 놓았을 때 "필요한 쪽" 과 "가진 쪽" 이 같은 표기로 읽혀야 한다
 * (`features/backtests/strategy-data-badge.tsx`).
 *
 * `undefined` 면 침묵한다: 없음으로 단정하면 재무가 있는데도 「재무 없음」이 붙어
 * 사용자가 쓸데없이 재동기화한다. 데이터셋 카드에서는 참조 종목 **전부** 가 재무를
 * 가졌을 때만 true 를 넘긴다 — 일부만 있으면 랭킹이 빠진 종목을 조용히 버린다.
 */
export function SymbolFactsBadge({ hasFacts }: { hasFacts?: boolean }) {
  if (hasFacts === undefined) return null;
  return hasFacts ? (
    <Badge variant="default" className="shrink-0">
      <FileText data-icon="inline-start" aria-hidden />
      재무 있음
    </Badge>
  ) : (
    <Badge variant="outline" className="shrink-0">
      <FileX data-icon="inline-start" aria-hidden />
      재무 없음
    </Badge>
  );
}
