import fs from 'node:fs';
import { describe, expect } from 'vitest';
import { authenticatedTest, test } from '../helpers/test-fixtures.js';

describe('test-scoped app fixture', () => {
  test('테스트마다 고유한 앱과 열린 DB를 제공한다', async ({ ctx }) => {
    expect(fs.existsSync(ctx.dir)).toBe(true);
    expect(() => ctx.container.jobQueue.getJob('missing-job')).not.toThrow();
  });

  test('추가 앱 factory도 서로 독립된 경로를 만든다', async ({ apps }) => {
    const first = await apps.create();
    const second = await apps.create({ env: { MAX_QUEUED_BACKTESTS: '3' } });

    expect(first.dir).not.toBe(second.dir);
    expect(first.container.database.dataPath).not.toBe(
      second.container.database.dataPath,
    );
    await first.close();
    expect(() => second.container.jobQueue.getJob('missing-job')).not.toThrow();
  });

  authenticatedTest('관리자와 실제 session cookie를 조합한다', async ({ ctx, admin, cookie }) => {
    const response = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      cookies: { qp_session: cookie },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().username).toBe(admin.username);
  });
});
