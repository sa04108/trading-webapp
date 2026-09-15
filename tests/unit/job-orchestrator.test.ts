import { describe, expect, it, vi } from 'vitest';
import { JobOrchestrator } from '../../src/server/modules/backtest/application/job-orchestrator.js';
import type { JobQueue } from '../../src/server/modules/backtest/application/job-queue.js';
import type { AuditLogService } from '../../src/runtime/modules/audit/audit-service.js';

describe('에이전트 작업 취소', () => {
  it('결과 완료와 경합해 상태 변경이 거절되면 취소 알림을 보내지 않는다', () => {
    const queue = { getJob: () => ({ status: 'RUNNING' }), setStatus: vi.fn(() => false) } as unknown as JobQueue;
    const record = vi.fn();
    const orchestrator = new JobOrchestrator(queue, { record } as unknown as AuditLogService);
    const event = vi.fn(); orchestrator.events.on('job', event);
    expect(orchestrator.cancel('job')).toBe('NOT_CANCELLABLE');
    expect(event).not.toHaveBeenCalled(); expect(record).not.toHaveBeenCalled();
  });
  it('실행 중인 에이전트 작업에 취소 상태를 남긴다', () => {
    const setStatus = vi.fn(() => true);
    const queue = { getJob: () => ({ status: 'RUNNING' }), setStatus } as unknown as JobQueue;
    const orchestrator = new JobOrchestrator(queue, { record: vi.fn() } as unknown as AuditLogService);
    expect(orchestrator.cancel('job')).toBe('CANCELLING');
    expect(setStatus).toHaveBeenCalledWith('job', 'CANCELLING', {}, ['RUNNING']);
  });
});
