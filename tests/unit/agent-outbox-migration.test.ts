import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentClient, type AgentRuntimeAdapter } from '../../src/agent/client.js';
import { AGENT_HEARTBEAT_MS, type AgentLease, type AgentMessage, type ServerAgentMessage } from '../../src/shared/agent-protocol.js';

let directory: string;
const clients: AgentClient[] = [];

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'qp-agent-outbox-'));
  vi.useFakeTimers();
});

afterEach(async () => {
  try {
    for (const client of clients.splice(0)) await client.stop();
  } finally {
    vi.useRealTimers();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function lease(jobId = 'restored-job'): AgentLease {
  return {
    kind: 'BACKTEST', jobId, attempt: 1, leaseToken: 't'.repeat(48), leaseExpiresAtMs: Date.now() + 90_000,
    dataset: {
      version: 1, datasetId: 'fe0da193-553e-4155-bcc8-470d15a8fd4a', sourceRevision: 1,
      schemaVersion: 1, collectionVersion: 'c'.repeat(64), sha256: 'd'.repeat(64), bytes: 1,
    },
    payload: {},
  };
}

function legacyLease(jobId = 'legacy-job') {
  const current = lease(jobId);
  const { collectionVersion: _collectionVersion, ...dataset } = current.dataset;
  return { ...current, dataset };
}

function writeOutbox<T extends Pick<AgentLease, 'jobId' | 'attempt' | 'leaseToken'>>(value: T): string {
  const jobDirectory = path.join(directory, 'jobs', `${value.jobId}-${value.attempt}`);
  fs.mkdirSync(jobDirectory, { recursive: true });
  fs.writeFileSync(path.join(jobDirectory, 'outbox.json'), JSON.stringify({
    lease: value,
    message: { type: 'FINISH', kind: 'BACKTEST', jobId: value.jobId, attempt: value.attempt, leaseToken: value.leaseToken, outcome: 'FAILED', error: '전송 대기 중인 결과' },
  }));
  return jobDirectory;
}

/** 실제 연결과 계산 없이 기동 시 HELLO와 미전송 결과 재전송을 관측한다. */
function harness() {
  const sent: AgentMessage[] = [];
  let receive: (message: ServerAgentMessage) => void = () => { throw new Error('에이전트가 연결되지 않았습니다'); };
  const upload = vi.fn<AgentRuntimeAdapter['upload']>().mockResolvedValue(200);
  const runtime: AgentRuntimeAdapter = {
    runnerVersion: 'a'.repeat(64),
    cache: {
      current: null, syncing: false, synchronize: async () => undefined,
      file: () => { throw new Error('작업을 실행하면 안 됩니다'); },
      prune: () => undefined, stop: async () => undefined,
    },
    connect: (listener) => { receive = listener; },
    send: (message) => { sent.push(message); },
    close: () => undefined,
    upload,
    resources: () => ({ cpus: 1, availableBytes: 0, reserveBytes: 0, slots: 0, heapMb: 64, maxBars: 1, budgetBytes: 0 }),
  };
  const client = new AgentClient({ serverUrl: 'http://localhost', token: '' }, directory, undefined, () => undefined, runtime);
  clients.push(client);
  return { client, sent, upload, receive: (message: ServerAgentMessage) => receive(message) };
}

describe('에이전트 미전송 결과 버전 전환', () => {
  it('현재 형식은 HELLO 후 결과를 재전송하고 ACK를 받아야 정리한다', () => {
    const restored = lease();
    const jobDirectory = writeOutbox(restored);
    const agent = harness();

    agent.client.start();
    expect(agent.sent).toEqual([{ type: 'HELLO', protocolVersion: 1, versionScheme: 'content-v1', runnerVersion: 'a'.repeat(64) }]);
    agent.receive({ type: 'WELCOME', versionScheme: 'content-v1', runnerVersion: 'a'.repeat(64) });
    expect(agent.sent.filter((message) => message.type === 'FINISH')).toHaveLength(1);
    expect(fs.existsSync(jobDirectory)).toBe(true);
    vi.advanceTimersByTime(AGENT_HEARTBEAT_MS);
    expect(agent.sent.filter((message) => message.type === 'FINISH')).toHaveLength(2);

    agent.receive({ type: 'ACK', kind: restored.kind, jobId: restored.jobId, attempt: restored.attempt, accepted: true });
    expect(fs.existsSync(jobDirectory)).toBe(false);
    expect(fs.existsSync(path.join(directory, 'legacy-jobs'))).toBe(false);
    expect(agent.upload).not.toHaveBeenCalled();
  });

  it('구형 결과와 파일을 보관하고 현재 결과만 복구해 정상 기동한다', () => {
    const previous = legacyLease();
    const jobDirectory = writeOutbox(previous);
    fs.writeFileSync(path.join(jobDirectory, 'lease.json'), JSON.stringify(previous));
    fs.writeFileSync(path.join(jobDirectory, 'job.sqlite'), '이전 작업 DB');
    fs.writeFileSync(path.join(jobDirectory, 'result.sqlite'), '이전 결과 DB');
    const saved = Object.fromEntries(fs.readdirSync(jobDirectory).map((file) => [file, fs.readFileSync(path.join(jobDirectory, file))]));
    const current = lease('current-job');
    const currentDirectory = writeOutbox(current);
    const agent = harness();

    expect(() => agent.client.start()).not.toThrow();
    expect(agent.sent[0]).toMatchObject({ type: 'HELLO', versionScheme: 'content-v1' });
    agent.receive({ type: 'WELCOME', versionScheme: 'content-v1', runnerVersion: 'a'.repeat(64) });
    vi.advanceTimersByTime(AGENT_HEARTBEAT_MS);
    const completions = agent.sent.filter((message) => message.type === 'FINISH');
    expect(completions).toHaveLength(2);
    expect(completions.every((message) => message.jobId === current.jobId)).toBe(true);
    expect(agent.upload).not.toHaveBeenCalled();
    expect(fs.existsSync(currentDirectory)).toBe(true);
    expect(fs.existsSync(jobDirectory)).toBe(false);

    const archive = path.join(directory, 'legacy-jobs');
    const outboxes = fs.readdirSync(archive, { recursive: true }).filter((file) => path.basename(String(file)) === 'outbox.json');
    expect(outboxes).toHaveLength(1);
    const archivedJob = path.dirname(path.join(archive, String(outboxes[0])));
    for (const [file, contents] of Object.entries(saved)) expect(fs.readFileSync(path.join(archivedJob, file))).toEqual(contents);
  });

  it.each(['invalid', null, 'a'.repeat(63)])('현재 형식의 잘못된 collectionVersion %j를 구형으로 취급하지 않는다', (collectionVersion) => {
    const current = lease();
    const jobDirectory = writeOutbox({ ...current, dataset: { ...current.dataset, collectionVersion } });
    const agent = harness();
    expect(() => agent.client.start()).toThrow();
    expect(agent.sent).toEqual([]);
    expect(fs.existsSync(path.join(jobDirectory, 'outbox.json'))).toBe(true);
    expect(fs.existsSync(path.join(directory, 'legacy-jobs'))).toBe(false);
  });

  it('collectionVersion만 없는 형식이어도 기존 필수 필드가 잘못되면 거부한다', () => {
    const previous = legacyLease();
    const jobDirectory = writeOutbox({ ...previous, leaseToken: 'invalid' });
    const agent = harness();
    expect(() => agent.client.start()).toThrow();
    expect(agent.sent).toEqual([]);
    expect(fs.existsSync(path.join(jobDirectory, 'outbox.json'))).toBe(true);
    expect(fs.existsSync(path.join(directory, 'legacy-jobs'))).toBe(false);
  });
});
