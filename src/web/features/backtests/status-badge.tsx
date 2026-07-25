import { Badge } from '@/components/ui/badge';
import type { BacktestStatus } from './types';

const STATUS_LABELS: Record<BacktestStatus, string> = {
  QUEUED: '대기',
  STARTING: '시작 중',
  RUNNING: '실행 중',
  CANCELLING: '취소 중',
  CANCELLED: '취소됨',
  COMPLETED: '완료',
  FAILED: '실패',
  INTERRUPTED: '중단됨',
};

const STATUS_VARIANTS: Record<BacktestStatus, 'default' | 'secondary' | 'destructive' | 'outline'> =
  {
    QUEUED: 'outline',
    STARTING: 'secondary',
    RUNNING: 'secondary',
    CANCELLING: 'secondary',
    CANCELLED: 'outline',
    COMPLETED: 'default',
    FAILED: 'destructive',
    INTERRUPTED: 'destructive',
  };

export function StatusBadge({ status }: { status: BacktestStatus }) {
  return <Badge variant={STATUS_VARIANTS[status]}>{STATUS_LABELS[status]}</Badge>;
}
