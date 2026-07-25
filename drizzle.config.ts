import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'sqlite',
  schema: './src/server/shared/db/schema.ts',
  out: './migrations',
  dbCredentials: {
    url: process.env.DATABASE_PATH ?? './data/app.sqlite',
  },
});
