import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { DatabaseHandle } from "../../../../runtime/shared/db/database.js";
import { paperTradingAccountId, paperInitialCashSchema, PAPER_TRADING_INITIAL_CASH_KRW, type TradingPresetSummary, type TradingSetup } from "../../../../shared/schemas/trading.js";
import { TradingError, type TradingService } from "./trading-service.js";
import type { IntradayRun } from "../../../../shared/schemas/intraday.js";
import { getIntradayStrategy, intradayRunRequestSchema } from "../../../../shared/schemas/intraday-strategies.js";
import type { IntradayTradingSetup, TradingSnapshot } from "../../../../shared/schemas/trading.js";
import { readRuntimeVersions } from "../../../../runtime/shared/runtime-versions.js";

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
    private readonly getRun?: (ownerId: string, id: string) => IntradayRun,
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
      WITH presets AS (
        SELECT d.id, d.account_slot AS accountSlot, d.created_at_ms AS createdAtMs,
          coalesce(nullif(trim(json_extract(d.setup_json, '$.title')), ''), d.name) AS title,
          CASE WHEN d.last_error IS NOT NULL OR c.error IS NOT NULL OR d.status = 'ERROR' THEN 'ERROR'
               WHEN d.status = 'ACTIVE' THEN 'ACTIVE' ELSE 'INACTIVE' END AS status,
          d.rowid AS sequence
        FROM trading_deployments d JOIN trading_control c ON c.singleton = d.account_slot
        WHERE d.mode = 'PAPER' AND d.slot IS NOT NULL
      )
      SELECT id, title, status, createdAtMs, accountSlot FROM presets
      ORDER BY CASE status WHEN 'ACTIVE' THEN 0 WHEN 'INACTIVE' THEN 1 ELSE 2 END, createdAtMs, sequence
    `).all() as Array<TradingPresetSummary & { accountSlot: number }>;
    const defaultAccountPresetId = rows.find(row => row.accountSlot === 1)?.id ?? null;
    const presets = rows.map(({ id, title, status, createdAtMs }) => ({ id, title, status, createdAtMs }));
    return { presets, archived: [], defaultAccountPresetId };
  }

  forPreset(id: string): TradingService {
    const row = this.database.sqlite.prepare(`
      SELECT d.account_slot AS slot FROM trading_deployments d
      WHERE d.id = ? AND d.mode = 'PAPER' AND d.slot IS NOT NULL
    `).get(id) as { slot: number } | undefined;
    if (!row) throw new TradingError("모의투자를 찾을 수 없습니다.", "PRESET_NOT_FOUND", 404);
    return this.account(row.slot);
  }

  async create(input: TradingSetup, revision: number, actor: string, initialCash?: number, requestId: string = randomUUID()) {
    if (revision !== 0) throw new TradingError("새 모의투자의 초기 개정 번호는 0입니다.", "STALE_REVISION");
    const cash = paperInitialCashSchema.parse(initialCash ?? PAPER_TRADING_INITIAL_CASH_KRW);
    const validated = await this.defaultAccount.validateRegistration(input);
    return this.createAccount(validated.setup, cash, requestId,
      (account, revision) => account.registerValidated(validated, revision, actor, undefined, requestId));
  }

  async createIntraday(input: { sourceRunId: string; requestId: string; title?: string }, actor: string) {
    if (!this.getRun) throw new TradingError("분봉 백테스트를 조회할 수 없습니다.");
    const run = this.getRun(actor, input.sourceRunId);
    if (run.status !== "COMPLETED" || !run.result) throw new TradingError("완료된 분봉 백테스트만 모의투자로 가져올 수 있습니다.");
    const parsed = intradayRunRequestSchema.safeParse(run.result.request);
    if (!parsed.success) throw new TradingError("현재 분봉 엔진에서 지원하지 않는 설정입니다. 백테스트를 복제해 지원 주기·설정으로 다시 실행해 주세요.", "UNSUPPORTED_EXECUTION", 422);
    const request = parsed.data;
    const artifact = getIntradayStrategy(request.strategyId);
    const executionVersion = readRuntimeVersions().executionVersion;
    if (run.result.strategyVersion !== artifact.version) {
      throw new TradingError("원본 분봉 전략 버전을 지원하지 않습니다. 현재 전략 버전으로 백테스트를 다시 실행해 주세요.", "UNSUPPORTED_EXECUTION", 422);
    }
    const setup: IntradayTradingSetup = { kind: "intraday", sourceRunId: run.id, executionVersion, request, title: input.title };
    return this.createAccount(setup, request.initialCash, input.requestId,
      (account, revision) => account.registerValidated({ setup, artifact }, revision, actor, undefined, input.requestId));
  }

  private createAccount(setup: TradingSetup | IntradayTradingSetup, cash: number, requestId: string,
    register: (account: TradingService, revision: number) => TradingSnapshot) {
    const { sqlite } = this.database;
    // 계좌 할당, 잔고 생성, 전략 저장을 한 번에 커밋한다. 제거한 전략의 자금은 재사용하지 않는다.
    const created = sqlite.transaction(() => {
      if (this.closing) throw new TradingError("서버 종료 중에는 모의투자를 만들 수 없습니다.");
      const previous = sqlite.prepare(`
        SELECT d.slot, d.setup_json AS setup, a.initial_cash AS cash FROM trading_deployments d
        LEFT JOIN paper_trading_account a ON a.singleton = d.account_slot WHERE d.id = ?
      `).get(requestId) as {slot: number | null; setup: string; cash: number | null} | undefined;
      if (previous) {
        if (!previous.slot || previous.cash !== cash || !isDeepStrictEqual(JSON.parse(previous.setup), JSON.parse(JSON.stringify(setup)))) {
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
      const snapshot = register(account, account.snapshot().revision);
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
