import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { NotificationService } from '../../src/server/modules/notification/application/notification-service.js';
import { kstDateOf } from '../../src/server/modules/market-data/domain/kst-date.js';
import { openDatabase, type DatabaseHandle } from '../../src/server/shared/db/database.js';
import { SqliteExternalApiUsage } from '../../src/server/shared/db/external-api-usage.js';

describe('SqliteExternalApiUsage', () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('같은 KST 날짜의 호출 수와 한도 알림을 재부팅 뒤에도 보존하고 날짜별로 초기화한다', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qp-api-usage-'));
    dirs.push(dir);
    const databasePath = path.join(dir, 'app.sqlite');
    let now = Date.parse('2026-08-22T03:00:00.000Z');
    const clock = { now: () => now };

    const createUsage = (database: DatabaseHandle) => {
      const notifications = new NotificationService(database.db, clock);
      const usage = new SqliteExternalApiUsage({
        database,
        clock,
        currentDateKst: kstDateOf,
        onQuotaExceeded: (event) => notifications.create({
          type: 'data-sync',
          severity: 'error',
          title: `${event.api} API 호출 한도 초과`,
          body: event.message,
        }),
      });
      return { usage, notifications };
    };

    const firstDatabase = openDatabase(databasePath);
    const first = createUsage(firstDatabase);
    expect(first.usage.recordCall('KRX', '/kospi/daily')).toBe(1);
    expect(first.usage.recordCall('KRX', '/kospi/daily')).toBe(2);
    expect(first.usage.recordCall('KRX', '/kosdaq/daily')).toBe(1);
    expect(first.usage.recordCall('DART', 'daily')).toBe(1);
    expect(first.usage.reportQuotaExceeded('KRX', '/kospi/daily', '한도 초과')).toBe(true);
    expect(first.usage.reportQuotaExceeded('KRX', '/kospi/daily', '중복')).toBe(false);
    expect(first.notifications.list().map(({ title }) => title)).toEqual([
      'KRX API 호출 한도 초과',
    ]);
    firstDatabase.close();

    // 같은 SQLite 파일을 다시 열어 서버 재부팅을 재현한다.
    const secondDatabase = openDatabase(databasePath);
    const second = createUsage(secondDatabase);
    expect(second.usage.callsUsed('KRX', '/kospi/daily')).toBe(2);
    expect(second.usage.maxCallsUsed('KRX')).toBe(2);
    expect(second.usage.callsUsed('DART', 'daily')).toBe(1);
    expect(second.usage.quotaExceeded('KRX', '/kospi/daily')).toBe(true);
    expect(second.usage.reportQuotaExceeded('KRX', '/kospi/daily', '재부팅 뒤 중복')).toBe(false);
    expect(second.notifications.list()).toHaveLength(1);

    // 2026-08-23 00:00 KST. 원장은 이전 행을 보존하되 오늘 조회는 0부터 시작한다.
    now = Date.parse('2026-08-22T15:00:00.000Z');
    expect(second.usage.callsUsed('KRX', '/kospi/daily')).toBe(0);
    expect(second.usage.maxCallsUsed('KRX')).toBe(0);
    expect(second.usage.quotaExceeded('KRX', '/kospi/daily')).toBe(false);
    expect(second.usage.reportQuotaExceeded('KRX', '/kospi/daily', '새 날짜 한도 초과')).toBe(true);
    expect(second.notifications.list()).toHaveLength(2);
    secondDatabase.close();
  });
});
