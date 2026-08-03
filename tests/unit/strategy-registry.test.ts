import { describe, expect, it } from 'vitest';
import { StrategyRegistry } from '../../src/server/modules/strategy/application/strategy-registry.js';
import type { AnyTradingStrategy } from '../../src/server/modules/strategy/domain/strategy.js';

const registry = new StrategyRegistry();

describe('StrategySummary 의 재무 요구 표시', () => {
  it('재무 전략은 true 로 내려간다', () => {
    const summary = registry.list().find((s) => s.id === 'value-quality-rank');
    expect(summary?.requiresFundamentals).toBe(true);
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
      'ema-trend-switch',
      'rsi-reversion',
    ]) {
      expect(ids, id).toContain(id);
    }
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
