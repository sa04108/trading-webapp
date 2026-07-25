import { useQuery } from '@tanstack/react-query';
import { useTheme } from 'next-themes';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { api } from '@/lib/api-client';

interface SystemInfo {
  name: string;
  version: string;
  gitCommitSha: string;
  uptimeSeconds: number;
  databaseSizeBytes: number;
  freeDiskBytes: number | null;
  freeMemoryBytes: number;
  queueLength: number;
  runningJobs: number;
}

function formatBytes(bytes: number | null): string {
  if (bytes === null) return '-';
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

function formatUptime(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return hours > 0 ? `${hours}시간 ${minutes}분` : `${minutes}분`;
}

export function SettingsPage() {
  const { theme, setTheme } = useTheme();
  const { data: info } = useQuery({
    queryKey: ['system', 'info'],
    queryFn: () => api<SystemInfo>('/system/info'),
    refetchInterval: 30_000,
  });

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <h2 className="text-lg font-semibold">설정</h2>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">화면</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-between gap-4">
            <Label htmlFor="theme-select">테마</Label>
            <Select value={theme} onValueChange={setTheme}>
              <SelectTrigger id="theme-select" className="h-11 w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="system">시스템</SelectItem>
                <SelectItem value="light">라이트</SelectItem>
                <SelectItem value="dark">다크</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">서버 상태</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          {info ? (
            <>
              <div className="flex justify-between">
                <span className="text-muted-foreground">버전</span>
                <span>
                  {info.version} ({info.gitCommitSha.slice(0, 7)})
                </span>
              </div>
              <Separator />
              <div className="flex justify-between">
                <span className="text-muted-foreground">가동 시간</span>
                <span>{formatUptime(info.uptimeSeconds)}</span>
              </div>
              <Separator />
              <div className="flex justify-between">
                <span className="text-muted-foreground">DB 크기</span>
                <span>{formatBytes(info.databaseSizeBytes)}</span>
              </div>
              <Separator />
              <div className="flex justify-between">
                <span className="text-muted-foreground">남은 디스크</span>
                <span>{formatBytes(info.freeDiskBytes)}</span>
              </div>
              <Separator />
              <div className="flex justify-between">
                <span className="text-muted-foreground">여유 메모리</span>
                <span>{formatBytes(info.freeMemoryBytes)}</span>
              </div>
            </>
          ) : (
            <p className="text-muted-foreground">불러오는 중…</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
