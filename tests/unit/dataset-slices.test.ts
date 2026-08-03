import { describe, expect, it } from 'vitest';
import {
  sliceHasData,
  sliceLabel,
  wizardTimeframes,
} from '../../src/web/features/datasets/dataset-slices.js';

const both = [
  { slice: '1d' as const, hasData: true },
  { slice: '1m' as const, hasData: true },
];

describe('sliceLabel / sliceHasData', () => {
  it('슬라이스 라벨은 일봉·분봉이고 hasData 를 그대로 읽는다', () => {
    expect(sliceLabel('1d')).toBe('일봉');
    expect(sliceLabel('1m')).toBe('분봉');
    expect(sliceHasData(both, '1m')).toBe(true);
    expect(sliceHasData([{ slice: '1d', hasData: false }], '1d')).toBe(false);
    expect(sliceHasData([], '1m')).toBe(false);
  });
});

describe('wizardTimeframes', () => {
  it('데이터 있는 슬라이스에서만 소비 봉을 도출한다', () => {
    expect(wizardTimeframes([{ slice: '1d', hasData: true }])).toEqual(['1d']);
    expect(wizardTimeframes([{ slice: '1m', hasData: true }])).toEqual(['1h', '1m']);
    expect(wizardTimeframes(both)).toEqual(['1d', '1h', '1m']);
    expect(wizardTimeframes([{ slice: '1m', hasData: false }])).toEqual([]);
  });
});
