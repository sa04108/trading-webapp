import { setTimeout as delay } from 'node:timers/promises';

export interface WaitForConditionOptions<T> {
  readonly signal: AbortSignal;
  readonly timeoutMs: number;
  readonly intervalMs?: number;
  readonly label: string;
  readonly describe?: (lastValue: T) => unknown;
}

/** 취소 또는 제한시간 뒤에는 상태 조회를 다시 실행하지 않는 polling 경계다. */
export async function waitForCondition<T>(
  read: () => T,
  done: (value: T) => boolean,
  options: WaitForConditionOptions<T>,
): Promise<T> {
  const startedAtMs = Date.now();
  for (;;) {
    options.signal.throwIfAborted();
    const value = read();
    if (done(value)) return value;
    const elapsedMs = Date.now() - startedAtMs;
    if (elapsedMs >= options.timeoutMs) {
      const detail = options.describe?.(value) ?? value;
      throw new Error(
        `${options.label} timeout: ${JSON.stringify({ elapsedMs, lastValue: detail })}`,
      );
    }
    await delay(
      Math.min(options.intervalMs ?? 5, options.timeoutMs - elapsedMs),
      undefined,
      { signal: options.signal },
    );
  }
}
