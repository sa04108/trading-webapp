import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import type { DatabaseHandle } from "../../../../runtime/shared/db/database.js";
import {
  AGENT_LEASE_MS,
  AGENT_MAX_ATTEMPTS,
  type AgentLease,
  type AgentMessage,
  type DatasetManifest,
} from "../../../../shared/agent-protocol.js";
import { PreparationPreviewCache } from "../../../../runtime/modules/backtest/application/preparation-preview-cache.js";
import { agentTokenHash } from "./agent-registry.js";

interface LeaseRow {
  job_id: string;
  client_id: string;
  attempt: number;
  lease_token_hash: string | null;
  lease_expires_at_ms: number | null;
  dataset_version: number;
  failures: number;
  result_hash: string | null;
  status: string;
  cancel_requested: number;
}
type Identity = Pick<AgentLease, "jobId" | "attempt" | "leaseToken">;
const resultSchema = z.object({
  dataRevision: z.number().int().nonnegative(),
  fundamentalSymbols: z.array(z.string()).max(10000),
  preview: z
    .object({
      schedule: z
        .array(
          z
            .object({
              rebalanceDate: z.string(),
              effectiveDate: z.string(),
              members: z.array(
                z
                  .object({ symbol: z.string(), standardCode: z.string() })
                  .passthrough(),
              ),
              excludedNonTradingCount: z.number().int().nonnegative(),
            })
            .passthrough(),
        )
        .min(1)
        .max(5000),
      scheduleHash: z.string().length(64),
      unionSymbols: z.array(z.string()).min(1).max(10000),
      diagnostics: z.array(z.unknown()),
      stages: z.array(z.unknown()),
      uncoveredDates: z.array(z.string()),
      periodCovered: z.boolean(),
      missingCandleSymbols: z.array(z.string()),
      warnings: z.array(z.string()),
    })
    .passthrough(),
});

export class AgentPreparationQueue {
  constructor(
    private readonly database: DatabaseHandle,
    private readonly changed: (jobId: string) => void,
  ) {}

  notify(jobId: string): void {
    this.changed(jobId);
  }

  notifyQueued(): void {
    const rows = this.database.sqlite
      .prepare(
        "SELECT id FROM backtest_preparation_jobs WHERE status IN ('QUEUED', 'WAITING_DATA')",
      )
      .all() as Array<{ id: string }>;
    for (const row of rows) this.changed(row.id);
  }

  claim(clientId: string, dataset: DatasetManifest): AgentLease | null {
    const lease = this.database.sqlite
      .transaction(() => {
        const job = this.database.sqlite
          .prepare(
            "SELECT id, request_hash AS requestHash, request_json AS requestJson FROM backtest_preparation_jobs WHERE status = 'QUEUED' AND cancel_requested = 0 ORDER BY created_at_ms LIMIT 1",
          )
          .get() as
          { id: string; requestHash: string; requestJson: string } | undefined;
        if (!job) return null;
        const token = randomBytes(32).toString("base64url");
        const expires = Date.now() + AGENT_LEASE_MS;
        const row = this.database.sqlite
          .prepare(
            `INSERT INTO agent_preparation_leases (job_id, client_id, attempt, lease_token_hash, lease_expires_at_ms, dataset_version)
        VALUES (?, ?, 1, ?, ?, ?) ON CONFLICT(job_id) DO UPDATE SET client_id = excluded.client_id,
        attempt = attempt + 1, lease_token_hash = excluded.lease_token_hash, lease_expires_at_ms = excluded.lease_expires_at_ms,
        dataset_version = excluded.dataset_version, result_hash = NULL RETURNING attempt`,
          )
          .get(
            job.id,
            clientId,
            agentTokenHash(token),
            expires,
            dataset.version,
          ) as { attempt: number };
        this.database.sqlite
          .prepare(
            "UPDATE backtest_preparation_jobs SET status = 'RUNNING', error = NULL, updated_at_ms = ? WHERE id = ?",
          )
          .run(Date.now(), job.id);
        return {
          kind: "PREPARATION" as const,
          jobId: job.id,
          attempt: row.attempt,
          leaseToken: token,
          leaseExpiresAtMs: expires,
          dataset,
          payload: {
            requestHash: job.requestHash,
            requestJson: job.requestJson,
          },
        };
      })
      .immediate();
    if (lease) this.changed(lease.jobId);
    return lease;
  }

  private row(jobId: string): LeaseRow | undefined {
    return this.database.sqlite
      .prepare(
        `SELECT l.*, j.status, j.cancel_requested FROM agent_preparation_leases l JOIN backtest_preparation_jobs j ON j.id = l.job_id WHERE l.job_id = ?`,
      )
      .get(jobId) as LeaseRow | undefined;
  }

