import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type DatabaseHandle } from '../../src/server/shared/db/database.js';
import {
  PreparationReferenceService,
} from '../../src/server/modules/backtest/application/preparation-reference-service.js';

const INPUT = {
  universeRule: {
    markets: ['KOSPI'],
    stages: [{ criterion: 'MARKET_CAP', direction: 'HIGH', limit: 2 }],
    rebalanceInterval: { unit: 'MONTH', value: 1 },
  },
  period: { from: '2026-01-05', to: '2026-01-05' },
  strategyId: 'range-breakout',
  parameters: { lookbackBars: 10 },
};

type Preview = {
  schedule: Array<{
    rebalanceDate: string;
    effectiveDate: string;
    members: Array<{ symbol: string }>;
    excludedNonTradingCount: number;
  }>;
  unionSymbols: string[];
  scheduleHash: string;
};

function preview(symbols: readonly string[] = ['005930', '000660'], scheduleHash = 'hash-a'): Preview {
  return {
    schedule: [{
      rebalanceDate: '2026-01-05',
      effectiveDate: '2026-01-05',
      members: symbols.map((symbol) => ({ symbol })),
      excludedNonTradingCount: 0,
    }],
    unionSymbols: [...symbols],
    scheduleHash,
  };
}

function legacySchedule(result: Preview): string {
  return JSON.stringify(result.schedule.map((entry) => ({
    rebalanceDate: entry.rebalanceDate,
    effectiveTradingDate: entry.effectiveDate,
    symbols: entry.members.map((member) => member.symbol),
    members: entry.members,
    excludedNonTradingCount: entry.excludedNonTradingCount,
  })));
}

