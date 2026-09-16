import { test as base } from 'vitest';
import { createTestApp, type TestApp } from './test-app.js';

/** 앱과 모든 background 자원을 테스트 하나의 수명에 묶는다. */
export const test = base.extend<{ ctx: TestApp }>({
  // Vitest가 fixture 의존성 분석을 위해 빈 객체 구조 분해를 요구한다.
  // eslint-disable-next-line no-empty-pattern
  ctx: async ({}, use) => {
    const ctx = await createTestApp();
    try {
      await use(ctx);
    } finally {
      await ctx.close();
    }
  },
});
