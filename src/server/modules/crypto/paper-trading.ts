import type Database from "better-sqlite3";
import type { CryptoBacktestInput, CryptoDailyBar } from "../../../shared/crypto-backtest.js";
import type { CryptoPaperAccount } from "../../../shared/crypto-paper.js";
import type { CryptoPortfolio } from "../../../runtime/modules/crypto/backtest.js";
import {
  cryptoStrategyVersions,
  type CryptoStrategy,
  type CryptoStrategyVersions,
} from "../../../runtime/modules/crypto/strategy-versions.js";
import { fetchUpbitDailyBars, fetchUpbitQuotes } from "./upbit.js";

const dayMs = 86_400_000;
const openWindowMs = 5 * 60_000;
const dateOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const httpError = (statusCode: number, message: string) => Object.assign(new Error(message), { statusCode });
interface AccountRow {
  owner_id: string;
  source_run_id: string;
  initial_cash: number;
  cash: number;
  holding_json: string | null;
  active: number;
  active_from_ms: number | null;
  revision: number;
  last_session: string | null;
  updated_at_ms: number;
  valued_at_ms: number | null;
  error: string | null;
  strategy_version: string;
  input_json: string;
}
const accountsSql = `SELECT a.*,r.input_json,COALESCE(a.strategy_version_override,r.strategy_version) AS strategy_version
   FROM crypto_paper_accounts a JOIN crypto_runs r ON a.source_run_id=r.id`;
type Options = {
  now?: () => number;
  history?: typeof fetchUpbitDailyBars;
  quotes?: typeof fetchUpbitQuotes;
  strategies?: CryptoStrategyVersions;
};

export class CryptoPaperTrading {
  private readonly now: () => number;
  private readonly history: typeof fetchUpbitDailyBars;
  private readonly quotes: typeof fetchUpbitQuotes;
  private timer?: NodeJS.Timeout;
  private pending: Promise<void> | null = null;
  private readonly abort = new AbortController();
  private lastValuation = 0;
  private readonly versions: CryptoStrategyVersions;
  private readonly latest: CryptoStrategy;

  constructor(
    private readonly db: Database.Database,
    options: Options = {},
  ) {
    this.versions = options.strategies ?? cryptoStrategyVersions;
    this.latest = this.versions.at(-1)!;
    this.now = options.now ?? Date.now;
    this.history = options.history ?? fetchUpbitDailyBars;
    this.quotes = options.quotes ?? fetchUpbitQuotes;
  }

  private versionUpdateBlocker(
    currentVersion: string,
    input: CryptoBacktestInput,
    target = this.latest,
  ): string | null {
    if (currentVersion === target.version) return null;
    if (!target.compatibleFrom.includes(currentVersion))
      return "대상 버전이 현재 계좌의 전략 상태를 이어받을 수 없습니다.";
    if (!target.acceptsInput(input)) return "현재 파라미터는 대상 전략 버전과 호환되지 않습니다.";
    return null;
  }

  get(owner: string): CryptoPaperAccount | null {
    const row = this.db.prepare(accountsSql + " WHERE a.owner_id=?").get(owner) as AccountRow | undefined;
    if (!row) return null;
    const holding: CryptoPortfolio["holding"] = row.holding_json && JSON.parse(row.holding_json);
    const fills = this.db
      .prepare(
        "SELECT fill_json FROM crypto_paper_fills WHERE owner_id=? ORDER BY date DESC,sequence DESC LIMIT 100",
      )
      .all(owner) as { fill_json: string }[];
    const input: CryptoBacktestInput = JSON.parse(row.input_json);
    return {
      sourceRunId: row.source_run_id,
      strategyVersion: row.strategy_version,
      latestStrategyVersion: this.latest.version,
      versionUpdateBlocker: this.versionUpdateBlocker(row.strategy_version, input),
      revision: row.revision,
      input,
      active: !!row.active,
      initialCash: row.initial_cash,
      cash: row.cash,
      holding,
      equity: row.cash + (holding ? holding.quantity * holding.lastClose : 0),
      trades: fills.map((f) => JSON.parse(f.fill_json)),
      lastSession: row.last_session,
      updatedAtMs: row.updated_at_ms,
      valuedAtMs: row.valued_at_ms,
      error: row.error,
    };
  }

