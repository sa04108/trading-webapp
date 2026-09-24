import { describe, expect, it, vi } from 'vitest';
import { measureAsync, measureSync, withDiagnostics } from '../../src/runtime/shared/diagnostics.js';

describe('작업 진단 컨텍스트', () => {
  it('동시 비동기 작업의 식별자를 분리하고 실패에도 원래 예외를 보존한다', async () => {
    const first = vi.fn(), second = vi.fn(); const cause = new Error('원본');
    await Promise.all([
      withDiagnostics({ reqId: 'one' }, first, () => measureAsync('validation', async () => { await Promise.resolve(); return [1, 2]; }, { logStart: true })),
      withDiagnostics({ dataRequestId: 'two' }, second, () => measureAsync('collection', async () => { await Promise.resolve(); throw cause; }, { logStart: true })).catch((error: unknown) => expect(error).toBe(cause)),
    ]);
    expect(first.mock.calls.map(([fields]) => fields.reqId)).toEqual(['one', 'one']);
    expect(first.mock.calls[1]![0]).toMatchObject({ rowCount: 2, outcome: 'COMPLETED' });
    expect(second.mock.calls.map(([fields]) => fields.dataRequestId)).toEqual(['two', 'two']);
    expect(second.mock.calls[1]![0]).toMatchObject({ outcome: 'FAILED' });
  });
  it('로그 출력 오류와 진단 밖 호출은 작업 결과에 영향을 주지 않는다', () => {
    const broken = () => { throw new Error('로거'); };
    expect(withDiagnostics({ jobId: 'one' }, broken, () => measureSync('sql', () => 42, { logStart: true }))).toBe(42);
    expect(measureSync('sql', () => 13)).toBe(13);
  });
});