  owns(clientId: string, identity: Identity, allowCompleted = false): boolean {
    const row = this.row(identity.jobId);
    return (
      !!row &&
      row.client_id === clientId &&
      row.attempt === identity.attempt &&
      row.lease_token_hash === agentTokenHash(identity.leaseToken) &&
      ((row.status === "RUNNING" &&
        (row.lease_expires_at_ms ?? 0) >= Date.now()) ||
        (allowCompleted && row.status === "COMPLETED"))
    );
  }

  heartbeat(
    clientId: string,
    identity: Identity,
    progress?: Extract<
      AgentMessage,
      { type: "HEARTBEAT" }
    >["preparationProgress"],
  ): {
    accepted: boolean;
    cancelRequested: boolean;
    leaseExpiresAtMs?: number;
  } {
    if (!this.owns(clientId, identity))
      return { accepted: false, cancelRequested: false };
    const nowMs = Date.now();
    if (progress) {
      const current = this.database.sqlite
        .prepare(
          "SELECT phase, overall_progress, done_symbols, total_symbols, saved_facts, gap_count, resolution_pass FROM backtest_preparation_jobs WHERE id = ?",
        )
        .get(identity.jobId) as {
          phase: string;
          overall_progress: number;
          done_symbols: number;
          total_symbols: number;
          saved_facts: number;
          gap_count: number;
          resolution_pass: number;
        } | undefined;
      const overallProgress = Math.max(
        current?.overall_progress ?? 0,
        progress.overallProgress,
      );
      const changed =
        !current ||
        current.phase !== progress.phase ||
        current.overall_progress !== overallProgress ||
        current.done_symbols !== progress.doneSymbols ||
        current.total_symbols !== progress.totalSymbols ||
        current.saved_facts !== progress.savedFacts ||
        current.gap_count !== progress.gapCount ||
        current.resolution_pass !== progress.resolutionPass;
      if (changed) {
        this.database.sqlite
          .prepare(
            "UPDATE backtest_preparation_jobs SET phase = ?, overall_progress = ?, done_symbols = ?, total_symbols = ?, saved_facts = ?, gap_count = ?, resolution_pass = ?, updated_at_ms = ? WHERE id = ?",
          )
          .run(
            progress.phase,
            overallProgress,
            progress.doneSymbols,
            progress.totalSymbols,
            progress.savedFacts,
            progress.gapCount,
            progress.resolutionPass,
            nowMs,
            identity.jobId,
          );
      }
    }
    const expires = nowMs + AGENT_LEASE_MS;
    this.database.sqlite
      .prepare(
        "UPDATE agent_preparation_leases SET lease_expires_at_ms = ?, last_received_at_ms = ? WHERE job_id = ?",
      )
      .run(expires, nowMs, identity.jobId);
    this.changed(identity.jobId);
    return {
      accepted: true,
      cancelRequested: this.row(identity.jobId)?.cancel_requested === 1,
      leaseExpiresAtMs: expires,
    };
  }

  waitForData(
    clientId: string,
    identity: Identity,
    request: () => void,
  ): boolean {
    // 읽기 뒤 쓰기 잠금을 승격하면 동시 결과 import와 충돌할 수 있어 먼저 쓰기 잠금을 잡는다.
    const accepted = this.database.sqlite.transaction(() => {
      if (!this.owns(clientId, identity)) return false;
      request();
      this.database.sqlite
        .prepare(
          "UPDATE backtest_preparation_jobs SET status = 'WAITING_DATA', updated_at_ms = ? WHERE id = ?",
        )
        .run(Date.now(), identity.jobId);
      this.database.sqlite
        .prepare(
          "UPDATE agent_preparation_leases SET lease_token_hash = NULL, lease_expires_at_ms = NULL WHERE job_id = ?",
        )
        .run(identity.jobId);
      return true;
    }).immediate();
    if (accepted) this.changed(identity.jobId);
    return accepted;
  }

