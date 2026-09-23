import { createHash } from "node:crypto";
import { ProviderRequestBlockedError } from "../../../shared/provider-request-policy.js";
import type { DatabaseHandle } from "../../../../runtime/shared/db/database.js";
import type { Logger } from "../../../shared/logger.js";
import { KrxQuotaError } from "../../../../runtime/modules/market-data/application/ports.js";
import {
  agentDataRequestSchema,
  type AgentDataRequest,
  type AgentLease,
} from "../../../../shared/agent-protocol.js";
import type { DatasetSnapshots } from "./dataset-snapshots.js";
import type {
  ExecutionActivity,
  ExecutionProgress,
  ExecutionProgressUnit,
} from "../../../../shared/execution-progress.js";

export interface CollectionProgressReport {
  readonly activity: ExecutionActivity;
  readonly unit: ExecutionProgressUnit;
  readonly completed: number;
  readonly total: number;
  readonly currentItem: string | null;
}

export class AgentCollectionPaused extends Error {
  constructor(
    message: string,
    readonly resumeAtMs: number,
  ) {
    super(message);
  }
}
interface DataRequestRow {
  id: string;
  request_json: string;
  status: string;
  available_version: number | null;
  attempts: number;
  updated_at_ms: number;
  next_attempt_at_ms: number;
  error: string | null;
}

const LEGACY_ACTION_FINANCIAL_WAIT =
  /^PENDING_PUBLICATION: ([0-9A-Z]{6}):FINANCIAL_STATEMENT:(\d{4}):(11011|11012|11013|11014):CFS \(.*\)$/;
const PENDING_PUBLICATION_RECEIPT =
  /^PENDING_PUBLICATION: .+ \(([0-9]{14})\)$/;
const UNRESOLVED_FILING_RECEIPT =
  /^UNRESOLVED_FILING: .+ \(([0-9]{14})\)$/;

/** 이전 ACTIONS 작업이 재무 CFS 대기를 잘못 공유한 경우만 시작 시 다시 평가한다. */
function isLegacyActionFinancialWait(row: Pick<DataRequestRow, "request_json" | "error">): boolean {
  if (row.error === null) return false;
  const match = LEGACY_ACTION_FINANCIAL_WAIT.exec(row.error);
  if (match === null) return false;
  try {
    const request = agentDataRequestSchema.parse(JSON.parse(row.request_json));
    if (request.kind !== "ACTIONS") return false;
    const year = Number(match[2]);
    return request.symbols.includes(match[1]!) &&
      request.fromYear <= year && year <= request.toYear;
  } catch {
    return false;
  }
}

export class AgentDataQueue {
  private running: Promise<void> | null = null;
  private stopped = false;

  constructor(
    private readonly database: DatabaseHandle,
    private readonly snapshots: DatasetSnapshots,
    private readonly collect: (
      request: AgentDataRequest,
      shouldStop: () => boolean,
      report: (progress: CollectionProgressReport) => void,
    ) => Promise<void>,
    private readonly onReady: (
      kind: AgentLease["kind"],
      jobId: string,
      error?: string,
    ) => void,
    private readonly logger: Logger,
    private readonly options?: {
      readonly collectionVersion?: string;
      readonly onProgress?: (kind: AgentLease["kind"], jobId: string) => void;
    },
  ) {}

  /** 공유 수집 요청의 현재 상태를 작업별 행에 복사하지 않고 대기 연결로 조합한다. */
  progressForJob(jobId: string): ExecutionProgress | null {
    const row = this.database.sqlite
      .prepare(
        `SELECT r.*, w.kind FROM agent_data_waits w
         JOIN agent_data_requests r ON r.id = w.request_id
         WHERE w.job_id = ? LIMIT 1`,
      )
      .get(jobId) as
      | (DataRequestRow & {
          activity: ExecutionActivity | null;
          progress_unit: ExecutionProgressUnit | null;
          progress_completed: number | null;
          progress_total: number | null;
          current_item: string | null;
          activity_started_at_ms: number | null;
          last_progress_at_ms: number | null;
        })
      | undefined;
    if (!row) return null;
    const queued = row.status === "QUEUED";
    const waiting = queued && row.next_attempt_at_ms > Date.now();
    return {
      activity: queued ? "WAITING_RETRY" : (row.activity ?? "CHECKING_INPUT"),
      detail: waiting || row.status === "BLOCKED"
        ? row.error
        : queued
          ? "앞선 수집 요청 완료 대기"
          : null,
      actorKind: "SERVER",
      actorId: null,
      actorName: "운영 서버",
      unit: row.progress_unit,
      completed: row.progress_completed,
      total: row.progress_total,
      currentItem: row.current_item,
      attempt: null,
      retryCount: row.attempts,
      startedAtMs: row.activity_started_at_ms ?? row.updated_at_ms,
      lastProgressAtMs: row.last_progress_at_ms,
      lastReceivedAtMs: row.updated_at_ms,
      nextResumeAtMs: waiting ? row.next_attempt_at_ms : null,
    };
  }

