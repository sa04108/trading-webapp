import { readRuntimeVersions } from '../../src/runtime/shared/runtime-versions.js';
import * as buildInfo from '../../src/runtime/shared/build-info.js';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { BacktestResultArtifactRejectedError } from '../../src/runtime/modules/backtest/application/backtest-result-artifact.js';
import { createHash, randomUUID } from 'node:crypto';
import type { WebSocket } from 'ws';
import { describe, expect, vi } from 'vitest';
import { test as base } from '../helpers/test-fixtures.js';
import type { TestApp } from '../helpers/test-app.js';
import type { BacktestRequest } from '../../src/shared/schemas/backtest-request.js';
import type { AgentLease, ServerAgentMessage } from '../../src/shared/agent-protocol.js';

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

class Peer extends EventEmitter {
  readyState = 1;
  readonly received: ServerAgentMessage[] = [];
  send(value: string) { this.received.push(JSON.parse(value) as ServerAgentMessage); }
  close() { this.readyState = 3; this.emit('close'); }
  terminate() { this.close(); }
  submit(value: unknown) { this.emit('message', Buffer.from(JSON.stringify(value)), false); }
  job(): AgentLease | undefined { const message = this.received.find((m) => m.type === 'JOB'); return message?.type === 'JOB' ? message.lease : undefined; }
}
const dataset = { version: 1, datasetId: randomUUID(), sourceRevision: 0, collectionVersion: readRuntimeVersions().collectionVersion, schemaVersion: 1, sha256: 'a'.repeat(64), bytes: 1 };
const agentBase = base.extend({ appOptions: { agentPreparation: true } });
const it = agentBase.extend<{
  scenario: {
    ctx: TestApp;
    id: string;
    token: string;
    enqueue(): void;
    connect(runnerVersion?: string): Promise<Peer>;
  };
}>({
  scenario: async ({ ctx }, use) => {
    const credential = ctx.container.agentCoordinator.registry.issue('device');
    vi.spyOn(ctx.container.agentCoordinator.snapshots, 'ensureLatest').mockResolvedValue(dataset);
    try {
      await use({
        ctx,
        id: credential.id,
        token: credential.token,
        enqueue() {
          ctx.container.database.sqlite.prepare("INSERT INTO backtest_jobs (id, status, request_json, strategy_id, universe_rule_json, universe_schedule_json, created_at_ms) VALUES ('job-one', 'QUEUED', '{}', 'test', '{}', '[]', 1)").run();
        },
        async connect(runnerVersion = ctx.container.agentCoordinator.runnerVersion) {
          const peer = new Peer();
          ctx.container.agentCoordinator.connect(credential.id, peer as unknown as WebSocket);
          peer.submit({ type: 'HELLO', protocolVersion: 3, runnerVersion });
          await vi.waitFor(() => expect(peer.received.length).toBeGreaterThan(0));
          return peer;
        },
      });
    } finally {
      await ctx.close();
      vi.restoreAllMocks();
    }
  },
});
function capacity(peer: Peer, slots = 1) { peer.submit({ type: 'CAPACITY', slots, datasetVersion: 1, maxBars: 8_000_000 }); }

