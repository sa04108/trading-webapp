import { useQuery } from "@tanstack/react-query";
import { Navigate, Outlet } from "react-router";
import { api, ApiError } from "@/lib/api-client";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

export interface AuthUser {
  id: string;
  username: string;
}

export function useAuthUser() {
  return useQuery<AuthUser, ApiError>({
    queryKey: ["auth", "me"],
    queryFn: () => api<AuthUser>("/auth/me"),
    retry: false,
    staleTime: 60_000,
  });
}

export function RequireAuth() {
  const { data, isLoading, error, isFetching, refetch } = useAuthUser();

  if (isLoading) {
    return (
      <div className="flex min-h-dvh items-center justify-center p-6">
        <div className="w-full max-w-sm space-y-3">
          <Skeleton className="h-8 w-1/2" />
          <Skeleton className="h-24 w-full" />
        </div>
      </div>
    );
  }

  if (error instanceof ApiError && [401, 403].includes(error.status)) {
    return <Navigate to="/login" replace />;
  }

  // 재조회 실패에도 Outlet의 위치와 인스턴스를 유지해 현재 화면의 입력을 보존한다.
  return <>
    {error && <Alert variant="destructive" role="alert">
      <AlertDescription>
        로그인 상태를 확인하지 못했습니다. 연결 상태를 확인한 뒤 다시 시도해 주세요.
        <Button variant="outline" size="sm" disabled={isFetching} onClick={() => void refetch()}>로그인 상태 다시 확인</Button>
      </AlertDescription>
    </Alert>}
    {data && <Outlet />}
  </>;
}
