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

const totpSchema = z.object({
  // max 는 서버(auth-routes 의 totpBodySchema)와 같은 64 로 맞춘다 — 어긋나면
  // 서버가 400 '요청 본문이 올바르지 않습니다' 를 주는데 화면은 그걸 코드 오류처럼 보여준다
  token: z.string().min(6, '6자리 코드 또는 복구 코드를 입력하세요').max(64, '코드가 너무 깁니다'),
});

type CredentialsForm = z.infer<typeof credentialsSchema>;
type TotpForm = z.infer<typeof totpSchema>;

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
  const [step, setStep] = useState<'credentials' | 'totp'>('credentials');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const credentialsForm = useForm<CredentialsForm>({
    resolver: zodResolver(credentialsSchema),
    defaultValues: { username: '', password: '' },
  });
  const totpForm = useForm<TotpForm>({
    resolver: zodResolver(totpSchema),
    defaultValues: { token: '' },
  });

  const finishLogin = async () => {
    await queryClient.invalidateQueries({ queryKey: ['auth'] });
    toast.success('로그인되었습니다');
    void navigate('/', { replace: true });
  };

  const loginMutation = useMutation({
    mutationFn: (body: CredentialsForm) => postJson<{ status: string }>('/auth/login', body),
    onSuccess: async (data) => {
      setErrorMessage(null);
      if (data.status === 'TOTP_REQUIRED') {
        setStep('totp');
      } else {
        await finishLogin();
      }
    },
    onError: (error: unknown) => {
      setErrorMessage(
        error instanceof ApiError && error.status === 429
          ? '실패가 너무 많습니다. 잠시 후 다시 시도하세요.'
          : '사용자 이름 또는 비밀번호가 올바르지 않습니다.',
      );
    },
  });

  const totpMutation = useMutation({
    mutationFn: (body: TotpForm) => postJson<{ status: string }>('/auth/totp/verify', body),
    onSuccess: async () => {
      setErrorMessage(null);
      await finishLogin();
    },
    // 서버가 잠금(429)·본문 오류(400)·내부 오류(500)를 구분해 보내는데 전부
    // "코드가 틀렸다" 로 뭉개면 운영자가 잠긴 줄 모르고 같은 코드를 계속 넣는다.
    // 위 credentials 뮤테이션과 같은 방식으로 응답을 읽는다.
    onError: (error: unknown) => {
      if (error instanceof ApiError && error.status === 429) {
        setErrorMessage('실패가 너무 많습니다. 잠시 후 다시 시도하세요.');
      } else if (error instanceof ApiError && error.status === 401) {
        setErrorMessage('인증 코드가 올바르지 않습니다.');
      } else if (error instanceof ApiError) {
        setErrorMessage(error.message);
      } else {
        setErrorMessage('서버에 연결할 수 없습니다. 잠시 후 다시 시도하세요.');
      }
    },
  });

  return (
    <main className="flex min-h-dvh items-center justify-center bg-muted/30 p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="text-lg">Quant Platform</CardTitle>
          <CardDescription>
            {step === 'credentials' ? '관리자 로그인' : '2단계 인증 코드를 입력하세요'}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {errorMessage ? (
            <Alert variant="destructive" role="alert">
              <AlertDescription>{errorMessage}</AlertDescription>
            </Alert>
          ) : null}

          {step === 'credentials' ? (
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
          ) : (
            <form
              className="space-y-4"
              onSubmit={totpForm.handleSubmit((values) => totpMutation.mutate(values))}
            >
              <div className="space-y-2">
                <Label htmlFor="token">TOTP 코드</Label>
                <Input
                  id="token"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  placeholder="123456 또는 복구 코드"
                  className="h-11"
                  autoFocus
                  {...totpForm.register('token')}
                />
              </div>
              <Button type="submit" className="h-11 w-full" disabled={totpMutation.isPending}>
                {totpMutation.isPending ? '확인 중…' : '확인'}
              </Button>
              <Button
                type="button"
                variant="ghost"
                className="h-11 w-full"
                onClick={() => {
                  setStep('credentials');
                  totpForm.reset();
                }}
              >
                처음으로
              </Button>
            </form>
          )}

          <ServerStatus />
        </CardContent>
      </Card>
    </main>
  );
}
