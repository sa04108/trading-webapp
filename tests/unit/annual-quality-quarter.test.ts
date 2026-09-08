import { describe, expect, it } from 'vitest';
import { annualQuality, annualQualityParameters, type AnnualObservation } from '../../scripts/quarter-research/annual-quality-momentum.js';

const p = annualQualityParameters.parse({});
const prior: AnnualObservation = { code: 'A', year: 2024, basis: 'CFS', asof: '2025-03-20', receipt: '20250320000000', operating_income: 100, equity: 900 };
const latest: AnnualObservation = { code: 'A', year: 2025, basis: 'CFS', asof: '2026-03-20', receipt: '20260320000000', operating_income: 130, equity: 1000 };

describe('연간 실적의 과거 시점 필터', () => {
  it('공시 당일에는 새 연간 실적을 앞당겨 사용하지 않는다', () => {
    expect(annualQuality([prior, latest], Date.parse('2026-03-20'), p)).toBeNull();
    expect(annualQuality([prior, latest], Date.parse('2026-03-21'), p)?.growth).toBeCloseTo(.3);
  });

  it('연결과 별도 기준을 섞어서 성장률을 만들지 않는다', () => {
    expect(annualQuality([{ ...prior, basis: 'OFS' }, latest], Date.parse('2026-04-01'), p)).toBeNull();
  });

  it('정정 공시가 미래에 반환됐으면 과거 최초 공시값으로 소급하지 않는다', () => {
    const revised = { ...latest, asof: '2026-08-01', receipt: '20260801000000' };
    expect(annualQuality([prior, revised], Date.parse('2026-04-01'), p)).toBeNull();
    expect(annualQuality([prior, revised], Date.parse('2026-08-02'), p)?.receipt).toBe('20260801000000');
  });

  it('적자에서 흑자로 전환한 값을 일반 성장률로 나누지 않는다', () => {
    expect(annualQuality([{ ...prior, operating_income: -100 }, latest], Date.parse('2026-04-01'), p)).toBeNull();
  });

  it('너무 오래된 공시와 자본잠식은 제외한다', () => {
    expect(annualQuality([prior, latest], Date.parse('2028-01-01'), p)).toBeNull();
    expect(annualQuality([prior, { ...latest, equity: -100 }], Date.parse('2026-04-01'), p)).toBeNull();
  });
});
