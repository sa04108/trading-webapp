import type { AppDatabase } from '../../shared/db/database.js';
import { auditLogs } from '../../shared/db/schema.js';
import type { Clock } from '../../shared/clock.js';
import type { Logger } from '../../shared/logger.js';

/** 스펙 §34 감사 로그: DB 저장 + 구조화 로그 동시 기록 */
export interface AuditLogService {
  record(actor: string, event: string, detail?: Record<string, unknown>): void;
}

export function createAuditLogService(
  db: AppDatabase,
  clock: Clock,
  logger: Logger,
): AuditLogService {
  return {
    record(actor, event, detail) {
      const createdAtMs = clock.now();
      db.insert(auditLogs)
        .values({
          actor,
          event,
          detailJson: detail ? JSON.stringify(detail) : null,
          createdAtMs,
        })
        .run();
      logger.info({ module: 'audit', event, actor, ...detail }, event);
    },
  };
}
