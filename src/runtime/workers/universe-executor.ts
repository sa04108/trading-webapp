import { Worker } from "node:worker_threads";
import { computeRebalanceDates } from "../../shared/schemas/rebalance-interval.js";
import type { UniverseComputeInput, UniverseComputeReply } from "../../shared/universe-compute.js";
import { UNIVERSE_COMPUTE_MAX_PENDING } from "../../shared/universe-compute.js";
import { UniverseResolutionCancelledError, type UniverseRuleResolver,
  type UniverseResolveAttempt } from "../modules/backtest/application/universe-rule-resolver.js";
import { partitionRebalanceDates, UniverseResolutionAccumulator } from "../modules/backtest/application/universe-resolution-partitions.js";
import { decodeUniverseResolution } from "../modules/backtest/application/universe-resolution-wire.js";

import { universeParallelism, universeThreadHeapMb } from "../shared/universe-resources.js";
export { universeParallelism, universeThreadHeapMb } from "../shared/universe-resources.js";

export class UniverseExecutor {
  private readonly workers: Worker[] = [];
  private closed = false;
  private readonly parallelism: number;

  constructor(private readonly serial: UniverseRuleResolver, private readonly options: {
    dataPath: string; collectionVersion: string; budgetBytes: number; cpuBudget: number;
    remote?: (input: UniverseComputeInput) => Promise<UniverseComputeReply>;
    verifyRemote?: (input: UniverseComputeInput, result: UniverseResolveAttempt) => void;
  }) {
    this.parallelism = universeParallelism(options.budgetBytes, options.cpuBudget);
  }

  readonly resolve: UniverseRuleResolver["resolveOrDescribeNeeds"] = async (rule, period, hooks = {}) => {
    if (this.closed || hooks.shouldStop?.()) throw new UniverseResolutionCancelledError();
    const dates = computeRebalanceDates(period, rule.rebalanceInterval);
    if (dates.length <= 6 || (!this.options.remote && this.parallelism === 0))
      return this.serial.resolveOrDescribeNeeds(rule, period, hooks);
    const parts = partitionRebalanceDates(dates);
    const input = (rebalanceDates: readonly string[]): UniverseComputeInput => ({
      rule, period, rebalanceDates: [...rebalanceDates], excludedSymbols: [...(hooks.excludedSymbols ?? [])],
    });
    const check = () => {
      if (this.closed || hooks.shouldStop?.()) throw new UniverseResolutionCancelledError();
    };
    check();
    // 보조 장치가 없고 메모리도 작으면 전체 순차 경로를 한 번만 돌려 캐시를 재사용한다.
    const remote = async (task: UniverseComputeInput): Promise<UniverseResolveAttempt | null> => {
      try {
        const reply = await this.options.remote?.(task);
        if (!reply || reply.status !== "COMPLETED") return null;
        const result = this.result(reply);
        const assigned = new UniverseResolutionAccumulator(task.rebalanceDates);
        assigned.add({ rebalanceDates: task.rebalanceDates, result });
        assigned.finish();
        this.options.verifyRemote?.(task, result);
        return result;
      } catch {
        // 보조 장치의 손상·통신 오류는 소유 장치에서 다시 검증한다. 같은 입력의
        // 실제 도메인 오류라면 아래 로컬 계산도 실패해 최종 실패 사유를 보존한다.
        return null;
      }
    };
    const first = await remote(input(parts[0]!));
    check();
    if (first === null && this.parallelism === 0)
      return this.serial.resolveOrDescribeNeeds(rule, period, hooks);
    const accumulator = new UniverseResolutionAccumulator(dates);
    let completed = 0;
    const record = (rebalanceDates: readonly string[], result: UniverseResolveAttempt) => {
      accumulator.add({ rebalanceDates, result });
      completed += rebalanceDates.length;
      hooks.onProgress?.({ completedRebalanceDates: completed, totalRebalanceDates: dates.length });
    };
    hooks.onProgress?.({ completedRebalanceDates: 0, totalRebalanceDates: dates.length });
    let next = 0;
    if (first !== null) {
      record(parts[0]!, first);
      next = 1;
    }
    // 원격 응답이 동시에 도착해도 작은 장치에서 순차 계산을 여러 개 겹치지 않는다.
    let serialTail = Promise.resolve();
    const local = (task: UniverseComputeInput, lane: number): Promise<UniverseResolveAttempt> => {
      if (this.parallelism > 0) return this.thread(task, lane);
      const pending = serialTail.then(() => {
        check();
        return this.serial.resolveRebalanceDates(rule, period, task.rebalanceDates,
          { excludedSymbols: hooks.excludedSymbols, shouldStop: hooks.shouldStop });
      });
      serialTail = pending.then(() => undefined, () => undefined);
      return pending;
    };
    const lanes = this.parallelism || UNIVERSE_COMPUTE_MAX_PENDING;
    try {
      // 앞 분할이 느려도 뒤 결과를 무제한 쌓지 않는다. 한 창만 수신한 뒤 순서대로
      // 전역 집합에 접고, 중복된 후보 객체와 결손 배열은 다음 창 전에 해제한다.
      for (; next < parts.length; next += lanes) {
        check();
        const window = parts.slice(next, next + lanes);
        const results = await Promise.all(window.map(async (rebalanceDates, lane) => {
          const task = input(rebalanceDates);
          const result = await remote(task);
          check();
          return result ?? await local(task, lane);
        }));
        check();
        for (let i = 0; i < window.length; i++) record(window[i]!, results[i]!);
      }
      return accumulator.finish();
    } catch (error) {
      await this.close();
      throw error;
    }
  };

  private result(reply: UniverseComputeReply): UniverseResolveAttempt {
    if (reply.status !== "COMPLETED")
      throw new Error(reply.status === "FAILED" ? reply.error : "선정 계산 결과가 없습니다");
    return decodeUniverseResolution(reply.resultJson);
  }

  private async thread(input: UniverseComputeInput, lane: number): Promise<UniverseResolveAttempt> {
    let worker = this.workers[lane];
    if (!worker) {
      const ts = import.meta.url.endsWith(".ts");
      worker = new Worker(new URL(`./universe-child.${ts ? "ts" : "js"}`, import.meta.url), {
        workerData: { dataPath: this.options.dataPath, collectionVersion: this.options.collectionVersion },
        execArgv: ts ? ["--import", "tsx"] : [],
        resourceLimits: { maxOldGenerationSizeMb: universeThreadHeapMb(this.options.budgetBytes, this.parallelism), maxYoungGenerationSizeMb: 4 },
      });
      this.workers[lane] = worker;
    }
    const target = worker;
    return new Promise((resolve, reject) => {
      const cleanup = () => { target.off("message", message); target.off("error", error); target.off("exit", exit); };
      const message = (reply: UniverseComputeReply) => {
        cleanup();
        try { resolve(this.result(reply)); } catch (failure) { reject(failure); }
      };
      const error = (failure: Error) => { cleanup(); reject(failure); };
      const exit = (code: number) => error(new Error(`선정 계산 워커가 종료되었습니다 (${code})`));
      target.once("message", message).once("error", error).once("exit", exit);
      target.postMessage(input);
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    await Promise.all(this.workers.map((worker) => worker.terminate()));
    this.workers.length = 0;
  }
}
