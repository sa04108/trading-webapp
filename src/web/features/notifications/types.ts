export type NotificationSeverity = 'info' | 'error';

export interface NotificationItem {
  id: string;
  type: 'backtest' | 'data-sync';
  severity: NotificationSeverity;
  title: string;
  body: string | null;
  link: string | null;
  read: boolean;
  createdAtMs: number;
}
