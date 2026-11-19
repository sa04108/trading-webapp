import type { UniverseRule } from "@shared/schemas/universe-rule";
import { getUniverseMarkets, getUniverseMarketSelection, UNIVERSE_MARKET_OPTIONS } from "@shared/universe-markets";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

interface UniverseMarketSelectProps {
  id: string;
  value: UniverseRule["markets"];
  onChange: (markets: UniverseRule["markets"]) => void;
  disabled?: boolean;
  className?: string;
}

export function UniverseMarketSelect({ id, value, onChange, disabled, className }: UniverseMarketSelectProps) {
  return (
    <Select disabled={disabled} value={getUniverseMarketSelection(value)} onValueChange={(selection) => onChange(getUniverseMarkets(selection))}>
      <SelectTrigger id={id} className={className}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {UNIVERSE_MARKET_OPTIONS.map((option) => (
          <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
