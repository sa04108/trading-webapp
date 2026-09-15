import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'sqlite',
  schema: './src/runtime/shared/db/operations-schema.ts',
  out: './migrations/agent',
});
