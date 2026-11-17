import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import type { AgentExecutionState, AgentList } from "@shared/agent-status";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api, postJson } from "@/lib/api-client";

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
  const [token, setToken] = useState<string | null>(null);
  const [savedToken, setSavedToken] = useState("");
  const [savedPending, setSavedPending] = useState(false);
  const [savedError, setSavedError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState<string | null>(null);
  const downloadInstaller = async (installerToken: string) => {
    const response = await fetch("/api/v1/agents/install/windows", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: installerToken, serverUrl: window.location.origin }),
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
  const issue = useMutation({
    mutationFn: () => postJson<{ token: string }>("/agents", { name }),
    onSuccess: (result) => {
      setToken(result.token);
      setCopied(false);
      setName("");
      void queryClient.invalidateQueries({ queryKey: ["agents"] });
    },
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
          연결 토큰을 발급하면 Windows Docker Desktop 설치 파일을 다운로드할 수 있습니다.
        </p>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            issue.mutate();
          }}
          className="flex flex-wrap items-end gap-2"
        >
          <div className="min-w-0 flex-1 basis-40 space-y-2">
            <Label htmlFor="agent-name">Agent 이름</Label>
            <Input
              id="agent-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={80}
              placeholder="작업용 PC"
            />
          </div>
          <Button type="submit" disabled={!name.trim() || issue.isPending}>
            연결 토큰 발급
          </Button>
        </form>
        {token && (
          <div className="space-y-2 rounded-md border p-3">
            <p>
              이 연결 토큰은 한 번만 표시됩니다. Windows 설치 파일을 다운로드해
              해당 PC에서 실행하세요. 설치 파일에 토큰이 포함되므로 안전하게 보관하세요.
            </p>
            <code className="block break-all select-all">{token}</code>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" className="h-auto min-h-8 whitespace-normal" onClick={() => windowsInstaller.mutate(token)} disabled={windowsInstaller.isPending}>
                {windowsInstaller.isPending ? "설치 파일 준비 중…" : "Windows Docker Desktop 설치 파일"}
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  void navigator.clipboard
                    .writeText(token)
                    .then(() => {
                      setCopied(true);
                      setCopyError(null);
                    })
                    .catch(() =>
                      setCopyError(
                        "복사하지 못했습니다. 토큰을 선택해 직접 복사하세요.",
                      ),
                    );
                }}
              >
                {copied ? "복사됨" : "토큰 복사"}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setToken(null)}>
                닫기
              </Button>
            </div>
          </div>
        )}
        <form
          id="saved-agent-installer"
          className="scroll-mt-20 space-y-2 rounded-md border p-3"
          onSubmit={(event) => {
            event.preventDefault();
            setSavedPending(true);
            setSavedError(null);
            void downloadInstaller(savedToken.trim())
              .then(() => setSavedToken(""))
              .catch((failure: unknown) => setSavedError(failure instanceof Error ? failure.message : "Windows 설치 파일을 만들지 못했습니다."))
              .finally(() => setSavedPending(false));
          }}
        >
          <Label htmlFor="saved-agent-token">저장한 기존 연결 토큰</Label>
          <p className="text-muted-foreground">기존 Agent를 업데이트하려면 활성 토큰으로 현재 서버의 설치 파일을 다시 받으세요. 기존 컨테이너와 이미지를 교체하며 저장 데이터는 버전 간 재사용됩니다. 다른 컨테이너가 사용 중인 이전 이미지는 유지됩니다.</p>
          <div className="flex flex-wrap gap-2">
            <Input className="min-w-0 flex-1 basis-40" id="saved-agent-token" type="password" autoComplete="off" value={savedToken}
              onChange={(event) => setSavedToken(event.target.value)} />
            <Button type="submit" disabled={!savedToken.trim() || savedPending}>
              {savedPending ? "설치 파일 준비 중…" : "설치 파일 다시 받기"}
            </Button>
          </div>
          {savedError && <p role="alert" className="text-destructive">{savedError}</p>}
        </form>
        {copyError && (
          <p role="alert" className="text-destructive">
            {copyError}
          </p>
        )}
        {windowsInstaller.error && (
          <p role="alert" className="text-destructive">{windowsInstaller.error.message}</p>
        )}
        {(error || issue.error || revoke.error) && (
          <p role="alert" className="text-destructive">
            {(error || issue.error || revoke.error)?.message}
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
                {(client.execution.state === "VERSION_MISMATCH" || client.execution.state === "PROTOCOL_MISMATCH") && (
                  <p><a className="underline underline-offset-4" href="#saved-agent-installer">설치 파일 다시 받기</a></p>
                )}
                {client.execution.connected && (client.execution.state === "READY" || client.execution.state === "BUSY" || client.execution.state === "NO_CAPACITY") && (
                  <p className="text-xs text-muted-foreground">진행 중 {client.execution.activeJobs}개 · 사용 가능한 슬롯 {client.execution.availableSlots}개</p>
                )}
                {client.lastSeenAtMs !== null && (
                  <p className="text-xs text-muted-foreground">최근 통신 {new Date(client.lastSeenAtMs).toLocaleString()}</p>
                )}
              </div>
              <Button
                size="sm"
                variant="outline"
                onClick={() => revoke.mutate(client.id)}
                disabled={revoke.isPending}
              >
                연결 해제
              </Button>
            </div>
          ))}
      </CardContent>
    </Card>
  );
}
