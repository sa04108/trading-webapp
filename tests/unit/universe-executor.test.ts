import { preparationHeapMb } from '../../src/runtime/shared/universe-resources.js';
import { describe, expect, it, vi } from 'vitest';
import { UniverseExecutor, universeParallelism, universeThreadHeapMb } from '../../src/runtime/workers/universe-executor.js';
import { UniverseResolutionCancelledError, type UniverseResolveAttempt, type UniverseRuleResolver } from '../../src/runtime/modules/backtest/application/universe-rule-resolver.js';
import { encodeUniverseResolution } from '../../src/runtime/modules/backtest/application/universe-resolution-wire.js';
import { computeRebalanceDates } from '../../src/shared/schemas/rebalance-interval.js';
import type { UniverseRule } from '../../src/shared/schemas/universe-rule.js';
import type { UniverseComputeInput, UniverseComputeReply } from '../../src/shared/universe-compute.js';

const rule: UniverseRule = { markets: ['KOSPI'], stages: [{ criterion: 'MARKET_CAP', direction: 'HIGH', limit: 1 }], rebalanceInterval: { unit: 'MONTH', value: 1 } };
const period = { from: '2020-01-01', to: '2022-12-01' };
const dates = computeRebalanceDates(period, rule.rebalanceInterval);
const MIB = 1024 ** 2;

