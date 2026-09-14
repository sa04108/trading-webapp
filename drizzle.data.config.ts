import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'sqlite',
  schema: './src/server/shared/db/data-schema.ts',
  out: './migrations/data',
});
