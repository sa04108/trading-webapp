import { useMutation } from '@tanstack/react-query';
import { Bell, Database, FlaskConical, LayoutDashboard, LogOut, Moon, Settings, Sun } from 'lucide-react';
import { useTheme } from 'next-themes';
import { NavLink, Outlet, useNavigate } from 'react-router';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api-client';
import { cn } from '@/lib/utils';
import { useNotificationStream, useUnreadCount } from '../features/notifications/api';
import { queryClient } from './query-client';

const NAV_ITEMS = [
  { to: '/', label: '대시보드', icon: LayoutDashboard, end: true },
  { to: '/backtests', label: '백테스트', icon: FlaskConical, end: false },
  { to: '/datasets', label: '데이터', icon: Database, end: false },
  { to: '/settings', label: '설정', icon: Settings, end: false },
] as const;

function NotificationBell() {
  const navigate = useNavigate();
  // SSE 구독은 여기(shell 상주 컴포넌트) 한 곳이다 — 어느 페이지에 있든 배지가 갱신된다
  const sseFailed = useNotificationStream();
  const { data } = useUnreadCount(sseFailed);
  const count = data?.count ?? 0;

  return (
    <Button
      variant="ghost"
      size="icon"
      className="relative size-11"
      aria-label={count > 0 ? `알림 ${count}건` : '알림'}
      onClick={() => void navigate('/notifications')}
    >
      <Bell className="size-5" />
      {count > 0 && (
        <span className="absolute right-1.5 top-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-medium leading-none text-white">
          {count > 99 ? '99+' : count}
        </span>
      )}
    </Button>
  );
}

function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme();
  return (
    <Button
      variant="ghost"
      size="icon"
      className="size-11"
      aria-label="테마 전환"
      onClick={() => setTheme(resolvedTheme === 'dark' ? 'light' : 'dark')}
    >
      <Sun className="size-5 dark:hidden" />
      <Moon className="hidden size-5 dark:block" />
    </Button>
  );
}

function LogoutButton() {
  const navigate = useNavigate();
  const logout = useMutation({
    mutationFn: () => api('/auth/logout', { method: 'POST' }),
    onSettled: () => {
      queryClient.clear();
      void navigate('/login', { replace: true });
    },
  });
  return (
    <Button
      variant="ghost"
      size="icon"
      className="size-11"
      aria-label="로그아웃"
      onClick={() => logout.mutate()}
    >
      <LogOut className="size-5" />
    </Button>
  );
}

function SidebarNav() {
  return (
    <nav className="flex flex-col gap-1 p-3" aria-label="주 메뉴">
      {NAV_ITEMS.map(({ to, label, icon: Icon, end }) => (
        <NavLink
          key={to}
          to={to}
          end={end}
          className={({ isActive }) =>
            cn(
              'flex h-11 items-center gap-3 rounded-lg px-3 text-sm font-medium transition-colors',
              isActive
                ? 'bg-accent text-accent-foreground'
                : 'text-muted-foreground hover:bg-muted hover:text-foreground',
            )
          }
        >
          <Icon className="size-4" />
          {label}
        </NavLink>
      ))}
    </nav>
  );
}

function BottomNav() {
  return (
    <nav
      className="fixed inset-x-0 bottom-0 z-20 border-t bg-background pb-[env(safe-area-inset-bottom)] md:hidden"
      aria-label="주 메뉴"
    >
      <div className="grid grid-cols-4">
        {NAV_ITEMS.map(({ to, label, icon: Icon, end }) => (
          <NavLink
            key={to}
            to={to}
            end={end}
            className={({ isActive }) =>
              cn(
                'flex min-h-14 flex-col items-center justify-center gap-1 text-xs',
                isActive ? 'text-foreground' : 'text-muted-foreground',
              )
            }
          >
            <Icon className="size-5" />
            {label}
          </NavLink>
        ))}
      </div>
    </nav>
  );
}

export function AppShell() {
  return (
    <div className="flex min-h-dvh">
      <aside className="hidden w-56 shrink-0 flex-col border-r bg-sidebar md:flex">
        <div className="flex h-14 items-center px-6 text-sm font-semibold tracking-tight">
          Quant Platform
        </div>
        <SidebarNav />
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-10 flex h-14 items-center gap-2 border-b bg-background/95 px-4 backdrop-blur">
          <span className="text-sm font-semibold md:hidden">Quant Platform</span>
          <div className="ml-auto flex items-center">
            <NotificationBell />
            <ThemeToggle />
            <LogoutButton />
          </div>
        </header>

        <main className="flex-1 px-4 py-4 pb-24 md:px-6 md:pb-8">
          <Outlet />
        </main>

        <BottomNav />
      </div>
    </div>
  );
}
