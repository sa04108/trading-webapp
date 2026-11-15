import type { ReactNode } from "react";
import { useNavigate } from "react-router";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export function BacktestHeader({
  title = "백테스트",
  mode,
  actions,
}: {
  title?: string;
  mode: "daily" | "intraday";
  actions?: ReactNode;
}) {
  const navigate = useNavigate();

  return (
    <div className="flex items-center justify-between gap-2">
      <div className="flex shrink-0 items-center gap-2 whitespace-nowrap">
        <h2 className="text-lg font-semibold">{title}</h2>
        <Select
          value={mode}
          onValueChange={(value) =>
            void navigate(
              value === "intraday" ? "/backtests/intraday" : "/backtests",
            )
          }
        >
          <SelectTrigger size="sm" aria-label="백테스트 주기">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="daily">일봉</SelectItem>
            <SelectItem value="intraday">분봉</SelectItem>
          </SelectContent>
        </Select>
      </div>
      {actions ? (
        <div className="flex shrink-0 items-center gap-2">{actions}</div>
      ) : null}
    </div>
  );
}
