import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { DatabaseHandle } from "../../../../runtime/shared/db/database.js";
import { paperTradingAccountId, paperInitialCashSchema, PAPER_TRADING_INITIAL_CASH_KRW, type TradingPresetSummary, type TradingSetup } from "../../../../shared/schemas/trading.js";
import { TradingError, type TradingService } from "./trading-service.js";

/** 시세·원천 데이터는 공유하고 주문 허용 상태와 실행기는 모의계좌 단위로 보관한다. */
export class TradingPresets {
  readonly defaultAccount: TradingService;
  private readonly services = new Map<number, TradingService>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private closing = false;

  constructor(
    private readonly database: DatabaseHandle,
    private readonly createService: (slot: number) => TradingService,
    private readonly reportError: (error: unknown) => void,
  ) {
    this.defaultAccount = this.account(1);
  }

  private account(slot: number): TradingService {
    let account = this.services.get(slot);
    if (!account) {
      account = this.createService(slot);
      this.services.set(slot, account);
    }
    return account;
  }

  list() {
    const rows = this.database.sqlite.prepare(`
      WITH ranked AS (
        SELECT d.id, d.account_slot AS accountSlot, d.created_at_ms AS createdAtMs, d.slot IS NULL AS archived,
          coalesce(nullif(trim(json_extract(d.setup_json, '$.title')), ''), d.name) AS title,
          CASE WHEN d.slot IS NULL THEN 'INACTIVE'
               WHEN d.last_error IS NOT NULL OR c.error IS NOT NULL OR d.status = 'ERROR' THEN 'ERROR'
               WHEN d.status = 'ACTIVE' THEN 'ACTIVE' ELSE 'INACTIVE' END AS status,
          row_number() OVER (PARTITION BY d.account_slot ORDER BY d.slot IS NULL, d.created_at_ms DESC, d.rowid DESC) AS rank,
          d.rowid AS sequence
        FROM trading_deployments d JOIN trading_control c ON c.singleton = d.account_slot
        WHERE d.mode = 'PAPER'
      )
      SELECT id, title, status, createdAtMs, archived, accountSlot FROM ranked WHERE rank = 1
      ORDER BY CASE status WHEN 'ACTIVE' THEN 0 WHEN 'INACTIVE' THEN 1 ELSE 2 END, createdAtMs, sequence
    `).all() as Array<TradingPresetSummary & { archived: number; accountSlot: number }>;
    const presets: TradingPresetSummary[] = [], archived: TradingPresetSummary[] = [];
    let defaultAccountPresetId: string | null = null;
    for (const { archived: removed, accountSlot, ...summary } of rows) {
      if (accountSlot === 1) defaultAccountPresetId = summary.id;
      (removed ? archived : presets).push(summary);
    }
    return { presets, archived, defaultAccountPresetId };
  }

  forPreset(id: string): TradingService {
    const row = this.database.sqlite.prepare(`
      SELECT d.account_slot AS slot FROM trading_deployments d
      LEFT JOIN trading_deployments current ON current.slot = d.account_slot
      WHERE d.id = ? AND d.mode = 'PAPER' AND (current.id = d.id OR (current.id IS NULL AND d.id = (
        SELECT latest.id FROM trading_deployments latest WHERE latest.account_slot = d.account_slot AND latest.mode = 'PAPER'
        ORDER BY latest.created_at_ms DESC, latest.rowid DESC LIMIT 1
      )))
    `).get(id) as { slot: number } | undefined;
    if (!row) throw new TradingError("모의투자를 찾을 수 없습니다.", "PRESET_NOT_FOUND", 404);
    return this.account(row.slot);
  }

