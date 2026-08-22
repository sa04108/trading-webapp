import { describe, expect, it } from 'vitest';
import { StrategyRegistry } from '../../src/server/modules/strategy/application/strategy-registry.js';
import type { AnyTradingStrategy } from '../../src/server/modules/strategy/domain/strategy.js';

const registry = new StrategyRegistry();

describe('StrategySummary 의 재무 요구 표시', () => {
  it('재무 전략은 true 로 내려간다', () => {
    for (const id of [
      'value-quality-rank',
      'earnings-acceleration-rank',
      'low-per-high-roe-rank',
    ]) {
      const summary = registry.list().find((s) => s.id === id);
      expect(summary?.requiresFundamentals, id).toBe(true);
    }
  });

  it('봉만 쓰는 전략은 undefined 가 아니라 false 로 내려간다', () => {
    // 도메인에서는 생략된 선택 필드다. 그대로 내리면 화면이 "재무를 안 쓴다" 와
    // "서버가 알려주지 않았다" 를 구분할 수 없어 배지가 침묵한다.
    for (const id of ['range-breakout', 'cross-sectional-momentum', 'ema-trend-switch']) {
      const summary = registry.list().find((s) => s.id === id);
      expect(summary?.requiresFundamentals, id).toBe(false);
    }
  });

});

describe('전략 등록 목록', () => {
  // 개별 전략 테스트 파일마다 toContain 을 반복하지 않고 여기 한 곳에서 고정한다
  it('출시된 전략이 전부 등록돼 있다', () => {
    const ids = registry.list().map((s) => s.id);
    for (const id of [
      'range-breakout',
      'cross-sectional-momentum',
      'value-quality-rank',
      'earnings-acceleration-rank',
      'low-per-high-roe-rank',
      'ema-trend-switch',
      'rsi-reversion',
    ]) {
      expect(ids, id).toContain(id);
    }
  });
});

describe('재무 순위 전략 metadata', () => {
  it('신규 ID, version, 이름, 설명을 정확히 등록한다', () => {
    expect(registry.describe('earnings-acceleration-rank')).toEqual({
      id: 'earnings-acceleration-rank',
      version: '1.2.0',
      name: '이익 가속·가격 확인 순위',
      requiresFundamentals: true,
      description: 'PIT 영업이익 가속과 양의 가격 모멘텀을 함께 순위화하는 동일가중 연구 전략',
    });
    expect(registry.describe('low-per-high-roe-rank')).toEqual({
      id: 'low-per-high-roe-rank',
      version: '1.2.0',
      name: '저PER·고ROE 순위',
      requiresFundamentals: true,
      description: 'PIT TTM 순이익 기준 저PER과 고ROE를 결합하는 동일가중 연구 전략',
    });
  });

  it('신규 전략 parameter JSON schema에 기본값을 노출한다', () => {
    const earnings = registry.getParameterJsonSchema('earnings-acceleration-rank') as {
      properties: Record<string, Record<string, unknown>>;
    };
    const lowPer = registry.getParameterJsonSchema('low-per-high-roe-rank') as {
      properties: Record<string, Record<string, unknown>>;
    };
    expect(earnings.properties.topN?.default).toBe(40);
    expect(earnings.properties.priceMomentumDays?.default).toBe(126);
    expect(lowPer.properties.topN?.default).toBe(40);
    expect(lowPer.properties.staleQuarters?.default).toBe(2);
  });
});

describe('requiresFundamentals()', () => {
  it('모르는 전략은 false — 여기서 예외를 던지면 제출 검증 순서가 뒤바뀐다', () => {
    expect(registry.requiresFundamentals('nope')).toBe(false);
  });
});

describe('describe() 는 list() 항목과 같은 값을 준다', () => {
  it('두 응답이 어긋나면 화면이 경로에 따라 다른 데이터 요구를 말한다', () => {
    for (const summary of registry.list()) {
      expect(registry.describe(summary.id)).toEqual(summary);
    }
  });

  it('모르는 전략은 null — 라우트가 404 로 바꾼다', () => {
    expect(registry.describe('nope')).toBeNull();
  });
});

describe('requiresFundamentals 가 명시적으로 false 인 전략', () => {
  // 생략(undefined)과 명시적 false 를 같게 다뤄야 한다 — `=== true` 비교의 회귀 방어
  const explicitFalse = {
    id: 'x',
    version: '1.0.0',
    name: 'x',
    description: 'x',
    requiresFundamentals: false,
  } as unknown as AnyTradingStrategy;

  it('false 로 그대로 내려간다', () => {
    expect(new StrategyRegistry([explicitFalse]).list()[0]?.requiresFundamentals).toBe(false);
  });
});