function ready(selected: readonly string[]): UniverseResolveAttempt {
  return {
    kind: 'READY',
    schedule: selected.map((rebalanceDate) => ({ rebalanceDate, effectiveDate: rebalanceDate,
      fromTsMs: Date.parse(`${rebalanceDate}T00:00:00Z`), members: [], excludedNonTradingCount: 0 })),
    diagnostics: selected.map((rebalanceDate) => ({ rebalanceDate, effectiveDate: rebalanceDate, stages: [] })),
    unionEntries: new Map(), dataExclusions: [], corporateActionExclusions: [],
  };
}
function completed(task: UniverseComputeInput): UniverseComputeReply {
  return { status: 'COMPLETED', resultJson: encodeUniverseResolution(ready(task.rebalanceDates)) };
}
function setup(remote: (task: UniverseComputeInput) => Promise<UniverseComputeReply>) {
  const full = vi.fn(async () => ready(dates));
  const part = vi.fn(async (_rule: UniverseRule, _period: typeof period, selected: readonly string[]) => ready(selected));
  const serial = { resolveOrDescribeNeeds: full, resolveRebalanceDates: part } as unknown as UniverseRuleResolver;
  const executor = new UniverseExecutor(serial, { dataPath: '', collectionVersion: 'a'.repeat(64), budgetBytes: 512 * MIB, cpuBudget: 1, remote });
  return { executor, full, part };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('UniverseExecutor', () => {
  it('보조 장치가 없고 메모리가 작으면 전체 순차 해소를 한 번 실행한다', async () => {
    const { executor, full, part } = setup(async () => ({ status: 'UNAVAILABLE' }));
    expect(await executor.resolve(rule, period)).toEqual(ready(dates));
    expect(full).toHaveBeenCalledTimes(1);
    expect(part).not.toHaveBeenCalled();
  });

  it('첫 원격 실패는 실제 소유자 계산으로 재시도하고 그 오류를 보존한다', async () => {
    const { executor, full, part } = setup(async () => ({ status: 'FAILED', error: '원격 오류' }));
    full.mockRejectedValueOnce(new Error('소유자 도메인 오류'));
    await expect(executor.resolve(rule, period)).rejects.toThrow('소유자 도메인 오류');
    expect(full).toHaveBeenCalledTimes(1);
    expect(part).not.toHaveBeenCalled();
  });

  it('첫 성공 뒤 원격 실패는 해당 분할을 소유자에서 다시 계산하고 오류를 보존한다', async () => {
    let calls = 0;
    const { executor, full, part } = setup(async (task) => ++calls === 1 ? completed(task) : { status: 'FAILED', error: '원격 오류' });
    part.mockRejectedValueOnce(new Error('분할 도메인 오류'));
    await expect(executor.resolve(rule, period)).rejects.toThrow('분할 도메인 오류');
    expect(full).not.toHaveBeenCalled();
    expect(part).toHaveBeenCalled();
  });

  it('후속 원격 실패의 결과는 소유자 분할 계산이 성공한 경우에만 완성한다', async () => {
    let calls = 0;
    const { executor, full, part } = setup(async (task) => ++calls === 1 ? completed(task) : { status: 'FAILED', error: '원격 오류' });
    expect(await executor.resolve(rule, period)).toEqual(ready(dates));
    expect(full).not.toHaveBeenCalled();
    expect(part).toHaveBeenCalledTimes(5);
    expect(part.mock.calls.flatMap((call) => [...call[2]])).toEqual(dates.slice(6));
  });

  it('할당된 날짜가 빠진 원격 결과를 버리고 소유자가 해당 분할을 계산한다', async () => {
    let calls = 0;
    const { executor, full, part } = setup(async (task) => {
      if (++calls === 2) return { status: 'COMPLETED', resultJson: encodeUniverseResolution(ready(task.rebalanceDates.slice(0, -1))) };
      return completed(task);
    });
    expect(await executor.resolve(rule, period)).toEqual(ready(dates));
    expect(full).not.toHaveBeenCalled();
    expect(part).toHaveBeenCalledTimes(1);
    expect(part.mock.calls[0]![2]).toEqual(dates.slice(6, 12));
  });

  it('원격 응답이 역순으로 완료돼도 창마다 최대 네 요청만 유지하고 날짜순으로 합친다', async () => {
    const pending: Array<{ task: UniverseComputeInput; gate: ReturnType<typeof deferred<UniverseComputeReply>> }> = [];
    let active = 0;
    let maxActive = 0;
    const { executor, full, part } = setup(async (task) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      const gate = deferred<UniverseComputeReply>();
      pending.push({ task, gate });
      try { return await gate.promise; } finally { active -= 1; }
    });
    const execution = executor.resolve(rule, period);
    pending[0]!.gate.resolve(completed(pending[0]!.task));
    await vi.waitFor(() => expect(pending).toHaveLength(5));
    for (const item of pending.slice(1, 5).reverse()) item.gate.resolve(completed(item.task));
    await vi.waitFor(() => expect(pending).toHaveLength(6));
    pending[5]!.gate.resolve(completed(pending[5]!.task));
    expect(await execution).toEqual(ready(dates));
    expect(maxActive).toBe(4);
    expect(full).not.toHaveBeenCalled();
    expect(part).not.toHaveBeenCalled();
  });

  it('원격 첫 성공 이후 소유자 분할 계산은 동시에 겹치지 않는다', async () => {
    let calls = 0;
    const { executor, part } = setup(async (task) => ++calls === 1 ? completed(task) : { status: 'UNAVAILABLE' });
    let active = 0;
    let maxActive = 0;
    part.mockImplementation(async (_rule, _period, selected) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active -= 1;
      return ready(selected);
    });
    expect(await executor.resolve(rule, period)).toEqual(ready(dates));
    expect(part).toHaveBeenCalledTimes(5);
    expect(maxActive).toBe(1);
  });

  it('대기 중 닫힌 executor는 늦게 도착한 결과를 사용하지 않는다', async () => {
    const gate = deferred<UniverseComputeReply>();
    const { executor, full, part } = setup(() => gate.promise);
    const execution = executor.resolve(rule, period);
    const rejection = expect(execution).rejects.toBeInstanceOf(UniverseResolutionCancelledError);
    await executor.close();
    gate.resolve({ status: 'UNAVAILABLE' });
    await rejection;
    expect(full).not.toHaveBeenCalled();
    expect(part).not.toHaveBeenCalled();
  });

  it('병렬도는 예산과 CPU를 따르며 유한한 4 이하 값이다', () => {
    expect(universeParallelism(703 * MIB, 8)).toBe(0);
    expect(universeParallelism(704 * MIB, 2)).toBe(2);
    expect(universeParallelism(4096 * MIB, 100)).toBe(4);
    expect(universeParallelism(4096 * MIB, 1)).toBe(0);
    expect(universeParallelism(Number.NaN, 4)).toBe(0);
    expect(universeParallelism(Infinity, Infinity)).toBe(4);
    expect(universeParallelism(5 * 1024 * MIB, 3)).toBe(3);
    expect(universeThreadHeapMb(704 * MIB, 2)).toBe(128);
    expect(universeThreadHeapMb(5 * 1024 * MIB, 3)).toBe(426);
    expect(preparationHeapMb(5 * 1024 * MIB, 3, 3328)).toBe(426);
    expect(preparationHeapMb(5 * 1024 * MIB, 1, 3328)).toBe(3328);
    expect(preparationHeapMb(5 * 1024 * MIB, 3, 300)).toBe(300);
    expect(universeThreadHeapMb(64 * 1024 * MIB, 4)).toBe(1024);
  });
});
