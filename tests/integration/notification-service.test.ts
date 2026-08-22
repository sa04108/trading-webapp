import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { notifications } from '../../src/server/shared/db/schema.js';
import type { NotificationRow } from '../../src/server/modules/notification/application/notification-service.js';
import { createTestApp, type TestApp } from '../helpers/test-app.js';

describe('NotificationService', () => {
  let ctx: TestApp;

  beforeEach(async () => {
    ctx = await createTestApp();
  });

  afterEach(async () => {
    await ctx.close();
  });

  it('creates a notification, persists it, and emits an event', () => {
    const service = ctx.container.notificationService;
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
    expect(row.read).toBe(false);
    expect(emitted).toEqual([row]);
    expect(service.list()).toEqual([row]);
    expect(service.unreadCount()).toBe(1);
  });

  it('API 한도 초과는 같은 KST 날짜와 scope에 한 건의 영속 오류 알림을 만든다', () => {
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

  it('lists newest first with a 200-row cap', () => {
    const db = ctx.container.database.db;
    const base = Date.now();
    db.insert(notifications)
      .values(
        Array.from({ length: 205 }, (_, i) => ({
          id: `ntf_${String(i).padStart(3, '0')}`,
          type: 'backtest',
          severity: 'info' as const,
          title: `n${i}`,
          read: false,
          createdAtMs: base + i,
        })),
      )
      .run();

    const listed = ctx.container.notificationService.list();
    expect(listed).toHaveLength(200);
    expect(listed[0]?.id).toBe('ntf_204'); // 최신이 앞
    expect(listed[199]?.id).toBe('ntf_005'); // 가장 오래된 5건이 잘린다
  });

  it('marks all read and deletes by ids or all', () => {
    const service = ctx.container.notificationService;
    const a = service.create({ type: 'backtest', severity: 'info', title: 'a' });
    const b = service.create({ type: 'data-sync', severity: 'info', title: 'b' });
    service.create({ type: 'data-sync', severity: 'info', title: 'c' });

    service.markAllRead();
    expect(service.unreadCount()).toBe(0);
    expect(service.list().every((n) => n.read)).toBe(true);

    service.remove([a.id, b.id]);
    expect(service.list().map((n) => n.title)).toEqual(['c']);

    service.remove([]); // 빈 배열은 no-op — inArray 에 빈 배열을 주면 drizzle 이 던진다
    expect(service.list()).toHaveLength(1);

    service.removeAll();
    expect(service.list()).toEqual([]);
  });
});
