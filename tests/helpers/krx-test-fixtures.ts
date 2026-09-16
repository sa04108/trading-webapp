import { test as base } from 'vitest';
import { startKrxFakeServer, type KrxFakeServer } from './krx-fixtures.js';
import { createTestApp, type TestApp } from './test-app.js';

export interface KrxTestContext {
  readonly t: TestApp;
  readonly fake: KrxFakeServer;
}

export interface KrxTestFactory {
  create(env?: Readonly<Record<string, string>>): Promise<KrxTestContext>;
}

/** fake KRX와 이를 소비하는 앱을 한 테스트 수명에 역순으로 정리한다. */
export const test = base.extend<{ krxApps: KrxTestFactory }>({
  // Vitest fixture 의존성 분석에는 빈 객체 구조 분해가 필요하다.
  // eslint-disable-next-line no-empty-pattern
  krxApps: async ({}, use) => {
    const contexts: KrxTestContext[] = [];
    await use({
      async create(env = {}) {
        const fake = await startKrxFakeServer();
        try {
          const t = await createTestApp({
            KRX_BASE_URL: fake.baseUrl,
            KRX_AUTH_KEY: 'test-auth-key',
            ...env,
          });
          const context = { t, fake };
          contexts.push(context);
          return context;
        } catch (error) {
          await fake.close();
          throw error;
        }
      },
    });

    const errors: unknown[] = [];
    for (const { t, fake } of contexts.reverse()) {
      try { await t.close(); } catch (error) { errors.push(error); }
      try { await fake.close(); } catch (error) { errors.push(error); }
    }
    if (errors.length > 0)
      throw new AggregateError(errors, 'KRX 테스트 자원 정리에 실패했습니다.');
  },
});
