import { describe, expect, it } from 'vitest';
import { UniverseComputeBroker } from '../../src/server/modules/agents/application/universe-compute-broker.js';
import type { AgentMessage, DatasetManifest, ServerAgentMessage } from '../../src/shared/agent-protocol.js';
import { UNIVERSE_COMPUTE_TIMEOUT_MS } from '../../src/shared/universe-compute.js';

type Request = Extract<AgentMessage, { type: 'UNIVERSE_REQUEST' }>;
type Task = Extract<ServerAgentMessage, { type: 'UNIVERSE_TASK' }>;
const dataset = { version: 7 } as DatasetManifest;
const request = (requestId: string, jobId = 'job'): Request => ({
  type: 'UNIVERSE_REQUEST', kind: 'PREPARATION', jobId, attempt: 1, leaseToken: 'lease', requestId,
  input: { rule: { markets: ['KOSPI'], stages: [{ criterion: 'MARKET_CAP', direction: 'HIGH', limit: 1 }], rebalanceInterval: { unit: 'MONTH', value: 1 } }, period: { from: '2024-01-01', to: '2024-01-31' }, rebalanceDates: ['2024-01-01'], excludedSymbols: [] },
});
function fixture() {
  let now = 1000;
  let valid = true;
  let peers = [{ id: 'worker', datasetVersion: 7, available: true }];
  const sent: { id: string; message: ServerAgentMessage }[] = [];
  const broker = new UniverseComputeBroker({ ownerDataset: () => valid ? dataset : null, peers: () => peers, send: (id, message) => sent.push({ id, message }), now: () => now });
  const tasks = () => sent.filter((item): item is { id: string; message: Task } => item.message.type === 'UNIVERSE_TASK');
  const results = () => sent.filter((item) => item.message.type === 'UNIVERSE_REPLY');
  const reply = (task: Task, worker = 'worker', token = task.token) => broker.result(worker, { type: 'UNIVERSE_RESULT', taskId: task.taskId, token, reply: { status: 'COMPLETED', resultJson: '{}' } });
  return { broker, sent, tasks, results, reply, setNow: (value: number) => { now = value; }, setValid: (value: boolean) => { valid = value; }, setPeers: (value: typeof peers) => { peers = value; } };
}

describe('UniverseComputeBroker', () => {
  it('ignores duplicate requests and rejects another worker or token before forwarding a valid result', () => {
    const f = fixture(); const req = request('one');
    f.broker.request('owner', req); f.broker.request('owner', req);
    expect(f.tasks()).toHaveLength(1);
    const task = f.tasks()[0]!.message;
    f.reply(task, 'intruder'); f.reply(task, 'worker', 'wrong');
    expect(f.results()).toHaveLength(0); expect(f.broker.active('worker')).toBe(1);
    f.reply(task);
    expect(f.results()).toEqual([{ id: 'owner', message: { type: 'UNIVERSE_REPLY', jobId: 'job', attempt: 1, requestId: 'one', reply: { status: 'COMPLETED', resultJson: '{}' } } }]);
    f.reply(task); expect(f.results()).toHaveLength(1); expect(f.broker.active('worker')).toBe(0);
  });
  it('limits each lease to four pending assignments and the broker to 32', () => {
    const f = fixture();
    for (let i = 0; i < 5; i++) f.broker.request('owner', request(`one-${i}`));
    expect(f.tasks()).toHaveLength(4);
    expect(f.results().at(-1)?.message).toMatchObject({ reply: { status: 'UNAVAILABLE' } });
    for (let i = 0; i < 28; i++) f.broker.request(`owner-${i}`, request(`many-${i}`));
    expect(f.tasks()).toHaveLength(32);
    f.broker.request('another', request('overflow'));
    expect(f.tasks()).toHaveLength(32);
    expect(f.results().at(-1)?.message).toMatchObject({ requestId: 'overflow', reply: { status: 'UNAVAILABLE' } });
  });
  it('returns unavailable when no eligible peer exists', () => {
    const f = fixture(); f.setPeers([{ id: 'worker', datasetVersion: 8, available: true }]);
    f.broker.request('owner', request('one'));
    expect(f.tasks()).toHaveLength(0);
    expect(f.results()[0]?.message).toMatchObject({ reply: { status: 'UNAVAILABLE' } });
  });
  it('cancels an invalid owner without replying or accepting a late result', () => {
    const f = fixture(); f.broker.request('owner', request('one'));
    const task = f.tasks()[0]!.message; f.setValid(false); f.broker.sweep(); f.reply(task);
    expect(f.sent).toContainEqual({ id: 'worker', message: { type: 'UNIVERSE_CANCEL', taskId: task.taskId } });
    expect(f.results()).toHaveLength(0); expect(f.broker.active('worker')).toBe(0);
  });
  it('cancels timed-out tasks and rejects late results', () => {
    const f = fixture(); f.broker.request('owner', request('one'));
    const task = f.tasks()[0]!.message; f.setNow(1000 + UNIVERSE_COMPUTE_TIMEOUT_MS); f.broker.sweep(); f.reply(task);
    expect(f.sent).toContainEqual({ id: 'worker', message: { type: 'UNIVERSE_CANCEL', taskId: task.taskId } });
    expect(f.results()).toHaveLength(1);
    expect(f.results()[0]?.message).toMatchObject({ reply: { status: 'UNAVAILABLE' } });
  });
  it('does not accept a result at the expiry boundary even before a sweep', () => {
    const f = fixture(); f.broker.request('owner', request('one'));
    const task = f.tasks()[0]!.message; f.setNow(1000 + UNIVERSE_COMPUTE_TIMEOUT_MS); f.reply(task);
    expect(f.results()[0]?.message).toMatchObject({ reply: { status: 'UNAVAILABLE' } });
  });
  it('falls back when a worker disconnects', () => {
    const f = fixture(); f.broker.request('owner', request('one'));
    const task = f.tasks()[0]!.message; f.setPeers([]); f.broker.sweep(); f.reply(task);
    expect(f.sent).toContainEqual({ id: 'worker', message: { type: 'UNIVERSE_CANCEL', taskId: task.taskId } });
    expect(f.results()).toHaveLength(1);
    expect(f.results()[0]?.message).toMatchObject({ reply: { status: 'UNAVAILABLE' } });
  });
});