  recover(): void {
    this.database.sqlite
      .prepare(
        "UPDATE agent_data_requests SET status = 'QUEUED' WHERE status = 'RUNNING' OR (status = 'BLOCKED' AND substr(error, 1, 20) = 'PENDING_PUBLICATION:')",
      )
      .run();
    const rows = this.database.sqlite
      .prepare(
        "SELECT id, request_json, error FROM agent_data_requests WHERE status IN ('QUEUED', 'BLOCKED') AND error LIKE 'PENDING_PUBLICATION:%:FINANCIAL_STATEMENT:%:CFS (%)'",
      )
      .all() as Array<Pick<DataRequestRow, "id" | "request_json" | "error">>;
    const now = Date.now();
    const repair = this.database.sqlite.prepare(
      `UPDATE agent_data_requests SET status = 'QUEUED', next_attempt_at_ms = 0,
       error = NULL, activity = NULL, activity_started_at_ms = NULL,
       last_progress_at_ms = NULL, current_item = NULL, updated_at_ms = ? WHERE id = ?`,
    );
    for (const row of rows) {
      if (isLegacyActionFinancialWait(row)) repair.run(now, row.id);
    }
    const absent = this.database.sqlite
      .prepare("SELECT receipt_no FROM dart_discovered_filings WHERE status IN ('UNLISTED', 'UNLISTED_PARTIAL')")
      .all() as Array<{ receipt_no: string | null }>;
    this.resumePendingPublicationForAbsentFilings(
      absent.flatMap((row) => row.receipt_no === null ? [] : [row.receipt_no]),
    );
    const reappeared = this.database.sqlite
      .prepare("SELECT receipt_no FROM dart_discovered_filings WHERE status = 'PENDING'")
      .all() as Array<{ receipt_no: string | null }>;
    this.resumeUnresolvedForReappearedFilings(
      reappeared.flatMap((row) => row.receipt_no === null ? [] : [row.receipt_no]),
    );
  }

  /** 완전한 공시 목록에서 사라진 접수의 게시 대기만 즉시 다시 평가한다. */
  resumePendingPublicationForAbsentFilings(receiptNos: readonly string[]): void {
    const absent = new Set(receiptNos.filter((receiptNo) => /^\d{14}$/.test(receiptNo)));
    if (absent.size === 0) return;
    const rows = this.database.sqlite
      .prepare("SELECT id, error FROM agent_data_requests WHERE status = 'QUEUED' AND error LIKE 'PENDING_PUBLICATION:%'")
      .all() as Array<Pick<DataRequestRow, "id" | "error">>;
    const now = Date.now();
    const resume = this.database.sqlite.prepare(
      `UPDATE agent_data_requests SET next_attempt_at_ms = 0, error = NULL,
       activity = NULL, activity_started_at_ms = NULL, last_progress_at_ms = NULL,
       current_item = NULL, updated_at_ms = ?
       WHERE id = ? AND status = 'QUEUED' AND error = ?`,
    );
    for (const row of rows) {
      const match = row.error === null ? null : PENDING_PUBLICATION_RECEIPT.exec(row.error);
      if (match === null || !absent.has(match[1]!)) continue;
      if (resume.run(now, row.id, row.error).changes > 0) this.notifyWaiters(row.id);
    }
  }

  /** 목록에 다시 나타난 접수의 무결성 차단만 재평가한다. */
  resumeUnresolvedForReappearedFilings(receiptNos: readonly string[]): void {
    const appeared = new Set(receiptNos.filter((receiptNo) => /^\d{14}$/.test(receiptNo)));
    if (appeared.size === 0) return;
    const rows = this.database.sqlite
      .prepare("SELECT id, error FROM agent_data_requests WHERE status = 'BLOCKED' AND error LIKE 'UNRESOLVED_FILING:%'")
      .all() as Array<Pick<DataRequestRow, "id" | "error">>;
    const now = Date.now();
    const resume = this.database.sqlite.prepare(
      `UPDATE agent_data_requests SET status = 'QUEUED', next_attempt_at_ms = 0, error = NULL,
       activity = NULL, activity_started_at_ms = NULL, last_progress_at_ms = NULL,
       current_item = NULL, updated_at_ms = ?
       WHERE id = ? AND status = 'BLOCKED' AND error = ?`,
    );
    for (const row of rows) {
      const match = row.error === null ? null : UNRESOLVED_FILING_RECEIPT.exec(row.error);
      if (match === null || !appeared.has(match[1]!)) continue;
      if (resume.run(now, row.id, row.error).changes > 0) this.notifyWaiters(row.id);
    }
  }

