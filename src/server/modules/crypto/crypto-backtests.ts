import { createHash, randomBytes, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type Database from "better-sqlite3";
import {
  cryptoBacktestInputSchema,
  cryptoBacktestResultSchema,
  type CryptoBacktestInput,
} from "../../../shared/crypto-backtest.js";
import type { AgentMessage, ServerAgentMessage } from "../../../shared/agent-protocol.js";
import type { CryptoRunDetail, CryptoRunSummary } from "../../../shared/crypto-runs.js";
import { UNIVERSE_COMPUTE_TIMEOUT_MS } from "../../../shared/universe-compute.js";
import { fetchUpbitDailyBars } from "./upbit.js";

const dayMs = 86_400_000;
const summaryFields = "r.id, r.input_json, r.status, r.created_at_ms, r.executor, r.error";
type SummaryRow = Omit<CryptoRunSummary, "input" | "createdAtMs"> & {
  input_json: string;
  created_at_ms: number;
};
type Task = Extract<ServerAgentMessage, { type: "CRYPTO_TASK" }>;
type Result = Pick<Extract<AgentMessage, { type: "CRYPTO_RESULT" }>, "taskId" | "token" | "reply">;

function summary({ input_json, created_at_ms, ...row }: SummaryRow): CryptoRunSummary {
  return { ...row, input: JSON.parse(input_json), createdAtMs: created_at_ms };
}

export class CryptoBacktests {
  readonly events = new EventEmitter();
  private stopped = false;
  private readonly unavailableUntil = new Map<string, number>();
  private collecting: Promise<void> | null = null;
  private fetching: { id: string; abort: AbortController } | null = null;

  constructor(
    private readonly db: Database.Database,
    private readonly version: string,
    private readonly collect = fetchUpbitDailyBars,
  ) {}

  start(): void {
    this.db
      .prepare(
        `UPDATE crypto_runs SET updated_at_ms=CAST(unixepoch('subsec')*1000 AS INTEGER),status='FAILED', error='계산 버전이 변경되었습니다. 다시 실행하세요.',
      token=NULL, deadline_ms=NULL WHERE strategy_version<>? AND status IN ('COLLECTING','QUEUED','RUNNING')`,
      )
      .run(this.version);
    this.sweep();
    this.pump();
  }

  submit(owner: string, raw: unknown): { id: string } {
    const input = cryptoBacktestInputSchema.parse(raw);
    if (input.endDate >= new Date().toISOString().slice(0, 10))
      throw Object.assign(new Error("종료일은 확정된 업비트 일봉 날짜까지 선택할 수 있습니다."), {
        statusCode: 400,
      });
    const id = randomUUID();
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO crypto_runs(id,owner_id,input_json,status,created_at_ms,updated_at_ms,strategy_version)
      VALUES(?,?,?,'COLLECTING',?,?,?)`,
      )
      .run(id, owner, JSON.stringify(input), now, now, this.version);
    this.pump();
    return { id };
  }

  list(owner: string, limit: number, offset: number) {
    const rows = this.db
      .prepare(
        `SELECT ${summaryFields} FROM crypto_runs r WHERE owner_id=?
      ORDER BY created_at_ms DESC, id DESC LIMIT ? OFFSET ?`,
      )
      .all(owner, limit, offset) as SummaryRow[];
    const { n } = this.db.prepare("SELECT count(*) AS n FROM crypto_runs WHERE owner_id=?").get(owner) as {
      n: number;
    };
    return { runs: rows.map(summary), total: n };
  }

  detail(owner: string, id: string): CryptoRunDetail | null {
    const row = this.db
      .prepare(
        `SELECT ${summaryFields},r.result_json,r.strategy_version,d.sha256
      FROM crypto_runs r LEFT JOIN crypto_datasets d ON d.query_key=r.dataset_key
      WHERE r.owner_id=? AND r.id=?`,
      )
      .get(owner, id) as
      | (SummaryRow & {
          result_json: string | null;
          strategy_version: string;
          sha256: string | null;
        })
      | undefined;
    if (!row) return null;
    const { result_json, strategy_version, sha256, ...fields } = row;
    return {
      ...summary(fields),
      strategyVersion: strategy_version,
      datasetHash: sha256,
      result: result_json ? JSON.parse(result_json) : null,
    };
  }

  cancel(owner: string, id: string): boolean {
    const row = this.db
      .prepare(
        `UPDATE crypto_runs SET updated_at_ms=CAST(unixepoch('subsec')*1000 AS INTEGER),status='CANCELLED',token=NULL,deadline_ms=NULL
      WHERE owner_id=? AND id=? AND status IN ('COLLECTING','QUEUED','RUNNING') RETURNING executor`,
      )
      .get(owner, id) as { executor: string | null } | undefined;
    if (!row) return false;
    if (this.fetching?.id === id) this.fetching.abort.abort();
    if (row.executor) this.events.emit("cancel", row.executor, id);
    return true;
  }

  private pump(): void {
    if (this.stopped || this.collecting) return;
    this.collecting = this.drain().finally(() => {
      this.collecting = null;
      if (
        !this.stopped &&
        this.db.prepare("SELECT 1 FROM crypto_runs WHERE status='COLLECTING' LIMIT 1").get()
      )
        this.pump();
    });
  }

  private async drain(): Promise<void> {
    while (!this.stopped) {
      const row = this.db
        .prepare(
          "SELECT id,input_json FROM crypto_runs WHERE status='COLLECTING' ORDER BY created_at_ms,id LIMIT 1",
        )
        .get() as { id: string; input_json: string } | undefined;
      if (!row) return;
      const abort = new AbortController();
      this.fetching = { id: row.id, abort };
      try {
        const input: CryptoBacktestInput = JSON.parse(row.input_json);
        const from = new Date(Date.parse(input.startDate) - Math.max(30, input.lookbackDays + 1) * dayMs)
          .toISOString()
          .slice(0, 10);
        const markets = [...input.markets].sort();
        const key = JSON.stringify(["upbit-krw-utc-day-v1", markets, from, input.endDate]);
        if (!this.db.prepare("SELECT 1 FROM crypto_datasets WHERE query_key=?").get(key)) {
          const bars = await this.collect(markets, from, input.endDate, abort.signal);
          if (abort.signal.aborted) continue;
          if (!bars.length) throw new Error("요청한 마켓과 기간에 업비트 일봉이 없습니다.");
          const json = JSON.stringify(bars);
          this.db
            .prepare("INSERT OR IGNORE INTO crypto_datasets(query_key,sha256,bars_json) VALUES(?,?,?)")
            .run(key, createHash("sha256").update(json).digest("hex"), json);
        }
        this.db
          .prepare(
            "UPDATE crypto_runs SET updated_at_ms=CAST(unixepoch('subsec')*1000 AS INTEGER),status='QUEUED', dataset_key=? WHERE id=? AND status='COLLECTING'",
          )
          .run(key, row.id);
        this.events.emit("queued");
      } catch (error) {
        if (!abort.signal.aborted)
          this.db
            .prepare(
              "UPDATE crypto_runs SET updated_at_ms=CAST(unixepoch('subsec')*1000 AS INTEGER),status='FAILED',error=? WHERE id=? AND status='COLLECTING'",
            )
            .run((error instanceof Error ? error.message : String(error)).slice(0, 2000), row.id);
      } finally {
        this.fetching = null;
      }
    }
  }

  hasQueued(): boolean {
    return !!this.db
      .prepare("SELECT 1 FROM crypto_runs WHERE status='QUEUED' AND COALESCE(deadline_ms,0)<=? LIMIT 1")
      .get(Date.now());
  }

  active(executor: string): number {
    return (
      this.db
        .prepare("SELECT count(*) AS n FROM crypto_runs WHERE status='RUNNING' AND executor=?")
        .get(executor) as { n: number }
    ).n;
  }

  claim(executor: string): Task | null {
    if ((this.unavailableUntil.get(executor) ?? 0) > Date.now()) return null;
    return this.db
      .transaction((): Task | null => {
        const now = Date.now();
        const row = this.db
          .prepare(
            `SELECT r.id,r.input_json,d.bars_json FROM crypto_runs r
        JOIN crypto_datasets d ON d.query_key=r.dataset_key WHERE r.status='QUEUED' AND COALESCE(r.deadline_ms,0)<=?
        ORDER BY r.created_at_ms,r.id LIMIT 1`,
          )
          .get(now) as { id: string; input_json: string; bars_json: string } | undefined;
        if (!row) return null;
        const token = randomBytes(32).toString("base64url");
        const deadlineMs = now + UNIVERSE_COMPUTE_TIMEOUT_MS;
        this.db
          .prepare(
            "UPDATE crypto_runs SET updated_at_ms=CAST(unixepoch('subsec')*1000 AS INTEGER),status='RUNNING', attempts=attempts+1, executor=?,token=?,deadline_ms=? WHERE id=?",
          )
          .run(executor, token, deadlineMs, row.id);
        return {
          type: "CRYPTO_TASK",
          taskId: row.id,
          token,
          deadlineMs,
          input: JSON.parse(row.input_json),
          barsJson: row.bars_json,
        };
      })
      .immediate();
  }

  finish(executor: string, { taskId, token, reply }: Result): void {
    const where = "WHERE id=? AND executor=? AND token=? AND status='RUNNING' AND deadline_ms>?";
    const identity = [taskId, executor, token, Date.now()];
    const source = this.db.prepare(`SELECT input_json FROM crypto_runs ${where}`).get(...identity) as
      | { input_json: string }
      | undefined;
    if (!source) return;
    if (reply.status === "UNAVAILABLE") {
      this.unavailableUntil.set(executor, Date.now() + 15_000);
      this.db
        .prepare(
          `UPDATE crypto_runs SET updated_at_ms=CAST(unixepoch('subsec')*1000 AS INTEGER),status='QUEUED',executor=NULL,token=NULL,attempts=attempts-1,deadline_ms=NULL ${where}`,
        )
        .run(...identity);
      return;
    }
    let result: string | null = null;
    let error: string | null = null;
    if (reply.status === "FAILED") error = reply.error;
    else {
      try {
        const value = cryptoBacktestResultSchema.parse(JSON.parse(reply.resultJson));
        const input: CryptoBacktestInput = JSON.parse(source.input_json);
        const start = Date.parse(input.startDate);
        const days = 1 + (Date.parse(input.endDate) - start) / dayMs;
        const closeEnough = (a: number, b: number) =>
          Math.abs(a - b) <= 1e-10 * Math.max(1, Math.abs(a), Math.abs(b));
        let peak = input.initialCash,
          drawdown = 0;
        for (const point of value.equityCurve) {
          peak = Math.max(peak, point.equity);
          drawdown = Math.max(drawdown, 1 - point.equity / peak);
        }
        if (
          value.equityCurve.length !== days ||
          value.equityCurve.some((p, i) => Date.parse(p.date) !== start + i * dayMs) ||
          !closeEnough(value.finalEquity, value.equityCurve.at(-1)!.equity) ||
          !closeEnough(value.totalReturn, value.finalEquity / input.initialCash - 1) ||
          !closeEnough(value.maxDrawdown, drawdown) ||
          value.trades.some(
            (t, i) =>
              !input.markets.includes(t.market) ||
              t.date < input.startDate ||
              t.date > input.endDate ||
              (i > 0 && t.date < value.trades[i - 1]!.date) ||
              t.side !== (i % 2 === 0 ? "BUY" : "SELL") ||
              (t.side === "SELL" && t.market !== value.trades[i - 1]?.market),
          )
        )
          throw new Error();
        result = JSON.stringify(value);
      } catch {
        error = "에이전트가 반환한 코인 백테스트 결과를 검증하지 못했습니다.";
      }
    }
    this.db
      .prepare(
        `UPDATE crypto_runs SET updated_at_ms=CAST(unixepoch('subsec')*1000 AS INTEGER),status=?,result_json=?,error=?,token=NULL,deadline_ms=NULL ${where}`,
      )
      .run(result ? "COMPLETED" : "FAILED", result, error, ...identity);
  }

  sweep(): void {
    for (const [id, until] of this.unavailableUntil)
      if (until <= Date.now()) this.unavailableUntil.delete(id);
    this.db
      .prepare(
        `UPDATE crypto_runs SET updated_at_ms=CAST(unixepoch('subsec')*1000 AS INTEGER),status=CASE WHEN attempts>=3 THEN 'FAILED' ELSE 'QUEUED' END,
      error=CASE WHEN attempts>=3 THEN '계산 장치의 응답 시간이 반복해서 초과되었습니다.' END,
      executor=NULL,token=NULL,deadline_ms=NULL WHERE status='RUNNING' AND deadline_ms<=?`,
      )
      .run(Date.now());
  }

  async close(): Promise<void> {
    this.stopped = true;
    this.fetching?.abort.abort();
    await this.collecting;
  }
}
