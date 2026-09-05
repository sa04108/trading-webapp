import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type DatabaseHandle } from '../../src/server/shared/db/database.js';
import { PreparationPreviewCache } from '../../src/server/modules/backtest/application/preparation-preview-cache.js';

describe('PreparationPreviewCache source invalidation', () => {
  let directory: string;
  let database: DatabaseHandle;
  let writer: DatabaseHandle;
  let cache: PreparationPreviewCache;
  const preview = { schedule: [], unionSymbols: ['005930'], warnings: ['preserved warning'] };
  const expectedPreview = { ...preview, preparationJobId: 'prep_test' };

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'qp-preview-cache-'));
    const filename = path.join(directory, 'app.sqlite');
    database = openDatabase(filename);
    writer = openDatabase(filename);
    cache = new PreparationPreviewCache(database);
    database.sqlite.prepare(`INSERT INTO backtest_preparation_jobs
      (id, request_hash, request_json, status, phase, preview_json, created_at_ms, updated_at_ms)
      VALUES ('prep_test', 'request', '{}', 'COMPLETED', 'FINALIZING', ?, 1, 1)`)
      .run(JSON.stringify(preview));
    writer.sqlite.exec(`INSERT INTO symbols (code, market, created_at_ms) VALUES ('005930', 'KR', 1)`);
    cache.store('prep_test', cache.beginValidation(), ['005930']);
  });

  afterEach(() => {
    writer.close();
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it.each([
    ['candles',
      "INSERT INTO krx_daily_bars VALUES ('005930', '2026-01-05', 'KOSPI', 100, 110, 90, 105, 1000)",
      'UPDATE krx_daily_bars SET close = 106', 'DELETE FROM krx_daily_bars'],
    ['selection metrics',
      "INSERT INTO daily_selection_metrics VALUES ('2026-01-05', 'KR7005930003', '100', 1, '100')",
      "UPDATE daily_selection_metrics SET market_cap_krw = '200'", 'DELETE FROM daily_selection_metrics'],
    ['facts',
      "INSERT INTO facts (scope, key, field, period_key, as_of_ts_ms, value, unit) VALUES ('SYMBOL', '005930', 'NET_INCOME', '2025Q4', 1, 10, 'KRW')",
      'UPDATE facts SET value = 20', 'DELETE FROM facts'],
    ['financial/action coverage',
      "INSERT INTO symbol_facts_state (code, covered_years_json, updated_at_ms) VALUES ('005930', '[2025]', 1)",
      "UPDATE symbol_facts_state SET action_covered_years_json = '[2025]'", 'DELETE FROM symbol_facts_state'],
    ['symbol identity and shares',
      `INSERT INTO symbol_master_versions (standard_code, valid_from_date, short_code, name,
        market, shares_outstanding, instrument_type, recorded_at_ms)
        VALUES ('KR7005930003', '2026-01-05', '005930', 'Samsung', 'KOSPI', '100', 'COMMON_STOCK', 1)`,
      "UPDATE symbol_master_versions SET shares_outstanding = '200'", 'DELETE FROM symbol_master_versions'],
    ['trading calendar',
      "INSERT INTO symbol_master_trading_days VALUES ('2026-01-05')",
      "UPDATE symbol_master_trading_days SET date = '2026-01-06'", 'DELETE FROM symbol_master_trading_days'],
    ['trading suspension',
      "INSERT INTO krx_non_trading_days (date, short_code, market, last_close) VALUES ('2026-01-05', '005930', 'KOSPI', 100)",
      'UPDATE krx_non_trading_days SET last_close = 200', 'DELETE FROM krx_non_trading_days'],
    ['market coverage',
      "INSERT INTO symbol_master_coverage (start_date, end_date, synced_at_ms) VALUES ('2026-01-05', '2026-01-05', 1)",
      "UPDATE symbol_master_coverage SET end_date = '2026-01-06'", 'DELETE FROM symbol_master_coverage'],
  ])('%s inserts, updates and deletes from another connection invalidate the result', (_name, ...writes) => {
    for (const statement of writes) {
      expect(cache.get('request')).toEqual({ preview: expectedPreview, fundamentalSymbols: ['005930'] });
      const revision = cache.revision();
      writer.sqlite.exec(statement);
      expect(cache.revision()).toBeGreaterThan(revision);
      expect(cache.get('request')).toBeNull();
      cache.store('prep_test', cache.beginValidation(), ['005930']);
    }
  });

  it('bulk writes invalidate once, and a new validation detects the next write', () => {
    expect(cache.get('request', 'wrong-preparation-id')).toBeNull();
    expect(cache.get('request', 'prep_test')).toEqual({
      preview: expectedPreview,
      fundamentalSymbols: ['005930'],
    });
    const revision = cache.revision();
    writer.sqlite.transaction(() => {
      for (let index = 0; index < 100; index += 1) {
        writer.sqlite.exec("UPDATE symbols SET name = 'changed'");
      }
    })();
    expect(cache.revision()).toBe(revision + 1);
    expect(cache.get('request')).toBeNull();
    const next = cache.beginValidation();
    const concurrent = new PreparationPreviewCache(writer);
    expect(concurrent.beginValidation()).toBe(next);
    writer.sqlite.exec("UPDATE symbols SET name = 'changed again'");
    expect(cache.revision()).toBe(next + 1);
    expect(concurrent.beginValidation()).toBe(next + 1);
    expect(cache.revision()).not.toBe(next);
  });

  it('rollback restores the revision and preserves the validated result', () => {
    const revision = cache.revision();
    expect(() => writer.sqlite.transaction(() => {
      writer.sqlite.exec("UPDATE symbols SET standard_code = 'changed'");
      throw new Error('rollback');
    })()).toThrow('rollback');
    expect(cache.revision()).toBe(revision);
    expect(cache.get('request')?.preview).toEqual(expectedPreview);
  });

  it('job progress and notifications do not invalidate source validation', () => {
    const revision = cache.revision();
    writer.sqlite.exec(`UPDATE backtest_preparation_jobs SET done_symbols = 42, updated_at_ms = 2;
      INSERT INTO notifications (id, type, severity, title, created_at_ms)
      VALUES ('notice', 'backtest', 'info', 'ready', 2)`);
    expect(cache.revision()).toBe(revision);
    expect(cache.get('request')?.preview).toEqual(expectedPreview);
  });

  it.each([
    "UPDATE backtest_preparation_jobs SET preview_json = '{}'",
    "UPDATE backtest_preparation_jobs SET request_hash = 'other'",
    "UPDATE backtest_preparation_jobs SET request_json = '{\"changed\":true}'",
    "UPDATE backtest_preparation_jobs SET status = 'FAILED'",
    'DELETE FROM backtest_preparation_jobs',
    "UPDATE preparation_preview_cache SET validation_version = 'older-release'",
    "UPDATE preparation_preview_cache SET fundamental_symbols_json = 'invalid json'",
  ])('changed result, request, or validation receipt is not reusable: %s', (statement) => {
    writer.sqlite.exec(statement);
    expect(cache.get('request')).toBeNull();
  });

  it('validation survives reopening the database and still detects later changes', () => {
    database.close();
    database = openDatabase(path.join(directory, 'app.sqlite'));
    cache = new PreparationPreviewCache(database);
    expect(cache.get('request')?.preview).toEqual(expectedPreview);
    writer.sqlite.exec("UPDATE symbols SET name = 'updated'");
    expect(cache.get('request')).toBeNull();
  });
});
