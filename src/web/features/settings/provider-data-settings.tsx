import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { api, postJson } from "@/lib/api-client";

interface RequestScope {
  provider: string;
  endpoint: string;
  parameters: Record<string, string>;
}

interface ProviderPlan {
  fingerprint: string;
  request_json: string;
  reason: string;
  evidence: string;
  status: string;
  attempts: number;
  max_attempts: number;
  created_at_ms: number;
}

interface ProviderDataStatus {
  plans: ProviderPlan[];
  freshness: {
    lastCheckedAtMs: number | null;
    checkedThrough: string | null;
    warning: string | null;
  };
}

const statusLabels: Record<string, string> = {
  BLOCKED: "승인 대기",
  APPROVED: "승인됨",
  CANCELLED: "취소됨",
  COMPLETED: "완료",
};
const reasonLabels: Record<string, string> = {
  FIRST_ACQUISITION: "처음 수집하는 자료",
  PUBLICATION_CONFIRMED: "새 공시가 확인된 게시 대기 자료",
  SOURCE_RECOVERY: "손상된 원문 복구",
  SOURCE_CHANGE_CONFIRMED: "확인된 공급자 정정 반영",
  BLOCKED_SOURCE_REQUIREMENT: "필수 원문·필드 보충",
};
const parameterLabels: Record<string, string> = {
  date: "날짜",
  basDd: "기준일",
  market: "시장",
  symbol: "종목",
  corp_code: "기업 코드",
  businessYear: "사업연도",
  bsns_year: "사업연도",
  reportCode: "보고서 코드",
  reprt_code: "보고서 코드",
  fsDiv: "연결·별도 구분",
  fs_div: "연결·별도 구분",
  bgn_de: "조회 시작일",
  end_de: "조회 종료일",
};

function parseScope(raw: string): RequestScope | null {
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null) return null;
    const scope = value as Partial<RequestScope>;
    if (
      typeof scope.provider !== "string" ||
      typeof scope.endpoint !== "string" ||
      typeof scope.parameters !== "object" ||
      scope.parameters === null ||
      Array.isArray(scope.parameters) ||
      !Object.values(scope.parameters).every((item) => typeof item === "string")
    ) return null;
    return scope as RequestScope;
  } catch {
    return null;
  }
}

function checkedAt(value: number | null): string {
  return value === null
    ? "확인 이력 없음"
    : new Date(value).toLocaleString("ko-KR", { timeZone: "Asia/Seoul" });
}

export function ProviderDataSettings() {
  const queryClient = useQueryClient();
  const status = useQuery({
    queryKey: ["provider-data", "plans"],
    queryFn: () => api<ProviderDataStatus>("/provider-data/plans"),
    refetchInterval: 30_000,
  });
  const decision = useMutation({
    mutationFn: ({ fingerprint, approved }: { fingerprint: string; approved: boolean }) =>
      postJson(`/provider-data/plans/${encodeURIComponent(fingerprint)}`, { approved }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["provider-data", "plans"] }),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">외부 데이터 확인·수집 승인</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        {status.isPending && <p className="text-muted-foreground">불러오는 중…</p>}
        {status.error && <p role="alert" className="text-destructive">{status.error.message}</p>}
        {decision.error && <p role="alert" className="text-destructive">{decision.error.message}</p>}
        {decision.isSuccess && <p role="status">수집 승인 상태를 변경했습니다.</p>}
        {status.data && (
          <>
            <div className="space-y-1">
              <p>마지막 공시 확인: {checkedAt(status.data.freshness.lastCheckedAtMs)} (한국 시간)</p>
              {status.data.freshness.checkedThrough && <p>확인 완료 범위: {status.data.freshness.checkedThrough}까지</p>}
              {(status.data.freshness.warning || status.data.freshness.lastCheckedAtMs === null) && (
                <div role="status" className="rounded-md border p-3">
                  <p>{status.data.freshness.warning || "아직 공시 최신성을 확인하지 못했습니다."}</p>
                  <p className="mt-1 text-muted-foreground">
                    기존 검증 데이터는 사용할 수 있습니다. 손상·정정이 확인되거나 필수 입력이 없는 범위는 복구·승인 전까지 차단됩니다.
                  </p>
                </div>
              )}
            </div>
            <p className="text-muted-foreground">
              승인은 아래에 표시된 대상과 근거에만 적용됩니다. 승인 후 해당 작업을 다시 실행하면 수집을 이어갑니다.
              취소하면 이후 요청 시도를 중단합니다.
            </p>
            {status.data.plans.length === 0 && <p className="text-muted-foreground">등록된 수집 계획이 없습니다.</p>}
            {status.data.plans.map((plan) => {
              const scope = parseScope(plan.request_json);
              const remaining = Math.max(0, plan.max_attempts - plan.attempts);
              const exhausted = remaining === 0;
              const canApprove = scope !== null && (
                ["BLOCKED", "CANCELLED"].includes(plan.status) ||
                (exhausted && plan.status === "APPROVED")
              );
              const canCancel = ["BLOCKED", "APPROVED"].includes(plan.status);
              return (
                <article key={plan.fingerprint} className="space-y-2 rounded-md border p-3">
                  <div className="flex flex-wrap justify-between gap-2 font-medium">
                    <span>{scope?.provider ?? "대상 확인 필요"}</span>
                    <span>{statusLabels[plan.status] ?? plan.status}</span>
                  </div>
                  {scope ? (
                    <>
                      <p className="break-all">대상 API: {scope.endpoint}</p>
                      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
                        {Object.entries(scope.parameters).map(([key, value]) => (
                          <div key={key} className="contents">
                            <dt className="text-muted-foreground">{parameterLabels[key] ?? key}</dt>
                            <dd className="break-all">{value}</dd>
                          </div>
                        ))}
                      </dl>
                    </>
                  ) : <p role="alert">수집 범위를 해석할 수 없어 승인할 수 없습니다.</p>}
                  <p>사유: {reasonLabels[plan.reason] ?? plan.reason}</p>
                  <p className="whitespace-pre-wrap break-words">근거: {plan.evidence}</p>
                  <p>예상 요청 1회 · 누적 시도 {plan.attempts}회 · 재시도를 포함한 남은 허용 시도 {remaining}회</p>
                  <p className="text-xs text-muted-foreground">등록: {checkedAt(plan.created_at_ms)}</p>
                  {exhausted && plan.status !== "COMPLETED" && (
                    <p>
                      현재 허용 한도 {plan.max_attempts}회를 모두 사용했습니다.
                      추가 승인 시 누적 시도 기록을 유지하고 한도를 {plan.max_attempts + 5}회로 늘립니다.
                    </p>
                  )}
                  {(canApprove || canCancel) && (
                    <div className="flex flex-wrap gap-2">
                      {canApprove && <Button size="sm" disabled={decision.isPending} onClick={() => decision.mutate({ fingerprint: plan.fingerprint, approved: true })}>{exhausted ? "추가 최대 5회 재시도 승인" : "이 범위 수집 승인"}</Button>}
                      {canCancel && <Button size="sm" variant="outline" disabled={decision.isPending} onClick={() => decision.mutate({ fingerprint: plan.fingerprint, approved: false })}>수집 승인 취소</Button>}
                    </div>
                  )}
                </article>
              );
            })}
          </>
        )}
      </CardContent>
    </Card>
  );
}
