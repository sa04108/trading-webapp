import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import type { DatabaseHandle } from "../../../../runtime/shared/db/database.js";
import type { Clock } from "../../../../runtime/shared/clock.js";
import { newId } from "../../../../runtime/shared/ids.js";
import { configurationSearchPreviewSchema, type ConfigurationSearchCatalog, type ConfigurationSearchConfig, type ConfigurationSearchDetail, type ConfigurationSearchItem, type ConfigurationSearchMode, type ConfigurationSearchRequest, type ConfigurationSearchSummary, type SearchValue } from "../../../../shared/schemas/configuration-search.js";
import { configurationSearches, configurationSearchItems } from "../../../shared/db/configuration-search-schema.js";
import { PreparationReferenceError } from "./preparation-reference-service.js";

export class ConfigurationSearchError extends Error {
  constructor(message: string, readonly statusCode = 400) { super(message); this.name = "ConfigurationSearchError"; }
}
export interface ConfigurationSearchSource { catalog: ConfigurationSearchCatalog; request: ConfigurationSearchRequest; runtimeIdentity: string }
export interface ConfigurationSearchAdapter {
  source(ownerId: string, sourceJobId: string): ConfigurationSearchSource;
  sample(source: ConfigurationSearchSource, config: ConfigurationSearchConfig): Array<{ request: ConfigurationSearchRequest; values: Record<string, SearchValue> }>;
  runtimeIdentity(request: ConfigurationSearchRequest): string;
  prepare?(request: ConfigurationSearchRequest, existingPreparationJobId: string | null): { preparationJobId: string | null; ready: boolean };
  releasePreparation?(id: string): void;
  buildSubmission(ownerId: string, request: ConfigurationSearchRequest, preparationJobId: string | null): Promise<(() => string | null) | null>;
  afterSubmit?(ownerId: string, jobId: string, request: ConfigurationSearchRequest): void;
  job(ownerId: string, jobId: string): { status: string; error: string | null; metrics: ConfigurationSearchItem["metrics"] } | null;
  cancelJob(ownerId: string, jobId: string): void;
  deleteJob(ownerId: string, jobId: string): void;
}
export interface ConfigurationSearchDependencies {
  database: DatabaseHandle; clock: Clock;
  adapters: Record<ConfigurationSearchMode, ConfigurationSearchAdapter>;
  onFinished: (summary: ConfigurationSearchSummary) => void;
  collectPreparations: () => void;
}
type SearchRow = typeof configurationSearches.$inferSelect;
type ItemRow = typeof configurationSearchItems.$inferSelect;
const terminal = (status: string) => ["COMPLETED", "FAILED", "CANCELLED"].includes(status);
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, v]) => `${JSON.stringify(key)}:${canonical(v)}`).join(",")}}`;
  return JSON.stringify(value);
}
const href = (mode: ConfigurationSearchMode, id: string) => mode === "daily" ? `/backtests/${encodeURIComponent(id)}` : `/backtests/intraday/${encodeURIComponent(id)}`;

export class ConfigurationSearchService {
  private activePump: Promise<void> | null = null;
  private stopped = false;
  constructor(private readonly deps: ConfigurationSearchDependencies) {}
  private get db() { return this.deps.database.db; }
  private row(ownerId: string, id: string): SearchRow {
    const row = this.db.select().from(configurationSearches).where(and(eq(configurationSearches.id, id), eq(configurationSearches.ownerId, ownerId))).get();
    if (!row) throw new ConfigurationSearchError("탐색 실험을 찾을 수 없습니다.", 404);
    return row;
  }
  private items(id: string): ItemRow[] { return this.db.select().from(configurationSearchItems).where(eq(configurationSearchItems.searchId, id)).orderBy(asc(configurationSearchItems.ordinal)).all(); }
  catalog(ownerId: string, mode: ConfigurationSearchMode, sourceJobId: string): ConfigurationSearchCatalog { return this.deps.adapters[mode].source(ownerId, sourceJobId).catalog; }
  preview(ownerId: string, mode: ConfigurationSearchMode, sourceJobId: string, input: unknown): ConfigurationSearchDetail {
    const parsed = configurationSearchPreviewSchema.safeParse(input);
    if (!parsed.success) throw new ConfigurationSearchError(parsed.error.issues[0]?.message ?? "탐색 설정이 올바르지 않습니다.");
    const { requestId, config } = parsed.data;
    const existing = this.db.select().from(configurationSearches).where(and(eq(configurationSearches.ownerId, ownerId), eq(configurationSearches.requestId, requestId))).get();
    if (existing) {
      if (existing.mode !== mode || existing.sourceJobId !== sourceJobId || canonical(JSON.parse(existing.configJson)) !== canonical(config)) throw new ConfigurationSearchError("이미 다른 설정에 사용한 요청 번호입니다.", 409);
      return this.get(ownerId, existing.id);
    }
    const adapter = this.deps.adapters[mode];
    const source = adapter.source(ownerId, sourceJobId);
    let samples: ReturnType<ConfigurationSearchAdapter["sample"]>;
    try { samples = adapter.sample(source, config); }
    catch (error) { throw new ConfigurationSearchError(error instanceof Error ? error.message : String(error), 422); }
    if (samples.length !== config.count) throw new ConfigurationSearchError("요청한 개수의 조합을 생성하지 못했습니다.");
    const id = newId("csearch");
    this.deps.database.sqlite.transaction(() => {
      const previews = this.db.select({ id: configurationSearches.id }).from(configurationSearches).where(and(eq(configurationSearches.ownerId, ownerId), eq(configurationSearches.status, "PREVIEW"))).limit(100).all();
      if (previews.length >= 100) throw new ConfigurationSearchError("저장된 미리보기가 100개입니다. 사용하지 않는 미리보기를 삭제하세요.", 409);
      this.db.insert(configurationSearches).values({ id, ownerId, requestId, mode, sourceJobId, configJson: canonical(config), catalogJson: JSON.stringify(source.catalog), runtimeIdentity: source.runtimeIdentity, status: "PREVIEW", createdAtMs: this.deps.clock.now() }).run();
      this.db.insert(configurationSearchItems).values(samples.map((sample, ordinal) => ({ id: newId("csitem"), searchId: id, ordinal, requestJson: JSON.stringify(sample.request), valuesJson: JSON.stringify(sample.values), status: "PENDING" as const }))).run();
    }).immediate();
    return this.get(ownerId, id);
  }
  start(ownerId: string, id: string): ConfigurationSearchDetail {
    const row = this.row(ownerId, id);
    if (row.status === "PREVIEW") {
      const first = this.items(id)[0];
      if (!first || this.deps.adapters[row.mode].runtimeIdentity(JSON.parse(first.requestJson)) !== row.runtimeIdentity) throw new ConfigurationSearchError("실행 기준이 변경되었습니다. 미리보기를 다시 만드세요.", 409);
      this.deps.database.sqlite.transaction(() => {
        const current = this.row(ownerId, id);
        if (current.status !== "PREVIEW") return;
        const active = this.db.select({ id: configurationSearches.id }).from(configurationSearches).where(inArray(configurationSearches.status, ["ACTIVE", "CANCELLING"])).limit(5).all();
        if (active.length >= 5) throw new ConfigurationSearchError("동시에 실행할 수 있는 탐색 실험은 5개입니다.", 409);
        this.db.update(configurationSearches).set({ status: "ACTIVE" }).where(and(eq(configurationSearches.id, id), eq(configurationSearches.status, "PREVIEW"))).run();
      }).immediate();
    }
    return this.get(ownerId, id);
  }
  list(ownerId: string, mode: ConfigurationSearchMode, sourceJobId: string): ConfigurationSearchSummary[] {
    return this.db.select().from(configurationSearches).where(and(eq(configurationSearches.ownerId, ownerId), eq(configurationSearches.mode, mode), eq(configurationSearches.sourceJobId, sourceJobId))).all().map(row => this.summary(row, this.items(row.id)));
  }
  get(ownerId: string, id: string): ConfigurationSearchDetail {
    const row = this.row(ownerId, id); const items = this.items(id); const adapter = this.deps.adapters[row.mode];
    return { ...this.summary(row, items), catalog: JSON.parse(row.catalogJson), items: items.map(item => {
      const job = item.jobId ? adapter.job(ownerId, item.jobId) : null;
      return { id: item.id, ordinal: item.ordinal, status: item.status, values: JSON.parse(item.valuesJson), request: JSON.parse(item.requestJson), jobId: item.jobId, resultHref: item.jobId ? href(row.mode, item.jobId) : null, error: item.error, metrics: job?.metrics ?? null };
    }) };
  }
  private summary(row: SearchRow, items: ItemRow[]): ConfigurationSearchSummary {
    const catalog = JSON.parse(row.catalogJson) as ConfigurationSearchCatalog;
    return { id: row.id, sourceJobId: row.sourceJobId, mode: row.mode, strategyId: catalog.strategyId, strategyName: catalog.strategyName, period: catalog.period, config: JSON.parse(row.configJson), status: row.status, totalCount: items.length, completedCount: items.filter(i => i.status === "COMPLETED").length, failedCount: items.filter(i => i.status === "FAILED").length, pendingCount: items.filter(i => i.status === "PENDING" || i.status === "PREPARING").length, runningCount: items.filter(i => i.status === "QUEUED" || i.status === "RUNNING").length, createdAtMs: row.createdAtMs, completedAtMs: row.completedAtMs, error: row.error, sourceHref: href(row.mode, row.sourceJobId) };
  }
  cancel(ownerId: string, id: string): ConfigurationSearchDetail {
    const row = this.row(ownerId, id);
    if (row.status !== "ACTIVE" && row.status !== "PREVIEW") return this.get(ownerId, id);
    const releases = this.items(id).filter(item => !item.jobId && !terminal(item.status) && item.preparationJobId).map(item => item.preparationJobId!);
    this.deps.database.sqlite.transaction(() => {
      this.db.update(configurationSearches).set({ status: "CANCELLING" }).where(eq(configurationSearches.id, id)).run();
      for (const item of this.items(id)) if (!item.jobId && !terminal(item.status)) this.db.update(configurationSearchItems).set({ status: "CANCELLED", preparationJobId: null }).where(eq(configurationSearchItems.id, item.id)).run();
    }).immediate();
    for (const preparationId of releases) this.deps.adapters[row.mode].releasePreparation?.(preparationId);
    for (const item of this.items(id)) if (item.jobId && !terminal(item.status)) this.deps.adapters[row.mode].cancelJob(ownerId, item.jobId);
    this.finishIfReady(this.row(ownerId, id)); this.deps.collectPreparations();
    return this.get(ownerId, id);
  }
  delete(ownerId: string, id: string): void {
    const row = this.row(ownerId, id); const items = this.items(id);
    if (!(row.status === "PREVIEW" || terminal(row.status)) || items.some(item => item.jobId && !terminal(item.status))) throw new ConfigurationSearchError("실행 중인 실험은 삭제할 수 없습니다.", 409);
    this.deps.database.sqlite.transaction(() => {
      this.db.update(configurationSearchItems).set({ jobId: null, preparationJobId: null }).where(eq(configurationSearchItems.searchId, id)).run();
      for (const item of items) if (item.jobId) this.deps.adapters[row.mode].deleteJob(ownerId, item.jobId);
      this.db.delete(configurationSearches).where(eq(configurationSearches.id, id)).run();
    }).immediate();
    this.deps.collectPreparations();
  }
  async stop(): Promise<void> { this.stopped = true; await this.activePump; }
  pump(): Promise<void> {
    if (this.activePump) return this.activePump;
    if (this.stopped) return Promise.resolve();
    const work = this.pumpOnce();
    this.activePump = work.finally(() => { this.activePump = null; });
    return this.activePump;
  }
  private async pumpOnce(): Promise<void> {
    const active = this.db.select().from(configurationSearches).where(inArray(configurationSearches.status, ["ACTIVE", "CANCELLING"])).orderBy(asc(configurationSearches.createdAtMs), asc(configurationSearches.id)).limit(100).all();
    for (const row of active) {
      if (this.stopped) return;
      await this.process(row);
    }
    if (this.stopped) return;
    const notifications = this.db.select().from(configurationSearches).where(and(inArray(configurationSearches.status, ["COMPLETED", "FAILED", "CANCELLED"]), isNull(configurationSearches.notifiedAtMs))).orderBy(asc(configurationSearches.createdAtMs), asc(configurationSearches.id)).limit(100).all();
    let failure: unknown;
    for (const row of notifications) {
      if (this.stopped) break;
      try { this.notify(row); } catch (error) { failure ??= error; }
    }
    if (failure !== undefined) throw failure;
  }
  private async process(row: SearchRow): Promise<void> {
    const adapter = this.deps.adapters[row.mode];
    for (const item of this.items(row.id)) {
      if (!item.jobId || terminal(item.status)) continue;
      // 취소 의도 저장 직후 서버가 종료되어도 다음 부팅에서 자식 취소를 다시 전달한다.
      if (row.status === "CANCELLING") adapter.cancelJob(row.ownerId, item.jobId);
      const job = adapter.job(row.ownerId, item.jobId);
      if (row.status === "ACTIVE" && job?.status === "QUEUED") adapter.afterSubmit?.(row.ownerId, item.jobId, JSON.parse(item.requestJson));
      let status: ItemRow["status"] = "RUNNING";
      if (!job || job.status === "INTERRUPTED") status = "FAILED";
      else if (job.status === "QUEUED") status = "QUEUED";
      else if (terminal(job.status)) status = job.status as ItemRow["status"];
      this.db.update(configurationSearchItems).set({ status, error: status === "FAILED" ? job?.error ?? "작업을 찾을 수 없거나 중단되었습니다." : null }).where(eq(configurationSearchItems.id, item.id)).run();
    }
    let current = this.row(row.ownerId, row.id);
    if (current.status === "ACTIVE") {
      const first = this.items(row.id)[0];
      if (first && adapter.runtimeIdentity(JSON.parse(first.requestJson)) !== row.runtimeIdentity) {
        this.db.update(configurationSearches).set({ status: "CANCELLING", error: "실행 기준이 변경되었습니다." }).where(eq(configurationSearches.id, row.id)).run();
        for (const item of this.items(row.id)) {
          if (item.jobId && !terminal(item.status)) adapter.cancelJob(row.ownerId, item.jobId);
          else if (!terminal(item.status)) {
            this.db.update(configurationSearchItems).set({ status: "FAILED", error: "실행 기준이 변경되었습니다.", preparationJobId: null }).where(eq(configurationSearchItems.id, item.id)).run();
            if (item.preparationJobId) adapter.releasePreparation?.(item.preparationJobId);
          }
        }
        this.deps.collectPreparations();
        current = this.row(row.ownerId, row.id);
      }
    }
    if (current.status === "ACTIVE") {
      const item = this.items(row.id).find(i => !i.jobId && (i.status === "PENDING" || i.status === "PREPARING"));
      if (item) await this.promote(current, item);
    }
    const latest = this.db.select().from(configurationSearches).where(eq(configurationSearches.id, row.id)).get();
    if (!this.stopped && latest) this.finishIfReady(latest);
  }
  private async promote(row: SearchRow, item: ItemRow): Promise<void> {
    const adapter = this.deps.adapters[row.mode]; const request = JSON.parse(item.requestJson) as ConfigurationSearchRequest;
    try {
      const prep = adapter.prepare?.(request, item.preparationJobId) ?? { preparationJobId: null, ready: true };
      this.db.update(configurationSearchItems).set({ status: prep.ready ? "PENDING" : "PREPARING", preparationJobId: prep.preparationJobId }).where(eq(configurationSearchItems.id, item.id)).run();
      if (item.preparationJobId && item.preparationJobId !== prep.preparationJobId) adapter.releasePreparation?.(item.preparationJobId);
      if (!prep.ready || this.stopped) return;
      const submit = await adapter.buildSubmission(row.ownerId, request, prep.preparationJobId);
      if (!submit || this.stopped) return;
      let submittedJobId: string | null = null;
      this.deps.database.sqlite.transaction(() => {
        const current = this.row(row.ownerId, row.id);
        const fresh = this.items(row.id).find(i => i.id === item.id);
        if (current.status !== "ACTIVE" || !fresh || fresh.jobId || terminal(fresh.status)) return;
        if (adapter.runtimeIdentity(request) !== current.runtimeIdentity) return;
        const jobId = submit();
        if (jobId) {
          this.db.update(configurationSearchItems).set({ status: "QUEUED", jobId, preparationJobId: null }).where(eq(configurationSearchItems.id, item.id)).run();
          submittedJobId = jobId;
        }
      }).immediate();
      if (submittedJobId) {
        adapter.afterSubmit?.(row.ownerId, submittedJobId, request);
        if (prep.preparationJobId) this.deps.collectPreparations();
      }
    } catch (error) {
      if (this.stopped) return;
      const current = this.db.select().from(configurationSearches).where(eq(configurationSearches.id, row.id)).get();
      const fresh = this.items(row.id).find(i => i.id === item.id);
      if (fresh?.jobId) throw error;
      if (!current || current.status !== "ACTIVE" || !fresh || terminal(fresh.status)) return;
      this.db.update(configurationSearchItems).set(error instanceof PreparationReferenceError ? { status: "PENDING", preparationJobId: null } : { status: "FAILED", preparationJobId: null, error: error instanceof Error ? error.message : String(error) }).where(eq(configurationSearchItems.id, item.id)).run();
      if (fresh.preparationJobId) adapter.releasePreparation?.(fresh.preparationJobId);
      this.deps.collectPreparations();
    }
  }
  private finishIfReady(row: SearchRow): void {
    if (row.status !== "ACTIVE" && row.status !== "CANCELLING") return;
    const items = this.items(row.id);
    if (!items.every(i => terminal(i.status))) return;
    const status = row.status === "CANCELLING" ? (row.error ? "FAILED" : "CANCELLED") : items.every(i => i.status === "COMPLETED") ? "COMPLETED" : "FAILED";
    this.db.update(configurationSearches).set({ status, completedAtMs: this.deps.clock.now() }).where(eq(configurationSearches.id, row.id)).run();
  }
  private notify(row: SearchRow): void {
    this.deps.database.sqlite.transaction(() => {
      const current = this.row(row.ownerId, row.id);
      if (current.notifiedAtMs !== null || !terminal(current.status)) return;
      this.deps.onFinished(this.summary(current, this.items(row.id)));
      this.db.update(configurationSearches).set({ notifiedAtMs: this.deps.clock.now() }).where(eq(configurationSearches.id, row.id)).run();
    }).immediate();
  }
}
