import { EventEmitter } from 'node:events';
import { RemoteResultArtifactRejectedError } from '../../src/server/modules/backtest/application/backtest-result-artifact.js';
import { createHash, randomUUID } from 'node:crypto';
import type { WebSocket } from 'ws';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestApp, type TestApp } from '../helpers/test-app.js';
import type { BacktestRequest } from '../../src/shared/schemas/backtest-request.js';
import type { AgentLease, ServerAgentMessage } from '../../src/shared/agent-protocol.js';

class Peer extends EventEmitter {
  readyState = 1;
  readonly received: ServerAgentMessage[] = [];
  send(value: string) { this.received.push(JSON.parse(value) as ServerAgentMessage); }
  close() { this.readyState = 3; this.emit('close'); }
  terminate() { this.close(); }
  submit(value: unknown) { this.emit('message', Buffer.from(JSON.stringify(value)), false); }
  job(): AgentLease | undefined { const message = this.received.find((m) => m.type === 'JOB'); return message?.type === 'JOB' ? message.lease : undefined; }
}
let ctx: TestApp;
let id: string;
let token: string;
const dataset = { version: 1, datasetId: randomUUID(), sourceRevision: 0, schemaVersion: 1, sha256: 'a'.repeat(64), bytes: 1 };
beforeEach(async () => {
  ctx = await createTestApp({}, undefined, true);
  const credential = ctx.container.agentCoordinator.registry.issue('device');
  id = credential.id; token = credential.token;
  vi.spyOn(ctx.container.agentCoordinator.snapshots, 'ensureLatest').mockResolvedValue(dataset);
});
afterEach(async () => { await ctx.close(); vi.restoreAllMocks(); });
function enqueue() {
  ctx.container.database.sqlite.prepare("INSERT INTO backtest_jobs (id, status, request_json, strategy_id, universe_rule_json, universe_schedule_json, created_at_ms) VALUES ('job-one', 'QUEUED', '{}', 'test', '{}', '[]', 1)").run();
}
async function connect(runnerVersion = ctx.container.agentCoordinator.runnerVersion): Promise<Peer> {
  const peer = new Peer();
  ctx.container.agentCoordinator.connect(id, peer as unknown as WebSocket);
  peer.submit({ type: 'HELLO', protocolVersion: 1, runnerVersion });
  await vi.waitFor(() => expect(peer.received.length).toBeGreaterThan(0));
  return peer;
}
function capacity(peer: Peer, slots = 1) { peer.submit({ type: 'CAPACITY', slots, datasetVersion: 1, maxBars: 8_000_000 }); }

describe('연결과 리스 수명 분리', () => {
  it('재접속과 중복 capacity 통지가 이미 배정한 작업을 중복 실행하지 않는다', async () => {
    enqueue();
    const first = await connect(); capacity(first); capacity(first);
    await vi.waitFor(() => expect(first.job()).toBeDefined());
    const lease = first.job()!;
    first.close();
    const second = await connect(); capacity(second);
    second.submit({ type: 'HEARTBEAT', kind: 'BACKTEST', jobId: lease.jobId, attempt: lease.attempt, leaseToken: lease.leaseToken });
    await vi.waitFor(() => expect(second.received).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'LEASE', accepted: true })])));
    expect(second.job()).toBeUndefined();
    expect(ctx.container.jobQueue.getJob('job-one')?.attempt).toBe(1);
    expect(ctx.container.agentCoordinator.maxBacktestBars()).toBe(8_000_000);
  });

  it('업데이트 전에 리스를 무효화하고 늦은 완료를 거부하며 계산 실패 횟수는 늘리지 않는다', async () => {
    enqueue();
    const first = await connect(); capacity(first);
    await vi.waitFor(() => expect(first.job()).toBeDefined());
    const lease = first.job()!;
    first.close();
    const old = await connect('previous-release');
    expect(old.received[0]).toMatchObject({ type: 'UPDATE_REQUIRED' });
    expect(ctx.container.jobQueue.getJob('job-one')).toMatchObject({ status: 'QUEUED', leaseTokenHash: null, leaseFailures: 0, attempt: 1 });
    old.close();
    const fresh = await connect(); capacity(fresh);
    await vi.waitFor(() => expect(fresh.job()?.attempt).toBe(2));
    fresh.submit({ type: 'FINISH', kind: 'BACKTEST', jobId: lease.jobId, attempt: lease.attempt, leaseToken: lease.leaseToken, outcome: 'FAILED' });
    await vi.waitFor(() => expect(fresh.received).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'ACK', accepted: false })])));
    expect(ctx.container.jobQueue.getJob('job-one')).toMatchObject({ status: 'STARTING', leaseFailures: 0 });
  });

  it('미인증 데이터 요청과 과대 결과 업로드를 파일 처리 전에 거부한다', async () => {
    expect((await ctx.app.inject({ method: 'GET', url: '/api/agents/datasets/1' })).statusCode).toBe(401);
    enqueue();
    ctx.container.agentCoordinator.backtests.claim(id, ctx.container.agentCoordinator.runnerVersion);
    const lease = ctx.container.jobQueue.getJob('job-one')!;
    const receive = vi.spyOn(ctx.container.remoteResultUploadManager, 'receive');
    const response = await ctx.app.inject({ method: 'POST', url: '/api/agents/jobs/job-one/result',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/vnd.quant-platform.backtest-result+sqlite',
        'content-length': String(1024 ** 3), 'x-agent-attempt': String(lease.attempt), 'x-agent-lease-token': 'x'.repeat(48), 'x-content-sha256': 'a'.repeat(64) }, payload: Buffer.from('x') });
    expect(response.statusCode).toBe(413);
    expect(receive).not.toHaveBeenCalled();
  });

  it('결과 검증 자식이 거부한 파일은 일시 장애 대신 422로 응답한다', async () => {
    enqueue();
    const claim = ctx.container.agentCoordinator.backtests.claim(id, ctx.container.agentCoordinator.runnerVersion);
    if (claim.status !== 'CLAIMED') throw new Error('리스 배정 실패');
    vi.spyOn(ctx.container.agentCoordinator.backtests, 'complete').mockRejectedValue(new RemoteResultArtifactRejectedError('invalid sqlite'));
    const payload = Buffer.from('invalid');
    const response = await ctx.app.inject({ method: 'POST', url: '/api/agents/jobs/job-one/result',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/vnd.quant-platform.backtest-result+sqlite',
        'content-length': String(payload.length), 'x-agent-attempt': String(claim.lease.attempt), 'x-agent-lease-token': claim.lease.leaseToken, 'x-content-sha256': createHash('sha256').update(payload).digest('hex') }, payload });
    expect(response.statusCode).toBe(422);
  });

  it('준비된 연결도 실행 버전이 달라지면 유휴 실행기에서 즉시 제외한다', async () => {
    const peer = await connect(); capacity(peer);
    await vi.waitFor(() => expect(ctx.container.agentCoordinator.maxBacktestBars()).toBe(8_000_000));
    peer.submit({ type: 'HELLO', protocolVersion: 1, runnerVersion: 'previous-release' });
    await vi.waitFor(() => expect(peer.received.some((message) => message.type === 'UPDATE_REQUIRED')).toBe(true));
    const job = ctx.container.jobQueue.enqueue(request);
    await new Promise((resolve) => setImmediate(resolve));
    expect(peer.job()).toBeUndefined();
    expect(ctx.container.jobQueue.getJob(job.id)?.status).toBe('QUEUED');
    expect(ctx.container.agentCoordinator.maxBacktestBars()).toBe(2_000_000);
  });

  it('장치 토큰은 해시만 저장하고 해제한 장치는 다시 인증할 수 없다', () => {
    const registry = ctx.container.agentCoordinator.registry;
    const credential = registry.issue('second');
    expect(registry.authenticate(credential.token)).toBe(credential.id);
    expect(JSON.stringify(registry.list())).not.toContain(credential.token);
    registry.revoke(credential.id);
    expect(registry.authenticate(credential.token)).toBeNull();
    expect(ctx.container.agentCoordinator.maxBacktestBars()).toBe(2_000_000);
  });
});

