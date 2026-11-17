import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { api } from "@/lib/api-client";
import { formatDateTime } from "@/lib/format";

import type { OpenApiTokenRecord as TokenRecord } from "@shared/schemas/openapi-token";
export function OpenApiTokenSettings() {
  const client = useQueryClient();
  const query = useQuery({ queryKey: ["openapi-tokens"], queryFn: () => api<{ tokens: TokenRecord[] }>("/openapi-tokens") });
  const [name, setName] = useState(""); const [scope, setScope] = useState<"READ_ONLY" | "READ_WRITE">("READ_WRITE"); const [days, setDays] = useState("365");
  const [secret, setSecret] = useState<{ id: string; token: string } | null>(null); const [pending, setPending] = useState(false); const [error, setError] = useState<string | null>(null); const [copyMessage, setCopyMessage] = useState(""); const [revokeId, setRevokeId] = useState<string | null>(null);
  const revoke = useMutation({ mutationFn: (id: string) => api(`/openapi-tokens/${encodeURIComponent(id)}`, { method: "DELETE" }), onSuccess: (_result, id) => { setSecret(current => current?.id === id ? null : current); setRevokeId(null); void client.invalidateQueries({ queryKey: ["openapi-tokens"] }); } });
  const issue = async () => {
    setPending(true); setError(null); setSecret(null); setCopyMessage("");
    try {
      const result = await api<{ token: string; record: TokenRecord }>("/openapi-tokens", { method: "POST", body: JSON.stringify({ name: name.trim(), scope, expiresInDays: Number(days) }) });
      setSecret({ id: result.record.id, token: result.token }); setName(""); void client.invalidateQueries({ queryKey: ["openapi-tokens"] });
    } catch (failure) { setError(failure instanceof Error ? failure.message : "토큰을 발급하지 못했습니다."); }
    finally { setPending(false); }
  };
  const valid = name.trim().length > 0 && Number.isInteger(Number(days)) && Number(days) >= 1 && Number(days) <= 3650;
  return <Card><CardHeader><CardTitle className="text-base">OpenAPI 토큰</CardTitle></CardHeader><CardContent className="space-y-4 text-sm">
    <p className="text-muted-foreground">로컬 도구와 AI가 API에 접근할 때 사용할 토큰입니다. 읽기·쓰기는 백테스트 실행 등 변경 작업을 허용합니다.</p>
    <form className="grid gap-3 sm:grid-cols-2" onSubmit={event => { event.preventDefault(); if (valid && !pending) void issue(); }}>
      <div className="space-y-2"><Label htmlFor="api-token-name">토큰 이름</Label><Input id="api-token-name" maxLength={80} value={name} onChange={event => setName(event.target.value)} /></div>
      <div className="space-y-2"><Label htmlFor="api-token-scope">권한</Label><select id="api-token-scope" className="h-10 w-full rounded-md border bg-background px-3" value={scope} onChange={event => setScope(event.target.value as typeof scope)}><option value="READ_WRITE">읽기·쓰기</option><option value="READ_ONLY">조회 전용</option></select></div>
      <div className="space-y-2 sm:col-span-2">
        <Label htmlFor="api-token-days">유효 기간 (일)</Label>
        <div className="grid gap-3 sm:grid-cols-2 sm:items-start">
          <div className="space-y-2"><Input id="api-token-days" type="number" min={1} max={3650} step={1} value={days} onChange={event => setDays(event.target.value)} /><p className="text-xs text-muted-foreground">기본 365일 (1년), 최대 3650일</p></div>
          <Button className="justify-self-start" type="submit" disabled={!valid || pending}>{pending ? "발급 중…" : "API 토큰 발급"}</Button>
        </div>
      </div>
    </form>
    {error ? <p role="alert" className="text-destructive">{error}</p> : null}
    {secret ? <div className="space-y-2 rounded-md border p-3"><p>토큰은 지금 한 번만 표시됩니다. 닫기 전에 안전한 곳에 저장하세요.</p><code className="block break-all select-all">{secret.token}</code><div className="flex flex-wrap gap-2"><Button size="sm" variant="outline" onClick={() => void navigator.clipboard.writeText(secret.token).then(() => setCopyMessage("복사됨"), () => setCopyMessage("복사하지 못했습니다. 직접 선택해 복사하세요."))}>토큰 복사</Button><Button size="sm" variant="ghost" onClick={() => { setSecret(null); setCopyMessage(""); }}>닫기</Button></div>{copyMessage ? <p role="status">{copyMessage}</p> : null}</div> : null}
    {query.isError ? <p role="alert" className="text-destructive">{query.error.message}</p> : query.isLoading ? <p>토큰을 불러오는 중…</p> : !query.data?.tokens.length ? <p className="text-muted-foreground">발급된 API 토큰이 없습니다.</p> : <ul className="divide-y">{query.data.tokens.map(token => <li key={token.id} className="flex flex-wrap items-start justify-between gap-2 py-3"><div className="space-y-1"><p className="font-medium">{token.name} · {token.prefix}</p><p className="text-muted-foreground">{token.scope === "READ_ONLY" ? "조회 전용" : "읽기·쓰기"} · {token.expiresAtMs <= Date.now() ? "만료됨" : "사용 중"}</p><p className="text-muted-foreground">발급 {formatDateTime(token.createdAtMs)} · 만료 {formatDateTime(token.expiresAtMs)} · 마지막 사용 {token.lastUsedAtMs ? formatDateTime(token.lastUsedAtMs) : "없음"}</p></div><Button size="sm" variant="outline" onClick={() => setRevokeId(token.id)}>폐기</Button></li>)}</ul>}
    <Dialog open={revokeId !== null} onOpenChange={open => { if (!open) setRevokeId(null); }}><DialogContent><DialogHeader><DialogTitle>API 토큰 폐기</DialogTitle><DialogDescription>이 토큰을 사용하는 도구는 더 이상 API에 접근할 수 없으며, 토큰 기록도 삭제됩니다.</DialogDescription></DialogHeader>{revoke.error ? <p role="alert">{revoke.error.message}</p> : null}<DialogFooter><Button variant="outline" onClick={() => setRevokeId(null)}>취소</Button><Button variant="destructive" disabled={revoke.isPending} onClick={() => revokeId && revoke.mutate(revokeId)}>폐기</Button></DialogFooter></DialogContent></Dialog>
  </CardContent></Card>;
}
