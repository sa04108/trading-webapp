import { createBrowserRouter } from 'react-router';
import { LoginPage } from '../features/auth/login-page';
import { BacktestDetailPage } from '../features/backtests/backtest-detail-page';
import { BacktestsPage } from '../features/backtests/backtests-page';
import { NewBacktestWizard } from '../features/backtests/new-backtest-wizard';
import { DashboardPage } from '../features/dashboard/dashboard-page';
import { DatasetsPage } from '../features/datasets/datasets-page';
import { SettingsPage } from '../features/settings/settings-page';
import { RequireAuth } from './require-auth';
import { AppShell } from './shell';

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
          { path: 'backtests', element: <BacktestsPage /> },
          { path: 'backtests/new', element: <NewBacktestWizard /> },
          { path: 'backtests/:id', element: <BacktestDetailPage /> },
          { path: 'datasets', element: <DatasetsPage /> },
          { path: 'settings', element: <SettingsPage /> },
        ],
      },
    ],
  },
]);
