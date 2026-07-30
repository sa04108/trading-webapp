import { describe, expect, it } from 'vitest';
import {
  formatSymbolLabel,
  formatSymbolSummary,
} from '../../src/web/features/backtests/symbol-summary.js';

const NAMES: Record<string, string> = {
  '005930': '삼성전자',
  '000660': 'SK하이닉스',
  '035720': '카카오',
  '035420': 'NAVER',
  '373220': 'LG에너지솔루션',
  '267260': 'HD현대일렉트릭',
};
const nameOf = (symbol: string): string | null => NAMES[symbol] ?? null;

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

describe('formatSymbolSummary', () => {
  it('빈 배열은 빈 문자열이다', () => {
    expect(formatSymbolSummary([], nameOf)).toBe('');
  });

  it('상한 이하면 전부 나열하고 접미사가 없다', () => {
    expect(formatSymbolSummary(['005930', '000660'], nameOf)).toBe(
      '삼성전자 (005930), SK하이닉스 (000660)',
    );
  });

  it('정확히 상한이면 접미사가 없다', () => {
    const five = ['005930', '000660', '035720', '035420', '373220'];
    const result = formatSymbolSummary(five, nameOf);
    expect(result).not.toContain('외');
    expect(result.split(', ')).toHaveLength(5);
  });

  it('상한을 넘으면 앞 5개 + "외 N종목" 이다', () => {
    const six = ['005930', '000660', '035720', '035420', '373220', '267260'];
    expect(formatSymbolSummary(six, nameOf)).toBe(
      '삼성전자 (005930), SK하이닉스 (000660), 카카오 (035720), NAVER (035420), LG에너지솔루션 (373220) 외 1종목',
    );
  });

  it('200종목이면 나머지를 개수로 접는다', () => {
    const many = Array.from({ length: 200 }, (_, index) => String(index).padStart(6, '0'));
    expect(formatSymbolSummary(many, nameOf)).toContain('외 195종목');
  });

  it('이름을 모르는 항목은 코드만 쓴다', () => {
    expect(formatSymbolSummary(['005930', '999999'], nameOf)).toBe('삼성전자 (005930), 999999');
  });

  it('전부 이름을 모르면 코드만 나열한다', () => {
    expect(formatSymbolSummary(['999999', '888888'], () => null)).toBe('999999, 888888');
  });

  it('limit 을 조정할 수 있다', () => {
    expect(formatSymbolSummary(['005930', '000660', '035720'], nameOf, 1)).toBe(
      '삼성전자 (005930) 외 2종목',
    );
  });
});
