import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type DatabaseHandle } from '../../src/server/shared/db/database.js';
import { PreparationReferenceService } from '../../src/server/modules/backtest/application/preparation-reference-service.js';

describe('PreparationReferenceService', () => {
  let directory: string;
  let database: DatabaseHandle;
  let writer: DatabaseHandle;
  let service: PreparationReferenceService;

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'qp-preparation-reference-'));
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

  function preparation(id: string, status = 'COMPLETED', managed = true): void {
    writer.sqlite.prepare(`
      INSERT INTO backtest_preparation_jobs
        (id, request_hash, request_json, status, phase, lifecycle_managed, created_at_ms, updated_at_ms)
      VALUES (?, ?, '{}', ?, 'FINALIZING', ?, 1, 1)
    `).run(id, id, status, managed ? 1 : 0);
  }

  function backtest(id: string, preparationJobId: string): void {
    writer.sqlite.prepare(`
      INSERT INTO backtest_jobs
        (id, status, request_json, strategy_id, universe_rule_json, universe_schedule_json,
         preparation_job_id, created_at_ms)
      VALUES (?, 'COMPLETED', '{}', 'range-breakout', '{}', '[]', ?, 1)
    `).run(id, preparationJobId);
  }

  function batch(id: string, preparationJobId: string): void {
    writer.sqlite.prepare(`
      INSERT INTO backtest_clone_batches
        (id, source_job_id, strategy_id, status, total_count, request_json,
         universe_schedule_json, preparation_job_id, created_at_ms)
      VALUES (?, 'source', 'range-breakout', 'COMPLETED', 1, '{}', '[]', ?, 1)
    `).run(id, preparationJobId);
  }

  it('사용자 전체에서 최대 하나의 wizard 참조를 문맥과 함께 원자적으로 교체한다', () => {
    preparation('prep_a');
    preparation('prep_b');
    backtest('backtest_a', 'prep_a');
    backtest('backtest_b', 'prep_b');

    service.bindWizard('user_a', '', 'prep_a');
    service.bindWizard('user_a', '', 'prep_b');
    service.bindWizard('user_a', 'clone-source', 'prep_a');

    expect(service.getWizard('user_a')).toMatchObject({
      userId: 'user_a',
      context: 'clone-source',
      preparationJobId: 'prep_a',
    });
    expect(service.getWizard('user_b')).toBeNull();
    expect(writer.sqlite.prepare('SELECT COUNT(*) AS count FROM preparation_wizard_references').get())
      .toEqual({ count: 1 });
  });

  it('다른 문맥 해제는 현재 참조를 유지한다', () => {
    preparation('prep_a');
    service.bindWizard('user_a', '', 'prep_a');
    service.bindWizard('user_b', '', 'prep_a');

    service.releaseWizard('user_a', 'clone-source');

    expect(service.getWizard('user_a', 'clone-source')).toBeNull();
    expect(service.getWizard('user_a')).toMatchObject({
      context: '', preparationJobId: 'prep_a',
    });
    expect(service.getWizard('user_b')).toMatchObject({ preparationJobId: 'prep_a' });
  });

  it('공유된 job·batch가 있는 준비 결과는 한 참조 해제만으로 수집하지 않는다', () => {
    preparation('prep_shared');
    backtest('backtest_shared', 'prep_shared');
    batch('batch_shared', 'prep_shared');
    service.bindWizard('user_a', '', 'prep_shared');

    service.releaseWizard('user_a');

    expect(service.collect()).toBe(0);
    expect(writer.sqlite.prepare('SELECT id FROM backtest_preparation_jobs WHERE id = ?').get('prep_shared'))
      .toEqual({ id: 'prep_shared' });
  });

  it('활성 및 대기 준비는 참조가 없어도 보호하고 terminal이 되면 수집한다', () => {
    preparation('prep_running', 'RUNNING');
    preparation('prep_waiting', 'WAITING_DAILY_QUOTA');
    preparation('prep_done', 'COMPLETED');

    expect(service.collect()).toBe(1);
    expect(writer.sqlite.prepare(
      'SELECT id, status FROM backtest_preparation_jobs ORDER BY id',
    ).all()).toEqual([
      { id: 'prep_running', status: 'RUNNING' },
      { id: 'prep_waiting', status: 'WAITING_DAILY_QUOTA' },
    ]);

    writer.sqlite.prepare(
      "UPDATE backtest_preparation_jobs SET status = 'COMPLETED' WHERE id = 'prep_running'",
    ).run();
    expect(service.collect()).toBe(1);
    expect(writer.sqlite.prepare(
      'SELECT id FROM backtest_preparation_jobs WHERE id = ?',
    ).get('prep_running')).toBeUndefined();
  });

  it('수집은 다른 연결의 커밋을 보고 마지막 참조 해제 뒤에만 삭제한다', () => {
    preparation('prep_cross_connection');
    service.bindWizard('user_a', '', 'prep_cross_connection');
    const other = new PreparationReferenceService(writer);

    other.releaseWizard('user_a');

    expect(service.collect()).toBe(0);
    expect(service.getWizard('user_a')).toBeNull();
    expect(writer.sqlite.prepare(
      'SELECT id FROM backtest_preparation_jobs WHERE id = ?',
    ).get('prep_cross_connection')).toBeUndefined();
  });

  it('참조 교체 실패 시 기존 참조와 데이터베이스 상태를 롤백한다', () => {
    preparation('prep_existing');
    service.bindWizard('user_a', '', 'prep_existing');

    expect(() => service.bindWizard('user_a', '', 'missing-preparation')).toThrow();

    expect(service.getWizard('user_a')).toMatchObject({
      preparationJobId: 'prep_existing',
    });
    expect(writer.sqlite.prepare('SELECT COUNT(*) AS count FROM preparation_wizard_references').get())
      .toEqual({ count: 1 });
  });

  it('참조 receipt를 지워도 준비 결과와 cache의 cascade를 통해 고아 상태가 남지 않는다', () => {
    preparation('prep_receipt');
    writer.sqlite.prepare(`
      INSERT INTO preparation_preview_cache
        (job_id, data_revision, validation_version, fundamental_symbols_json)
      VALUES ('prep_receipt', 1, 'test', '[]')
    `).run();
    service.bindWizard('user_a', '', 'prep_receipt');
    service.releaseWizard('user_a');

    expect(service.collect()).toBe(0);
    expect(writer.sqlite.prepare(
      'SELECT COUNT(*) AS count FROM preparation_wizard_references WHERE preparation_job_id = ?',
    ).get('prep_receipt')).toEqual({ count: 0 });
    expect(writer.sqlite.prepare(
      'SELECT COUNT(*) AS count FROM preparation_preview_cache WHERE job_id = ?',
    ).get('prep_receipt')).toEqual({ count: 0 });
  });

  it('두 backtest가 공유한 준비 결과는 마지막 job 삭제 뒤에만 수집한다', () => {
    preparation('prep_two_jobs');
    backtest('backtest_one', 'prep_two_jobs');
    backtest('backtest_two', 'prep_two_jobs');

    expect(() => writer.sqlite.prepare(
      'DELETE FROM backtest_preparation_jobs WHERE id = ?',
    ).run('prep_two_jobs')).toThrow();

    writer.sqlite.prepare('DELETE FROM backtest_jobs WHERE id = ?').run('backtest_one');
    expect(service.collect()).toBe(0);
    expect(writer.sqlite.prepare(
      'SELECT id FROM backtest_preparation_jobs WHERE id = ?',
    ).get('prep_two_jobs')).toEqual({ id: 'prep_two_jobs' });

    writer.sqlite.prepare('DELETE FROM backtest_jobs WHERE id = ?').run('backtest_two');
    expect(service.collect()).toBe(1);
    expect(writer.sqlite.prepare(
      'SELECT id FROM backtest_preparation_jobs WHERE id = ?',
    ).get('prep_two_jobs')).toBeUndefined();
  });
});
