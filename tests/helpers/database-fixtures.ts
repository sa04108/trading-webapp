import { test as base } from 'vitest';
import { openDatabase, type DatabaseHandle } from '../../src/runtime/shared/db/database.js';

export const test = base.extend<{ database: DatabaseHandle }>({
  // eslint-disable-next-line no-empty-pattern
  database: async ({}, use) => {
    const database = openDatabase(':memory:');
    try {
      await use(database);
    } finally {
      database.close();
    }
  },
});
