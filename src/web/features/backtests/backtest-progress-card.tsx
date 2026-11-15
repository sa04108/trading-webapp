import type { ReactNode } from "react";
import { LoaderCircle } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";

export function BacktestProgressCard({
  percent = null,
  label = "진행 중",
  children,
}: {
  percent?: number | null;
  label?: string;
  children?: ReactNode;
}) {
  return (
    <Card role="status" aria-label="백테스트 실행 상태">
      <CardContent className="space-y-2 py-4">
        <div className="flex items-center justify-between gap-2 text-sm">
          <span className="flex items-center gap-2">
            <LoaderCircle className="size-4 animate-spin motion-reduce:animate-none" aria-hidden />
            진행률
          </span>
          <span className="tabular-nums">{percent !== null ? `${percent}%` : label}</span>
        </div>
        {percent !== null ? (
          <Progress value={percent} aria-label="백테스트 현재 단계 진행률" />
        ) : null}
        {children}
      </CardContent>
    </Card>
  );
}
