import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../../src/runtime/shared/db/database.js";
import {
  cryptoStrategyVersions,
  type CryptoStrategy,
} from "../../src/runtime/modules/crypto/strategy-versions.js";
import { runCryptoBacktest } from "../../src/runtime/modules/crypto/backtest.js";
import { CryptoPaperTrading } from "../../src/server/modules/crypto/paper-trading.js";
import { waitForCondition } from "../helpers/wait-for-condition.js";

const base = cryptoStrategyVersions[0];
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
const bars = Array.from({ length: 40 }, (_, i) => {
  const price = 100 + i;
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
const ms = (value: string) => Date.parse(value);
const result = JSON.stringify(runCryptoBacktest(input, bars));
function seed(sqlite: ReturnType<typeof openDatabase>["sqlite"], owner: string, id: string) {
  sqlite
    .prepare(
      `INSERT INTO crypto_runs(id,owner_id,input_json,status,created_at_ms,updated_at_ms,strategy_version,result_json)
    VALUES(?,?,?,'COMPLETED',1,1,'upbit-turnover-momentum-v1',?)`,
    )
    .run(id, owner, JSON.stringify(input), result);
}
const history = async (_markets: string[], from: string, to: string) =>
  bars.filter((bar) => bar.date >= from && bar.date <= to);

function temporaryDatabase() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crypto-paper-test-"));
  return { dir, dbPath: path.join(dir, "app.sqlite") };
}

describe("암호화폐 모의투자", () => {
  it("파일 DB 재시작 후 활성 상태와 체결을 이어가고 비활성 상태에서는 보유 자산을 팔지 않는다", async () => {
    const { dir, dbPath } = temporaryDatabase();
    let db = openDatabase(dbPath);
    let now = ms("2026-01-31T23:59:00Z");
    const deps = {
      now: () => now,
      history,
      quotes: async () => new Map([["KRW-BTC", { price: 130, atMs: now }]]),
    };
    let paper = new CryptoPaperTrading(db.sqlite, deps);
    try {
      seed(db.sqlite, "owner-a", "run-a");
      expect(() => paper.configure("owner-b", "run-a")).toThrow();
      expect(paper.get("owner-b")).toBeNull();
      paper.configure("owner-a", "run-a");
      paper.setActive("owner-a", true);
      expect(() => paper.configure("owner-a", "run-a")).toThrow();
      now = ms("2026-02-01T00:01:00Z");
      await paper.tick();
      expect(paper.get("owner-a")).toMatchObject({
        active: true,
        lastSession: "2026-02-01",
        cash: 0,
        holding: { market: "KRW-BTC" },
        trades: [{ date: "2026-02-01", side: "BUY", market: "KRW-BTC" }],
      });
      await paper.tick();
      expect(paper.get("owner-a")!.trades).toHaveLength(1);
      await paper.close();
      db.close();
      db = openDatabase(dbPath);
      paper = new CryptoPaperTrading(db.sqlite, deps);
      now = ms("2026-02-02T00:01:00Z");
      paper.start();
      await waitForCondition(
        () => paper.get("owner-a"),
        (account) => account?.lastSession === "2026-02-02",
        {
          signal: AbortSignal.timeout(5000),
          timeoutMs: 4000,
          label: "재시작 후 세션",
        },
      );
      expect(paper.get("owner-a")).toMatchObject({ active: true, holding: { market: "KRW-BTC" } });
      expect(paper.get("owner-a")!.trades).toHaveLength(1);
      paper.setActive("owner-a", false);
      await paper.close();
      db.close();
      db = openDatabase(dbPath);
      paper = new CryptoPaperTrading(db.sqlite, deps);
      now = ms("2026-02-03T00:01:00Z");
      await paper.tick();
      expect(paper.get("owner-a")).toMatchObject({
        active: false,
        lastSession: "2026-02-02",
        holding: { market: "KRW-BTC" },
      });
      expect(paper.get("owner-a")!.trades).toHaveLength(1);
    } finally {
      await paper.close();
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("요청 중 OFF/ON 변경과 경과한 거래 창은 오래된 시세의 체결을 막는다", async () => {
    const { dir, dbPath } = temporaryDatabase();
    const db = openDatabase(dbPath);
    let now = ms("2026-01-31T23:59:00Z");
    let release!: (value: Map<string, { price: number; atMs: number }>) => void;
    let started!: () => void;
    const called = new Promise<void>((resolve) => {
      started = resolve;
    });
    const pending = new Promise<Map<string, { price: number; atMs: number }>>((resolve) => {
      release = resolve;
    });
    const paper = new CryptoPaperTrading(db.sqlite, {
      now: () => now,
      history,
      quotes: async () => {
        started();
        return pending;
      },
    });
    try {
      seed(db.sqlite, "owner-a", "run-a");
      paper.configure("owner-a", "run-a");
      paper.setActive("owner-a", true);
      now = ms("2026-02-01T00:01:00Z");
      const tick = paper.tick();
      await called;
      paper.setActive("owner-a", false);
      paper.setActive("owner-a", true);
      now = ms("2026-02-01T00:02:00Z");
      release(new Map([["KRW-BTC", { price: 130, atMs: now }]]));
      await tick;
      expect(paper.get("owner-a")).toMatchObject({ active: true, cash: 10000, holding: null, trades: [] });
      now = ms("2026-02-01T00:06:00Z");
      await paper.tick();
      expect(paper.get("owner-a")).toMatchObject({ active: true, cash: 10000, holding: null, trades: [] });
    } finally {
      await paper.close();
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("이전 세션 또는 오래된 시세를 거부하고 경계 이후 켠 계좌는 다음 세션까지 대기한다", async () => {
    const { dir, dbPath } = temporaryDatabase();
    const db = openDatabase(dbPath);
    let now = ms("2026-01-31T23:59:00Z");
    let quoteTime = now;
    const paper = new CryptoPaperTrading(db.sqlite, {
      now: () => now,
      history,
      quotes: async () => new Map([["KRW-BTC", { price: 130, atMs: quoteTime }]]),
    });
    try {
      seed(db.sqlite, "owner-a", "run-a");
      seed(db.sqlite, "owner-b", "run-b");
      paper.configure("owner-a", "run-a");
      paper.configure("owner-b", "run-b");
      paper.setActive("owner-a", true);
      now = ms("2026-02-01T00:02:00Z");
      paper.setActive("owner-b", true);
      await paper.tick();
      expect(paper.get("owner-a")).toMatchObject({
        cash: 10000,
        holding: null,
        trades: [],
        lastSession: null,
      });
      expect(paper.get("owner-a")!.error).toContain("현재가");
      expect(paper.get("owner-b")).toMatchObject({
        cash: 10000,
        holding: null,
        trades: [],
        lastSession: null,
      });
      quoteTime = now;
      await paper.tick();
      expect(paper.get("owner-a")!.trades).toMatchObject([{ date: "2026-02-01", side: "BUY" }]);
      expect(paper.get("owner-b")!.trades).toEqual([]);
      now = ms("2026-02-02T00:06:00Z");
      await paper.tick();
      expect(paper.get("owner-b")).toMatchObject({
        cash: 10000,
        holding: null,
        trades: [],
        lastSession: "2026-02-02",
      });
      expect(paper.get("owner-b")!.error).toContain("건너뛰었습니다");
    } finally {
      await paper.close();
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("기존 ON 계좌를 재시작 뒤 호환 전략으로 전환하고 다음 세션에서 새 결정을 실행한다", async () => {
    const { dir, dbPath } = temporaryDatabase();
    let db = openDatabase(dbPath);
    let now = ms("2026-01-31T23:59:00Z");
    const next: CryptoStrategy = {
      ...base,
      version: "test-compatible-v2",
      compatibleFrom: [base.version],
      selectTarget: () => ({ target: null, evaluated: true, incomplete: false }),
      executeSession: (settings, portfolio, decision, prices, date) =>
        base.executeSession({ ...settings, feeBps: 100 }, portfolio, decision, prices, date),
    };
    const deps = {
      now: () => now,
      history,
      quotes: async () => new Map([["KRW-BTC", { price: 130, atMs: now }]]),
    };
    let paper = new CryptoPaperTrading(db.sqlite, { ...deps, strategies: [base] });
    try {
      seed(db.sqlite, "owner-a", "run-a");
      seed(db.sqlite, "owner-b", "run-b");
      paper.configure("owner-a", "run-a");
      paper.configure("owner-b", "run-b");
      paper.setActive("owner-a", true);
      now = ms("2026-02-01T00:01:00Z");
      await paper.tick();
      const before = paper.get("owner-a")!;
      const other = paper.get("owner-b")!;
      expect(before).toMatchObject({
        strategyVersion: base.version,
        active: true,
        cash: 0,
        holding: { market: "KRW-BTC", quantity: 10000 / 130 },
        lastSession: "2026-02-01",
      });
      expect(before.trades).toMatchObject([{ date: "2026-02-01", side: "BUY" }]);
      expect(
        db.sqlite
          .prepare("SELECT strategy_version_override FROM crypto_paper_accounts WHERE owner_id=?")
          .get("owner-a"),
      ).toEqual({ strategy_version_override: null });
      await paper.close();
      db.close();
      db = openDatabase(dbPath);
      paper = new CryptoPaperTrading(db.sqlite, { ...deps, strategies: [base, next] });
      expect(paper.get("owner-a")).toMatchObject({
        cash: before.cash,
        holding: before.holding,
        trades: before.trades,
        sourceRunId: "run-a",
        lastSession: "2026-02-01",
        active: true,
      });
      now = ms("2026-02-02T00:01:00Z");
      await paper.tick();
      const after = paper.get("owner-a")!;
      expect(after).toMatchObject({
        strategyVersion: next.version,
        latestStrategyVersion: next.version,
        sourceRunId: "run-a",
        active: true,
        cash: 9900,
        holding: null,
        lastSession: "2026-02-02",
      });
      expect(after.trades).toMatchObject([
        { date: "2026-02-02", side: "SELL", market: "KRW-BTC", fee: 100 },
        { date: "2026-02-01", side: "BUY", market: "KRW-BTC" },
      ]);
      await paper.tick();
      expect(paper.get("owner-a")!.trades).toEqual(after.trades);
      expect(paper.get("owner-b")).toMatchObject({
        strategyVersion: base.version,
        active: false,
        cash: other.cash,
        holding: other.holding,
        trades: other.trades,
        sourceRunId: "run-b",
      });
      expect(
        db.sqlite
          .prepare("SELECT strategy_version,input_json,result_json FROM crypto_runs WHERE id=?")
          .get("run-a"),
      ).toEqual({ strategy_version: base.version, input_json: JSON.stringify(input), result_json: result });
    } finally {
      await paper.close();
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("OFF 계좌는 명시적 갱신 또는 활성화에서 호환 버전을 적용하며 이전 revision과 ON 갱신을 거부한다", async () => {
    const { dir, dbPath } = temporaryDatabase();
    const db = openDatabase(dbPath);
    let now = ms("2026-01-31T23:59:00Z");
    const next: CryptoStrategy = {
      ...base,
      version: "test-compatible-v2",
      compatibleFrom: [base.version],
      selectTarget: () => ({ target: null, evaluated: true, incomplete: false }),
    };
    const deps = {
      now: () => now,
      history,
      quotes: async () => new Map([["KRW-BTC", { price: 130, atMs: now }]]),
    };
    let paper = new CryptoPaperTrading(db.sqlite, { ...deps, strategies: [base] });
    try {
      seed(db.sqlite, "owner-a", "run-a");
      seed(db.sqlite, "owner-b", "run-b");
      paper.configure("owner-a", "run-a");
      paper.configure("owner-b", "run-b");
      await paper.close();
      paper = new CryptoPaperTrading(db.sqlite, { ...deps, strategies: [base, next] });
      const before = paper.get("owner-a")!;
      expect(before).toMatchObject({
        strategyVersion: base.version,
        latestStrategyVersion: next.version,
        active: false,
      });
      expect(() => paper.updateVersion("owner-a", before.revision - 1, next.version)).toThrow();
      expect(() => paper.updateVersion("owner-a", before.revision, base.version)).toThrow();
      expect(paper.get("owner-a")).toEqual(before);
      const updated = paper.updateVersion("owner-a", before.revision, next.version);
      expect(updated).toMatchObject({
        strategyVersion: next.version,
        sourceRunId: "run-a",
        cash: before.cash,
        holding: before.holding,
        trades: before.trades,
        active: false,
        lastSession: before.lastSession,
      });
      expect(paper.configure("owner-a", "run-a")).toMatchObject({
        strategyVersion: next.version,
        sourceRunId: "run-a",
        cash: before.cash,
        holding: before.holding,
        trades: before.trades,
      });
      seed(db.sqlite, "owner-a", "other-v1-run");
      expect(() => paper.configure("owner-a", "other-v1-run")).toThrow();
      expect(paper.get("owner-a")).toEqual(updated);
      expect(paper.get("owner-b")!.strategyVersion).toBe(base.version);
      expect(paper.setActive("owner-b", true)).toMatchObject({ active: true, strategyVersion: next.version });
      expect(() => paper.updateVersion("owner-b", paper.get("owner-b")!.revision, next.version)).toThrow();
      now = ms("2026-02-01T00:01:00Z");
      await paper.tick();
      expect(paper.get("owner-b")).toMatchObject({
        strategyVersion: next.version,
        cash: 10000,
        holding: null,
        trades: [],
        lastSession: "2026-02-01",
      });
    } finally {
      await paper.close();
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each(["이전 버전", "계좌 파라미터"])(
    "%s 호환성이 없으면 ON 계좌는 기존 전략으로 계속 실행한다",
    async (incompatibleField) => {
      const { dir, dbPath } = temporaryDatabase();
      const db = openDatabase(dbPath);
      let now = ms("2026-01-31T23:59:00Z");
      const incompatible: CryptoStrategy = {
        ...base,
        version: "test-incompatible-v2",
        compatibleFrom: incompatibleField === "이전 버전" ? [] : [base.version],
        acceptsInput: (params) => incompatibleField !== "계좌 파라미터" || params.lookbackDays >= 10,
        selectTarget: () => ({ target: null, evaluated: true, incomplete: false }),
      };
      const deps = {
        now: () => now,
        history,
        quotes: async () => new Map([["KRW-BTC", { price: 130, atMs: now }]]),
      };
      let paper = new CryptoPaperTrading(db.sqlite, { ...deps, strategies: [base] });
      try {
        seed(db.sqlite, "owner-a", "run-a");
        paper.configure("owner-a", "run-a");
        paper.setActive("owner-a", true);
        await paper.close();
        paper = new CryptoPaperTrading(db.sqlite, { ...deps, strategies: [base, incompatible] });
        now = ms("2026-02-01T00:01:00Z");
        await paper.tick();
        expect(paper.get("owner-a")).toMatchObject({
          active: true,
          strategyVersion: base.version,
          latestStrategyVersion: incompatible.version,
          holding: { market: "KRW-BTC" },
          lastSession: "2026-02-01",
        });
        expect(paper.get("owner-a")!.versionUpdateBlocker).toEqual(expect.any(String));
        expect(paper.get("owner-a")!.trades).toMatchObject([{ date: "2026-02-01", side: "BUY" }]);
      } finally {
        await paper.close();
        db.close();
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});
