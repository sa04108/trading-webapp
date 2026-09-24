import Fastify from "fastify";
import http from "node:http";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { registerRequestObservability } from "../../src/server/shared/request-observability.js";

describe("registerRequestObservability", () => {
  it("느린 응답은 URL 대신 route와 단조 elapsed를 한 번만 기록한다", async () => {
    let tick = 0n;
    const app = Fastify({ logger: false });
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    registerRequestObservability(app, {
      slowMs: 1,
      now: () => {
        tick += 2_000_000n;
        return tick;
      },
    });
    app.get("/slow/:id", { logLevel: "silent" }, async (request) => {
      Object.assign(request.log, log);
      return { ok: true };
    });

    const response = await app.inject({ url: "/slow/secret?token=hidden" });
    expect(response.statusCode).toBe(200);
    const observabilityLogs = log.info.mock.calls.filter(
      ([fields]) => (fields as { event?: string }).event === "http.request.slow",
    );
    expect(observabilityLogs).toHaveLength(1);
    expect(observabilityLogs[0]?.[0]).toMatchObject({
      event: "http.request.slow",
      route: "/slow/:id",
      method: "GET",
      statusCode: 200,
    });
    expect(JSON.stringify(observabilityLogs[0]?.[0])).not.toContain("hidden");
    await app.close();
  });

  it("클라이언트 오류는 failed 이벤트로 한 번 기록한다", async () => {
    const app = Fastify({ logger: false });
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    registerRequestObservability(app);
    app.get("/missing", { logLevel: "silent" }, async (request) => {
      Object.assign(request.log, log);
      const error = new Error("CONFLICT") as Error & { statusCode: number };
      error.statusCode = 409;
      throw error;
    });

    const response = await app.inject({ url: "/missing" });
    expect(response.statusCode).toBe(409);
    const failures = log.warn.mock.calls.filter(
      ([fields]) => (fields as { event?: string }).event === "http.request.failed",
    );
    expect(failures).toHaveLength(1);
    expect(failures[0]?.[0]).toMatchObject({
      route: "/missing",
      statusCode: 409,
      failureClass: "CLIENT",
    });
    expect(log.error).not.toHaveBeenCalled();
    await app.close();
  });

  it("정상 POST의 request close는 aborted로 기록하지 않는다", async () => {
    const app = Fastify({ logger: false });
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    registerRequestObservability(app);
    app.post("/submit", { logLevel: "silent" }, async (request) => {
      Object.assign(request.log, log);
      return { ok: true };
    });

    const response = await app.inject({ method: "POST", url: "/submit", payload: { request: "complete" } });
    expect(response.statusCode).toBe(200);
    expect(log.warn.mock.calls.filter(
      ([fields]) => (fields as { event?: string }).event === "http.request.aborted",
    )).toHaveLength(0);
    await app.close();
  });

  it.each(["text/event-stream", "application/octet-stream"])("%s 응답의 스트림 수명은 느린 요청으로 기록하지 않는다", async (contentType) => {
    let tick = 0n;
    const app = Fastify({ logger: false });
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    registerRequestObservability(app, { now: () => { tick += 2_000_000_000n; return tick; } });
    app.get("/stream", async (request, reply) => {
      Object.assign(request.log, log);
      reply.type(contentType);
      return Readable.from(["data: ready\n\n"]);
    });

    try {
      const response = await app.inject({ url: "/stream" });
      expect(response.statusCode).toBe(200);
      expect(response.body).toContain("ready");
      expect(log.info.mock.calls.filter(([fields]) => fields.event === "http.request.slow")).toHaveLength(0);
      expect(log.warn.mock.calls.filter(([fields]) => fields.event === "http.request.aborted")).toHaveLength(0);
    } finally {
      await app.close();
    }
  });

  it("실제 연결 중단은 응답 완료와 중복되지 않게 기록한다", async () => {
    const app = Fastify({ logger: false });
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    registerRequestObservability(app);
    app.addHook("preHandler", (request, _reply, done) => {
      Object.assign(request.log, log);
      done();
    });
    app.get("/delayed", async () => {
      await new Promise((resolve) => setTimeout(resolve, 200));
      return { ok: true };
    });
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const abortLogged = new Promise<void>((resolve) => {
      log.warn.mockImplementation((fields: { event?: string }) => {
        if (fields.event === "http.request.aborted") resolve();
      });
    });
    const request = http.get(`${address}/delayed`);
    request.on("error", () => undefined);
    setTimeout(() => request.destroy(), 20).unref();

    await abortLogged;
    const aborted = log.warn.mock.calls.filter(
      ([fields]) => (fields as { event?: string }).event === "http.request.aborted",
    );
    expect(aborted).toHaveLength(1);
    expect(aborted[0]?.[0]).toMatchObject({ route: "/delayed", method: "GET" });
    await app.close();
  });
});
