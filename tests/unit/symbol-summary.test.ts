import { describe, expect, it } from 'vitest';
import {
  clampSymbolName,
  formatSymbolLabel,
  SYMBOL_NAME_MAX_CHARS,
} from '../../src/web/features/backtests/symbol-summary.js';

describe('formatSymbolLabel', () => {
  it('이름이 있으면 "이름 (코드)" 다', () => {
    expect(formatSymbolLabel('005930', '삼성전자')).toBe('삼성전자 (005930)');
  });

  it('이름이 없으면 코드만이다 — 빈 괄호를 만들지 않는다', () => {
    expect(formatSymbolLabel('005930', null)).toBe('005930');
  });

  it('빈 문자열 이름도 코드만으로 다룬다', () => {
    expect(formatSymbolLabel('005930', '')).toBe('005930');
  });
});

describe('clampSymbolName', () => {
  it('상한 이하 이름은 건드리지 않는다', () => {
    expect(clampSymbolName('삼성전자')).toBe('삼성전자');
  });

  it('정확히 상한인 이름도 건드리지 않는다', () => {
    const exact = '가'.repeat(SYMBOL_NAME_MAX_CHARS);
    expect(clampSymbolName(exact)).toBe(exact);
  });

  it('상한을 넘으면 줄이고 …을 붙여 상한 길이를 지킨다', () => {
    const long = '가'.repeat(SYMBOL_NAME_MAX_CHARS + 5);
    const result = clampSymbolName(long);
    expect(result).toBe(`${'가'.repeat(SYMBOL_NAME_MAX_CHARS - 1)}…`);
    expect(result).toHaveLength(SYMBOL_NAME_MAX_CHARS);
  });

  it('null·빈 이름은 그대로 흘려 코드만 남게 한다', () => {
    expect(clampSymbolName(null)).toBeNull();
    expect(clampSymbolName('')).toBe('');
  });

  it('상한을 조정할 수 있다', () => {
    expect(clampSymbolName('에이치엘비생명과학', 4)).toBe('에이치…');
  });

  it('라벨과 합치면 이름만 줄고 코드는 온전하다', () => {
    expect(formatSymbolLabel('267260', clampSymbolName('HD현대일렉트릭', 4))).toBe(
      'HD현… (267260)',
    );
  });
});
