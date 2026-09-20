import { afterEach, expect, vi } from 'vitest';
import path from 'node:path';
import Database from 'better-sqlite3';
import { authenticatedTest as base } from '../helpers/test-fixtures.js';
import { waitForPreparationFixture } from '../helpers/test-app.js';
import { installPreviewShapeStubs } from '../helpers/backtest-preparation-stubs.js';
import { seedSymbolMasterUniverse } from '../helpers/symbol-master-seed.js';
import { AgentPreparationQueue } from '../../src/server/modules/agents/application/agent-preparation-queue.js';
import { DatasetSnapshots } from '../../src/server/modules/agents/application/dataset-snapshots.js';
import type { DatasetManifest } from '../../src/shared/agent-protocol.js';

const it = base.extend({ appOptions: { env: { DART_API_KEY: 'fixture-key' } } });
const input = {
  universeRule: { markets: ['KOSPI'], stages: [{ criterion: 'MARKET_CAP', direction: 'HIGH', limit: 1 }], rebalanceInterval: { unit: 'DAY', value: 1 } },
  period: { from: '2026-01-05', to: '2026-01-05' }, strategyId: 'range-breakout', parameters: {},
};
const dataset: DatasetManifest = { version: 1, datasetId: 'fixture', sourceRevision: 0, collectionVersion: 'a'.repeat(64), schemaVersion: 1, sha256: 'b'.repeat(64), bytes: 1 };
afterEach(() => vi.restoreAllMocks());

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => { resolve = complete; });
  return { promise, resolve };
}

it('공시 확인 전에 202를 반환하고 HTTP와 상태 조회는 응답하되 로컬·원격 계산은 배정하지 않는다', async ({ ctx, cookie }) => {
  const gate = deferred();
  const refresh = vi.spyOn(ctx.container.filingDiscovery, 'refresh').mockReturnValue(gate.promise);
  const preparation = ctx.container.backtestPreparationOrchestrator;
  const run = vi.spyOn(preparation, 'runClaimedJob').mockResolvedValue();
  try {
    expect(refresh).not.toHaveBeenCalled();
    const response = await ctx.app.inject({ method: 'POST', url: '/api/v1/backtests/universe-preview', cookies: { session: cookie }, payload: input });
    expect(response.statusCode).toBe(202);
    const job = response.json().job;
    expect(job).toMatchObject({ status: 'WAITING_DATA', phase: 'FILING_DISCOVERY', progress: { activity: 'FILING_DISCOVERY' } });
    expect((await ctx.app.inject('/api/v1/health/ready')).statusCode).toBe(200);
    expect((await ctx.app.inject({ url: `/api/v1/backtests/preparation-jobs/${job.id}`, cookies: { session: cookie } })).json().job.status).toBe('WAITING_DATA');
    expect(new AgentPreparationQueue(ctx.container.database, vi.fn()).claim('agent', dataset)).toBeNull();
    expect(run).not.toHaveBeenCalled();
    const duplicate = await ctx.app.inject({ method: 'POST', url: '/api/v1/backtests/universe-preview', cookies: { session: cookie }, payload: input });
    expect(duplicate.json().job.id).toBe(job.id);
    expect(refresh).toHaveBeenCalledTimes(1);
    gate.resolve();
    await vi.waitFor(() => expect(run).toHaveBeenCalledWith(job.id));
  } finally { gate.resolve(); }
});

it('캐시가 있어도 새 시작은 공시를 확인하고 완료 결과 읽기는 공시 조회를 반복하지 않는다', async ({ ctx, cookie }) => {
  const refresh = vi.spyOn(ctx.container.filingDiscovery, 'refresh').mockResolvedValue();
  const restore = installPreviewShapeStubs(ctx);
  try {
    seedSymbolMasterUniverse(ctx.container, ['2026-01-05'], [
      { standardCode: 'KR7005930003', shortCode: '005930', name: '삼성전자', market: 'KOSPI', marketCapKrw: '500000000000000' },
    ]);
    const start = () => ctx.app.inject({ method: 'POST', url: '/api/v1/backtests/universe-preview', cookies: { session: cookie }, payload: input });
    const first = await start();
    expect(first.statusCode).toBe(202);
    const firstId = first.json().job.id as string;
    expect(await waitForPreparationFixture(() => ctx.container.backtestPreparationOrchestrator.get(firstId), firstId)).toBe(true);
    const result = await ctx.app.inject({ method: 'POST', url: '/api/v1/backtests/universe-preview', cookies: { session: cookie }, payload: { ...input, completedPreparationJobId: firstId } });
    expect(result.statusCode, result.body).toBe(200);
    expect(result.json().preparationJobId).toBe(firstId);
    expect(refresh).toHaveBeenCalledTimes(1);
    const next = await start();
    expect(next.statusCode).toBe(202);
    const nextId = next.json().job.id as string;
    expect(nextId).not.toBe(firstId);
    expect(await waitForPreparationFixture(() => ctx.container.backtestPreparationOrchestrator.get(nextId), nextId)).toBe(true);
    expect(refresh).toHaveBeenCalledTimes(2);
    // 이전 작업 ID로 현재 소유권과 데이터 revision 검증을 우회할 수 없다.
    expect((await ctx.app.inject({ method: 'POST', url: '/api/v1/backtests/universe-preview', cookies: { session: cookie }, payload: { ...input, completedPreparationJobId: firstId } })).statusCode).toBe(409);
  } finally { await ctx.close(); restore(); }
});

