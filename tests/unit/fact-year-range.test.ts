import { describe, expect, it } from 'vitest';
import { deriveFactYearRange } from '../../src/server/modules/market-data/domain/fact-year-range.js';

/** 2020-01-01 09:00 KST = 2020-01-01 00:00 UTC */
const KST_2020_OPEN = Date.UTC(2020, 0, 1, 0, 0);
/** 2024-06-03 09:00 KST */
const KST_2024 = Date.UTC(2024, 5, 3, 0, 0);
/** 2019-12-31 23:00 KST = 2019-12-31 14:00 UTC — KST 로는 아직 2019년 */
const KST_2019_LATE = Date.UTC(2019, 11, 31, 14, 0);

describe('deriveFactYearRange', () => {
  it('봉이 있는 종목의 최초·최종 연도를 돌려준다', () => {
    expect(
      deriveFactYearRange(
        [
          { firstTsMs: KST_2020_OPEN, lastTsMs: KST_2024, barCount: 100 },
          { firstTsMs: KST_2024, lastTsMs: KST_2024, barCount: 50 },
        ],
        'KR',
      ),
    ).toEqual({ fromYear: 2020, toYear: 2024 });
  });

  it('barCount 가 0 인 행은 무시한다', () => {
    expect(
      deriveFactYearRange(
        [
          { firstTsMs: KST_2020_OPEN, lastTsMs: KST_2020_OPEN, barCount: 0 },
          { firstTsMs: KST_2024, lastTsMs: KST_2024, barCount: 10 },
        ],
        'KR',
      ),
    ).toEqual({ fromYear: 2024, toYear: 2024 });
  });

  it('봉이 하나도 없으면 null 이다', () => {
    expect(deriveFactYearRange([], 'KR')).toBeNull();
    expect(
      deriveFactYearRange([{ firstTsMs: KST_2020_OPEN, lastTsMs: KST_2024, barCount: 0 }], 'KR'),
    ).toBeNull();
  });

  it('타임스탬프가 null 인 행은 무시한다', () => {
    expect(
      deriveFactYearRange(
        [
          { firstTsMs: null, lastTsMs: null, barCount: 5 },
          { firstTsMs: KST_2024, lastTsMs: KST_2024, barCount: 5 },
        ],
        'KR',
      ),
    ).toEqual({ fromYear: 2024, toYear: 2024 });
  });

  it('UTC 가 아니라 거래소 현지(KST) 연도로 자른다', () => {
    // UTC 로는 2019-12-31, KST 로도 2019-12-31 — 둘 다 2019
    expect(deriveFactYearRange([{ firstTsMs: KST_2019_LATE, lastTsMs: KST_2019_LATE, barCount: 1 }], 'KR')).toEqual({
      fromYear: 2019,
      toYear: 2019,
    });
    // UTC 로는 2019-12-31 15:00 이지만 KST 로는 2020-01-01 00:00 — 2020 이어야 한다
    const kstNewYear = Date.UTC(2019, 11, 31, 15, 0);
    expect(deriveFactYearRange([{ firstTsMs: kstNewYear, lastTsMs: kstNewYear, barCount: 1 }], 'KR')).toEqual({
      fromYear: 2020,
      toYear: 2020,
    });
  });
});
