import type { Candle } from "../../market-data/domain/candle.js";

/** 분할 실행에서 최근 봉의 숫자 필드만 고정 길이 버퍼에 보관한다. */
export class RecentCandleHistory {
  private readonly tsMs: Float64Array;
  private readonly open: Float64Array;
  private readonly high: Float64Array;
  private readonly low: Float64Array;
  private readonly close: Float64Array;
  private readonly volume: Float64Array;
  private readonly markets: Uint8Array;
  private readonly venues: Uint8Array;
  private readonly view: readonly Candle[];
  private start = 0;
  private size = 0;

  constructor(private readonly symbol: string, private readonly capacity: number) {
    if (!Number.isSafeInteger(capacity) || capacity <= 0)
      throw new RangeError("봉 이력 크기는 양의 안전한 정수여야 합니다");
    this.tsMs = new Float64Array(capacity);
    this.open = new Float64Array(capacity);
    this.high = new Float64Array(capacity);
    this.low = new Float64Array(capacity);
    this.close = new Float64Array(capacity);
    this.volume = new Float64Array(capacity);
    this.markets = new Uint8Array(capacity);
    this.venues = new Uint8Array(capacity);

    // 전략의 기존 배열 읽기 계약은 유지하고 실제 객체는 접근한 봉만 만든다.
    const target: Candle[] = [];
    this.view = new Proxy(target, {
      get: (array, property, receiver) => {
        const index = this.index(property);
        return index === null ? Reflect.get(array, property, receiver) : this.get(index);
      },
      has: (array, property) => {
        const index = this.index(property);
        return index === null ? Reflect.has(array, property) : index < this.size;
      },
      ownKeys: () => [
        ...Array.from({ length: this.size }, (_, index) => String(index)),
        "length",
      ],
      getOwnPropertyDescriptor: (array, property) => {
        const index = this.index(property);
        if (index === null) return Reflect.getOwnPropertyDescriptor(array, property);
        if (index >= this.size) return undefined;
        return {
          configurable: true,
          enumerable: true,
          writable: false,
          value: this.get(index),
        };
      },
    });
  }

  append(bar: Candle): void {
    if (bar.symbol !== this.symbol)
      throw new Error("봉 이력의 종목 코드가 다릅니다");
    const slot = this.size < this.capacity
      ? (this.start + this.size) % this.capacity
      : this.start;
    if (this.size < this.capacity) this.size += 1;
    else this.start = (this.start + 1) % this.capacity;
    this.tsMs[slot] = bar.tsMs;
    this.open[slot] = bar.open;
    this.high[slot] = bar.high;
    this.low[slot] = bar.low;
    this.close[slot] = bar.close;
    this.volume[slot] = bar.volume;
    this.markets[slot] = bar.market === "KR" ? 1 : 2;
    this.venues[slot] = bar.venue === "KOSPI" ? 1 : bar.venue === "KOSDAQ" ? 2 : 0;
    (this.view as Candle[]).length = this.size;
  }

  asArray(): readonly Candle[] {
    return this.view;
  }

  lastVolume(): number {
    if (this.size === 0) return 0;
    return this.volume[(this.start + this.size - 1) % this.capacity] as number;
  }

  private get(index: number): Candle | undefined {
    if (index >= this.size) return undefined;
    const slot = (this.start + index) % this.capacity;
    const venue = this.venues[slot];
    return {
      symbol: this.symbol,
      market: this.markets[slot] === 1 ? "KR" : "US",
      ...(venue === 0 ? {} : { venue: venue === 1 ? "KOSPI" as const : "KOSDAQ" as const }),
      timeframe: "1d",
      tsMs: this.tsMs[slot] as number,
      open: this.open[slot] as number,
      high: this.high[slot] as number,
      low: this.low[slot] as number,
      close: this.close[slot] as number,
      volume: this.volume[slot] as number,
    };
  }

  private index(property: string | symbol): number | null {
    if (typeof property !== "string" || !/^(0|[1-9]\d*)$/.test(property))
      return null;
    const index = Number(property);
    return Number.isSafeInteger(index) ? index : null;
  }
}
