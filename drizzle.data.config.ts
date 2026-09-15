import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'sqlite',
  schema: './src/runtime/shared/db/data-schema.ts',
  out: './migrations/data',
});
