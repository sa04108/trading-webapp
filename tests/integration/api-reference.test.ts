import { describe, expect } from 'vitest';
import { authenticatedTest as it } from '../helpers/test-fixtures.js';
import type { ApiReference } from '../../src/shared/schemas/api-reference.js';

describe('API reference', () => {
  it('실제 등록 경로마다 상세 계약을 제공하고 인증 없이 노출하지 않는다', async ({ ctx, cookie }) => {
    const url = '/api/v1/system/api-reference';
    expect((await ctx.app.inject({ method: 'GET', url })).statusCode).toBe(401);
    const response = await ctx.app.inject({ method: 'GET', url, cookies: { session: cookie } });
    expect(response.statusCode, response.body).toBe(200);
    const reference = response.json<ApiReference>();
    expect(reference.version).toBe('1');
    expect(reference.endpoints.length).toBeGreaterThan(100);
    const gaps = reference.endpoints.filter(endpoint => endpoint.description.includes('아직 문서화되지 않았습니다') || endpoint.responses.some(result => result.status === 'default'));
    expect(gaps.map(endpoint => endpoint.id)).toEqual([]);
    for (const endpoint of reference.endpoints) {
      expect(endpoint.title).toBeTruthy();
      expect(endpoint.responses.length).toBeGreaterThan(0);
      for (const pathPart of endpoint.path.matchAll(/:([A-Za-z0-9_]+)/g)) expect(endpoint.parameters).toEqual(expect.arrayContaining([expect.objectContaining({ name: pathPart[1], in: 'path', required: true })]));
    }
    expect(reference.endpoints.map(endpoint => endpoint.id)).toContain('GET /api/agents/connect');
    expect(reference.endpoints.map(endpoint => endpoint.id)).toContain('POST /api/v1/backtests/:id/configuration-search/preview');
  });
});
