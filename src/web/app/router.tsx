import { createBrowserRouter } from 'react-router';
import { LoginPage } from '../features/auth/login-page';
import { BacktestDetailPage } from '../features/backtests/backtest-detail-page';
import { BacktestsPage } from '../features/backtests/backtests-page';
import { NewBacktestEntry } from '../features/backtests/new-backtest-entry';
import { NewBacktestWizard } from '../features/backtests/new-backtest-wizard';
import { DashboardPage } from '../features/dashboard/dashboard-page';
import { DataPage, DatasetsIndexRedirect } from '../features/datasets/data-page';
import { SymbolsPanel } from '../features/datasets/symbols-panel';
import { NotificationsPage } from '../features/notifications/notifications-page';
import { SettingsPage } from '../features/settings/settings-page';
import { SymbolMasterPanel } from '../features/symbol-master/symbol-master-panel';
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
          { path: 'backtests/new', element: <NewBacktestEntry /> },
          { path: 'backtests/new/:step', element: <NewBacktestWizard /> },
          { path: 'backtests/:id', element: <BacktestDetailPage /> },
          {
            path: 'datasets',
            element: <DataPage />,
            children: [
              { index: true, element: <DatasetsIndexRedirect /> },
              { path: 'master', element: <SymbolMasterPanel /> },
              { path: 'prices', element: <SymbolsPanel /> },
            ],
          },
          { path: 'notifications', element: <NotificationsPage /> },
          { path: 'settings', element: <SettingsPage /> },
        ],
      },
    ],
  },
]);
