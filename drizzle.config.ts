import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'sqlite',
  schema: './src/server/shared/db/operations-schema.ts',
  out: './migrations/operations',
});
