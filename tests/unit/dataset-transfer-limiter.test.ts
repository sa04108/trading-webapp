import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { finished } from "node:stream/promises";
import { afterEach, expect, it, vi } from "vitest";
import { DatasetTransferLimiter } from "../../src/server/modules/agents/infrastructure/dataset-transfer-limiter.js";

const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); vi.useRealTimers(); });

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dataset-egress-"));
  const file = path.join(dir, "data");
  const bytes = Buffer.alloc(32 * 1024, 7);
  fs.writeFileSync(file, bytes);
  cleanup.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  const limiter = new DatasetTransferLimiter(64 * 1024);
  cleanup.push(() => limiter.close());
  return { file, bytes, limiter };
}

// 기존 다운로드 인증 검사는 동시 다운로드가 각자 속도 상한을 얻는 회귀를 잡지 못한다.
it("여러 응답이 합산 예산을 공유하고 쉬었던 시간만큼 몰아 보내지 않는다", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  const { file, bytes, limiter } = fixture();
  await vi.advanceTimersByTimeAsync(60_000);
  const started = performance.now();
  let total = 0, completed = 0;
  const points: Array<{ at: number; total: number }> = [];
  const copies = Array.from({ length: 3 }, () => {
    const output: Buffer[] = [];
    const stream = limiter.stream(file);
    stream.on("data", (chunk: Buffer) => {
      expect(chunk.length).toBeLessThanOrEqual(limiter.chunkBytes);
      output.push(chunk); total += chunk.length;
      points.push({ at: performance.now() - started, total });
    });
    stream.on("end", () => { completed++; });
    return output;
  });
  await vi.waitFor(() => expect(completed).toBe(3), { timeout: 5_000 });
  for (const point of points)
    expect(point.total).toBeLessThanOrEqual(64 * 1024 * point.at / 1000 + limiter.chunkBytes);
  for (const output of copies) expect(Buffer.concat(output)).toEqual(bytes);
});

it("읽지 않는 응답과 취소된 대기가 다른 다운로드를 막지 않는다", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  const { file, bytes, limiter } = fixture();
  const slow = limiter.stream(file);
  const cancelled = limiter.stream(file);
  const closed = finished(cancelled).catch(() => undefined);
  cancelled.destroy();
  const output: Buffer[] = [];
  let done = false;
  const fast = limiter.stream(file);
  fast.on("data", (chunk: Buffer) => output.push(chunk));
  fast.on("end", () => { done = true; });
  await vi.waitFor(() => expect(done).toBe(true), { timeout: 5_000 });
  expect(Buffer.concat(output)).toEqual(bytes);
  const slowClosed = finished(slow).catch(() => undefined);
  limiter.close();
  await Promise.all([closed, slowClosed]);
  expect(slow.destroyed).toBe(true);
  expect(() => limiter.stream(file)).toThrow(/종료/);
  expect(vi.getTimerCount()).toBe(0);
});
