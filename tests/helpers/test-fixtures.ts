import { test as base } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  createTestAdmin,
  createTestApp,
  type TestAdminOptions,
  type TestApp,
} from './test-app.js';

export interface TestAppOptions {
  readonly env?: Readonly<Record<string, string>>;
  readonly configure?: (app: FastifyInstance) => void;
  readonly agentPreparation?: boolean;
}

export interface TestAppFactory {
  create(options?: TestAppOptions): Promise<TestApp>;
}

interface AppFixtures {
  appOptions: TestAppOptions;
  ctx: TestApp;
  apps: TestAppFactory;
}

interface AuthenticatedFixtures {
  adminOptions: TestAdminOptions;
  admin: Awaited<ReturnType<typeof createTestAdmin>>;
  cookie: string;
}

/** 앱과 모든 background 자원을 테스트 하나의 수명에 묶는다. */
export const test = base.extend<AppFixtures>({
  appOptions: {},
  // Vitest가 fixture 의존성 분석을 위해 빈 객체 구조 분해를 요구한다.
  // eslint-disable-next-line no-empty-pattern
  apps: async ({}, use) => {
    const contexts: TestApp[] = [];
    let stopping = false;
    await use({
      async create(options = {}) {
        if (stopping)
          throw new Error('종료 중인 테스트 fixture는 앱을 만들 수 없습니다');
        const ctx = await createTestApp(
          { ...options.env },
          options.configure,
          options.agentPreparation ?? false,
        );
        contexts.push(ctx);
        return ctx;
      },
    });
    stopping = true;
    const results = await Promise.allSettled(
      contexts.reverse().map((ctx) => ctx.close()),
    );
    const errors = results
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map((result) => result.reason);
    if (errors.length > 0)
      throw new AggregateError(errors, '테스트 fixture 앱 정리에 실패했습니다.');
  },
  ctx: async ({ appOptions }, use) => {
    const ctx = await createTestApp(
      { ...appOptions.env },
      appOptions.configure,
      appOptions.agentPreparation ?? false,
    );
    try {
      await use(ctx);
    } finally {
      await ctx.close();
    }
  },
});

/** 기본 관리자 로그인까지 필요한 테스트가 명시적으로 선택하는 fixture다. */
export const authenticatedTest = test.extend<AuthenticatedFixtures>({
  adminOptions: {},
  admin: async ({ ctx, adminOptions }, use) => {
    await use(await createTestAdmin(ctx.container, adminOptions));
  },
  cookie: async ({ ctx, admin }, use) => {
    const login = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username: admin.username, password: admin.password },
    });
    const cookie = login.cookies.find((item) => item.name === 'session')?.value;
    if (login.statusCode !== 200 || cookie === undefined)
      throw new Error(`테스트 관리자 로그인 실패: ${login.statusCode} ${login.body}`);
    await use(cookie);
  },
});
