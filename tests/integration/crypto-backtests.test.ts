import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import { describe, expect } from "vitest";
import { test as it } from "../helpers/database-fixtures.js";
import { waitForCondition } from "../helpers/wait-for-condition.js";
import { CryptoBacktests } from "../../src/server/modules/crypto/crypto-backtests.js";
import { registerCryptoRoutes } from "../../src/server/modules/crypto/routes.js";
import { runCryptoBacktest } from "../../src/runtime/modules/crypto/backtest.js";
import { universeComputeReplySchema } from "../../src/shared/universe-compute.js";
import type { CryptoDailyBar } from "../../src/shared/crypto-backtest.js";

const input = {
  markets: ["KRW-BTC"],
  startDate: "2026-02-01",
  endDate: "2026-02-02",
  initialCash: 10000,
  universeSize: 1,
  lookbackDays: 1,
  feeBps: 0,
  slippageBps: 0,
};
const bars: CryptoDailyBar[] = Array.from({ length: 33 }, (_, i) => {
  const price = i >= 30 ? 110 : 100;
  return {
    market: "KRW-BTC",
    date: new Date(Date.UTC(2026, 0, i + 1)).toISOString().slice(0, 10),
    open: price,
    high: price,
    low: price,
    close: price,
    turnover: 1000,
  };
});

async function claim(service: CryptoBacktests, executor: string) {
  return waitForCondition(
    () => service.claim(executor),
    (task) => task !== null,
    {
      signal: AbortSignal.timeout(5_000),
      timeoutMs: 4_000,
      label: "암호화폐 작업 대기",
    },
  );
}

async function runChild(inputValue: typeof input, barsJson: string) {
  const child = fork(
    fileURLToPath(new URL("../../src/runtime/workers/crypto-child.ts", import.meta.url)),
    [],
    {
      execArgv: ["--import", "tsx"],
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    },
  );
  return new Promise<unknown>((resolve, reject) => {
    let message: unknown;
    child.once("message", (value: unknown) => {
      message = value;
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code !== 0 || message === undefined) reject(new Error(`crypto child failed: ${code}`));
      else resolve(message);
    });
    child.send({ input: inputValue, barsJson });
  });
}

describe("암호화폐 백테스트 영속 큐", () => {
  it("수집 데이터를 재사용하고 오래된 리스를 거부하며 소유자별 결과를 격리한다", async ({ database }) => {
    const collections: { markets: string[]; from: string; to: string }[] = [];
    const collect = async (markets: string[], from: string, to: string) => {
      collections.push({ markets, from, to });
      return bars;
    };
    let service = new CryptoBacktests(database.sqlite, "test-version", collect);
    try {
      service.start();
      const { id } = service.submit("owner-a", input);
      const first = await claim(service, "agent-a");
      expect(first).not.toBeNull();
      expect(first!.taskId).toBe(id);
      expect(first!.barsJson).toEqual(JSON.stringify(bars));
      expect(service.detail("owner-b", id)).toBeNull();
      expect(service.cancel("owner-b", id)).toBe(false);
      expect(service.list("owner-b", 20, 0)).toEqual({ runs: [], total: 0 });
      database.sqlite.prepare("UPDATE crypto_runs SET deadline_ms = 0 WHERE id = ?").run(id);
      await service.close();
      service = new CryptoBacktests(database.sqlite, "test-version", collect);
      service.start();
      const retry = await claim(service, "agent-b");
      expect(retry!.taskId).toBe(id);
      expect(retry!.token).not.toBe(first!.token);
      const result = runCryptoBacktest(input, bars);
      const reply = universeComputeReplySchema.parse(await runChild(input, retry!.barsJson));
      expect(reply).toEqual({ status: "COMPLETED", resultJson: JSON.stringify(result) });
      service.finish("agent-a", { taskId: id, token: first!.token, reply });
      expect(database.sqlite.prepare("SELECT result_json FROM crypto_runs WHERE id = ?").get(id)).toEqual({
        result_json: null,
      });
      service.finish("agent-b", { taskId: id, token: retry!.token, reply });
      expect(
        database.sqlite.prepare("SELECT status, result_json FROM crypto_runs WHERE id = ?").get(id),
      ).toEqual({ status: "COMPLETED", result_json: JSON.stringify(result) });
      expect(service.detail("owner-a", id)).not.toBeNull();
      const second = service.submit("owner-a", input);
      const reused = await claim(service, "agent-b");
      expect(reused!.taskId).toBe(second.id);
      expect(collections).toEqual([{ markets: ["KRW-BTC"], from: "2026-01-02", to: "2026-02-02" }]);
      expect(service.cancel("owner-a", second.id)).toBe(true);
      service.finish("agent-b", { taskId: second.id, token: reused!.token, reply });
      expect(
        database.sqlite.prepare("SELECT status, result_json FROM crypto_runs WHERE id = ?").get(second.id),
      ).toEqual({ status: "CANCELLED", result_json: null });
    } finally {
      await service.close();
    }
  });

  it("HTTP 경계에서 인증과 소유자별 조회·취소를 적용한다", async ({ database }) => {
    const service = new CryptoBacktests(database.sqlite, "test-version", async () => bars);
    const app = Fastify();
    registerCryptoRoutes(app, service, async (request, reply) => {
      const id = request.headers["x-test-owner"];
      if (typeof id !== "string") {
        await reply.code(401).send({ error: "인증이 필요합니다" });
        return;
      }
      request.authUser = { id, username: id };
    });
    const send = (
      method: "GET" | "POST" | "DELETE",
      url: string,
      owner?: string,
      payload?: Record<string, unknown>,
    ) => app.inject({ method, url, headers: owner ? { "x-test-owner": owner } : {}, payload });
    try {
      service.start();
      expect((await send("GET", "/crypto/backtests")).statusCode).toBe(401);
      expect(
        (await send("POST", "/crypto/backtests", "owner-a", { ...input, markets: ["USD-BTC"] })).statusCode,
      ).toBe(400);
      const created = await send("POST", "/crypto/backtests", "owner-a", input);
      expect(created.statusCode).toBe(202);
      const { id } = created.json() as { id: string };
      expect((await send("GET", `/crypto/backtests/${id}`, "owner-b")).statusCode).toBe(404);
      expect((await send("DELETE", `/crypto/backtests/${id}`, "owner-b")).statusCode).toBe(404);
      expect((await send("GET", "/crypto/backtests", "owner-b")).json()).toEqual({ runs: [], total: 0 });
      expect((await send("DELETE", `/crypto/backtests/${id}`, "owner-a")).statusCode).toBe(204);
      const detail = await send("GET", `/crypto/backtests/${id}`, "owner-a");
      expect(detail.json().status).toBe("CANCELLED");
    } finally {
      await app.close();
      await service.close();
    }
  });
});
