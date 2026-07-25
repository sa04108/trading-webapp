import { useQuery } from '@tanstack/react-query';
import { Navigate, Outlet } from 'react-router';
import { api, ApiError } from '@/lib/api-client';
import { Skeleton } from '@/components/ui/skeleton';

export interface AuthUser {
  id: string;
  username: string;
}

export function useAuthUser() {
  return useQuery<AuthUser, ApiError>({
    queryKey: ['auth', 'me'],
    queryFn: () => api<AuthUser>('/auth/me'),
    retry: false,
    staleTime: 60_000,
  });
}

export function RequireAuth() {
  const { data, isLoading, isError } = useAuthUser();

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

  if (isError || !data) {
    return <Navigate to="/login" replace />;
  }

  return <Outlet />;
}
