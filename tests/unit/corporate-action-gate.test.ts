import { describe, expect, it } from 'vitest';
import { ApiError } from '../../src/web/lib/api-client.js';
import {
  canCancelSyncJob,
  extractCorporateActionGate,
  formatCollectionEstimate,
  formatCollectionTarget,
  formatGateHeadline,
  formatRemainingGateMessage,
  formatSymbolNames,
  formatYearRange,
  isSyncJobTerminal,
  syncProgressPercent,
} from '../../src/web/features/backtests/corporate-action-gate-logic.js';

describe('extractCorporateActionGate', () => {
  it('ApiError 의 details 에서 corporateActionGate 를 꺼낸다', () => {
    const error = new ApiError(400, '수집한 적이 없습니다', {
      error: '수집한 적이 없습니다',
      corporateActionGate: { symbols: ['005930', '000660'], fromYear: 2025, toYear: 2026 },
    });
    expect(extractCorporateActionGate(error)).toEqual({
      symbols: ['005930', '000660'],
      fromYear: 2025,
      toYear: 2026,
    });
  });

  it('ApiError 가 아니면 null 이다', () => {
    expect(extractCorporateActionGate(new Error('그냥 오류'))).toBeNull();
  });

  it('details 에 corporateActionGate 가 없으면 null 이다 (다른 종류의 400)', () => {
    const error = new ApiError(400, '알 수 없는 전략', { error: '알 수 없는 전략' });
    expect(extractCorporateActionGate(error)).toBeNull();
  });

  it('details 가 없으면 null 이다', () => {
    const error = new ApiError(400, '오류');
    expect(extractCorporateActionGate(error)).toBeNull();
  });

  it('symbols 가 배열이 아니면 null 이다 (형태가 어긋난 응답)', () => {
    const error = new ApiError(400, '오류', {
      corporateActionGate: { symbols: '005930', fromYear: 2025, toYear: 2026 },
    });
    expect(extractCorporateActionGate(error)).toBeNull();
  });
});

describe('formatYearRange', () => {
  it('시작·끝 연도가 같으면 한 해만 적는다', () => {
    expect(formatYearRange(2026, 2026)).toBe('2026년');
  });

  it('다르면 범위로 적는다', () => {
    expect(formatYearRange(2025, 2026)).toBe('2025–2026년');
  });
});

describe('formatGateHeadline / formatCollectionTarget', () => {
  it('종목 수를 문장에 담는다', () => {
    expect(formatGateHeadline(23)).toBe('자본변동 이력이 없는 종목 23개가 있습니다.');
  });

  it('수집 대상 줄은 종목 수 × 연도 범위다', () => {
    expect(formatCollectionTarget(23, 2025, 2026)).toBe('수집 대상: 23종목 × 2025–2026년');
  });
});

describe('formatCollectionEstimate', () => {
  it('서버가 준 calls·estimatedMs 를 그대로 문장에 담는다 — 화면이 따로 추정하지 않는다', () => {
    const text = formatCollectionEstimate({ calls: 690, estimatedMs: 4 * 60_000, overDailyLimit: false });
    expect(text).toBe('예상 호출: 약 690회 · 예상 시간 약 4분');
  });

  it('1000 단위 구분자를 쓴다', () => {
    const text = formatCollectionEstimate({ calls: 12_000, estimatedMs: 60_000, overDailyLimit: true });
    expect(text).toContain('12,000회');
  });
});

describe('syncProgressPercent', () => {
  it('완료/전체 비율을 반올림한 정수로 낸다', () => {
    expect(syncProgressPercent(1, 3)).toBe(33);
  });

  it('전체가 0 이면 0 이다 (아직 계획을 못 받은 순간)', () => {
    expect(syncProgressPercent(0, 0)).toBe(0);
  });
});

describe('isSyncJobTerminal / canCancelSyncJob', () => {
  it('QUEUED·RUNNING 은 종료 상태가 아니고 취소할 수 있다', () => {
    expect(isSyncJobTerminal('QUEUED')).toBe(false);
    expect(isSyncJobTerminal('RUNNING')).toBe(false);
    expect(canCancelSyncJob('QUEUED')).toBe(true);
    expect(canCancelSyncJob('RUNNING')).toBe(true);
  });

  it('COMPLETED·FAILED·CANCELLED 는 종료 상태이고 취소할 수 없다', () => {
    for (const status of ['COMPLETED', 'FAILED', 'CANCELLED'] as const) {
      expect(isSyncJobTerminal(status)).toBe(true);
      expect(canCancelSyncJob(status)).toBe(false);
    }
  });
});

describe('formatSymbolNames / formatRemainingGateMessage', () => {
  const nameOf = (code: string): string | null => (code === '005930' ? '삼성전자' : null);

  it('이름을 알면 이름(코드), 모르면 코드만 적는다', () => {
    expect(formatSymbolNames(['005930', '900050'], nameOf)).toBe('삼성전자 (005930), 900050');
  });

  it('수집 후 여전히 실패한 종목을 이름으로 밝힌다 — "일부 실패" 로 뭉뚱그리지 않는다', () => {
    const message = formatRemainingGateMessage(['900050'], nameOf);
    expect(message).toContain('900050');
    expect(message).not.toContain('일부 실패');
  });
});