it('공유 확인 도중 한 미리보기를 취소해도 다른 요청의 확인은 계속되고 취소 작업은 부활하지 않는다', async ({ ctx, cookie }) => {
  const gate = deferred();
  const refresh = vi.spyOn(ctx.container.filingDiscovery, 'refresh').mockReturnValue(gate.promise);
  const run = vi.spyOn(ctx.container.backtestPreparationOrchestrator, 'runClaimedJob').mockResolvedValue();
  try {
    const response = await ctx.app.inject({ method: 'POST', url: '/api/v1/backtests/universe-preview', cookies: { session: cookie }, payload: input });
    const id = response.json().job.id as string;
    const shared = ctx.container.refreshProviderFilings();
    expect(refresh).toHaveBeenCalledTimes(1);
    await ctx.app.inject({ method: 'POST', url: `/api/v1/backtests/preparation-jobs/${id}/cancel`, cookies: { session: cookie } });
    gate.resolve();
    await shared;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(ctx.container.backtestPreparationOrchestrator.get(id)?.status).toBe('CANCELLED');
    expect(run).not.toHaveBeenCalled();
  } finally { gate.resolve(); }
});

it('대조 실패는 대기 작업을 실패로 닫고 사용자의 다음 시작으로 재시도한다', async ({ ctx, cookie }) => {
  const refresh = vi.spyOn(ctx.container, 'refreshProviderFilings').mockRejectedValueOnce(new Error('원문 대조 실패')).mockResolvedValue();
  const start = () => ctx.app.inject({ method: 'POST', url: '/api/v1/backtests/universe-preview', cookies: { session: cookie }, payload: input });
  const first = await start();
  const id = first.json().job.id as string;
  await vi.waitFor(() => expect(ctx.container.backtestPreparationOrchestrator.get(id)).toMatchObject({ status: 'FAILED', error: '원문 대조 실패' }));
  const next = await start();
  expect(next.statusCode).toBe(202);
  expect(next.json().job.id).not.toBe(id);
  expect(refresh).toHaveBeenCalledTimes(2);
});

it('재시작으로 남은 공시 확인 작업은 자동 조회 없이 재시작 안내로 종료한다', async ({ ctx }) => {
  const refresh = vi.spyOn(ctx.container.filingDiscovery, 'refresh');
  ctx.container.database.sqlite.prepare("INSERT INTO backtest_preparation_jobs(id,request_hash,request_json,status,phase,created_at_ms,updated_at_ms) VALUES('interrupted','hash','{}','WAITING_DATA','FILING_DISCOVERY',1,1)").run();
  ctx.container.backtestPreparationOrchestrator.recoverOrphaned();
  expect(ctx.container.backtestPreparationOrchestrator.get('interrupted')).toMatchObject({ status: 'FAILED', error: expect.stringContaining('다시 시작') });
  expect(refresh).not.toHaveBeenCalled();
});

it('이미 추가된 공급자 입력 문제 스키마를 보존한 계산 DB를 정상 게시한다', async ({ ctx }) => {
  const database = ctx.container.database;
  database.sqlite.prepare("INSERT INTO provider_input_issues(id,symbol,business_year,report_code,reason,evidence) VALUES('fixture-issue','005930',2026,'11012','PENDING_FILING','fixture')").run();
  const snapshots = new DatasetSnapshots(database, path.join(ctx.dir, 'schema-compatibility'));
  try {
    const manifest = await snapshots.ensureLatest();
    const published = new Database(snapshots.file(manifest), { readonly: true });
    try {
      expect(published.prepare('SELECT id,reason FROM provider_input_issues').all()).toEqual([{id:'fixture-issue',reason:'PENDING_FILING'}]);
      expect(published.prepare("SELECT name FROM sqlite_master WHERE name='dart_raw_api_snapshots'").get()).toBeUndefined();
    } finally { published.close(); }
  } finally { await snapshots.stop(); }
});
