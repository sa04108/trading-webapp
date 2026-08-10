import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api, postJsonWithStatus } from '../../src/web/lib/api-client.js';

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

  it('ApiError 가 응답 본문 전체를 details 로 들고 있다 (구조화 오류 필드용, 예: uncoveredDates)', async () => {
    const payload = {
      error: '종목 마스터가 다음 리밸런스 날짜를 커버하지 않습니다',
      uncoveredDates: ['2026-01-05'],
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(payload), { status: 400 })),
    );
    const failure = api('/backtests', { method: 'POST', body: '{}' });
    await expect(failure).rejects.toMatchObject({ details: payload });
  });
});

describe('postJsonWithStatus (200 READY vs 202 PREPARING 구분용, Task 10)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('성공 응답의 status 코드를 몸통과 함께 돌려준다 — 202 도 성공이다', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ job: { id: 'prep_1' } }), { status: 202 })),
    );
    await expect(postJsonWithStatus('/backtests/universe-preview', {})).resolves.toEqual({
      status: 202,
      data: { job: { id: 'prep_1' } },
    });
  });

  it('실패 응답은 api() 와 같은 ApiError 를 던진다', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ error: '알 수 없는 전략' }), { status: 400 })),
    );
    const failure = postJsonWithStatus('/backtests/universe-preview', {});
    await expect(failure).rejects.toBeInstanceOf(ApiError);
    await expect(failure).rejects.toMatchObject({ status: 400, message: '알 수 없는 전략' });
  });
});
