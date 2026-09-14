import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { api, postJson } from '@/lib/api-client';

interface AgentList {
  clients: Array<{ id: string; name: string; lastSeenAtMs: number | null; revokedAtMs: number | null }>;
  downloads: Array<{ arch: string; file: string }>;
}
export function AgentSettings() {
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [token, setToken] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState<string | null>(null);
  const { data, error } = useQuery({ queryKey: ['agents'], queryFn: () => api<AgentList>('/agents'), refetchInterval: 15_000 });
  const issue = useMutation({ mutationFn: () => postJson<{ token: string }>('/agents', { name }), onSuccess: (result) => {
    setToken(result.token); setCopied(false); setName(''); void queryClient.invalidateQueries({ queryKey: ['agents'] });
  } });
  const revoke = useMutation({ mutationFn: (id: string) => api(`/agents/${id}`, { method: 'DELETE' }), onSuccess: () => { void queryClient.invalidateQueries({ queryKey: ['agents'] }); } });
  return <Card>
    <CardHeader><CardTitle className="text-base">계산 장치</CardTitle></CardHeader>
    <CardContent className="space-y-4 text-sm">
      <p className="text-muted-foreground">Linux 또는 WSL2 장치에서 클라이언트를 실행하면 유니버스 준비와 백테스트를 맡길 수 있습니다. CPU와 메모리 사용량은 자동으로 조절됩니다.</p>
      <div className="flex flex-wrap gap-3">
        {data?.downloads.map((download) => <a key={download.arch} className="underline" href={`/api/v1/agents/download/${download.file}`}>Linux {download.arch} 다운로드</a>)}
        {data?.downloads.length === 0 && <span className="text-muted-foreground">클라이언트 파일 게시를 기다리고 있습니다.</span>}
      </div>
      <form onSubmit={(event) => { event.preventDefault(); issue.mutate(); }} className="flex items-end gap-2">
        <div className="flex-1 space-y-2"><Label htmlFor="agent-name">장치 이름</Label><Input id="agent-name" value={name} onChange={(event) => setName(event.target.value)} maxLength={80} placeholder="작업용 PC" /></div>
        <Button type="submit" disabled={!name.trim() || issue.isPending}>연결 토큰 발급</Button>
      </form>
      {token && <div className="space-y-2 rounded-md border p-3">
        <p>클라이언트 첫 실행 때 서버 주소와 이 토큰을 입력하세요. 토큰은 이 화면에서 한 번만 표시됩니다.</p>
        <code className="block break-all select-all">{token}</code>
        <div className="flex gap-2"><Button size="sm" variant="outline" onClick={() => { void navigator.clipboard.writeText(token).then(() => { setCopied(true); setCopyError(null); }).catch(() => setCopyError('복사하지 못했습니다. 토큰을 선택해 직접 복사하세요.')); }}>{copied ? '복사됨' : '토큰 복사'}</Button><Button size="sm" variant="ghost" onClick={() => setToken(null)}>닫기</Button></div>
      </div>}
      {copyError && <p role="alert" className="text-destructive">{copyError}</p>}
      {(error || issue.error || revoke.error) && <p role="alert" className="text-destructive">{(error || issue.error || revoke.error)?.message}</p>}
      {data?.clients.filter((client) => client.revokedAtMs === null).map((client) => <div key={client.id} className="flex items-center justify-between gap-3 border-t pt-3">
        <div><p>{client.name}</p><p className="text-xs text-muted-foreground">{client.lastSeenAtMs ? `최근 연결 ${new Date(client.lastSeenAtMs).toLocaleString()}` : '첫 연결 대기'}</p></div>
        <Button size="sm" variant="outline" onClick={() => revoke.mutate(client.id)} disabled={revoke.isPending}>연결 해제</Button>
      </div>)}
    </CardContent>
  </Card>;
}
