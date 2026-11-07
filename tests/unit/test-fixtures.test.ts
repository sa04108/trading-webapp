import { describe, expect } from 'vitest';
import { test } from '../helpers/test-fixtures.js';

describe('test-scoped app fixture', () => {
  test('추가 앱 factory가 설정 콜백을 전달한다', async ({ apps }) => {
    const app = await apps.create({
      configure: (instance) => {
        instance.get('/fixture-configured', async () => ({ configured: true }));
      },
    });

    const response = await app.app.inject({ method: 'GET', url: '/fixture-configured' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ configured: true });
  });
});
