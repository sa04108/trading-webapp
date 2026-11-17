import { z } from "zod";

const agentExecutionStateSchema = z.enum([
  "NEVER_CONNECTED", "OFFLINE", "UNRESPONSIVE", "CONNECTING",
  "VERSION_MISMATCH", "PROTOCOL_MISMATCH", "SYNCING",
  "NO_CAPACITY", "BUSY", "READY", "REVOKED",
]);
export type AgentExecutionState = z.infer<typeof agentExecutionStateSchema>;

const agentRegistrationSchema = z.object({
  id: z.string(),
  name: z.string(),
  createdAtMs: z.number(),
  lastSeenAtMs: z.number().nullable(),
  revokedAtMs: z.number().nullable(),
  runnerVersion: z.string().nullable(),
  protocolVersion: z.number().int().positive().nullable(),
});
export type AgentRegistration = z.infer<typeof agentRegistrationSchema>;

/** 최근 통신 이력과 현재 새 작업을 받을 수 있는 상태를 분리한다. */
export const agentClientStatusSchema = agentRegistrationSchema.extend({
  execution: z.object({
    state: agentExecutionStateSchema,
    detail: z.string(),
    connected: z.boolean(),
    canAcceptJobs: z.boolean(),
    activeJobs: z.number().int().nonnegative(),
    availableSlots: z.number().int().nonnegative(),
    requiredRunnerVersion: z.string(),
    requiredProtocolVersion: z.number().int().positive(),
  }),
});
export type AgentClientStatus = z.infer<typeof agentClientStatusSchema>;

export interface AgentList {
  clients: AgentClientStatus[];
}