describe('PreparationReferenceService legacy migration', () => {
  let directory: string;
  let database: DatabaseHandle;
  let writer: DatabaseHandle;
  let service: PreparationReferenceService;

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'qp-preparation-reference-migration-'));
    const filename = path.join(directory, 'app.sqlite');
    database = openDatabase(filename);
    writer = openDatabase(filename);
    service = new PreparationReferenceService(database);
    writer.sqlite.exec(`
      INSERT INTO users (id, username, password_hash, created_at_ms, updated_at_ms)
      VALUES ('user_a', 'user-a', 'hash', 1, 1), ('user_b', 'user-b', 'hash', 1, 1);
    `);
  });

  afterEach(() => {
    writer.close();
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  function insertPreparation(
    id: string,
    result = preview(),
    options: { status?: string; lifecycleManaged?: boolean; createdAtMs?: number; input?: typeof INPUT } = {},
  ): void {
    writer.sqlite.prepare(`
      INSERT INTO backtest_preparation_jobs
        (id, request_hash, request_json, status, phase, lifecycle_managed,
         preview_json, created_at_ms, updated_at_ms)
      VALUES (?, ?, ?, ?, 'FINALIZING', ?, ?, ?, ?)
    `).run(
      id,
      `request-${id}`,
      JSON.stringify(options.input ?? INPUT),
      options.status ?? 'COMPLETED',
      options.lifecycleManaged ? 1 : 0,
      JSON.stringify(result),
      options.createdAtMs ?? 1,
      options.createdAtMs ?? 1,
    );
  }

  function insertBacktest(
    id: string,
    request = INPUT,
    schedule = legacySchedule(preview()),
  ): void {
    writer.sqlite.prepare(`
      INSERT INTO backtest_jobs
        (id, status, request_json, strategy_id, universe_rule_json,
         universe_schedule_json, created_at_ms)
      VALUES (?, 'COMPLETED', ?, ?, ?, ?, 1)
    `).run(
      id,
      JSON.stringify(request),
      request.strategyId,
      JSON.stringify(request.universeRule),
      schedule,
    );
  }

  function insertBatch(
    id: string,
    request = INPUT,
    schedule = legacySchedule(preview()),
  ): void {
    writer.sqlite.prepare(`
      INSERT INTO backtest_clone_batches
        (id, source_job_id, strategy_id, status, total_count, request_json,
         universe_schedule_json, created_at_ms)
      VALUES (?, 'source-job', ?, 'COMPLETED', 1, ?, ?, 1)
    `).run(id, request.strategyId, JSON.stringify(request), schedule);
  }

  function insertDraft(
    userId: string,
    context: string,
    updatedAtMs: number,
    request = INPUT,
    scheduleHash = 'hash-a',
  ): void {
    writer.sqlite.prepare(`
      INSERT INTO backtest_wizard_drafts
        (user_id, context, step, payload_json, updated_at_ms)
      VALUES (?, ?, 'universe', ?, ?)
    `).run(
      userId,
      context,
      JSON.stringify({
        universeRule: request.universeRule,
        lastPreview: {
          params: request,
          result: { scheduleHash },
        },
      }),
      updatedAtMs,
    );
  }

  it('요청과 전체 schedule이 일치하는 legacy preview만 job에 연결한다', () => {
    const matching = preview(['005930', '000660'], 'match');
    insertPreparation('prep-match', matching);
    insertPreparation('prep-wrong-schedule', preview(['005930'], 'wrong'), { status: 'RUNNING' });
    insertBacktest('job-match', INPUT, legacySchedule(matching));
    insertBacktest('job-wrong', INPUT, legacySchedule(preview(['000660', '005930'], 'match')));

    service.initializeLegacyReferences();

    expect(writer.sqlite.prepare(
      'SELECT preparation_job_id AS preparationJobId FROM backtest_jobs WHERE id = ?',
    ).get('job-match')).toEqual({ preparationJobId: 'prep-match' });
    expect(writer.sqlite.prepare(
      'SELECT preparation_job_id AS preparationJobId FROM backtest_jobs WHERE id = ?',
    ).get('job-wrong')).toEqual({ preparationJobId: null });
    expect(writer.sqlite.prepare(
      'SELECT lifecycle_managed AS lifecycleManaged FROM backtest_preparation_jobs WHERE id = ?',
    ).get('prep-wrong-schedule')).toEqual({ lifecycleManaged: 1 });
  });

  it('일치하는 legacy clone batch도 준비 작업을 소유한다', () => {
    const result = preview();
    insertPreparation('prep-batch', result);
    insertBatch('batch-legacy', INPUT, legacySchedule(result));

    service.initializeLegacyReferences();

    expect(writer.sqlite.prepare(
      'SELECT preparation_job_id AS preparationJobId FROM backtest_clone_batches WHERE id = ?',
    ).get('batch-legacy')).toEqual({ preparationJobId: 'prep-batch' });
  });

  it('사용자별 최신 draft context만 scheduleHash와 요청이 맞을 때 연결하고 본문을 축약한다', () => {
    insertPreparation('prep-draft', preview(['005930', '000660'], 'draft-hash'));
    insertDraft('user_a', 'older-context', 10, INPUT, 'draft-hash');
    insertDraft('user_a', 'latest-context', 20, INPUT, 'draft-hash');
    insertDraft('user_b', 'wrong-hash-context', 30, INPUT, 'other-hash');

    service.initializeLegacyReferences();

    expect(writer.sqlite.prepare(
      'SELECT user_id AS userId, context, preparation_job_id AS preparationJobId FROM preparation_wizard_references ORDER BY user_id',
    ).all()).toEqual([
      { userId: 'user_a', context: 'latest-context', preparationJobId: 'prep-draft' },
    ]);
    const stored = writer.sqlite.prepare(
      'SELECT payload_json AS payloadJson FROM backtest_wizard_drafts WHERE user_id = ? AND context = ?',
    ).get('user_a', 'latest-context') as { payloadJson: string };
    expect(JSON.parse(stored.payloadJson)).toEqual({ universeRule: INPUT.universeRule });
    const older = writer.sqlite.prepare(
      'SELECT payload_json AS payloadJson FROM backtest_wizard_drafts WHERE user_id = ? AND context = ?',
    ).get('user_a', 'older-context') as { payloadJson: string };
    expect(JSON.parse(older.payloadJson)).toEqual({ universeRule: INPUT.universeRule });
  });

  it('unreferenced terminal은 삭제하고 active와 연결된 결과는 보존한다', () => {
    insertPreparation('prep-terminal', preview(), {
      input: { ...INPUT, strategyId: 'legacy-other' },
    });
    insertPreparation('prep-active', preview(), { status: 'RUNNING' });
    insertPreparation('prep-owned');
    insertBacktest('job-owner', INPUT, legacySchedule(preview()));

    service.initializeLegacyReferences();

    expect(writer.sqlite.prepare(
      'SELECT id FROM backtest_preparation_jobs WHERE id = ?',
    ).get('prep-terminal')).toBeUndefined();
    expect(writer.sqlite.prepare(
      'SELECT id FROM backtest_preparation_jobs WHERE id = ?',
    ).get('prep-active')).toEqual({ id: 'prep-active' });
    expect(writer.sqlite.prepare(
      'SELECT id FROM backtest_preparation_jobs WHERE id = ?',
    ).get('prep-owned')).toEqual({ id: 'prep-owned' });
  });

  it('orphan 정리 전에 legacy DART 호출 합계를 원장에 보존하고 기존 큰 값은 줄이지 않는다', () => {
    insertPreparation('prep-quota-a', preview(), {
      input: { ...INPUT, strategyId: 'legacy-quota-a' },
    });
    insertPreparation('prep-quota-b', preview(), {
      input: { ...INPUT, strategyId: 'legacy-quota-b' },
    });
    writer.sqlite.prepare(`
      UPDATE backtest_preparation_jobs
      SET dart_quota_date_kst = ?, dart_calls_used = ?, updated_at_ms = ?
      WHERE id = ?
    `).run('2026-01-05', 4, 10, 'prep-quota-a');
    writer.sqlite.prepare(`
      UPDATE backtest_preparation_jobs
      SET dart_quota_date_kst = ?, dart_calls_used = ?, updated_at_ms = ?
      WHERE id = ?
    `).run('2026-01-05', 5, 11, 'prep-quota-b');
    writer.sqlite.prepare(`
      INSERT INTO external_api_daily_usage
        (api, quota_scope, usage_date_kst, calls_used, updated_at_ms)
      VALUES ('DART', 'daily', '2026-01-05', 12, 20)
    `).run();
    writer.sqlite.prepare(`
      UPDATE backtest_preparation_jobs
      SET dart_quota_date_kst = ?, dart_calls_used = ?, updated_at_ms = ?
      WHERE id = ?
    `).run('2026-01-06', 4, 10, 'prep-quota-a');
    writer.sqlite.prepare(`
      UPDATE backtest_preparation_jobs
      SET dart_quota_date_kst = ?, dart_calls_used = ?, updated_at_ms = ?
      WHERE id = ?
    `).run('2026-01-06', 5, 11, 'prep-quota-b');

    service.initializeLegacyReferences();

    expect(writer.sqlite.prepare(`
      SELECT calls_used AS callsUsed FROM external_api_daily_usage
      WHERE api = 'DART' AND quota_scope = 'daily' AND usage_date_kst = '2026-01-05'
    `).get()).toEqual({ callsUsed: 12 });
    expect(writer.sqlite.prepare(
      'SELECT calls_used AS callsUsed FROM external_api_daily_usage WHERE usage_date_kst = ?',
    ).get('2026-01-06')).toEqual({ callsUsed: 9 });
    expect(writer.sqlite.prepare(
      'SELECT id FROM backtest_preparation_jobs WHERE id IN (?, ?) ORDER BY id',
    ).all('prep-quota-a', 'prep-quota-b')).toEqual([]);
  });

  it('준비 행이 없어도 legacy universe draft 본문을 축약한다', () => {
    insertDraft('user_a', 'orphan-context', 10, INPUT, 'missing-hash');

    service.initializeLegacyReferences();

    const stored = writer.sqlite.prepare(
      'SELECT payload_json AS payloadJson FROM backtest_wizard_drafts WHERE user_id = ? AND context = ?',
    ).get('user_a', 'orphan-context') as { payloadJson: string };
    expect(JSON.parse(stored.payloadJson)).toEqual({ universeRule: INPUT.universeRule });
    expect(writer.sqlite.prepare(
      'SELECT COUNT(*) AS count FROM preparation_wizard_references',
    ).get()).toEqual({ count: 0 });
  });

  it('반복 초기화는 참조와 축약 payload를 바꾸지 않는다', () => {
    const result = preview(['005930', '000660'], 'repeat-hash');
    insertPreparation('prep-repeat', result);
    insertBacktest('job-repeat', INPUT, legacySchedule(result));
    insertDraft('user_a', 'repeat-context', 10, INPUT, 'repeat-hash');

    service.initializeLegacyReferences();
    const firstReferences = writer.sqlite.prepare(
      'SELECT user_id, context, preparation_job_id FROM preparation_wizard_references',
    ).all();
    const firstJob = writer.sqlite.prepare(
      'SELECT preparation_job_id, lifecycle_managed FROM backtest_jobs b JOIN backtest_preparation_jobs p ON p.id = b.preparation_job_id WHERE b.id = ?',
    ).get('job-repeat');
    const firstDraft = writer.sqlite.prepare(
      'SELECT payload_json FROM backtest_wizard_drafts WHERE user_id = ? AND context = ?',
    ).get('user_a', 'repeat-context');

    service.initializeLegacyReferences();

    expect(writer.sqlite.prepare(
      'SELECT user_id, context, preparation_job_id FROM preparation_wizard_references',
    ).all()).toEqual(firstReferences);
    expect(writer.sqlite.prepare(
      'SELECT preparation_job_id, lifecycle_managed FROM backtest_jobs b JOIN backtest_preparation_jobs p ON p.id = b.preparation_job_id WHERE b.id = ?',
    ).get('job-repeat')).toEqual(firstJob);
    expect(writer.sqlite.prepare(
      'SELECT payload_json FROM backtest_wizard_drafts WHERE user_id = ? AND context = ?',
    ).get('user_a', 'repeat-context')).toEqual(firstDraft);
  });
});
