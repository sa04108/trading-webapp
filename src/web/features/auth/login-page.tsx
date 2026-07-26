import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { useNavigate } from 'react-router';
import { toast } from 'sonner';
import { z } from 'zod';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { api, ApiError, postJson } from '@/lib/api-client';
import { cn } from '@/lib/utils';
import { queryClient } from '../../app/query-client';

const credentialsSchema = z.object({
  username: z.string().min(1, '사용자 이름을 입력하세요'),
  password: z.string().min(1, '비밀번호를 입력하세요'),
});

type CredentialsForm = z.infer<typeof credentialsSchema>;

function ServerStatus() {
  const { isSuccess, isError } = useQuery({
    queryKey: ['health'],
    queryFn: () => api<{ status: string }>('/health/live'),
    refetchInterval: 30_000,
    retry: false,
  });
  return (
    <p className="flex items-center gap-2 text-xs text-muted-foreground">
      <span
        aria-hidden
        className={cn(
          'size-2 rounded-full',
          isSuccess ? 'bg-emerald-500' : isError ? 'bg-red-500' : 'bg-muted-foreground',
        )}
      />
      {isSuccess ? '서버 연결됨' : isError ? '서버에 연결할 수 없음' : '서버 확인 중'}
    </p>
  );
}

export function LoginPage() {
  const navigate = useNavigate();
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const credentialsForm = useForm<CredentialsForm>({
    resolver: zodResolver(credentialsSchema),
    defaultValues: { username: '', password: '' },
  });

  const loginMutation = useMutation({
    mutationFn: (body: CredentialsForm) => postJson<{ status: string }>('/auth/login', body),
    onSuccess: async () => {
      setErrorMessage(null);
      await queryClient.invalidateQueries({ queryKey: ['auth'] });
      toast.success('로그인되었습니다');
      void navigate('/', { replace: true });
    },
    onError: (error: unknown) => {
      setErrorMessage(
        error instanceof ApiError && error.status === 429
          ? '실패가 너무 많습니다. 잠시 후 다시 시도하세요.'
          : '사용자 이름 또는 비밀번호가 올바르지 않습니다.',
      );
    },
  });

  return (
    <main className="flex min-h-dvh items-center justify-center bg-muted/30 p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="text-lg">Quant Platform</CardTitle>
          <CardDescription>관리자 로그인</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {errorMessage ? (
            <Alert variant="destructive" role="alert">
              <AlertDescription>{errorMessage}</AlertDescription>
            </Alert>
          ) : null}

          <form
            className="space-y-4"
            onSubmit={credentialsForm.handleSubmit((values) => loginMutation.mutate(values))}
          >
            <div className="space-y-2">
              <Label htmlFor="username">사용자 이름</Label>
              <Input
                id="username"
                autoComplete="username"
                className="h-11"
                {...credentialsForm.register('username')}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="password">비밀번호</Label>
              <Input
                id="password"
                type="password"
                autoComplete="current-password"
                className="h-11"
                {...credentialsForm.register('password')}
              />
            </div>
            <Button type="submit" className="h-11 w-full" disabled={loginMutation.isPending}>
              {loginMutation.isPending ? '확인 중…' : '로그인'}
            </Button>
          </form>

          <ServerStatus />
        </CardContent>
      </Card>
    </main>
  );
}
