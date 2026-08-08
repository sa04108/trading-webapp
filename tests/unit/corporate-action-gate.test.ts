import { describe, expect, it } from 'vitest';
import { ApiError } from '../../src/web/lib/api-client.js';
import {
  canCancelSyncJob,
  extractActiveSyncJobId,
  extractCorporateActionGate,
  formatCollectionEstimate,
  formatCollectionTarget,
  formatGateHeadline,
  formatRemainingGateMessage,
  formatSymbolNames,
  formatYearRange,
  isSyncJobTerminal,
  selectSyncJob,
  syncJobRefetchIntervalMs,
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

  it('하루 한도를 넘으면 경고를 이어 붙인다 — 계산해 놓고 버리지 않는다', () => {
    const text = formatCollectionEstimate({
      calls: 120_000,
      estimatedMs: 4 * 3_600_000,
      overDailyLimit: true,
    });
    expect(text).toContain('하루 호출 한도를 넘습니다');
    expect(text).toContain('나눠');
  });

  it('한도 안이면 경고를 붙이지 않는다', () => {
    const text = formatCollectionEstimate({ calls: 690, estimatedMs: 60_000, overDailyLimit: false });
    expect(text).not.toContain('한도');
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

describe('syncJobRefetchIntervalMs — SSE 폴백(리뷰 finding 1)', () => {
  it('상태를 아직 모르면 폴링하지 않는다', () => {
    expect(syncJobRefetchIntervalMs(null, true)).toBe(false);
  });

  it('SSE 가 살아 있으면(sseFailed=false) 폴링하지 않는다 — SSE 가 진행률을 나른다', () => {
    expect(syncJobRefetchIntervalMs('RUNNING', false)).toBe(false);
  });

  it('SSE 가 끊기고(sseFailed=true) 아직 종료 전이면 2초마다 폴링한다', () => {
    expect(syncJobRefetchIntervalMs('RUNNING', true)).toBe(2_000);
    expect(syncJobRefetchIntervalMs('QUEUED', true)).toBe(2_000);
  });

  it('이미 종료된 상태면 SSE 가 끊겼어도 더 폴링하지 않는다', () => {
    expect(syncJobRefetchIntervalMs('COMPLETED', true)).toBe(false);
    expect(syncJobRefetchIntervalMs('FAILED', true)).toBe(false);
    expect(syncJobRefetchIntervalMs('CANCELLED', true)).toBe(false);
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

describe('selectSyncJob — SSE 가 끊긴 뒤에도 진행률이 이어져야 한다', () => {
  const job = (id: string, doneSymbols: number, status: 'RUNNING' | 'COMPLETED') =>
    ({
      id,
      status,
      symbols: ['005930'],
      fromYear: 2025,
      toYear: 2026,
      doneSymbols,
      totalSymbols: 10,
      savedFacts: null,
      gapCount: null,
      error: null,
      createdAtMs: 0,
      completedAtMs: null,
    }) as const;

  it('SSE 가 살아 있으면 그 값이 이긴다', () => {
    const chosen = selectSyncJob(job('cas1', 7, 'RUNNING'), job('cas1', 3, 'RUNNING'), false);
    expect(chosen?.doneSymbols).toBe(7);
  });

  it('SSE 가 끊기면 폴링 값이 이긴다 — 얼어붙은 값을 계속 쓰면 진행률이 멈춘다', () => {
    const frozen = job('cas1', 3, 'RUNNING');
    const polled = job('cas1', 9, 'RUNNING');
    expect(selectSyncJob(frozen, polled, true)?.doneSymbols).toBe(9);
  });

  it('SSE 가 끊긴 뒤 폴링이 완료를 물어오면 완료로 보인다', () => {
    const frozen = job('cas1', 3, 'RUNNING');
    const polled = job('cas1', 10, 'COMPLETED');
    expect(selectSyncJob(frozen, polled, true)?.status).toBe('COMPLETED');
  });

  it('끊긴 직후 폴링이 아직 없으면 얼어붙은 값이라도 쓴다 — 화면을 비우지 않는다', () => {
    const frozen = job('cas1', 3, 'RUNNING');
    expect(selectSyncJob(frozen, null, true)?.doneSymbols).toBe(3);
  });

  it('둘 다 없으면 null 이다', () => {
    expect(selectSyncJob(null, null, false)).toBeNull();
  });
});

describe('extractActiveSyncJobId', () => {
  it('409 응답에서 도는 잡의 id 를 꺼낸다', () => {
    const error = new ApiError(409, '이미 실행 중입니다', {
      error: '이미 실행 중입니다',
      activeJobId: 'cas_abc',
    });
    expect(extractActiveSyncJobId(error)).toBe('cas_abc');
  });

  it('409 가 아니면 null 이다 — 다른 오류를 잡 id 로 오인하지 않는다', () => {
    const error = new ApiError(400, '잘못된 요청', { error: '잘못된 요청', activeJobId: 'cas_abc' });
    expect(extractActiveSyncJobId(error)).toBeNull();
  });

  it('id 가 없거나 문자열이 아니면 null 이다', () => {
    expect(extractActiveSyncJobId(new ApiError(409, '이미 실행 중입니다', { error: 'x' }))).toBeNull();
    expect(
      extractActiveSyncJobId(new ApiError(409, '이미 실행 중입니다', { activeJobId: 42 })),
    ).toBeNull();
    expect(extractActiveSyncJobId(new Error('boom'))).toBeNull();
  });
});
