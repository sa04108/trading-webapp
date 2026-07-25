import { createBrowserRouter } from 'react-router';
import { LoginPage } from '../features/auth/login-page';
import { DashboardPage } from '../features/dashboard/dashboard-page';
import { DatasetsPage } from '../features/datasets/datasets-page';
import { SettingsPage } from '../features/settings/settings-page';
import { RequireAuth } from './require-auth';
import { AppShell } from './shell';

function Placeholder({ title }: { title: string }) {
  return (
    <div className="space-y-2">
      <h2 className="text-lg font-semibold">{title}</h2>
      <p className="text-sm text-muted-foreground">이후 단계에서 제공됩니다.</p>
    </div>
  );
}

export const router = createBrowserRouter([
  { path: '/login', element: <LoginPage /> },
  {
    path: '/',
    element: <RequireAuth />,
    children: [
      {
        element: <AppShell />,
        children: [
          { index: true, element: <DashboardPage /> },
          { path: 'backtests', element: <Placeholder title="백테스트" /> },
          { path: 'datasets', element: <DatasetsPage /> },
          { path: 'settings', element: <SettingsPage /> },
        ],
      },
    ],
  },
]);
