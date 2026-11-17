import { describe, expect } from 'vitest';
import { notifications } from '../../src/server/shared/db/operations-schema.js';
import { NotificationService, type NotificationRow } from '../../src/server/modules/notification/application/notification-service.js';
import { test as appTest } from '../helpers/test-fixtures.js';
import { test as databaseTest } from '../helpers/database-fixtures.js';

const now = Date.parse('2026-01-05T00:00:00Z');
const it = databaseTest.extend<{ service: NotificationService }>({
  service: async ({ database }, use) => {
    const service = new NotificationService(database.db, { now: () => now });
    try { await use(service); } finally { service.events.removeAllListeners(); }
  },
});

describe('NotificationService', () => {
  it('creates a notification, persists it, and emits an event', ({ service }) => {
    const emitted: NotificationRow[] = [];
    service.events.on('notification', (row: NotificationRow) => emitted.push(row));

    const row = service.create({
      type: 'backtest',
      severity: 'error',
      title: '백테스트가 실패했습니다',
      body: 'cross-sectional-momentum — 메모리 부족',
      link: '/backtests/bt_x',
    });

    expect(row.id).toMatch(/^ntf_/);
    expect(row).toMatchObject({
      type: 'backtest', severity: 'error', title: '백테스트가 실패했습니다',
      body: 'cross-sectional-momentum — 메모리 부족', link: '/backtests/bt_x',
      read: false, createdAtMs: now,
    });
    expect(emitted).toEqual([row]);
    expect(service.list()).toEqual([row]);
    expect(service.unreadCount()).toBe(1);
  });

  appTest('API 한도 초과는 같은 KST 날짜와 scope에 한 건의 영속 오류 알림을 만든다', ({ ctx }) => {
    const usage = ctx.container.externalApiUsage;
    usage.recordCall('DART', 'daily');

    expect(usage.reportQuotaExceeded('DART', 'daily', 'DART 한도 초과')).toBe(true);
    expect(usage.reportQuotaExceeded('DART', 'daily', '중복 한도 초과')).toBe(false);

    const [notification] = ctx.container.notificationService.list();
    expect(notification).toMatchObject({
      type: 'data-sync',
      severity: 'error',
      title: 'DART API 호출 한도 초과',
      read: false,
    });
    expect(notification?.body).toContain('DART 한도 초과');
    expect(notification?.body).toContain('기록 호출 수: 1회');
  });

  it('lists newest first with a 200-row cap', ({ database, service }) => {
    const db = database.db;
    const base = now;
    db.insert(notifications)
      .values(
        Array.from({ length: 205 }, (_, i) => ({
          id: `ntf_${String(i).padStart(3, '0')}`,
          type: 'backtest',
          severity: i === 0 ? 'error' as const : 'info' as const,
          title: i === 0 ? '난수 시드 실험이 실패했습니다' : `n${i}`,
          read: false,
          createdAtMs: base + i,
        })),
      )
      .run();

    const listed = service.list();
    expect(listed).toHaveLength(200);
    expect(listed[0]?.id).toBe('ntf_204'); // 최신이 앞
    expect(listed[199]?.id).toBe('ntf_005'); // 가장 오래된 5건이 잘린다
    expect(service.list('error').map((row) => row.id)).toEqual(['ntf_000']);
    expect(service.list('error')[0]?.title).toBe('설정 탐색 실험이 실패했습니다');
  });

  it('marks all read and deletes by ids or all', ({ service }) => {
    const a = service.create({ type: 'backtest', severity: 'info', title: 'a' });
    const b = service.create({ type: 'data-sync', severity: 'info', title: 'b' });
    const c = service.create({ type: 'data-sync', severity: 'info', title: 'c' });

    service.markAllRead();
    expect(service.unreadCount()).toBe(0);
    expect(service.list().map(({ id, read }) => ({ id, read })).sort((a, b) => a.id.localeCompare(b.id)))
      .toEqual([a, b, c].map(({ id }) => ({ id, read: true })).sort((a, b) => a.id.localeCompare(b.id)));

    service.remove([a.id, b.id]);
    expect(service.list().map((n) => n.title)).toEqual(['c']);

    service.remove([]); // 빈 배열은 no-op — inArray 에 빈 배열을 주면 drizzle 이 던진다
    expect(service.list()).toHaveLength(1);

    service.removeAll();
    expect(service.list()).toEqual([]);
  });
});