const request: BacktestRequest = {
  strategyId: 'range-breakout', parameters: {},
  universeRule: { markets: ['KOSPI'], stages: [{ criterion: 'MARKET_CAP', direction: 'HIGH', limit: 1 }], rebalanceInterval: { unit: 'DAY', value: 1 } },
  period: { from: '2026-01-05', to: '2026-01-05' },
  capital: { initialCash: 1_000_000, currency: 'KRW' },
  execution: { fillTiming: 'NEXT_BAR_OPEN', commissionProfileId: 'zero-cost', slippageProfileId: 'zero-slippage' },
  risk: { maxPositions: 1 }, randomSeed: 1,
};

describe('이벤트로 대기 큐 재배정', () => {
  it('유휴 에이전트가 이미 연결된 상태에서 새 작업을 등록하면 타이머 없이 배정한다', async () => {
    const peer = await connect(); capacity(peer);
    await vi.waitFor(() => expect(ctx.container.agentCoordinator.maxBacktestBars()).toBe(8_000_000));
    const job = ctx.container.jobQueue.enqueue(request);
    await vi.waitFor(() => expect(peer.job()?.jobId).toBe(job.id));
    expect(ctx.container.jobQueue.getJob(job.id)).toMatchObject({ attempt: 1, workerId: `remote:${id}` });
  });

  it('슬롯이 없어 대기하던 작업은 capacity가 생기면 주기 타이머 없이 배정한다', async () => {
    const peer = await connect(); capacity(peer, 0);
    const job = ctx.container.jobQueue.enqueue(request);
    await new Promise((resolve) => setImmediate(resolve));
    expect(ctx.container.jobQueue.getJob(job.id)?.status).toBe('QUEUED');
    capacity(peer, 1);
    await vi.waitFor(() => expect(peer.job()?.jobId).toBe(job.id));
  });

  it('작업 완료로 슬롯이 반환되면 다음 capacity 통지 전에도 대기 작업을 배정한다', async () => {
    const peer = await connect(); capacity(peer);
    ctx.container.jobQueue.enqueue(request);
    const next = ctx.container.jobQueue.enqueue({ ...request, randomSeed: 2 });
    await vi.waitFor(() => expect(peer.job()).toBeDefined());
    const lease = peer.job()!;
    peer.submit({ type: 'FINISH', kind: 'BACKTEST', jobId: lease.jobId, attempt: lease.attempt, leaseToken: lease.leaseToken, outcome: 'FAILED', error: '계산 실패' });
    await vi.waitFor(() => expect(peer.received.filter((message) => message.type === 'JOB').map((message) => message.lease.jobId)).toContain(next.id));
    expect(ctx.container.jobQueue.getJob(next.id)?.attempt).toBe(1);
  });
});