  configure(owner: string, sourceRunId: string, initialCash?: number): CryptoPaperAccount {
    return this.db
      .transaction(() => {
        const run = this.db
          .prepare("SELECT status,input_json,strategy_version FROM crypto_runs WHERE owner_id=? AND id=?")
          .get(owner, sourceRunId) as
          | { status: string; input_json: string; strategy_version: string }
          | undefined;
        if (!run) throw httpError(404, "원본 코인 백테스트를 찾을 수 없습니다.");
        const strategy = this.versions.find((v) => v.version === run.strategy_version);
        if (run.status !== "COMPLETED" || !strategy)
          throw httpError(409, "실행 가능한 버전으로 완료한 백테스트가 필요합니다.");
        const existing = this.get(owner);
        if (existing?.active) throw httpError(409, "자동매매를 끈 뒤 설정을 변경하세요.");
        if (existing && initialCash !== undefined && initialCash !== existing.initialCash)
          throw httpError(409, "기존 모의계좌의 초기 자금은 변경할 수 없습니다.");
        if (existing?.sourceRunId === sourceRunId) return existing;
        const input: CryptoBacktestInput = JSON.parse(run.input_json);
        if (existing) {
          const blocker = this.versionUpdateBlocker(existing.strategyVersion, input, strategy);
          if (blocker) throw httpError(409, blocker);
        }
        const funds = initialCash ?? input.initialCash;
        if (!Number.isFinite(funds) || funds <= 0 || funds > 1e15)
          throw httpError(400, "초기 모의자금이 올바르지 않습니다.");
        this.db
          .prepare(
            `INSERT INTO crypto_paper_accounts(owner_id,source_run_id,initial_cash,cash,updated_at_ms)
        VALUES(?,?,?,?,?) ON CONFLICT(owner_id) DO UPDATE SET source_run_id=excluded.source_run_id,
        strategy_version_override=NULL,revision=revision+1,updated_at_ms=excluded.updated_at_ms,error=NULL`,
          )
          .run(owner, sourceRunId, funds, funds, this.now());
        return this.get(owner)!;
      })
      .immediate();
  }

  updateVersion(owner: string, expectedRevision: number, targetVersion: string): CryptoPaperAccount {
    return this.db
      .transaction(() => {
        const account = this.get(owner);
        if (!account) throw httpError(404, "코인 모의계좌를 찾을 수 없습니다.");
        if (account.active) throw httpError(409, "자동매매를 끈 뒤 전략 버전을 변경하세요.");
        if (account.revision !== expectedRevision || targetVersion !== this.latest.version)
          throw httpError(409, "계좌 설정 또는 최신 버전이 변경되었습니다. 다시 확인하세요.");
        if (account.versionUpdateBlocker) throw httpError(409, account.versionUpdateBlocker);
        if (account.strategyVersion === targetVersion) return account;
        this.db
          .prepare(
            `UPDATE crypto_paper_accounts SET strategy_version_override=?, revision=revision+1, updated_at_ms=?
        WHERE owner_id=?`,
          )
          .run(targetVersion, this.now(), owner);
        return this.get(owner)!;
      })
      .immediate();
  }

  setActive(owner: string, active: boolean): CryptoPaperAccount {
    return this.db
      .transaction(() => {
        const account = this.get(owner);
        if (!account) throw httpError(404, "코인 모의계좌를 먼저 준비하세요.");
        if (account.active !== active) {
          const upgrade =
            active && account.strategyVersion !== this.latest.version && !account.versionUpdateBlocker;
          if (active && !upgrade && !this.versions.some((v) => v.version === account.strategyVersion))
            throw httpError(409, "이 계좌에 고정된 전략 버전을 실행할 수 없습니다.");
          const now = this.now();
          this.db
            .prepare(
              `UPDATE crypto_paper_accounts SET active=?,active_from_ms=?,revision=revision+1,
          strategy_version_override=COALESCE(?,strategy_version_override),updated_at_ms=?,error=NULL WHERE owner_id=?`,
            )
            .run(Number(active), active ? now : null, upgrade ? this.latest.version : null, now, owner);
        }
        return this.get(owner)!;
      })
      .immediate();
  }

