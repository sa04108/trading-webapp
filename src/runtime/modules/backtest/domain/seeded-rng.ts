/**
 * mulberry32 — 결정적 시드 RNG (스펙 §9.5: 같은 seed 는 같은 결과).
 * 엔진·전략은 Math.random 을 절대 사용하지 않고 이 RNG 만 사용한다.
 */
export type Rng = () => number;

export function createRng(seed: number): Rng {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 같은 RNG 상태는 같은 순열을 내는 in-place Fisher–Yates shuffle. */
export function shuffleInPlace<T>(items: T[], rng: Rng): void {
  for (let index = items.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(rng() * (index + 1));
    const current = items[index] as T;
    items[index] = items[swapIndex] as T;
    items[swapIndex] = current;
  }
}
