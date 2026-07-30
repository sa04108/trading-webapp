import { describe, expect, it } from 'vitest';
import { parsePageSize } from '../../src/web/features/backtests/page-size.js';

describe('parsePageSize', () => {
  it('숫자 문자열을 그대로 쓴다', () => {
    expect(parsePageSize('35', 50)).toBe(35);
  });

  it('비어 있거나 숫자가 아니면 기본값으로 돌아간다', () => {
    expect(parsePageSize('', 50)).toBe(50);
    expect(parsePageSize('abc', 20)).toBe(20);
  });

  it('1~200 으로 클램프한다', () => {
    expect(parsePageSize('0', 50)).toBe(1);
    expect(parsePageSize('-5', 50)).toBe(1);
    expect(parsePageSize('999', 50)).toBe(200);
  });

  it('상한을 따로 주면 그 값으로 클램프한다 — 거래 내역은 10건 제한', () => {
    expect(parsePageSize('50', 10, 10)).toBe(10);
    expect(parsePageSize('7', 10, 10)).toBe(7);
    expect(parsePageSize('', 10, 10)).toBe(10);
  });
});