  /** 같은 데이터 요구는 여러 작업이 공유하고, 데이터 대기는 계산 재시도에 포함하지 않는다. */
  request(
    kind: AgentLease["kind"],
    jobId: string,
    requestedVersion: number,
    input: AgentDataRequest,
  ): void {
    const request = agentDataRequestSchema.parse(input);
    if ("dates" in request) request.dates = [...new Set(request.dates)].sort();
    else if (request.kind === "REGISTER")
      request.symbols.sort((a, b) => a.symbol.localeCompare(b.symbol));
    else {
      if (
        request.fromYear > request.toYear ||
        request.toYear - request.fromYear > 50
      )
        throw new Error("데이터 요청 연도 범위가 올바르지 않습니다");
      request.symbols = [...new Set(request.symbols)].sort();
    }
    const json = JSON.stringify(request);
    // 실행 코드 버전과 무관한 원천 범위를 중복 제거 키로 사용한다.
    const id = createHash("sha256")
      .update(json)
      .digest("hex");
    const now = Date.now();
    const previous = this.database.sqlite
      .prepare("SELECT * FROM agent_data_requests WHERE id = ?")
      .get(id) as DataRequestRow | undefined;
    if (
      previous?.status === "COMPLETED" &&
      previous.available_version === requestedVersion
    ) {
      throw new Error(
        "서버가 수집을 완료한 데이터로도 같은 결손이 남았습니다. 공급자 응답과 데이터 범위를 확인하세요.",
      );
    }
    this.database.sqlite
      .prepare(
        `INSERT INTO agent_data_requests (id, request_json, status, created_at_ms, updated_at_ms)
      VALUES (?, ?, 'QUEUED', ?, ?) ON CONFLICT(id) DO UPDATE SET
      status = CASE WHEN status IN ('COMPLETED', 'FAILED') AND COALESCE(available_version, 0) <= ? THEN 'QUEUED' ELSE status END,
      attempts = CASE WHEN status IN ('COMPLETED', 'FAILED') THEN 0 ELSE attempts END`,
      )
      .run(id, json, now, now, requestedVersion);
    this.database.sqlite
      .prepare(
        `INSERT INTO agent_data_waits (kind, job_id, request_id, requested_version)
      VALUES (?, ?, ?, ?) ON CONFLICT(kind, job_id) DO UPDATE SET request_id = excluded.request_id, requested_version = excluded.requested_version`,
      )
      .run(kind, jobId, id, requestedVersion);
  }

  tick(): void {
    if (this.stopped || this.running) return;
    this.running = this.runNext()
      .catch((error: unknown) => {
        this.logger.error({ err: error }, "에이전트 데이터 수집 큐 처리 실패");
      })
      .finally(() => {
        this.running = null;
      });
  }

