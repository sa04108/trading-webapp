import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api, postJson } from "@/lib/api-client";

interface AgentList {
  clients: Array<{
    id: string;
    name: string;
    lastSeenAtMs: number | null;
    revokedAtMs: number | null;
  }>;
}
export function AgentSettings() {
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [token, setToken] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState<string | null>(null);
  const windowsInstaller = useMutation({
    mutationFn: async (issuedToken: string) => {
      const response = await fetch("/api/v1/agents/install/windows", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: issuedToken, serverUrl: window.location.origin }),
      });
      if (!response.ok) {
        let message = "Windows 설치 파일을 만들지 못했습니다.";
        try {
          const result = (await response.json()) as { error?: string };
          if (result.error) message = result.error;
        } catch { /* 응답 본문이 JSON이 아니면 기본 메시지를 표시한다. */ }
        throw new Error(message);
      }
      return response.blob();
    },
    onSuccess: (blob) => {
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = "quant-agent-windows.cmd";
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    },
  });
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
          className="flex items-end gap-2"
        >
          <div className="flex-1 space-y-2">
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
            <div className="flex gap-2">
              <Button size="sm" onClick={() => windowsInstaller.mutate(token)} disabled={windowsInstaller.isPending}>
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
              className="flex items-center justify-between gap-3 border-t pt-3"
            >
              <div>
                <p>{client.name}</p>
                <p className="text-xs text-muted-foreground">
                  {client.lastSeenAtMs
                    ? `최근 연결 ${new Date(client.lastSeenAtMs).toLocaleString()}`
                    : "첫 연결 대기"}
                </p>
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
