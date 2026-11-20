import type { ReactNode } from "react";
import { Link, useNavigate } from "react-router";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export function NewBacktestButton({ mode }: { mode: "daily" | "intraday" }) {
  return (
    <Button asChild size="icon" className="size-11 sm:w-auto sm:gap-1.5 sm:px-4">
      <Link
        to={mode === "daily" ? "/backtests/new" : "/backtests/intraday/new"}
        aria-label="새 백테스트"
      >
        <Plus aria-hidden />
        <span className="hidden sm:inline">새 백테스트</span>
      </Link>
    </Button>
  );
}

export function BacktestHeader({
  title = "백테스트",
  mode,
  actions,
}: {
  title?: string;
  mode: "daily" | "intraday" | "crypto";
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
              value === "intraday" ? "/backtests/intraday" : value === "crypto" ? "/backtests/crypto" : "/backtests",
            )
          }
        >
          <SelectTrigger size="sm" aria-label="백테스트 주기">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="daily">일봉</SelectItem>
            <SelectItem value="intraday">분봉</SelectItem>
            <SelectItem value="crypto">코인 일봉</SelectItem>
          </SelectContent>
        </Select>
      </div>
      {actions ? (
        <div className="flex shrink-0 items-center gap-2">{actions}</div>
      ) : null}
    </div>
  );
}