  async create(input: TradingSetup, revision: number, actor: string, initialCash?: number, requestId: string = randomUUID()) {
    if (revision !== 0) throw new TradingError("새 모의투자의 초기 개정 번호는 0입니다.", "STALE_REVISION");
    const cash = paperInitialCashSchema.parse(initialCash ?? PAPER_TRADING_INITIAL_CASH_KRW);
    const validated = await this.defaultAccount.validateRegistration(input);
    const { sqlite } = this.database;
    // 계좌 할당, 잔고 생성, 전략 저장을 한 번에 커밋한다. 제거한 전략의 자금은 재사용하지 않는다.
    const created = sqlite.transaction(() => {
      if (this.closing) throw new TradingError("서버 종료 중에는 모의투자를 만들 수 없습니다.");
      const previous = sqlite.prepare(`
        SELECT d.slot, d.setup_json AS setup, a.initial_cash AS cash FROM trading_deployments d
        LEFT JOIN paper_trading_account a ON a.singleton = d.account_slot WHERE d.id = ?
      `).get(requestId) as {slot: number | null; setup: string; cash: number | null} | undefined;
      if (previous) {
        if (!previous.slot || previous.cash !== cash || !isDeepStrictEqual(JSON.parse(previous.setup), JSON.parse(JSON.stringify(validated.setup)))) {
          throw new TradingError("같은 생성 요청으로 저장한 모의투자의 설정이 다릅니다.", "CREATE_REQUEST_CONFLICT");
        }
        const account = this.account(previous.slot);
        return {slot: previous.slot, account, snapshot: account.snapshot(), id: requestId};
      }
      const virgin = !sqlite.prepare("SELECT 1 FROM trading_deployments WHERE account_slot = 1 LIMIT 1").get()
        && !sqlite.prepare("SELECT 1 FROM paper_trading_account WHERE singleton = 1").get()
        && !sqlite.prepare("SELECT 1 FROM paper_trading_orders WHERE account_slot = 1 LIMIT 1").get();
      const slot = virgin ? 1 : (sqlite.prepare("SELECT max(singleton) + 1 AS slot FROM trading_control").get() as {slot: number}).slot;
      if (!virgin) sqlite.prepare("INSERT INTO trading_control (singleton, mode, account_id) VALUES (?, 'PAPER', ?)").run(slot, paperTradingAccountId(slot));
      sqlite.prepare("INSERT INTO paper_trading_account (singleton, initial_cash, cash) VALUES (?, ?, ?)").run(slot, cash, cash);
      sqlite.prepare("UPDATE trading_control SET snapshot_json = ? WHERE singleton = ?").run(JSON.stringify({ holdings: [], cashBuyingPower: cash }), slot);
      const account = virgin ? this.defaultAccount : this.createService(slot);
      const snapshot = account.registerValidated(validated, account.snapshot().revision, actor, undefined, requestId);
      return { slot, account, snapshot, id: snapshot.deployment!.id };
    }).immediate();
    this.services.set(created.slot, created.account);
    return { id: created.id, snapshot: created.snapshot };
  }

  async tick(): Promise<void> {
    if (this.closing) return;
    const rows = this.database.sqlite.prepare(`
      SELECT slot FROM trading_deployments WHERE mode = 'PAPER' AND slot > 1
      UNION SELECT singleton FROM paper_trading_account WHERE singleton > 1 AND holdings_json <> '{}'
    `).all() as { slot: number }[];
    // 느린 데이터 수집이나 이전 판단이 진행 중인 계좌는 자기 실행만 기다린다.
    await Promise.all([1, ...rows.map(row => row.slot)].map(async slot => {
      try { await this.account(slot).tick(); }
      catch (cause) { this.reportError(new Error(`모의계좌 ${slot} 실행 실패`, { cause })); }
    }));
  }

  start() {
    if (this.timer || this.closing) return;
    const run = () => { void this.tick().catch(this.reportError); };
    this.timer = setInterval(run, 5_000);
    this.timer.unref();
    run();
  }

  async close() {
    this.closing = true;
    if (this.timer) clearInterval(this.timer);
    await Promise.all([...this.services.values()].map(service => service.close()));
  }
}