describe('연결과 리스 수명 분리', () => {
  it('종료 시 등록된 결과 작업을 abort하고 정리 완료까지 기다린다', async ({ scenario }) => {
    const { ctx } = scenario;
    const finished = deferred();
    let shutdownSignal: AbortSignal | null = null;
    const operation = ctx.container.agentCoordinator.runResultOperation(async (signal) => {
      shutdownSignal = signal;
      try {
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
      } finally {
        await finished.promise;
      }
    });
    const rejection = expect(operation).rejects.toMatchObject({
      name: 'AgentCoordinatorStoppingError',
      statusCode: 503,
    });
    let stopped = false;
    const stopping = ctx.container.agentCoordinator.stop().then(() => { stopped = true; });

    await vi.waitFor(() => expect(shutdownSignal?.aborted).toBe(true));
    expect(stopped).toBe(false);
    finished.resolve();

    await rejection;
    await stopping;
    expect(stopped).toBe(true);
  });

  it('종료 전에 시작한 WebSocket 메시지 handler를 끝까지 기다린다', async ({ scenario }) => {
    const { ctx, id } = scenario;
    const snapshot = deferred<typeof dataset>();
    vi.mocked(ctx.container.agentCoordinator.snapshots.ensureLatest)
      .mockReturnValueOnce(snapshot.promise);
    const peer = new Peer();
    ctx.container.agentCoordinator.connect(id, peer as unknown as WebSocket);
    peer.submit({
      type: 'HELLO',
      protocolVersion: 3,
      runnerVersion: ctx.container.agentCoordinator.runnerVersion,
    });
    await vi.waitFor(() => expect(peer.received[0]).toMatchObject({ type: 'WELCOME' }));
    let stopped = false;
    const stopping = ctx.container.agentCoordinator.stop().then(() => { stopped = true; });

    await Promise.resolve();
    expect(stopped).toBe(false);
    snapshot.resolve(dataset);

    await stopping;
    expect(stopped).toBe(true);
  });

  it('배정 전 데이터 동기화는 작업 lease 없이 장치명과 바이트 진행을 표시한다', async ({ scenario }) => {
    const { ctx, connect } = scenario;
    ctx.container.database.sqlite.prepare(
      "INSERT INTO backtest_preparation_jobs (id, request_hash, request_json, status, phase, created_at_ms, updated_at_ms) VALUES ('prep-sync', 'hash-sync', '{}', 'QUEUED', 'MARKET_DATA', 1, 1)",
    ).run();
    const peer = await connect();
    peer.submit({
      type: 'DEVICE_ACTIVITY',
      progress: {
        activity: 'DOWNLOADING_DATASET', datasetId: dataset.datasetId,
        datasetVersion: dataset.version, completed: 512, total: 1024,
        detail: null, occurredAtMs: 100,
      },
    });
    await vi.waitFor(() => {
      const base = ctx.container.backtestPreparationOrchestrator.get('prep-sync')!;
      expect(ctx.container.agentCoordinator.preparationView(base).progress).toMatchObject({
        activity: 'DOWNLOADING_DATASET', actorName: 'device', completed: 512,
        total: 1024, attempt: null,
      });
    });
  });

  it('재접속과 중복 capacity 통지가 이미 배정한 작업을 중복 실행하지 않는다', async ({ scenario }) => {
    const { ctx, enqueue, connect } = scenario;
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

  it('업데이트 전에 리스를 무효화하고 늦은 완료를 거부하며 계산 실패 횟수는 늘리지 않는다', async ({ scenario }) => {
    const { ctx, enqueue, connect } = scenario;
    enqueue();
    const first = await connect(); capacity(first);
    await vi.waitFor(() => expect(first.job()).toBeDefined());
    const lease = first.job()!;
    first.close();
    const old = await connect('b'.repeat(64));
    expect(old.received[0]).toMatchObject({ type: 'UPDATE_REQUIRED' });
    expect(ctx.container.jobQueue.getJob('job-one')).toMatchObject({ status: 'QUEUED', leaseTokenHash: null, leaseFailures: 0, attempt: 1 });
    old.close();
    const fresh = await connect(); capacity(fresh);
    await vi.waitFor(() => expect(fresh.job()?.attempt).toBe(2));
    fresh.submit({ type: 'FINISH', kind: 'BACKTEST', jobId: lease.jobId, attempt: lease.attempt, leaseToken: lease.leaseToken, outcome: 'FAILED' });
    await vi.waitFor(() => expect(fresh.received).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'ACK', accepted: false })])));
    expect(ctx.container.jobQueue.getJob('job-one')).toMatchObject({ status: 'STARTING', leaseFailures: 0 });
  });

  it('미인증 데이터 요청과 과대 결과 업로드를 파일 처리 전에 거부한다', async ({ scenario }) => {
    const { ctx, id, token, enqueue } = scenario;
    expect((await ctx.app.inject({ method: 'GET', url: '/api/agents/datasets/1' })).statusCode).toBe(401);
    enqueue();
    ctx.container.agentCoordinator.backtests.claim(id, readRuntimeVersions().executionVersion);
    const lease = ctx.container.jobQueue.getJob('job-one')!;
    const receive = vi.spyOn(ctx.container.remoteResultUploadManager, 'receive');
    const response = await ctx.app.inject({ method: 'POST', url: '/api/agents/jobs/job-one/result',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/vnd.quant-platform.backtest-result+sqlite',
        'content-length': String(1024 ** 3), 'x-agent-attempt': String(lease.attempt), 'x-agent-lease-token': 'x'.repeat(48), 'x-content-sha256': 'a'.repeat(64) }, payload: Buffer.from('x') });
    expect(response.statusCode).toBe(413);
    expect(receive).not.toHaveBeenCalled();
  });

  it('결과 검증 자식이 거부한 파일은 일시 장애 대신 422로 응답한다', async ({ scenario }) => {
    const { ctx, id, token, enqueue } = scenario;
    enqueue();
    const claim = ctx.container.agentCoordinator.backtests.claim(id, readRuntimeVersions().executionVersion);
    if (claim.status !== 'CLAIMED') throw new Error('리스 배정 실패');
    vi.spyOn(ctx.container.agentCoordinator.backtests, 'complete').mockRejectedValue(new BacktestResultArtifactRejectedError('invalid sqlite'));
    const payload = Buffer.from('invalid');
    const response = await ctx.app.inject({ method: 'POST', url: '/api/agents/jobs/job-one/result',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/vnd.quant-platform.backtest-result+sqlite',
        'content-length': String(payload.length), 'x-agent-attempt': String(claim.lease.attempt), 'x-agent-lease-token': claim.lease.leaseToken, 'x-content-sha256': createHash('sha256').update(payload).digest('hex') }, payload });
    expect(response.statusCode).toBe(422);
  });

  it('서버 종료가 전송 중인 결과 업로드를 중단하고 503으로 응답한다', async ({ scenario }) => {
    const { ctx, id, token, enqueue } = scenario;
    enqueue();
    const claim = ctx.container.agentCoordinator.backtests.claim(id, readRuntimeVersions().executionVersion);
    if (claim.status !== 'CLAIMED') throw new Error('리스 배정 실패');
    const payload = Buffer.from('partial-result');
    const receive = vi.spyOn(ctx.container.remoteResultUploadManager, 'receive')
      .mockImplementation(async (_source, _jobId, _attempt, _onProgress, signal) => {
        if (signal === undefined) throw new Error('종료 signal이 필요합니다');
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
        throw new Error('도달할 수 없습니다');
      });
    const response = ctx.app.inject({
      method: 'POST',
      url: '/api/agents/jobs/job-one/result',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/vnd.quant-platform.backtest-result+sqlite',
        'content-length': String(payload.length),
        'x-agent-attempt': String(claim.lease.attempt),
        'x-agent-lease-token': claim.lease.leaseToken,
        'x-content-sha256': createHash('sha256').update(payload).digest('hex'),
      },
      payload,
    });
    await vi.waitFor(() => expect(receive).toHaveBeenCalledOnce());

    const stopping = ctx.container.agentCoordinator.stop();

    expect((await response).statusCode).toBe(503);
    await stopping;
  });

  it('준비된 연결도 실행 버전이 달라지면 유휴 실행기에서 즉시 제외한다', async ({ scenario }) => {
    const { ctx, connect } = scenario;
    const peer = await connect(); capacity(peer);
    await vi.waitFor(() => expect(ctx.container.agentCoordinator.maxBacktestBars()).toBe(8_000_000));
    peer.submit({ type: 'HELLO', protocolVersion: 3, runnerVersion: 'b'.repeat(64) });
    await vi.waitFor(() => expect(peer.received.some((message) => message.type === 'UPDATE_REQUIRED')).toBe(true));
    const job = ctx.container.jobQueue.enqueue(request);
    await new Promise((resolve) => setImmediate(resolve));
    expect(peer.job()).toBeUndefined();
    expect(ctx.container.jobQueue.getJob(job.id)?.status).toBe('QUEUED');
    expect(ctx.container.agentCoordinator.maxBacktestBars()).toBe(2_000_000);
  });

  it('클라이언트 다운로드는 연결 이력 없이 유효한 토큰으로 허용하고 해제 후에는 거부한다', async ({ scenario }) => {
    const { ctx, id, token } = scenario;
    const exists = fs.existsSync;
    const files = new Set([
      path.resolve('dist/clients/manifest.json'),
      path.resolve('dist/clients/quant-agent-linux-x64.tar.gz'),
    ]);
    vi.spyOn(fs, 'existsSync').mockImplementation((file) => files.has(String(file)) ? false : exists(file));
    const endpoints = ['/api/agents/client/latest', '/api/agents/client/quant-agent-linux-x64.tar.gz'];
    for (const url of endpoints) {
      expect((await ctx.app.inject({ method: 'GET', url })).statusCode).toBe(401);
      expect((await ctx.app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${'x'.repeat(48)}` } })).statusCode).toBe(401);
    }
    const headers = { authorization: `Bearer ${token}` };
    // 게시 파일이 없어도 인증을 통과해 명세는 503, 패키지는 404까지 도달한다.
    expect((await ctx.app.inject({ method: 'GET', url: endpoints[0]!, headers })).statusCode).toBe(503);
    expect((await ctx.app.inject({ method: 'GET', url: endpoints[1]!, headers })).statusCode).toBe(404);
    ctx.container.agentCoordinator.registry.revoke(id);
    for (const url of endpoints) {
      expect((await ctx.app.inject({ method: 'GET', url, headers })).statusCode).toBe(401);
    }
  });

  it('배포 SHA가 바뀌어도 동일 내용 버전 클라이언트는 환영하고 실행 버전으로 배정한다', async ({ scenario }) => {
    const { ctx, enqueue, connect } = scenario;
    vi.spyOn(buildInfo, 'readGitCommitSha').mockReturnValue('e'.repeat(40));
    const peer = await connect();
    expect(peer.received[0]).toMatchObject({ type: 'WELCOME' });
    enqueue(); capacity(peer);
    await vi.waitFor(() => expect(peer.job()).toBeDefined());
    expect(ctx.container.jobQueue.getJob('job-one')?.runnerVersion).toBe(readRuntimeVersions().executionVersion);
  });

  it('최신 클라이언트 명세는 내용 버전과 게시된 아키텍처를 그대로 반환한다', async ({ scenario }) => {
    const { ctx, token } = scenario;
    const manifestPath = path.resolve('dist/clients/manifest.json');
    const manifest = { runnerVersion: ctx.container.agentCoordinator.runnerVersion, clients: [
      { arch: 'x64', file: 'quant-agent-linux-x64.tar.gz', sha256: 'a'.repeat(64), bytes: 1 },
      { arch: 'arm64', file: 'quant-agent-linux-arm64.tar.gz', sha256: 'b'.repeat(64), bytes: 2 },
    ] };
    const exists = fs.existsSync;
    const read = fs.readFileSync;
    vi.spyOn(fs, 'existsSync').mockImplementation((file) => String(file) === manifestPath || exists(file));
    vi.spyOn(fs, 'readFileSync').mockImplementation((...args: Parameters<typeof fs.readFileSync>) => String(args[0]) === manifestPath ? JSON.stringify(manifest) : read(...args));
    const response = await ctx.app.inject({ method: 'GET', url: '/api/agents/client/latest', headers: { authorization: `Bearer ${token}` } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(manifest);
  });

  it('장치 토큰은 해시만 저장하고 해제한 장치는 다시 인증할 수 없다', ({ scenario }) => {
    const { ctx } = scenario;
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
  it('유휴 에이전트가 이미 연결된 상태에서 새 작업을 등록하면 타이머 없이 배정한다', async ({ scenario }) => {
    const { ctx, id, connect } = scenario;
    const peer = await connect(); capacity(peer);
    await vi.waitFor(() => expect(ctx.container.agentCoordinator.maxBacktestBars()).toBe(8_000_000));
    const job = ctx.container.jobQueue.enqueue(request);
    await vi.waitFor(() => expect(peer.job()?.jobId).toBe(job.id));
    expect(ctx.container.jobQueue.getJob(job.id)).toMatchObject({ attempt: 1, agentId: id });
  });

  it('슬롯이 없어 대기하던 작업은 capacity가 생기면 주기 타이머 없이 배정한다', async ({ scenario }) => {
    const { ctx, connect } = scenario;
    const peer = await connect(); capacity(peer, 0);
    const job = ctx.container.jobQueue.enqueue(request);
    await new Promise((resolve) => setImmediate(resolve));
    expect(ctx.container.jobQueue.getJob(job.id)?.status).toBe('QUEUED');
    capacity(peer, 1);
    await vi.waitFor(() => expect(peer.job()?.jobId).toBe(job.id));
  });

  it('작업 완료로 슬롯이 반환되면 다음 capacity 통지 전에도 대기 작업을 배정한다', async ({ scenario }) => {
    const { ctx, connect } = scenario;
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
