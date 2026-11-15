import type { JobProgress, JobStatus } from "@shared/schemas/jobs";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";

const labels: Record<JobStatus, string> = {
  QUEUED: "대기 중", RUNNING: "진행 중", WAITING: "대기 중", CANCELLING: "취소 중",
  COMPLETED: "완료", FAILED: "실패", CANCELLED: "취소됨", INTERRUPTED: "중단됨",
};

export function JobStatusBadge({ status }: { status: JobStatus }) {
  return <Badge variant={status === "FAILED" || status === "INTERRUPTED" ? "destructive" : "secondary"}>{labels[status]}</Badge>;
}

export function JobProgressDisplay({ progress }: { progress: JobProgress | null }) {
  if (!progress) return null;
  const counts = progress.total !== null
    ? `${progress.current?.toLocaleString("ko-KR") ?? "-"} / ${progress.total.toLocaleString("ko-KR")}`
    : progress.current !== null && !progress.label ? `${progress.current.toLocaleString("ko-KR")} 처리` : null;
  return (
    <div className="space-y-1 text-sm text-muted-foreground">
      {(progress.label || counts || progress.percent !== null) && <p className="wrap-anywhere">{[progress.label, counts, progress.percent !== null ? `${progress.percent.toLocaleString("ko-KR", { maximumFractionDigits: 1 })}%` : null].filter(Boolean).join(" · ")}</p>}
      {progress.percent !== null && <Progress value={progress.percent} aria-label="작업 진행률" />}
    </div>
  );
}
