import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import { openDatabase } from "../../src/runtime/shared/db/database.js";
import { SymbolLibraryService } from "../../src/server/modules/market-data/application/symbol-library-service.js";
import { SymbolInfoService } from "../../src/server/modules/market-data/application/symbol-info-service.js";
import { registerSymbolLibraryRoutes } from "../../src/server/modules/market-data/presentation/symbol-library-routes.js";
import type { StockInfo } from "../../src/runtime/modules/market-data/application/ports.js";
import pino from "pino";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });
function fixture() {
  const database = openDatabase(":memory:");
  const service = new SymbolLibraryService(database.sqlite, () => 1000);
  for (const id of ["alice", "bob"]) database.sqlite.prepare("INSERT INTO users (id, username, password_hash, created_at_ms, updated_at_ms) VALUES (?, ?, 'unused', 0, 0)").run(id, id);
  const app = Fastify();
  registerSymbolLibraryRoutes(app, service, async (req, reply) => {
    const owner = req.headers.authorization;
    if (owner !== "alice" && owner !== "bob") { await reply.code(401).send({ error: "인증 필요" }); return; }
    req.authUser = { id: owner, username: owner };
  });
  cleanup.push(async () => { await app.close(); database.close(); });
  return { database, service, app };
}
const stock: StockInfo = { symbol: "042700", name: "한미반도체", market: "KOSPI", englishName: null, status: "ACTIVE", sharesOutstanding: null };

describe("종목 사전과 개인 목록", () => {
  // 기존 이름 폴백 검사는 API 응답을 재시작 뒤 한국어 검색에 재사용하는 경로를 다루지 않는다.
  it("기존 마스터를 검색하고 코드로 배운 이름을 새 서비스에서도 API 재호출 없이 검색한다", async () => {
    const { database, service } = fixture();
    database.sqlite.prepare("INSERT INTO data.symbols (code, name, market, created_at_ms) VALUES ('005930', '삼성전자', 'KOSPI', 0)").run();
    database.sqlite.prepare("INSERT INTO data.symbols (code, name, market, created_at_ms) VALUES ('042700', '042700', 'KOSPI', 0)").run();
    const source = { getStockInfo: vi.fn(async () => ({ stocks: [stock], failedSymbols: [] })) };
    const info = new SymbolInfoService(source, { now: () => 1000 }, pino({ level: "silent" }), service);
    const lookup = (codes: string[]) => info.lookup(codes);
    expect(await service.search("삼성", lookup)).toEqual([{ symbol: "005930", name: "삼성전자", market: "KOSPI" }]);
    expect(source.getStockInfo).not.toHaveBeenCalled();
    expect(await service.search("042700", lookup)).toEqual([{ symbol: stock.symbol, name: stock.name, market: stock.market }]);
    const restarted = new SymbolLibraryService(database.sqlite);
    const unavailable = vi.fn(async () => { throw new Error("연결 끊김"); });
    expect(await restarted.search("한미 반도체", unavailable)).toHaveLength(1);
    expect(await restarted.search("042700", unavailable)).toHaveLength(1);
    expect(unavailable).not.toHaveBeenCalled();
    expect(await restarted.search("%", unavailable)).toEqual([]);
    expect(source.getStockInfo).toHaveBeenCalledTimes(1);
    expect(await restarted.search("123456", async () => [])).toEqual([{ symbol: "123456", name: "123456", market: "" }]);
    expect(restarted.getLocalNames(["123456"]).size).toBe(0);
  });

  // 기존 분봉 소유권 테스트에는 새 목록 API의 교차 사용자 수정·조회 경계가 없다.
  it("사용자별 관심 목록과 중복 없는 최근 조회를 독립적으로 저장한다", async () => {
    const { app, service, database } = fixture();
    service.rememberNames([stock]);
    const patch = (owner: string, symbol: string, body: object) => app.inject({ method: "PATCH", url: `/symbols/library/${symbol}`, headers: { authorization: owner }, payload: body });
    expect((await app.inject({ method: "GET", url: "/symbols/library" })).statusCode).toBe(401);
    expect((await patch("", stock.symbol, { favorite: true })).statusCode).toBe(401);
    expect((await patch("alice", "bad", { favorite: true })).statusCode).toBe(400);
    expect((await patch("alice", stock.symbol, { ownerId: "bob", favorite: true })).statusCode).toBe(400);
    await patch("alice", stock.symbol, { favorite: true });
    await patch("alice", stock.symbol, { viewed: true });
    await patch("alice", "005930", { viewed: true });
    const latest = (await patch("alice", stock.symbol, { viewed: true })).json();
    expect(latest.favorites.map((s: StockInfo) => s.symbol)).toEqual([stock.symbol]);
    expect(latest.recent.map((s: StockInfo) => s.symbol)).toEqual([stock.symbol, "005930"]);
    expect((await app.inject({ method: "GET", url: "/symbols/library", headers: { authorization: "bob" } })).json()).toEqual({ favorites: [], recent: [] });
    expect((await patch("alice", stock.symbol, { favorite: false })).json().recent).toEqual(latest.recent);
    expect(new SymbolLibraryService(database.sqlite).list("alice").recent).toEqual(latest.recent);
    await patch("alice", stock.symbol, { favorite: true });
    for (let i = 0; i < 31; i++) await patch("alice", String(100000 + i), { viewed: true });
    const pruned = service.list("alice");
    expect(pruned.recent).toHaveLength(30);
    expect(pruned.recent[0]?.symbol).toBe("100030");
    expect(pruned.favorites.map((s) => s.symbol)).toEqual([stock.symbol]);
  });
});
