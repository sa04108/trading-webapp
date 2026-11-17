/** 항목 수와 보관 객체 수를 함께 제한하고 최근 사용한 결과부터 재사용한다. */
export class BoundedIntradayCache<T> {
  private readonly entries = new Map<string, { value: T; weight: number }>();
  private weight = 0;

  constructor(private readonly maxWeight: number, private readonly maxEntries: number) {}

  get(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key: string, value: T, weight: number): void {
    const previous = this.entries.get(key);
    if (previous) {
      this.weight -= previous.weight;
      this.entries.delete(key);
    }
    if (weight > this.maxWeight || this.maxEntries < 1) return;
    this.entries.set(key, { value, weight });
    this.weight += weight;
    while (this.weight > this.maxWeight || this.entries.size > this.maxEntries) {
      const oldest = this.entries.entries().next().value!;
      this.entries.delete(oldest[0]);
      this.weight -= oldest[1].weight;
    }
  }

  clear(): void {
    this.entries.clear();
    this.weight = 0;
  }
}
