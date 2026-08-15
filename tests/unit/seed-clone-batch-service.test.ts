import { describe, expect, it, vi } from 'vitest';
import { createSeedCloneBatchJobListener } from '../../src/server/modules/backtest/application/seed-clone-batch-service.js';

describe('createSeedCloneBatchJobListener', () => {
  it('상태 이벤트에만 배치 상태 조정과 다음 item 승격을 요청한다', () => {
    const onJobStatusChanged = vi.fn();
    const listener = createSeedCloneBatchJobListener({ onJobStatusChanged });

    listener({ jobId: 'bt_1', kind: 'progress' });
    expect(onJobStatusChanged).not.toHaveBeenCalled();

    listener({ jobId: 'bt_1', kind: 'status' });
    expect(onJobStatusChanged).toHaveBeenCalledTimes(1);
  });
});
