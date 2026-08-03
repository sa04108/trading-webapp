import { describe, expect, it } from 'vitest';
import {
  filterSymbols,
  matchesSymbolQuery,
} from '../../src/web/features/datasets/symbol-search.js';

const SYMBOLS = [
  { code: '005930', name: '삼성전자' },
  { code: '000660', name: 'SK하이닉스' },
  { code: '035720', name: '카카오' },
  { code: '999999', name: null },
];

describe('matchesSymbolQuery', () => {
  it('빈 검색어는 전부 통과시킨다', () => {
    expect(matchesSymbolQuery(SYMBOLS[0]!, '')).toBe(true);
    expect(matchesSymbolQuery(SYMBOLS[3]!, '   ')).toBe(true);
  });

  it('이름 일부로 찾는다', () => {
    expect(matchesSymbolQuery(SYMBOLS[1]!, '하이닉스')).toBe(true);
  });

  it('코드 앞자리로 찾는다', () => {
    expect(matchesSymbolQuery(SYMBOLS[0]!, '0059')).toBe(true);
  });

  it('코드 가운데로도 찾는다 — 앞자리만 아는 경우가 전부는 아니다', () => {
    expect(matchesSymbolQuery(SYMBOLS[0]!, '593')).toBe(true);
  });

  it('대소문자를 무시한다 — 해외 티커를 소문자로 치는 것을 실패로 만들지 않는다', () => {
    expect(matchesSymbolQuery({ code: 'AAPL', name: 'Apple' }, 'aapl')).toBe(true);
    expect(matchesSymbolQuery({ code: 'AAPL', name: 'Apple' }, 'APP')).toBe(true);
  });

  it('앞뒤 공백은 무시한다', () => {
    expect(matchesSymbolQuery(SYMBOLS[2]!, '  카카오  ')).toBe(true);
  });

  it('이름이 없는 종목은 코드로만 걸린다', () => {
    expect(matchesSymbolQuery(SYMBOLS[3]!, '9999')).toBe(true);
    expect(matchesSymbolQuery(SYMBOLS[3]!, '삼성')).toBe(false);
  });

  it('어느 축에도 없으면 걸리지 않는다', () => {
    expect(matchesSymbolQuery(SYMBOLS[0]!, 'LG')).toBe(false);
  });
});

describe('filterSymbols', () => {
  it('빈 검색어는 원본을 그대로 돌려준다 — 매 렌더 새 배열을 만들지 않는다', () => {
    expect(filterSymbols(SYMBOLS, '')).toBe(SYMBOLS);
    expect(filterSymbols(SYMBOLS, '  ')).toBe(SYMBOLS);
  });

  it('이름·코드 어느 쪽이든 맞는 항목만 남긴다', () => {
    expect(filterSymbols(SYMBOLS, '카카오').map((s) => s.code)).toEqual(['035720']);
    expect(filterSymbols(SYMBOLS, '00').map((s) => s.code)).toEqual(['005930', '000660']);
  });

  it('결과가 없으면 빈 배열이다', () => {
    expect(filterSymbols(SYMBOLS, '없는종목')).toEqual([]);
  });

});
