import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  extractNumberParams,
  paramLabel,
  paramMetaLine,
} from '../../src/web/features/backtests/param-specs.js';
import { hourlyBreakoutParameters } from '../../src/server/modules/strategy/strategies/hourly-breakout.js';

const jsonSchema = z.toJSONSchema(hourlyBreakoutParameters) as Record<string, unknown>;

describe('extractNumberParams', () => {
  it('서버 스키마의 title·description 을 라벨·설명으로 옮긴다', () => {
    const specs = extractNumberParams(jsonSchema);
    const lookback = specs.find((s) => s.key === 'lookbackBars');
    expect(lookback?.label).toBe('돌파 기준 봉 수');
    expect(lookback?.help).toContain('최고가');
    expect(lookback?.minimum).toBe(2);
    expect(lookback?.maximum).toBe(200);
    expect(lookback?.defaultValue).toBe(20);
    expect(lookback?.isInteger).toBe(true);
  });

  it('시간봉 돌파 전략 파라미터 전부 한국어 라벨·설명을 갖는다', () => {
    const specs = extractNumberParams(jsonSchema);
    expect(specs.map((s) => s.key)).toEqual([
      'lookbackBars',
      'atrPeriod',
      'stopAtrMultiplier',
      'takeProfitAtrMultiplier',
      'riskPerTradePercent',
    ]);
    for (const spec of specs) {
      expect(spec.label, spec.key).toBeTruthy();
      expect(spec.help, spec.key).toBeTruthy();
    }
  });

  it('title 이 없으면 라벨은 원본 키로 폴백한다', () => {
    const specs = extractNumberParams(
      z.toJSONSchema(z.object({ bare: z.number() })) as Record<string, unknown>,
    );
    expect(specs).toHaveLength(1);
    expect(specs[0]!.label).toBeUndefined();
    expect(specs[0]!.help).toBeUndefined();
    expect(paramLabel(specs[0]!)).toBe('bare');
  });

  it('스키마가 없으면 빈 배열', () => {
    expect(extractNumberParams(undefined)).toEqual([]);
  });
});

describe('paramMetaLine', () => {
  it('원본 키·범위·기본값을 병기한다', () => {
    const specs = extractNumberParams(jsonSchema);
    const lookback = specs.find((s) => s.key === 'lookbackBars')!;
    expect(paramMetaLine(lookback)).toBe('lookbackBars · 2~200 · 기본 20');
  });

  it('기본값 없는 선택 파라미터는 선택 입력으로 표시한다', () => {
    const specs = extractNumberParams(jsonSchema);
    const takeProfit = specs.find((s) => s.key === 'takeProfitAtrMultiplier')!;
    expect(takeProfit.optional).toBe(true);
    expect(paramMetaLine(takeProfit)).toContain('선택 입력');
  });
});
