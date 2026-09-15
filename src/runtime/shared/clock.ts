export interface Clock {
  /** UTC epoch milliseconds */
  now(): number;
}

export const systemClock: Clock = {
  now: () => Date.now(),
};
