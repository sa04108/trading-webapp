import { createHash, randomBytes } from "node:crypto";
import type { DatabaseHandle } from "../../../../runtime/shared/db/database.js";
import { newId } from "../../../../runtime/shared/ids.js";
import type { AgentRegistration } from "../../../../shared/agent-status.js";

export function agentTokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export interface AgentInstallationTarget {
  id: string;
  name: string;
  tokenHash: string;
  revokedAtMs: number | null;
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

  installationTarget(id: string): AgentInstallationTarget | null {
    return this.database.sqlite.prepare(
      "SELECT id, name, token_hash AS tokenHash, revoked_at_ms AS revokedAtMs FROM agent_clients WHERE id = ?",
    ).get(id) as AgentInstallationTarget | undefined ?? null;
  }

  /** 같은 설치 파일의 재시도는 장치를 중복 발급하거나 해제된 연결을 되살리지 않는다. */
  registerInstallation(credential: { id: string; name: string; token: string }): void {
    this.database.sqlite.prepare(
      "INSERT INTO agent_clients (id, name, token_hash, created_at_ms) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO NOTHING",
    ).run(credential.id, credential.name, agentTokenHash(credential.token), Date.now());
    if (this.authenticate(credential.token) !== credential.id)
      throw Object.assign(new Error("이 설치 파일의 연결 권한이 해제되었습니다. 새 설치 파일을 받으세요."), { statusCode: 401 });
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
