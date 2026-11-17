import { createHash, randomBytes } from "node:crypto";
import type { DatabaseHandle } from "../../../../runtime/shared/db/database.js";
import { newId } from "../../../../runtime/shared/ids.js";
import type { AgentRegistration } from "../../../../shared/agent-status.js";

export function agentTokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export class AgentRegistry {
  constructor(private readonly database: DatabaseHandle) {}

  issue(name: string): { id: string; name: string; token: string } {
    const id = newId("agent");
    const token = randomBytes(48).toString("base64url");
    this.database.sqlite
      .prepare(
        "INSERT INTO agent_clients (id, name, token_hash, created_at_ms) VALUES (?, ?, ?, ?)",
      )
      .run(id, name, agentTokenHash(token), Date.now());
    return { id, name, token };
  }

  authenticate(token: string): string | null {
    const row = this.database.sqlite
      .prepare(
        "SELECT id FROM agent_clients WHERE token_hash = ? AND revoked_at_ms IS NULL",
      )
      .get(agentTokenHash(token)) as { id: string } | undefined;
    return row?.id ?? null;
  }

  active(id: string): boolean {
    return (
      this.database.sqlite
        .prepare(
          "SELECT 1 FROM agent_clients WHERE id = ? AND revoked_at_ms IS NULL",
        )
        .get(id) !== undefined
    );
  }

  touch(id: string): void {
    this.database.sqlite
      .prepare("UPDATE agent_clients SET last_seen_at_ms = ? WHERE id = ?")
      .run(Date.now(), id);
  }

  recordHello(id: string, runnerVersion: string, protocolVersion: number): void {
    this.database.sqlite.prepare(
      "UPDATE agent_clients SET runner_version = ?, protocol_version = ?, last_seen_at_ms = ? WHERE id = ?",
    ).run(runnerVersion, protocolVersion, Date.now(), id);
  }

  revoke(id: string): boolean {
    return (
      this.database.sqlite
        .prepare("UPDATE agent_clients SET revoked_at_ms = ? WHERE id = ?")
        .run(Date.now(), id).changes > 0
    );
  }

  list(): AgentRegistration[] {
    return this.database.sqlite
      .prepare(
        "SELECT id, name, created_at_ms AS createdAtMs, last_seen_at_ms AS lastSeenAtMs, revoked_at_ms AS revokedAtMs, runner_version AS runnerVersion, protocol_version AS protocolVersion FROM agent_clients ORDER BY created_at_ms DESC",
      )
      .all() as AgentRegistration[];
  }
}
