import { test as base } from 'vitest';
import { pino, type Logger } from 'pino';
import { openDatabase, type NativeAppDatabase } from '../../src/runtime/shared/db/database.js';
import { systemClock, type Clock } from '../../src/runtime/shared/clock.js';
import { SymbolMasterService } from '../../src/runtime/modules/market-data/application/symbol-master-service.js';
import type { KrxHistoricalUniverseSource } from '../../src/runtime/modules/market-data/application/ports.js';
import { createKrxHistoricalUniverseSource } from '../../src/server/modules/market-data/infrastructure/krx/krx-historical-universe-source.js';
import { startKrxFakeServer, type KrxFakeServer } from './krx-fixtures.js';
import type { TestApp } from './test-app.js';

export interface KrxTestContext {
  readonly t: TestApp;
  readonly fake: KrxFakeServer;
}

export interface KrxTestFactory {
  create(env?: Readonly<Record<string, string>>): Promise<KrxTestContext>;
}

/** 단위 테스트가 사용하는 실제 DB와 KRX 경계다. */
export interface KrxUnitContext {
  readonly fake: KrxFakeServer;
  readonly db: NativeAppDatabase;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly source: KrxHistoricalUniverseSource;
  readonly svc: SymbolMasterService;
}

export interface KrxUnitFactory {
  create(apiKey: string, sourceClock?: Clock): Promise<KrxUnitContext>;
}

export const test = base.extend<{ krxApps: KrxTestFactory; krxUnits: KrxUnitFactory }>({
  // eslint-disable-next-line no-empty-pattern
  krxUnits: async ({}, use) => {
    const contexts: { fake: KrxFakeServer; closeDatabase: () => void }[] = [];
    const errors: unknown[] = [];
    try {
      await use({
        async create(apiKey, sourceClock = systemClock) {
          const database = openDatabase(':memory:');
          let fake: KrxFakeServer | undefined;
          try {
            fake = await startKrxFakeServer();
            const clock = systemClock;
            const logger = pino({ level: 'silent' });
            const source = createKrxHistoricalUniverseSource(
              { baseUrl: fake.baseUrl, apiKey, approvalExpiry: null },
              sourceClock, logger, { sleep: async () => undefined },
            );
            const db = database.db;
            const svc = new SymbolMasterService({ db, source, clock, logger });
            contexts.push({ fake, closeDatabase: () => database.close() });
            return { fake, db, clock, logger, source, svc };
          } catch (error) {
            try { await fake?.close(); } finally { database.close(); }
            throw error;
          }
        },
      });
    } finally {
      for (const context of contexts.reverse()) {
        try { await context.fake.close(); } catch (error) { errors.push(error); }
        try { context.closeDatabase(); } catch (error) { errors.push(error); }
      }
    }
    if (errors.length > 0) throw new AggregateError(errors, 'KRX 단위 테스트 자원 정리에 실패했습니다.');
  },
  // Vitest fixture 의존성 분석에는 빈 객체 구조 분해가 필요하다.
  // eslint-disable-next-line no-empty-pattern
  krxApps: async ({}, use) => {
    const contexts: KrxTestContext[] = [];
    await use({
      async create(env = {}) {
        const fake = await startKrxFakeServer();
        try {
          const { createTestApp } = await import('./test-app.js');
          const t = await createTestApp({
            KRX_BASE_URL: fake.baseUrl,
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
