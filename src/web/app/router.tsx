import { SeedExperimentsPage } from "../features/backtests/seed-experiments-page";
import { PeriodValidationPage, PeriodValidationDetailPage } from "../features/backtests/period-validation-pages";
import { createBrowserRouter } from "react-router";
import {
  IntradayDataPage,
  IntradayDetailPage,
  IntradayListPage,
  IntradayNewPage,
} from "../features/intraday/pages";
import { LoginPage } from "../features/auth/login-page";
import { BacktestDetailPage } from "../features/backtests/backtest-detail-page";
import { BacktestsPage } from "../features/backtests/backtests-page";
import { NewBacktestEntry } from "../features/backtests/new-backtest-entry";
import { NewBacktestWizard } from "../features/backtests/new-backtest-wizard";
import { SeedCloneBatchPage } from "../features/backtests/seed-clone-batch-page";
import { DashboardPage } from "../features/dashboard/dashboard-page";
import {
  DataPage,
  DatasetsIndexRedirect,
} from "../features/datasets/data-page";
import { JobsPage } from "../features/jobs/jobs-page";
import { JobDetailPage } from "../features/jobs/job-detail-page";
import { NotificationsPage } from "../features/notifications/notifications-page";
import { SettingsPage } from "../features/settings/settings-page";
import { SymbolMasterPanel } from "../features/symbol-master/symbol-master-panel";
import { BenchmarkPanel } from "../features/datasets/benchmark-panel";
import { TradingPage } from "../features/trading/trading-page";
import { RequireAuth } from "./require-auth";
import { AppShell } from "./shell";

export const router = createBrowserRouter([
  { path: "/login", element: <LoginPage /> },
  {
    path: "/",
    element: <RequireAuth />,
    children: [
      {
        element: <AppShell />,
        children: [
          { index: true, element: <DashboardPage /> },
          { path: "trading", element: <TradingPage /> },
          { path: "backtests", element: <BacktestsPage /> },
          { path: "backtests/intraday", element: <IntradayListPage /> },
          { path: "backtests/intraday/new", element: <IntradayNewPage /> },
          { path: "backtests/intraday/:id", element: <IntradayDetailPage /> },
          { path: "backtests/new", element: <NewBacktestEntry /> },
          { path: "backtests/new/:step", element: <NewBacktestWizard /> },
          { path: "backtests/batches/:id", element: <SeedCloneBatchPage /> },
          { path: "backtests/:id/seeds", element: <SeedExperimentsPage /> },
          { path: "backtests/:id/validations", element: <PeriodValidationPage /> },
          { path: "backtests/validations/:validationId", element: <PeriodValidationDetailPage /> },
          { path: "backtests/:id", element: <BacktestDetailPage /> },
          {
            path: "datasets",
            element: <DataPage />,
            children: [
              { index: true, element: <DatasetsIndexRedirect /> },
              { path: "intraday", element: <IntradayDataPage /> },
              { path: "master", element: <SymbolMasterPanel /> },
              { path: "benchmarks", element: <BenchmarkPanel /> },
              // 모르는 하위 경로(옛 tab 값을 경로로 손입력한 /datasets/prices 같은 것)도
              // 기본 구획으로 잇는다. 이 자식이 없으면 매칭 실패가 앱 셸을 통째로 라우터
              // 오류 화면으로 바꿔, 사용자가 nav 를 잃고 URL 을 다시 쳐야 한다.
              { path: "*", element: <DatasetsIndexRedirect /> },
            ],
          },
          { path: "jobs", element: <JobsPage /> },
          { path: "jobs/:id", element: <JobDetailPage /> },
          { path: "notifications", element: <NotificationsPage /> },
          { path: "settings", element: <SettingsPage /> },
        ],
      },
    ],
  },
]);
