import { ChartCandlestick, FileText } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import {
  STRATEGY_DATA_LABELS,
  strategyDataRequirement,
  type StrategyDataRequirement,
} from './strategy-data-requirement';

// 색만으로 구분하지 않는다 (§17) — 아이콘과 문구가 함께 다르다. 재무 쪽만 채운 배지로
// 무게를 준 이유: 봉이 기본이고 재무가 예외라는 사실이 목록을 훑을 때 읽혀야 한다.
const VARIANTS: Record<StrategyDataRequirement, 'default' | 'outline'> = {
  FUNDAMENTALS: 'default',
  BARS_ONLY: 'outline',
};

const ICONS: Record<StrategyDataRequirement, typeof FileText> = {
  FUNDAMENTALS: FileText,
  BARS_ONLY: ChartCandlestick,
};

export function StrategyDataBadge({ requiresFundamentals }: { requiresFundamentals?: boolean }) {
  const requirement = strategyDataRequirement(requiresFundamentals);
  if (requirement === null) return null;
  const Icon = ICONS[requirement];
  return (
    <Badge variant={VARIANTS[requirement]} className="shrink-0">
      <Icon data-icon="inline-start" aria-hidden />
      {STRATEGY_DATA_LABELS[requirement]}
    </Badge>
  );
}
