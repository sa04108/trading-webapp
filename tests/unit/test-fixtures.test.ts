import { describe, expect } from 'vitest';
import { test } from '../helpers/test-fixtures.js';

describe('test-scoped app fixture', () => {
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
});
