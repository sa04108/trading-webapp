import { describe, expect, it } from 'vitest';
import {
  pageNumberLimitForWidth,
  pageWindow,
  visiblePageNumbers,
} from '../../src/web/lib/pagination.js';

describe('pageWindow', () => {
  it('returns the first page range', () => {
    expect(pageWindow(100, 10, 0)).toEqual({ pageCount: 10, currentPage: 0, from: 0, to: 10 });
  });

  it('returns a shortened final page range', () => {
    expect(pageWindow(95, 10, 9)).toEqual({ pageCount: 10, currentPage: 9, from: 90, to: 95 });
  });

  it('calculates one empty-list page', () => {
    expect(pageWindow(0, 10, 0)).toEqual({ pageCount: 1, currentPage: 0, from: 0, to: 0 });
  });

  it('clamps an empty-list page request to zero', () => {
    expect(pageWindow(0, 10, 7)).toEqual({ pageCount: 1, currentPage: 0, from: 0, to: 0 });
  });

  it('does not add a blank final page for exact division', () => {
    expect(pageWindow(20, 10, 0).pageCount).toBe(2);
    expect(pageWindow(10, 10, 0).pageCount).toBe(1);
  });

  it('clamps a page that disappears after the list shrinks', () => {
    expect(pageWindow(15, 10, 5)).toEqual({ pageCount: 2, currentPage: 1, from: 10, to: 15 });
  });

  it('normalizes negative pages and non-positive page sizes', () => {
    expect(pageWindow(100, 10, -3).currentPage).toBe(0);
    expect(pageWindow(3, 0, 0)).toEqual({ pageCount: 3, currentPage: 0, from: 0, to: 1 });
    expect(pageWindow(3, -5, 2)).toEqual({ pageCount: 3, currentPage: 2, from: 2, to: 3 });
  });

  it('keeps a page size larger than the list to one page', () => {
    expect(pageWindow(7, 200, 0)).toEqual({ pageCount: 1, currentPage: 0, from: 0, to: 7 });
  });

  it('calculates 100 pages for 1,000 symbols at 10 per page', () => {
    expect(pageWindow(1000, 10, 99)).toEqual({
      pageCount: 100,
      currentPage: 99,
      from: 990,
      to: 1000,
    });
  });
});

describe('visiblePageNumbers', () => {
  it('shows every page when there are fewer than the limit', () => {
    expect(visiblePageNumbers(0, 4, 5)).toEqual([1, 2, 3, 4]);
  });

  it('pins the first window to page one', () => {
    expect(visiblePageNumbers(1, 100, 9)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it('centers the middle window on the current page', () => {
    expect(visiblePageNumbers(49, 100, 9)).toEqual([46, 47, 48, 49, 50, 51, 52, 53, 54]);
  });

  it('pins the final window to the final page', () => {
    expect(visiblePageNumbers(98, 100, 9)).toEqual([92, 93, 94, 95, 96, 97, 98, 99, 100]);
  });

  it('clamps out-of-range current pages before calculating a window', () => {
    expect(visiblePageNumbers(-4, 10, 5)).toEqual([1, 2, 3, 4, 5]);
    expect(visiblePageNumbers(50, 10, 5)).toEqual([6, 7, 8, 9, 10]);
  });
});

describe('pageNumberLimitForWidth', () => {
  it('selects five, seven, or nine items at the responsive breakpoints', () => {
    expect(pageNumberLimitForWidth(639)).toBe(5);
    expect(pageNumberLimitForWidth(640)).toBe(7);
    expect(pageNumberLimitForWidth(1023)).toBe(7);
    expect(pageNumberLimitForWidth(1024)).toBe(9);
  });
});
