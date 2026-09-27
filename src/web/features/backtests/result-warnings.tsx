import { useMemo } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  summarizeExecutionWarnings,
  isExecutionLimitation,
} from "./execution-warning-summary";
import { splitPreparationWarnings } from "./preparation-issues";
import { PreparationIssuesCard } from "./preparation-issues-card";

export function ResultWarnings({
  warnings,
  jobId,
}: {
  readonly warnings: readonly string[];
  readonly jobId?: string;
}) {
  const { preparationWarnings, executionWarnings, limitations } =
    useMemo(() => {
      const split = splitPreparationWarnings(warnings);
      const other = new Set(split.otherWarnings);
      const summarized = summarizeExecutionWarnings(split.otherWarnings);
      return {
        preparationWarnings: warnings.filter((warning) => !other.has(warning)),
        executionWarnings: summarized.filter(
          (warning) => !isExecutionLimitation(warning),
        ),
        limitations: summarized.filter(isExecutionLimitation),
      };
    }, [warnings]);
  if (warnings.length === 0) return null;
  return (
    <div className="min-w-0 space-y-4 lg:col-span-2">
      {preparationWarnings.length > 0 ? (
        <PreparationIssuesCard warnings={preparationWarnings} result />
      ) : null}
      {executionWarnings.length + limitations.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">경고·한계</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4 text-sm">
            {executionWarnings.length > 0 ? (
              <section aria-label="실행 중 발생한 경고" className="space-y-2">
                <h3 className="font-medium">실행 중 발생한 경고</h3>
                <ul className="list-disc space-y-2 pl-4 text-muted-foreground wrap-anywhere">
                  {executionWarnings.map((warning, index) => (
                    <li key={index}>{warning}</li>
                  ))}
                </ul>
              </section>
            ) : null}
            {limitations.length > 0 ? (
              <section aria-label="계산 방식·한계" className="space-y-2">
                <h3 className="font-medium">계산 방식·한계</h3>
                <ul className="list-disc space-y-2 pl-4 text-muted-foreground wrap-anywhere">
                  {limitations.map((warning, index) => (
                    <li key={index}>{warning}</li>
                  ))}
                </ul>
              </section>
            ) : null}
          </CardContent>
        </Card>
      ) : null}
      {jobId ? (
        <div>
          <Button variant="outline" asChild>
            <a
              href={`/api/v1/backtests/${encodeURIComponent(jobId)}/warnings`}
              download
            >
              전체 경고 원문 다운로드
            </a>
          </Button>
        </div>
      ) : null}
    </div>
  );
}