  finish(
    clientId: string,
    identity: Identity,
    outcome: "COMPLETED" | "FAILED" | "CANCELLED",
    input: unknown,
    dataset: DatasetManifest | null,
    error?: string,
  ): boolean {
    const row = this.row(identity.jobId);
    if (!this.owns(clientId, identity, true) || !row) return false;
    const hash = createHash("sha256")
      .update(JSON.stringify(input ?? null))
      .digest("hex");
    if (row.status === "COMPLETED")
      return row.result_hash === hash && outcome === "COMPLETED";
    if (row.cancel_requested) outcome = "CANCELLED";
    if (
      outcome === "COMPLETED" &&
      dataset?.sourceRevision !== new PreparationPreviewCache(this.database).revision()
    ) {
      // 실제 계산 입력이나 확인된 변경 상태가 달라진 옛 결과를 최신 검증으로 수락하지 않는다.
      this.database.sqlite.transaction(() => {
        this.database.sqlite
          .prepare(
            "UPDATE backtest_preparation_jobs SET status = 'QUEUED', error = NULL, updated_at_ms = ?, completed_at_ms = NULL WHERE id = ?",
          )
          .run(Date.now(), identity.jobId);
        this.database.sqlite
          .prepare(
            "UPDATE agent_preparation_leases SET lease_token_hash = NULL, lease_expires_at_ms = NULL WHERE job_id = ?",
          )
          .run(identity.jobId);
      })();
      this.changed(identity.jobId);
      return true;
    }
    const result = outcome === "COMPLETED" ? resultSchema.parse(input) : null;
    if (result) result.preview = (input as typeof result).preview;
    if (
      result &&
      (result.dataRevision !== dataset?.sourceRevision ||
        createHash("sha256")
          .update(JSON.stringify(result.preview.schedule))
          .digest("hex") !== result.preview.scheduleHash)
    ) {
      throw new Error("유니버스 결과의 데이터 버전 또는 일정 해시가 다릅니다");
    }
    this.database.sqlite.transaction(() => {
      this.database.sqlite
        .prepare(
          `UPDATE backtest_preparation_jobs SET status = ?, overall_progress = ?, preview_json = ?, error = ?, completed_at_ms = ?, updated_at_ms = ? WHERE id = ?`,
        )
        .run(
          outcome,
          outcome === "COMPLETED" ? 100 : 0,
          result ? JSON.stringify(result.preview) : null,
          outcome === "FAILED" ? (error ?? "계산 실패") : null,
          Date.now(),
          Date.now(),
          identity.jobId,
        );
      this.database.sqlite
        .prepare(
          "UPDATE agent_preparation_leases SET result_hash = ? WHERE job_id = ?",
        )
        .run(hash, identity.jobId);
      if (result)
        new PreparationPreviewCache(this.database).store(
          identity.jobId,
          dataset!.sourceRevision,
          result.fundamentalSymbols,
        );
    })();
    this.changed(identity.jobId);
    return true;
  }

  datasetVersion(jobId: string): number | null {
    return this.row(jobId)?.dataset_version ?? null;
  }

  sweep(): void {
    const rows = this.database.sqlite
      .prepare(
        `SELECT j.id, j.cancel_requested, l.failures FROM backtest_preparation_jobs j
      LEFT JOIN agent_preparation_leases l ON l.job_id = j.id WHERE (j.status = 'RUNNING' AND (l.job_id IS NULL OR l.lease_expires_at_ms < ?))
      OR (j.status IN ('QUEUED', 'WAITING_DATA', 'WAITING_DAILY_QUOTA') AND j.cancel_requested = 1)`,
      )
      .all(Date.now()) as Array<{
      id: string;
      cancel_requested: number;
      failures: number | null;
    }>;
    for (const row of rows) {
      const failures = (row.failures ?? 0) + 1;
      const status = row.cancel_requested
        ? "CANCELLED"
        : failures >= AGENT_MAX_ATTEMPTS
          ? "FAILED"
          : "QUEUED";
      this.database.sqlite.transaction(() => {
        this.database.sqlite
          .prepare(
            "UPDATE agent_preparation_leases SET failures = ?, lease_token_hash = NULL, lease_expires_at_ms = NULL WHERE job_id = ?",
          )
          .run(failures, row.id);
        this.database.sqlite
          .prepare(
            "UPDATE backtest_preparation_jobs SET status = ?, error = ?, updated_at_ms = ?, completed_at_ms = ? WHERE id = ?",
          )
          .run(
            status,
            status === "FAILED"
              ? "에이전트 연결 또는 실행 실패로 재시도 한도에 도달했습니다."
              : null,
            Date.now(),
            status === "QUEUED" ? null : Date.now(),
            row.id,
          );
      })();
      this.changed(row.id);
    }
  }

  resume(jobId: string, error?: string): void {
    this.database.sqlite
      .prepare(
        "UPDATE backtest_preparation_jobs SET status = CASE WHEN cancel_requested = 1 THEN 'CANCELLED' ELSE ? END, error = ?, updated_at_ms = ?, completed_at_ms = CASE WHEN cancel_requested = 1 OR ? = 1 THEN ? ELSE NULL END, next_resume_at_ms = NULL WHERE id = ? AND status = 'WAITING_DATA'",
      )
      .run(
        error ? "FAILED" : "QUEUED",
        error ?? null,
        Date.now(),
        error ? 1 : 0,
        Date.now(),
        jobId,
      );
    this.changed(jobId);
  }
}
