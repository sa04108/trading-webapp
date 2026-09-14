import { z } from 'zod';
import { isoDateSchema } from './schemas/backtest-request.js';

export const AGENT_PROTOCOL_VERSION = 1;
export const AGENT_LEASE_MS = 90_000;
export const AGENT_HEARTBEAT_MS = 15_000;
export const AGENT_MAX_ATTEMPTS = 3;
export const AGENT_MAX_MESSAGE_BYTES = 32 * 1024 * 1024;

export const datasetManifestSchema = z.object({
  version: z.number().int().positive(),
  datasetId: z.string().uuid(),
  sourceRevision: z.number().int().nonnegative(),
  schemaVersion: z.number().int().positive(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  bytes: z.number().int().positive(),
});
export type DatasetManifest = z.infer<typeof datasetManifestSchema>;

const symbolSchema = z.string().regex(/^[0-9A-Z]{6}$/);
const yearSchema = z.number().int().min(1990).max(2200);
export const agentDataRequestSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('MARKET'), dates: z.array(isoDateSchema).min(1).max(4000) }),
  z.object({ kind: z.literal('SELECTION'), dates: z.array(isoDateSchema).min(1).max(4000) }),
  z.object({ kind: z.literal('REGISTER'), symbols: z.array(z.object({ symbol: symbolSchema, standardCode: z.string().regex(/^[A-Z0-9]{12}$/) })).min(1).max(10000) }),
  z.object({ kind: z.literal('FINANCIAL'), symbols: z.array(symbolSchema).min(1).max(10000), fromYear: yearSchema, toYear: yearSchema }),
  z.object({ kind: z.literal('ACTIONS'), symbols: z.array(symbolSchema).min(1).max(10000), fromYear: yearSchema, toYear: yearSchema }),
]);
export type AgentDataRequest = z.infer<typeof agentDataRequestSchema>;

/** 계산 장치가 API를 직접 호출하는 대신 중앙 수집 큐에 요구를 돌려보낸다. */
export class AgentDataRequired extends Error {
  constructor(readonly request: AgentDataRequest) {
    super('계산에 필요한 데이터를 서버에 요청합니다');
    this.name = 'AgentDataRequired';
  }
}

export const agentLeaseSchema = z.object({
  kind: z.enum(['PREPARATION', 'BACKTEST']),
  jobId: z.string().regex(/^[a-zA-Z0-9_-]{3,128}$/),
  attempt: z.number().int().positive(),
  leaseToken: z.string().min(32).max(256),
  leaseExpiresAtMs: z.number().int().positive(),
  dataset: datasetManifestSchema,
  payload: z.record(z.string(), z.unknown()),
});
export type AgentLease = z.infer<typeof agentLeaseSchema>;

const identity = {
  kind: z.enum(['PREPARATION', 'BACKTEST']),
  jobId: z.string().min(3).max(128),
  attempt: z.number().int().positive(),
  leaseToken: z.string().min(32).max(256),
};
export const agentMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('HELLO'), protocolVersion: z.literal(AGENT_PROTOCOL_VERSION), runnerVersion: z.string().min(1).max(128) }),
  z.object({ type: z.literal('CAPACITY'), slots: z.number().int().min(0).max(4096), datasetVersion: z.number().int().nonnegative(), maxBars: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) }),
  z.object({ type: z.literal('HEARTBEAT'), ...identity, progress: z.object({ processedBars: z.number().int().nonnegative(), totalBars: z.number().int().nonnegative(), progressLabel: z.string().max(200).nullable() }).optional(), preparationProgress: z.object({ phase: z.enum(['MARKET_DATA', 'RESOLVING_STAGES', 'VALIDATING_RESULT', 'SYNCING_FACTS', 'FINALIZING']), overallProgress: z.number().min(0).max(100), doneSymbols: z.number().int().nonnegative(), totalSymbols: z.number().int().nonnegative(), savedFacts: z.number().int().nonnegative(), gapCount: z.number().int().nonnegative() }).optional() }),
  z.object({ type: z.literal('NEEDS_DATA'), ...identity, request: agentDataRequestSchema }),
  z.object({ type: z.literal('FINISH'), ...identity, outcome: z.enum(['COMPLETED', 'FAILED', 'CANCELLED']), result: z.record(z.string(), z.unknown()).optional(), error: z.string().max(2000).optional() }),
]);
export type AgentMessage = z.infer<typeof agentMessageSchema>;
export type ServerAgentMessage =
  | { type: 'WELCOME'; runnerVersion: string }
  | { type: 'UPDATE_REQUIRED'; runnerVersion: string }
  | { type: 'DEMAND'; estimatedBars: number }
  | { type: 'DATASET'; dataset: DatasetManifest }
  | { type: 'JOB'; lease: AgentLease }
  | { type: 'LEASE'; kind: AgentLease['kind']; jobId: string; attempt: number; accepted: boolean; cancelRequested: boolean; leaseExpiresAtMs?: number }
  | { type: 'ACK'; kind: AgentLease['kind']; jobId: string; attempt: number; accepted: boolean };