  start(): void {
    if (this.timer || this.abort.signal.aborted) return;
    const poll = () => {
      void this.tick().catch((error) => console.error("코인 모의매매 스케줄러 오류", error));
    };
    this.timer = setInterval(poll, 15_000);
    this.timer.unref();
    poll();
  }

  tick(): Promise<void> {
    if (this.abort.signal.aborted) return Promise.resolve();
    this.pending ??= this.process().finally(() => {
      this.pending = null;
    });
    return this.pending;
  }

  private async process(): Promise<void> {
    const now = this.now(),
      open = Math.floor(now / dayMs) * dayMs,
      session = dateOf(open);
    const rows = this.db
      .prepare(
        accountsSql +
          ` WHERE a.active=1 AND a.active_from_ms<=?
      AND (a.last_session IS NULL OR a.last_session<?) ORDER BY a.owner_id`,
      )
      .all(open, session) as AccountRow[];
    const datasets = new Map<string, Promise<CryptoDailyBar[]>>();
    for (const row of rows) {
      if (this.abort.signal.aborted) return;
      try {
        if (this.now() >= open + openWindowMs) {
          this.db
            .prepare(
              `UPDATE crypto_paper_accounts SET last_session=?,error=?,updated_at_ms=?
            WHERE owner_id=? AND revision=? AND active=1 AND (last_session IS NULL OR last_session<?)`,
            )
            .run(
              session,
              "09:00~09:05에 유효한 시세로 실행하지 못해 이 세션의 주문을 건너뛰었습니다.",
              this.now(),
              row.owner_id,
              row.revision,
              session,
            );
          continue;
        }
        const input: CryptoBacktestInput = JSON.parse(row.input_json);
        let strategy = this.versions.find((v) => v.version === row.strategy_version);
        if (
          row.strategy_version !== this.latest.version &&
          !this.versionUpdateBlocker(row.strategy_version, input)
        ) {
          // 이전 버전으로 이미 시작한 판단은 revision이 달라져 체결을 기록할 수 없다.
          const updated = this.db
            .prepare(
              `UPDATE crypto_paper_accounts SET strategy_version_override=?,
            revision=revision+1,updated_at_ms=? WHERE owner_id=? AND revision=? AND active=1
            AND (last_session IS NULL OR last_session<?) RETURNING revision`,
            )
            .get(this.latest.version, this.now(), row.owner_id, row.revision, session) as
            | { revision: number }
            | undefined;
          if (!updated) continue;
          row.revision = updated.revision;
          strategy = this.latest;
        }
        if (!strategy) throw new Error("이 계좌에 고정된 전략 버전을 실행할 수 없습니다.");
        const from = dateOf(open - strategy.warmupDays(input) * dayMs);
        const markets = [...input.markets].sort(),
          key = JSON.stringify([markets, from]);
        if (!datasets.has(key))
          datasets.set(key, this.history(markets, from, dateOf(open - dayMs), this.abort.signal));
        const signal = strategy.selectTarget(input, await datasets.get(key)!, session);
        const portfolio: CryptoPortfolio = {
          cash: row.cash,
          holding: row.holding_json && JSON.parse(row.holding_json),
        };
        const symbols = new Set<string>();
        if (portfolio.holding) symbols.add(portfolio.holding.market);
        if (signal.target) symbols.add(signal.target);
        const quotes =
          signal.evaluated && symbols.size ? await this.quotes([...symbols], this.abort.signal) : new Map();
        const observed = this.now(),
          prices = new Map<string, number>();
        if (this.abort.signal.aborted || observed >= open + openWindowMs) continue;
        for (const market of symbols) {
          const quote = quotes.get(market);
          if (quote && quote.atMs >= open && quote.atMs <= observed && observed - quote.atMs <= 60_000)
            prices.set(market, quote.price);
        }
        const step = strategy.executeSession(input, portfolio, signal, prices, session);
        if (step.skipped === "INSUFFICIENT_HISTORY") throw new Error("판단에 필요한 확정 일봉이 부족합니다.");
        if (step.skipped === "MISSING_PRICE") throw new Error("새 세션 현재가를 기다리고 있습니다.");
        const holding = step.portfolio.holding;
        const valuation = holding ? quotes.get(holding.market)! : null;
        if (holding && valuation && prices.has(holding.market)) holding.lastClose = valuation.price;
        this.db
          .transaction(() => {
            const updated = this.db
              .prepare(
                `UPDATE crypto_paper_accounts SET last_session=?,cash=?,holding_json=?,updated_at_ms=?,
            valued_at_ms=?,error=? WHERE owner_id=? AND revision=? AND active=1 AND (last_session IS NULL OR last_session<?)`,
              )
              .run(
                session,
                step.portfolio.cash,
                holding ? JSON.stringify(holding) : null,
                observed,
                (holding && prices.has(holding.market)
                  ? valuation?.atMs
                  : holding
                    ? row.valued_at_ms
                    : null) ?? null,
                step.minimumBuy || step.minimumSell
                  ? "최소 주문금액 5,000원 미만으로 주문을 건너뛰었습니다."
                  : signal.incomplete
                    ? "이력이 부족한 후보를 제외하고 평가했습니다."
                    : null,
                row.owner_id,
                row.revision,
                session,
              );
            if (!updated.changes) return;
            const insert = this.db.prepare(
              "INSERT INTO crypto_paper_fills(owner_id,date,sequence,fill_json) VALUES(?,?,?,?)",
            );
            step.trades.forEach((fill, i) => insert.run(row.owner_id, session, i, JSON.stringify(fill)));
          })
          .immediate();
      } catch (error) {
        if (this.abort.signal.aborted) return;
        this.db
          .prepare(
            "UPDATE crypto_paper_accounts SET error=?,updated_at_ms=? WHERE owner_id=? AND active=1 AND revision=? AND (last_session IS NULL OR last_session<?)",
          )
          .run(
            (error instanceof Error ? error.message : String(error)).slice(0, 2000),
            this.now(),
            row.owner_id,
            row.revision,
            session,
          );
      }
    }
    if (!this.abort.signal.aborted && now - this.lastValuation >= 60_000) {
      this.lastValuation = now;
      await this.markHoldings();
    }
  }

