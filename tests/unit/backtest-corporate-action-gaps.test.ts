import { describe, expect, it } from 'vitest';
import {
  findRelevantCorporateActionGaps,
} from '../../src/server/modules/backtest/application/backtest-corporate-action-gaps.js';

const DETAILS = new Map([['005930', [{
  year: 2025,
  periodKey: '-',
  reason: '분류할 수 없는 발행형태: -',
  severity: 'BLOCKING' as const,
}]]]);

const WINDOW = {
  executionFrom: '2025-01-01',
  executionTo: '2025-12-31',
  rawFrom: '2024-10-03',
  rawTo: '2026-01-30',
};

describe('findRelevantCorporateActionGaps', () => {
  it('DART gap 연도에 KRX 주식수 변경이 없으면 실행을 막지 않는다', () => {
    expect(findRelevantCorporateActionGaps(DETAILS, [], WINDOW)).toEqual([]);
  });

  it('일자를 모르는 DART gap 주변에 실제 KRX 변경이 있으면 차단 대상으로 남긴다', () => {
    expect(findRelevantCorporateActionGaps(DETAILS, [{
      shortCode: '005930',
      effectiveDate: '2025-05-15',
      ratio: 2,
    }], WINDOW)).toEqual([{
      symbol: '005930',
      ...DETAILS.get('005930')![0],
    }]);
  });

  it('일자가 있는 gap은 정렬 허용 창 안의 KRX 변경과만 연결한다', () => {
    const dated = new Map([['005930', [{
      year: 2025,
      periodKey: '2025-03-01',
      reason: '직전 발행주식수를 알 수 없습니다',
      severity: 'BLOCKING' as const,
    }]]]);
    const far = {
      shortCode: '005930',
      effectiveDate: '2025-07-01',
      ratio: 2,
    };
    const nearby = {
      shortCode: '005930',
      effectiveDate: '2025-03-20',
      ratio: 2,
    };

    expect(findRelevantCorporateActionGaps(dated, [far], WINDOW)).toEqual([]);
    expect(findRelevantCorporateActionGaps(dated, [nearby], WINDOW)).toHaveLength(1);
  });
});
