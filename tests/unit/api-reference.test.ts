import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { buildApiReference, installApiReference } from '../../src/server/modules/system/application/api-reference.js';

describe('API reference route collection', () => {
  it('실제 등록한 경로를 수집하고 미문서화 계약을 구분한다', async () => {
    const app = Fastify();
    const store = installApiReference(app);
    await app.register(async api => {
      api.get('/health/live', async () => ({ status: 'ok' }));
      api.get('/new/:id', async () => ({}));
    }, { prefix: '/api/v1' });
    await app.ready();
    const routes = buildApiReference(store).endpoints;
    expect(routes.find(route => route.path === '/api/v1/health/live')?.authentication).toBe('PUBLIC');
    expect(routes.find(route => route.path === '/api/v1/new/:id')).toMatchObject({ method: 'GET', parameters: [{ name: 'id', in: 'path', required: true }], description: expect.stringContaining('아직 문서화되지 않았습니다') });
    expect(routes.some(route => route.method === 'HEAD')).toBe(false);
    await app.close();
  });
});
