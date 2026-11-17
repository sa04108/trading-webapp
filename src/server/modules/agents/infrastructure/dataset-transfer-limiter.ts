import fs from "node:fs";
import { pipeline, Transform } from "node:stream";

interface WaitingChunk {
  readonly bytes: number;
  readonly signal: AbortSignal;
  readonly aborted: () => void;
  readonly resolve: () => void;
}

/** 모든 데이터셋 응답이 하나의 전송 예산을 나눠 쓴다. CPU·메모리 지표는 사용하지 않는다. */
export class DatasetTransferLimiter {
  readonly chunkBytes: number;
  private readonly waiting: WaitingChunk[] = [];
  private readonly streams = new Set<Transform>();
  private timer: NodeJS.Timeout | undefined;
  private nextAt = 0;
  private closed = false;

  constructor(readonly bytesPerSecond: number) {
    if (!Number.isSafeInteger(bytesPerSecond) || bytesPerSecond <= 0)
      throw new Error("데이터셋 전송 속도는 양의 정수여야 합니다");
    // 낮은 속도에서도 큰 덩어리가 한꺼번에 나가지 않도록 약 50ms 단위로 나눈다.
    this.chunkBytes = Math.max(1, Math.min(16 * 1024, Math.floor(bytesPerSecond / 20)));
  }

  stream(file: string): Transform {
    if (this.closed) throw Object.assign(new Error("데이터셋 전송이 종료 중입니다"), { statusCode: 503 });
    const abort = new AbortController();
    const output = new Transform({
      highWaterMark: this.chunkBytes,
      transform: (chunk: Buffer, _encoding, callback) => {
        void this.acquire(chunk.length, abort.signal).then(
          () => callback(null, chunk),
          (error: Error) => callback(error),
        );
      },
      destroy: (error, callback) => {
        abort.abort();
        this.streams.delete(output);
        callback(error);
      },
    });
    this.streams.add(output);
    // 파이프라인이 소비자의 backpressure와 연결 종료를 파일 읽기까지 전달한다.
    pipeline(fs.createReadStream(file, { highWaterMark: this.chunkBytes }), output, () => {});
    return output;
  }

  close(): void {
    this.closed = true;
    for (const stream of this.streams)
      stream.destroy(Object.assign(new Error("서버 종료로 데이터셋 전송을 중단합니다"), { statusCode: 503 }));
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  private acquire(bytes: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal.aborted) { reject(signal.reason); return; }
      const entry: WaitingChunk = {
        bytes, signal, resolve,
        aborted: () => {
          const index = this.waiting.indexOf(entry);
          if (index !== -1) this.waiting.splice(index, 1);
          signal.removeEventListener("abort", entry.aborted);
          reject(signal.reason);
          if (!this.waiting.length) { clearTimeout(this.timer); this.timer = undefined; }
        },
      };
      signal.addEventListener("abort", entry.aborted, { once: true });
      this.waiting.push(entry);
      this.dispatch();
    });
  }

  private dispatch(): void {
    if (this.timer || !this.waiting.length || this.closed) return;
    const now = performance.now();
    const delay = this.nextAt - now;
    if (delay > 0) {
      this.timer = setTimeout(() => { this.timer = undefined; this.dispatch(); }, Math.ceil(delay));
      this.timer.unref();
      return;
    }
    const entry = this.waiting.shift()!;
    entry.signal.removeEventListener("abort", entry.aborted);
    // 쉬었던 시간의 토큰을 적립하지 않아 재개 시 보상성 버스트가 생기지 않는다.
    this.nextAt = now + entry.bytes * 1000 / this.bytesPerSecond;
    entry.resolve();
    this.dispatch();
  }
}
