import { describe, expect, it } from 'vitest';
import { JobOrchestrator, type JobEvent } from '../../src/server/modules/backtest/application/job-orchestrator.js';
import type { JobQueue } from '../../src/server/modules/backtest/application/job-queue.js';
import type { AuditLogService } from '../../src/server/modules/audit/audit-service.js';
import { createLogger } from '../../src/server/shared/logger.js';
import { loadConfig } from '../../src/server/bootstrap/config.js';

const logger = createLogger(loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'error' }));
const config = loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'error' });
const noopAudit: AuditLogService = { record: () => {} };
const clock = { now: () => 0 };

describe('JobOrchestrator.start() — 재시작 복구 알림 (리뷰 지적: INTERRUPTED 알림 도달 불가)', () => {
  it('recoverInterrupted 가 돌려준 각 잡마다 status 이벤트를 emit 한다', () => {
    // recoverInterrupted 외에는 이 테스트에서 호출되지 않는다 — tick() 은 1초 후에나
    // 도는 setInterval 뒤에 있고, 테스트는 그 전에 stop() 한다
    const stubQueue = {
      recoverInterrupted: () => ['bt_orphan_1', 'bt_orphan_2'],
    } as unknown as JobQueue;

    const orchestrator = new JobOrchestrator(stubQueue, config, logger, noopAudit, clock);
    const received: JobEvent[] = [];
    orchestrator.events.on('job', (event: JobEvent) => received.push(event));

    orchestrator.start();
    orchestrator.stop();

    expect(received).toEqual([
      { jobId: 'bt_orphan_1', kind: 'status' },
      { jobId: 'bt_orphan_2', kind: 'status' },
    ]);
  });

  it('복구된 잡이 없으면 이벤트를 emit 하지 않는다', () => {
    const stubQueue = { recoverInterrupted: () => [] } as unknown as JobQueue;
    const orchestrator = new JobOrchestrator(stubQueue, config, logger, noopAudit, clock);
    const received: JobEvent[] = [];
    orchestrator.events.on('job', (event: JobEvent) => received.push(event));

    orchestrator.start();
    orchestrator.stop();

    expect(received).toEqual([]);
  });
});
