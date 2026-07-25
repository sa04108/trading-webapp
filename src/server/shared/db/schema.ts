/**
 * SQLite 메타데이터 스키마 (스펙 §12).
 * 테이블은 Phase 진행에 따라 추가된다. drizzle-kit generate 로 migrations/ 를 생성한다.
 * schema_migrations 역할은 drizzle 의 __drizzle_migrations 테이블이 담당한다.
 */
import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  username: text('username').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  totpSecret: text('totp_secret'),
  totpEnabled: integer('totp_enabled', { mode: 'boolean' }).notNull().default(false),
  recoveryCodeHashesJson: text('recovery_code_hashes_json'),
  createdAtMs: integer('created_at_ms').notNull(),
  updatedAtMs: integer('updated_at_ms').notNull(),
});

export const sessions = sqliteTable(
  'sessions',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    pendingTotp: integer('pending_totp', { mode: 'boolean' }).notNull().default(false),
    createdAtMs: integer('created_at_ms').notNull(),
    lastSeenAtMs: integer('last_seen_at_ms').notNull(),
  },
  (table) => [index('idx_sessions_user').on(table.userId)],
);

export const loginAttempts = sqliteTable(
  'login_attempts',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    username: text('username').notNull(),
    ip: text('ip').notNull(),
    success: integer('success', { mode: 'boolean' }).notNull(),
    attemptedAtMs: integer('attempted_at_ms').notNull(),
  },
  (table) => [index('idx_login_attempts_username_time').on(table.username, table.attemptedAtMs)],
);

export const auditLogs = sqliteTable(
  'audit_logs',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    actor: text('actor').notNull(),
    event: text('event').notNull(),
    detailJson: text('detail_json'),
    createdAtMs: integer('created_at_ms').notNull(),
  },
  (table) => [index('idx_audit_logs_time').on(table.createdAtMs)],
);

export const applicationSettings = sqliteTable('application_settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAtMs: integer('updated_at_ms').notNull(),
});

// ── 데이터 (스펙 §12) ──────────────────────────────────────────────

export const datasets = sqliteTable('datasets', {
  id: text('id').primaryKey(),
  name: text('name').notNull().unique(),
  market: text('market').notNull(),
  timeframe: text('timeframe').notNull(),
  symbolsJson: text('symbols_json').notNull(),
  description: text('description'),
  createdAtMs: integer('created_at_ms').notNull(),
  updatedAtMs: integer('updated_at_ms').notNull(),
});

export const datasetVersions = sqliteTable(
  'dataset_versions',
  {
    id: text('id').primaryKey(),
    datasetId: text('dataset_id')
      .notNull()
      .references(() => datasets.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    contentHash: text('content_hash').notNull(),
    note: text('note'),
    createdAtMs: integer('created_at_ms').notNull(),
  },
  (table) => [index('idx_dataset_versions_dataset').on(table.datasetId)],
);

export const dataCoverage = sqliteTable(
  'data_coverage',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    datasetId: text('dataset_id')
      .notNull()
      .references(() => datasets.id, { onDelete: 'cascade' }),
    symbol: text('symbol').notNull(),
    firstTsMs: integer('first_ts_ms'),
    lastTsMs: integer('last_ts_ms'),
    barCount: integer('bar_count').notNull().default(0),
    expectedBarCount: integer('expected_bar_count'),
    missingRangesJson: text('missing_ranges_json'),
    computedAtMs: integer('computed_at_ms').notNull(),
  },
  (table) => [index('idx_data_coverage_dataset_symbol').on(table.datasetId, table.symbol)],
);

export const dataImportJobs = sqliteTable(
  'data_import_jobs',
  {
    id: text('id').primaryKey(),
    datasetId: text('dataset_id')
      .notNull()
      .references(() => datasets.id, { onDelete: 'cascade' }),
    status: text('status').notNull(), // QUEUED | RUNNING | COMPLETED | FAILED
    sourceType: text('source_type').notNull(), // CSV | PARQUET | BROKER
    fileName: text('file_name'),
    symbol: text('symbol'),
    rowsImported: integer('rows_imported'),
    error: text('error'),
    createdAtMs: integer('created_at_ms').notNull(),
    completedAtMs: integer('completed_at_ms'),
  },
  (table) => [index('idx_data_import_jobs_dataset').on(table.datasetId)],
);

export const dataSyncJobs = sqliteTable('data_sync_jobs', {
  id: text('id').primaryKey(),
  datasetId: text('dataset_id')
    .notNull()
    .references(() => datasets.id, { onDelete: 'cascade' }),
  status: text('status').notNull(),
  detailJson: text('detail_json'),
  createdAtMs: integer('created_at_ms').notNull(),
  completedAtMs: integer('completed_at_ms'),
});
