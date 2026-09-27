import { describe, expect } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { test as base } from '../helpers/test-fixtures.js';

const test = base.extend({
  appOptions: {
    configure: (app: FastifyInstance) => {
      app.get('/test/large', async () => ({ data: 'x'.repeat(4096) }));
    },
  },
});

describe('응답 압축', () => {
  test('threshold 를 넘는 응답을 gzip 으로 압축한다', async ({ ctx }) => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/test/large',
      headers: { 'accept-encoding': 'gzip' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-encoding']).toBe('gzip');
  });

  test('Accept-Encoding 이 없으면 압축하지 않는다', async ({ ctx }) => {
    const res = await ctx.app.inject({ method: 'GET', url: '/test/large' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-encoding']).toBeUndefined();
  });
});