  private async markHoldings(): Promise<void> {
    const rows = this.db
      .prepare(
        "SELECT owner_id,holding_json,revision FROM crypto_paper_accounts WHERE holding_json IS NOT NULL",
      )
      .all() as { owner_id: string; holding_json: string; revision: number }[];
    if (!rows.length) return;
    const positions = rows.map((row) => ({
      ...row,
      holding: JSON.parse(row.holding_json) as NonNullable<CryptoPortfolio["holding"]>,
    }));
    const quotes = await this.quotes([...new Set(positions.map((p) => p.holding.market))], this.abort.signal);
    if (this.abort.signal.aborted) return;
    const update = this.db.prepare(`UPDATE crypto_paper_accounts SET holding_json=?,valued_at_ms=?
      WHERE owner_id=? AND revision=? AND holding_json=? AND (valued_at_ms IS NULL OR valued_at_ms<?)`);
    for (const row of positions) {
      const quote = quotes.get(row.holding.market);
      if (quote && quote.atMs <= this.now())
        update.run(
          JSON.stringify({ ...row.holding, lastClose: quote.price }),
          quote.atMs,
          row.owner_id,
          row.revision,
          row.holding_json,
          quote.atMs,
        );
    }
  }

  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.abort.abort();
    await this.pending?.catch((error) => {
      if (!this.abort.signal.aborted) throw error;
    });
  }
}
