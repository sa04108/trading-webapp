import type { ReactNode } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";

type InfoRows = readonly (readonly [string, string])[];

export function ReproductionInfoRows({ rows, monospace = false }: { rows: InfoRows; monospace?: boolean }) {
  return <dl className={cn("text-sm", monospace ? "space-y-1" : "space-y-2")}>
    {rows.map(([label, value]) => (
      <div key={label} className="flex justify-between gap-4">
        <dt className={cn("text-muted-foreground", monospace ? "shrink-0" : "min-w-0 flex-1")}>{label}</dt>
        {/* 공백 없는 해시·설정도 잘리지 않도록 전체 값을 줄바꿈한다. */}
        <dd className={cn("text-right tabular-nums wrap-anywhere", monospace ? "font-mono text-xs leading-5" : "min-w-0 flex-1")}>{value}</dd>
      </div>
    ))}
  </dl>;
}

export function ReproductionInfoCard({ rows, children }: { rows?: InfoRows; children?: ReactNode }) {
  return (
    <Card aria-label="재현 정보">
      <CardHeader>
        <CardTitle className="text-base">재현 정보</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        {rows ? <ReproductionInfoRows rows={rows} monospace /> : null}
        {children}
      </CardContent>
    </Card>
  );
}