  private async runNext(): Promise<void> {
    this.resumeReady();
    const row = this.database.sqlite
      .prepare(
        `SELECT * FROM agent_data_requests WHERE status = 'QUEUED' AND next_attempt_at_ms <= ? ORDER BY created_at_ms LIMIT 1`,
      )
      .get(Date.now()) as DataRequestRow | undefined;
    if (!row) return;
    this.database.sqlite
      .prepare(
        "UPDATE agent_data_requests SET status = 'RUNNING', activity = 'CHECKING_INPUT', activity_started_at_ms = ?, last_progress_at_ms = NULL, error = NULL, updated_at_ms = ? WHERE id = ?",
      )
      .run(Date.now(), Date.now(), row.id);
    this.notifyWaiters(row.id);
    let lastSavedAt = 0;
    try {
      await this.collect(
        agentDataRequestSchema.parse(JSON.parse(row.request_json)),
        () => this.stopped,
        (progress) => {
          const now = Date.now();
          if (now - lastSavedAt < 1000 && progress.completed < progress.total)
            return;
          lastSavedAt = now;
          this.database.sqlite
            .prepare(
              `UPDATE agent_data_requests SET activity = ?, progress_unit = ?,
               progress_completed = ?, progress_total = ?, current_item = ?,
               activity_started_at_ms = CASE WHEN activity = ? THEN activity_started_at_ms ELSE ? END,
               last_progress_at_ms = ?, updated_at_ms = ? WHERE id = ?`,
            )
            .run(
              progress.activity,
              progress.unit,
              progress.completed,
              progress.total,
              progress.currentItem,
              progress.activity,
              now,
              now,
              now,
              row.id,
            );
          this.notifyWaiters(row.id);
        },
      );
      if (this.stopped) return;
      this.database.sqlite
        .prepare(
          "UPDATE agent_data_requests SET activity = 'PUBLISHING_COPY', activity_started_at_ms = ?, current_item = NULL, updated_at_ms = ? WHERE id = ?",
        )
        .run(Date.now(), Date.now(), row.id);
      this.notifyWaiters(row.id);
      const manifest = await this.snapshots.ensureLatest();
      this.database.sqlite
        .prepare(
          "UPDATE agent_data_requests SET status = 'COMPLETED', available_version = ?, error = NULL, updated_at_ms = ? WHERE id = ?",
        )
        .run(manifest.version, Date.now(), row.id);
      this.notifyWaiters(row.id);
    } catch (error) {
      if (this.stopped) return;
      const blocked = error instanceof ProviderRequestBlockedError;
      const scheduledRetry = blocked && ["PENDING_PUBLICATION", "RETRY_BACKOFF"].includes(error.reason);
      const quota =
        error instanceof AgentCollectionPaused ||
        error instanceof KrxQuotaError;
      const attempts = row.attempts + (quota || blocked ? 0 : 1);
      const nextMidnight =
        Math.floor((Date.now() + 9 * 3600_000) / 86400_000 + 1) * 86400_000 -
        9 * 3600_000;
      const next =
        scheduledRetry
          ? error.retryAfterMs ?? Date.now() + 86_400_000
          : error instanceof AgentCollectionPaused
          ? error.resumeAtMs
          : quota
            ? nextMidnight
            : Date.now() + 5000 * 2 ** attempts;
      this.database.sqlite
        .prepare(
          "UPDATE agent_data_requests SET status = ?, attempts = ?, next_attempt_at_ms = ?, error = ?, updated_at_ms = ? WHERE id = ?",
        )
        .run(
          scheduledRetry ? "QUEUED" : blocked ? "BLOCKED" : attempts >= 3 ? "FAILED" : "QUEUED",
          attempts,
          next,
          error instanceof Error ? error.message : String(error),
          Date.now(),
          row.id,
        );
      this.database.sqlite
        .prepare(
          "UPDATE agent_data_requests SET activity = ?, activity_started_at_ms = ?, updated_at_ms = ? WHERE id = ?",
        )
        .run(blocked && !scheduledRetry ? "BLOCKED" : "WAITING_RETRY", Date.now(), Date.now(), row.id);
      if (blocked && error.reason === "PENDING_PUBLICATION" && /^\d{14}$/.test(error.evidence)) {
        const absent = this.database.sqlite.prepare(`SELECT 1 FROM dart_discovered_filings
          WHERE receipt_no = ? AND status IN ('UNLISTED', 'UNLISTED_PARTIAL') LIMIT 1`).get(error.evidence);
        if (absent) this.resumePendingPublicationForAbsentFilings([error.evidence]);
      }
      this.notifyWaiters(row.id);
    }
    this.resumeReady();
  }

  private notifyWaiters(requestId: string): void {
    const rows = this.database.sqlite
      .prepare("SELECT kind, job_id FROM agent_data_waits WHERE request_id = ?")
      .all(requestId) as Array<{ kind: AgentLease["kind"]; job_id: string }>;
    for (const row of rows) this.options?.onProgress?.(row.kind, row.job_id);
  }

  private resumeReady(): void {
    const rows = this.database.sqlite
      .prepare(
        `SELECT w.kind, w.job_id, r.status, r.error FROM agent_data_waits w
      JOIN agent_data_requests r ON r.id = w.request_id WHERE r.status IN ('COMPLETED', 'FAILED')`,
      )
      .all() as Array<{
      kind: AgentLease["kind"];
      job_id: string;
      status: string;
      error: string | null;
    }>;
    for (const row of rows) {
      this.database.sqlite.transaction(() => {
        this.onReady(
          row.kind,
          row.job_id,
          row.status === "FAILED"
            ? (row.error ?? "데이터 수집 실패")
            : undefined,
        );
        this.database.sqlite
          .prepare("DELETE FROM agent_data_waits WHERE kind = ? AND job_id = ?")
          .run(row.kind, row.job_id);
      })();
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.running;
  }
}
