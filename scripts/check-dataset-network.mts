import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import Fastify from "fastify";
import { loadConfig } from "../src/server/bootstrap/config.js";
import { DatasetTransferLimiter } from "../src/server/modules/agents/infrastructure/dataset-transfer-limiter.js";

// 데이터셋 전송 변경 후 pnpm check:dataset-network로 실행하는 독립 네트워크 검증이다.
// 기본 단위 테스트와 분리하며 약 30초가 걸린다. CPU·메모리 부하는 주입하지 않는다.
// 제한된 모형의 결과이며 임의의 공용망에서 목표가 보장된다는 뜻은 아니다.
const LIMIT = loadConfig({}).agentDatasetBytesPerSecond;
const LINK = 1_000_000;
const MAX_TTFB = 800;
const PAYLOAD = Buffer.alloc(2 * 1024 * 1024, 37);

async function scenario(file: string, limited: boolean) {
  const limiter = new DatasetTransferLimiter(LIMIT);
  const app = Fastify();
  app.get("/probe", async () => ({ ok: true }));
  app.get("/dataset", (_request, reply) => reply.type("application/octet-stream")
    .header("content-length", PAYLOAD.length)
    .send(limited ? limiter.stream(file) : fs.createReadStream(file)));

  const space = new EventEmitter();
  space.setMaxListeners(0);
  const queue: Array<{ reply: http.ServerResponse; bytes: Buffer; end: boolean }> = [];
  let buffered = 0;
  let sending = false;
  async function drain() {
    if (sending) return;
    sending = true;
    while (queue.length) {
      const item = queue.shift()!;
      if (!item.reply.destroyed) {
        if (item.end) item.reply.end();
        else item.reply.write(item.bytes);
        if (item.bytes.length) await delay(item.bytes.length / LINK * 1000);
      }
      buffered -= item.bytes.length;
      space.emit("space");
    }
    sending = false;
  }
  async function enqueue(reply: http.ServerResponse, bytes: Buffer, end = false) {
    while (buffered + bytes.length > 1024 * 1024) await once(space, "space");
    buffered += bytes.length;
    queue.push({ reply, bytes, end });
    void drain();
  }

  let origin = "";
  // 공유 업링크 8Mbps, FIFO 버퍼 1MiB, 왕복 경로 지연 100ms를 재현한다.
  const proxy = http.createServer(async (request, reply) => {
    await delay(100);
    if (reply.destroyed) return;
    const upstream = http.get(`${origin}${request.url}`, async response => {
      reply.writeHead(response.statusCode ?? 500, response.headers);
      try {
        for await (const chunk of response) {
          const bytes = chunk as Buffer;
          for (let at = 0; at < bytes.length; at += 16 * 1024)
            await enqueue(reply, bytes.subarray(at, at + 16 * 1024));
        }
        await enqueue(reply, Buffer.alloc(0), true);
      } catch { reply.destroy(); }
    });
    upstream.on("error", () => reply.destroy());
    reply.on("close", () => { if (!reply.writableFinished) upstream.destroy(); });
  });
  const abort = new AbortController();
  let downloads: Promise<unknown>[] = [];
  try {
    origin = await app.listen({ host: "127.0.0.1", port: 0 });
    await new Promise<void>((resolve, reject) => {
      proxy.once("error", reject);
      proxy.listen(0, "127.0.0.1", () => { proxy.off("error", reject); resolve(); });
    });
    const address = proxy.address();
    assert.ok(address && typeof address !== "string");
    const url = `http://127.0.0.1:${address.port}`;
    async function probe() {
      const started = performance.now();
      const response = await fetch(`${url}/probe`, { signal: abort.signal });
      const ttfb = performance.now() - started;
      assert.ok(response.ok);
      await response.arrayBuffer();
      return ttfb;
    }
    const baseline: number[] = [];
    for (let i = 0; i < 5; i++) baseline.push(await probe());
    const started = performance.now();
    downloads = Array.from({ length: 3 }, async () => {
      const response = await fetch(`${url}/dataset`, { signal: abort.signal });
      assert.ok(response.ok);
      const data = Buffer.from(await response.arrayBuffer());
      assert.equal(data.length, PAYLOAD.length);
      assert.equal(data.compare(PAYLOAD), 0);
    });
    // 전체 결과를 기다리기 전에도 각 다운로드의 실패를 처리한다.
    for (const download of downloads) void download.catch(() => {});
    await delay(300);
    const samples: number[] = [];
    for (let i = 0; i < 30; i++) { samples.push(await probe()); await delay(100); }
    await Promise.all(downloads);
    const sorted = [...samples].sort((a, b) => a - b);
    return { limited, linkBytesPerSecond: LINK, aggregateCapBytesPerSecond: limited ? LIMIT : null,
      concurrentDownloads: 3, bytesPerDownload: PAYLOAD.length, samples: samples.length,
      baselineMaxMs: Math.max(...baseline), maxTtfbMs: Math.max(...samples), p95TtfbMs: sorted[Math.ceil(sorted.length * 0.95) - 1],
      durationMs: performance.now() - started, targetMs: MAX_TTFB };
  } finally {
    abort.abort();
    limiter.close();
    proxy.closeAllConnections();
    await Promise.allSettled(downloads);
    if (proxy.listening) await new Promise<void>((resolve, reject) => proxy.close(error => error ? reject(error) : resolve()));
    await app.close();
  }
}

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "dataset-network-"));
try {
  const file = path.join(directory, "payload.bin");
  fs.writeFileSync(file, PAYLOAD);
  const before = await scenario(file, false);
  console.log(JSON.stringify(before));
  const after = await scenario(file, true);
  console.log(JSON.stringify(after));
  assert.ok(before.maxTtfbMs > MAX_TTFB, "병목 재현이 800ms를 초과해야 한다");
  assert.ok(after.maxTtfbMs <= MAX_TTFB, "제한 후 모든 측정 TTFB가 800ms 이하여야 한다");
} finally {
  fs.rmSync(directory, { recursive: true, force: true });
}
