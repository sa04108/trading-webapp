import { EventEmitter } from 'node:events';
import { count, desc, eq, inArray } from 'drizzle-orm';
import type { AppDatabase } from '../../../shared/db/database.js';
import { notifications } from '../../../shared/db/schema.js';
import type { Clock } from '../../../shared/clock.js';
import { newId } from '../../../shared/ids.js';

export type NotificationType = 'backtest' | 'data-sync';
export type NotificationSeverity = 'info' | 'error';

export interface NotificationInput {
  readonly type: NotificationType;
  readonly severity: NotificationSeverity;
  readonly title: string;
  readonly body?: string | null;
  readonly link?: string | null;
}

export type NotificationRow = typeof notifications.$inferSelect;

/**
 * 목록 상한 (설계 2026-08-03-notification-center). 7일 보관에서 이 상한을 넘는 경우는
 * 드물고, 넘치면 오래된 것이 잘린다 — 페이징 대신 상한이다.
 */
const LIST_LIMIT = 200;

/**
 * 사용자 알림. 저장이 전달이다 — 접속 중이면 events 를 SSE 가 실어 나르고,
 * 미접속 중 발생분은 다음 접속 때 목록으로 본다.
 */
export class NotificationService {
  /** 'notification' 이벤트, payload = NotificationRow. SSE 라우트가 구독한다 */
  readonly events = new EventEmitter();

  constructor(
    private readonly db: AppDatabase,
    private readonly clock: Clock,
  ) {}

  create(input: NotificationInput): NotificationRow {
    const row: NotificationRow = {
      id: newId('ntf'),
      type: input.type,
      severity: input.severity,
      title: input.title,
      body: input.body ?? null,
      link: input.link ?? null,
      read: false,
      createdAtMs: this.clock.now(),
    };
    this.db.insert(notifications).values(row).run();
    this.events.emit('notification', row);
    return row;
  }

  list(): NotificationRow[] {
    return this.db
      .select()
      .from(notifications)
      .orderBy(desc(notifications.createdAtMs), desc(notifications.id))
      .limit(LIST_LIMIT)
      .all();
  }

  unreadCount(): number {
    const [row] = this.db
      .select({ value: count() })
      .from(notifications)
      .where(eq(notifications.read, false))
      .all();
    return row?.value ?? 0;
  }

  markAllRead(): void {
    this.db.update(notifications).set({ read: true }).where(eq(notifications.read, false)).run();
  }

  remove(ids: readonly string[]): void {
    if (ids.length === 0) return; // inArray 는 빈 배열에서 던진다
    this.db.delete(notifications).where(inArray(notifications.id, [...ids])).run();
  }

  removeAll(): void {
    this.db.delete(notifications).run();
  }
}
