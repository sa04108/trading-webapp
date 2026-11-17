import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import type { AgentExecutionState, AgentList } from "@shared/agent-status";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api } from "@/lib/api-client";

const stateLabels: Record<AgentExecutionState, string> = {
  NEVER_CONNECTED: "첫 연결 대기",
  OFFLINE: "연결 끊김",
  UNRESPONSIVE: "응답 없음",
  CONNECTING: "상태 확인 중",
  VERSION_MISMATCH: "업데이트 필요",
  PROTOCOL_MISMATCH: "통신 규격 불일치",
  SYNCING: "데이터 동기화 중",
  NO_CAPACITY: "자원 대기",
  BUSY: "작업 중",
  READY: "실행 가능",
  REVOKED: "연결 해제됨",
};

export function AgentSettings() {
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const downloadInstaller = async (selection: { name: string } | { clientId: string }) => {
    const response = await fetch("/api/v1/agents/install/windows", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...selection, serverUrl: window.location.origin }),
    });
    if (!response.ok) {
      let message = "Windows 설치 파일을 만들지 못했습니다.";
      try {
        const result = (await response.json()) as { error?: string };
        if (result.error) message = result.error;
      } catch { /* 응답 본문이 JSON이 아니면 기본 메시지를 표시한다. */ }
      throw new Error(message);
    }
    const url = URL.createObjectURL(await response.blob());
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "quant-agent-windows.cmd";
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const windowsInstaller = useMutation({ mutationFn: downloadInstaller });
  const { data, error } = useQuery({
    queryKey: ["agents"],
    queryFn: () => api<AgentList>("/agents"),
    refetchInterval: 15_000,
  });
  const revoke = useMutation({
    mutationFn: (id: string) => api(`/agents/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["agents"] });
    },
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Agent</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        <p className="text-muted-foreground">
          Windows Docker Desktop으로 Agent를 설치해 유니버스 준비와 백테스트를
          맡길 수 있습니다. CPU와 메모리 사용량은 자동으로 조절됩니다.
        </p>
        <p className="text-muted-foreground">
          CMD를 받아 실행하면 기존 연결 정보를 자동으로 확인하고 저장 데이터를 유지하며 업데이트합니다.
          연결 정보를 사용할 수 없으면 새 연결로 설치합니다. 토큰을 입력하거나 보관할 필요가 없습니다.
        </p>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            windowsInstaller.mutate({ name: name.trim() || "Windows PC" });
          }}
          className="flex flex-wrap items-end gap-2"
        >
          <div className="min-w-0 flex-1 basis-40 space-y-2">
            <Label htmlFor="agent-name">Agent 이름 (선택)</Label>
            <Input id="agent-name" value={name} onChange={(event) => setName(event.target.value)}
              maxLength={80} placeholder="작업용 PC" />
          </div>
          <Button type="submit" disabled={windowsInstaller.isPending}>
            {windowsInstaller.isPending ? "파일 준비 중…" : "Windows CMD 받기"}
          </Button>
        </form>
        <p className="text-xs text-muted-foreground">
          다운로드한 CMD는 7일 안에 실행하세요. 연결 권한이 포함되어 있으므로 다른 사람에게 공유하지 마세요.
          한 PC에 Agent가 여러 개라면 아래에서 해당 장치의 CMD를 받으세요.
        </p>
        {windowsInstaller.error && (
          <p role="alert" className="text-destructive">{windowsInstaller.error.message}</p>
        )}
        {(error || revoke.error) && (
          <p role="alert" className="text-destructive">
            {(error || revoke.error)?.message}
          </p>
        )}
        {data?.clients
          .filter((client) => client.revokedAtMs === null)
          .map((client) => (
            <div
              key={client.id}
              className="flex flex-wrap items-start justify-between gap-3 border-t pt-3"
            >
              <div className="min-w-0 flex-1 basis-48 space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="break-all">{client.name}</p>
                  <Badge variant={client.execution.state === "VERSION_MISMATCH" || client.execution.state === "PROTOCOL_MISMATCH" ? "destructive" : "secondary"}>
                    {stateLabels[client.execution.state]}
                  </Badge>
                </div>
                <p className="break-words text-muted-foreground">{client.execution.detail}</p>
                {client.execution.connected && (client.execution.state === "READY" || client.execution.state === "BUSY" || client.execution.state === "NO_CAPACITY") && (
                  <p className="text-xs text-muted-foreground">진행 중 {client.execution.activeJobs}개 · 사용 가능한 슬롯 {client.execution.availableSlots}개</p>
                )}
                {client.lastSeenAtMs !== null && (
                  <p className="text-xs text-muted-foreground">최근 통신 {new Date(client.lastSeenAtMs).toLocaleString()}</p>
                )}
              </div>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" onClick={() => windowsInstaller.mutate({ clientId: client.id })}
                  disabled={windowsInstaller.isPending} aria-label={`${client.name} 설치·업데이트 CMD 받기`}>
                  설치·업데이트 CMD
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => revoke.mutate(client.id)}
                  disabled={revoke.isPending}
                >
                  연결 해제
                </Button>
              </div>
            </div>
          ))}
      </CardContent>
    </Card>
  );
}
