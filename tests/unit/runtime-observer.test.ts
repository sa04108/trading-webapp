import { describe, expect, it, vi } from "vitest";
import { startRuntimeObserver } from "../../src/server/shared/runtime-observer.js";

describe("startRuntimeObserver", () => {
  it("임계값을 넘은 event-loop 지연만 자원 변화와 함께 기록하고 종료한다", () => {
    const callback = vi.fn();
    const timer = { unref: vi.fn() } as unknown as NodeJS.Timeout;
    const histogram = {
      enable: vi.fn(),
      disable: vi.fn(),
      reset: vi.fn(),
      max: 250_000_000,
      percentile: vi.fn(() => 210_000_000),
    };
    let gcEntries: ((entries: readonly { duration: number }[]) => void) | undefined;
    const gcObserver = { observe: vi.fn(), disconnect: vi.fn() };
    let now = 1_000;
    let cpu = { user: 10_000, system: 20_000 };
    let memory = {
      rss: 100,
      heapTotal: 50,
      heapUsed: 40,
      external: 10,
      arrayBuffers: 1,
    };
    const logger = { warn: vi.fn() };
    const observer = startRuntimeObserver(logger, {
      now: () => now,
      createHistogram: () => histogram,
      createGcObserver: (onEntries: (entries: readonly { duration: number }[]) => void) => {
        gcEntries = onEntries;
        return gcObserver;
      },
      cpuUsage: () => cpu,
      memoryUsage: () => memory,
      setInterval: (next: () => void) => {
        callback.mockImplementation(next);
        return timer;
      },
      clearInterval: vi.fn(),
    });

    now += 5_000;
    cpu = { user: 13_000, system: 22_000 };
    memory = { ...memory, rss: 120, heapUsed: 55, external: 12 };
    gcEntries?.([{ duration: 4 }, { duration: 7 }]);
    callback();

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "runtime.event_loop_lag",
        measurementWindowMs: 5_000,
        eventLoopMaxMs: 250,
        eventLoopP99Ms: 210,
        cpuUserMs: 3,
        cpuSystemMs: 2,
        rssDeltaBytes: 20,
        gcCount: 2,
        gcTotalMs: 11,
        gcMaxMs: 7,
      }),
      expect.any(String),
    );
    expect(histogram.reset).toHaveBeenCalledTimes(1);
    observer.stop();
    observer.stop();
    expect(histogram.disable).toHaveBeenCalledTimes(1);
    expect(gcObserver.disconnect).toHaveBeenCalledTimes(1);
  });

  it("histogram이 짧아도 timer drift가 임계값을 넘으면 기록한다", () => {
    const callback = vi.fn();
    let now = 1_000;
    const logger = { warn: vi.fn() };
    startRuntimeObserver(logger, {
      intervalMs: 5_000,
      lagThresholdMs: 200,
      now: () => now,
      createHistogram: () => ({
        enable: vi.fn(), disable: vi.fn(), reset: vi.fn(), max: 20_000_000,
        percentile: vi.fn(() => 10_000_000),
      }),
      createGcObserver: () => ({ observe: vi.fn(), disconnect: vi.fn() }),
      setInterval: (next: () => void) => {
        callback.mockImplementation(next);
        return { unref: vi.fn() } as unknown as NodeJS.Timeout;
      },
      clearInterval: vi.fn(),
    });

    now += 5_500;
    callback();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ eventLoopMaxMs: 20, timerDriftMs: 500 }),
      expect.any(String),
    );
  });
});
