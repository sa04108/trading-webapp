import { monitorEventLoopDelay, PerformanceObserver, performance } from "node:perf_hooks";
import type { Logger } from "./logger.js";

interface EventLoopHistogram {
  enable(): void;
  disable(): void;
  reset(): void;
  readonly max: number;
  percentile(percentile: number): number;
}

interface GcObserver {
  observe(options: { readonly entryTypes: readonly string[] }): void;
  disconnect(): void;
}

export interface RuntimeObserverOptions {
  readonly intervalMs?: number;
  readonly lagThresholdMs?: number;
  readonly minEmitIntervalMs?: number;
  readonly now?: () => number;
  readonly createHistogram?: () => EventLoopHistogram;
  readonly createGcObserver?: (onEntries: (entries: readonly { duration: number }[]) => void) => GcObserver;
  readonly cpuUsage?: () => NodeJS.CpuUsage;
  readonly memoryUsage?: () => NodeJS.MemoryUsage;
  readonly setInterval?: typeof globalThis.setInterval;
  readonly clearInterval?: typeof globalThis.clearInterval;
}

export interface RuntimeObserver {
  stop(): void;
}

const NANOSECONDS_PER_MILLISECOND = 1_000_000;

function cpuDeltaMs(
  current: NodeJS.CpuUsage,
  previous: NodeJS.CpuUsage,
): { userMs: number; systemMs: number } {
  return {
    userMs: Math.max(0, (current.user - previous.user) / 1_000),
    systemMs: Math.max(0, (current.system - previous.system) / 1_000),
  };
}

/**
 * Node 이벤트 루프가 다시 움직인 직후 지연 구간을 한 번 기록한다. 매 주기 로그는
 * journald를 과도하게 채우므로 임계값을 넘은 경우만 남긴다.
 */
export function startRuntimeObserver(
  logger: Pick<Logger, "warn">,
  options: RuntimeObserverOptions = {},
): RuntimeObserver {
  const intervalMs = options.intervalMs ?? 5_000;
  const lagThresholdMs = options.lagThresholdMs ?? 200;
  const minEmitIntervalMs = options.minEmitIntervalMs ?? intervalMs;
  const now = options.now ?? (() => performance.now());
  const histogram =
    options.createHistogram?.() ?? monitorEventLoopDelay({ resolution: 20 });
  const cpuUsage = options.cpuUsage ?? process.cpuUsage;
  const memoryUsage = options.memoryUsage ?? process.memoryUsage;
  const setTimer = options.setInterval ?? globalThis.setInterval;
  const clearTimer = options.clearInterval ?? globalThis.clearInterval;
  let stopped = false;
  let previousAtMs = now();
  let previousCpu = cpuUsage();
  let previousMemory = memoryUsage();
  let lastEmittedAtMs = Number.NEGATIVE_INFINITY;
  let gcCount = 0;
  let gcTotalMs = 0;
  let gcMaxMs = 0;
  const gcObserver = (options.createGcObserver ?? ((onEntries) => new PerformanceObserver((list) => {
    onEntries(list.getEntries().map((entry) => ({ duration: entry.duration })));
  })))((entries) => {
    for (const entry of entries) {
      gcCount += 1;
      gcTotalMs += entry.duration;
      gcMaxMs = Math.max(gcMaxMs, entry.duration);
    }
  });

  histogram.enable();
  gcObserver.observe({ entryTypes: ["gc"] });
  const timer = setTimer(() => {
    const measuredAtMs = now();
    const currentCpu = cpuUsage();
    const currentMemory = memoryUsage();
    const maxMs = histogram.max / NANOSECONDS_PER_MILLISECOND;
    const p99Ms = histogram.percentile(99) / NANOSECONDS_PER_MILLISECOND;
    const measurementWindowMs = Math.max(0, measuredAtMs - previousAtMs);
    const timerDriftMs = Math.max(0, measurementWindowMs - intervalMs);
    const mayEmit = measuredAtMs - lastEmittedAtMs >= minEmitIntervalMs;
    if (Math.max(maxMs, timerDriftMs) >= lagThresholdMs && mayEmit) {
      const cpu = cpuDeltaMs(currentCpu, previousCpu);
      logger.warn(
        {
          event: "runtime.event_loop_lag",
          measurementWindowMs,
          eventLoopMaxMs: maxMs,
          eventLoopP99Ms: p99Ms,
          timerDriftMs,
          cpuUserMs: cpu.userMs,
          cpuSystemMs: cpu.systemMs,
          rssBytes: currentMemory.rss,
          heapUsedBytes: currentMemory.heapUsed,
          externalBytes: currentMemory.external,
          rssDeltaBytes: currentMemory.rss - previousMemory.rss,
          heapUsedDeltaBytes: currentMemory.heapUsed - previousMemory.heapUsed,
          externalDeltaBytes: currentMemory.external - previousMemory.external,
          gcCount,
          gcTotalMs,
          gcMaxMs,
        },
        "이벤트 루프 지연이 임계값을 넘었습니다",
      );
      lastEmittedAtMs = measuredAtMs;
    }
    previousAtMs = measuredAtMs;
    previousCpu = currentCpu;
    previousMemory = currentMemory;
    gcCount = 0;
    gcTotalMs = 0;
    gcMaxMs = 0;
    histogram.reset();
  }, intervalMs);
  timer.unref?.();

  return {
    stop(): void {
      if (stopped) return;
      stopped = true;
      clearTimer(timer);
      histogram.disable();
      gcObserver.disconnect();
    },
  };
}
