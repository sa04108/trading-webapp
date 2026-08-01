import { describe, expect, it } from 'vitest';
import { pageWindow } from '../../src/web/features/datasets/symbol-paging.js';

describe('pageWindow', () => {
  it('첫 페이지는 앞에서 pageSize 만큼 자른다', () => {
    expect(pageWindow(100, 10, 0)).toEqual({ pageCount: 10, currentPage: 0, from: 0, to: 10 });
  });

  it('마지막 페이지는 남은 만큼만 자른다', () => {
    expect(pageWindow(95, 10, 9)).toEqual({ pageCount: 10, currentPage: 9, from: 90, to: 95 });
  });

  it('빈 목록도 1페이지다 — 「0 / 0 페이지」 를 만들지 않는다', () => {
    expect(pageWindow(0, 10, 0)).toEqual({ pageCount: 1, currentPage: 0, from: 0, to: 0 });
  });

  it('나누어떨어지면 빈 마지막 페이지를 만들지 않는다', () => {
    expect(pageWindow(20, 10, 0).pageCount).toBe(2);
    expect(pageWindow(10, 10, 0).pageCount).toBe(1);
  });

  /**
   * 목록이 줄어들면(검색·제거) 보고 있던 페이지가 사라진다. 그때 빈 화면을 그리지 않게
   * 마지막 페이지로 당긴다 — 호출부가 page 상태를 되쓰지 않아도 되게 계산만 여기서 한다.
   */
  it('목록이 줄어 페이지가 사라지면 마지막 페이지로 당긴다', () => {
    expect(pageWindow(15, 10, 5)).toEqual({ pageCount: 2, currentPage: 1, from: 10, to: 15 });
  });

  it('목록이 비면 0페이지로 당긴다', () => {
    expect(pageWindow(0, 10, 7)).toEqual({ pageCount: 1, currentPage: 0, from: 0, to: 0 });
  });

  it('음수 page 는 0으로 올린다', () => {
    expect(pageWindow(100, 10, -3).currentPage).toBe(0);
  });

  it('pageSize 0 이하는 1로 올린다 — 0으로 나누면 pageCount 가 Infinity 다', () => {
    expect(pageWindow(3, 0, 0)).toEqual({ pageCount: 3, currentPage: 0, from: 0, to: 1 });
    expect(pageWindow(3, -5, 2)).toEqual({ pageCount: 3, currentPage: 2, from: 2, to: 3 });
  });

  it('페이지당이 목록보다 크면 전부 한 페이지에 담는다', () => {
    expect(pageWindow(7, 200, 0)).toEqual({ pageCount: 1, currentPage: 0, from: 0, to: 7 });
  });

  it('1000종목 · 페이지당 10 이면 100페이지다 (데이터셋 편집 기본값)', () => {
    const window = pageWindow(1000, 10, 99);
    expect(window.pageCount).toBe(100);
    expect(window).toMatchObject({ currentPage: 99, from: 990, to: 1000 });
  });
});
