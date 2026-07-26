import { afterEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../helpers/test-app.js';

describe('응답 압축 (D-016 — Caddy encode 대체)', () => {
  let testApp: TestApp;

  afterEach(async () => {
    await testApp.close();
  });

  it('threshold 를 넘는 응답을 gzip 으로 압축한다', async () => {
    testApp = await createTestApp({}, (app) => {
      app.get('/test/large', async () => ({ data: 'x'.repeat(4096) }));
    });
    const res = await testApp.app.inject({
      method: 'GET',
      url: '/test/large',
      headers: { 'accept-encoding': 'gzip' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-encoding']).toBe('gzip');
  });

  it('Accept-Encoding 이 없으면 압축하지 않는다', async () => {
    testApp = await createTestApp({}, (app) => {
      app.get('/test/large', async () => ({ data: 'x'.repeat(4096) }));
    });
    const res = await testApp.app.inject({ method: 'GET', url: '/test/large' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-encoding']).toBeUndefined();
  });
});
