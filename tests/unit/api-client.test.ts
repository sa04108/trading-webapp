import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api } from '../../src/web/lib/api-client.js';

describe('api client (웹 공용 fetch 래퍼)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns undefined for 204 No Content instead of failing JSON parse (Codex 리뷰)', async () => {
    // DELETE /backtests/:id 는 204 무본문 — json() 파싱하면 SyntaxError 로 실패 처리된다
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 204 })),
    );
    await expect(api('/backtests/bt_x', { method: 'DELETE' })).resolves.toBeUndefined();
  });

  it('parses JSON bodies on success', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      ),
    );
    await expect(api('/system/info')).resolves.toEqual({ ok: true });
  });

  it('throws ApiError with the server-provided message on failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: '알 수 없는 데이터셋' }), { status: 400 }),
      ),
    );
    const failure = api('/backtests', { method: 'POST', body: '{}' });
    await expect(failure).rejects.toBeInstanceOf(ApiError);
    await expect(failure).rejects.toMatchObject({ status: 400, message: '알 수 없는 데이터셋' });
  });
});
