import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export function ReproductionInfoCard({ rows }: { rows: readonly (readonly [string, string])[] }) {
  return (
    <Card aria-label="재현 정보">
      <CardHeader>
        <CardTitle className="text-base">재현 정보</CardTitle>
      </CardHeader>
      <CardContent className="space-y-1 text-sm">
        {rows.map(([label, value]) => (
          <div key={label} className="flex justify-between gap-4">
            <span className="shrink-0 text-muted-foreground">{label}</span>
            {/* 공백 없는 해시·설정도 잘리지 않도록 전체 값을 줄바꿈한다. */}
            <span className="text-right font-mono text-xs leading-5 wrap-anywhere">
              {value}
            </span>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
