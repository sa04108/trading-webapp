import { parseWorkerDiagnostics } from "../../../../shared/agent-diagnostics.js";

interface DiagnosticSink {
  record(actor: string, event: string, detail: Record<string, unknown>): void;
}
interface DiagnosticLogger {
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
}
export interface ReceivedWorkerDiagnostics {
  accepted: boolean;
  clientId: string;
  kind: "BACKTEST" | "PREPARATION";
  jobId: string;
  attempt: number;
  outcome: "FAILED" | "CANCELLED" | "COMPLETED";
  executionMode: "local" | "remote";
  runnerVersion: string;
  diagnostics: unknown;
}

/** 진단은 부가 정보다. 잘못된 진단이나 감사 저장 실패가 확정된 작업과 ACK를 뒤집지 않는다. */
export function recordWorkerDiagnostics(
  input: ReceivedWorkerDiagnostics,
  audit: DiagnosticSink,
  logger: DiagnosticLogger,
): void {
  if (!input.accepted || input.diagnostics === undefined) return;
  const { diagnostics: raw, accepted: _accepted, outcome, ...identity } = input;
  const diagnostics = parseWorkerDiagnostics(raw);
  if (!diagnostics) {
    logger.warn({ event: "agent.invalid-diagnostics", ...identity }, "에이전트 진단 형식 오류");
    return;
  }
  const detail = { event: "agent.worker.diagnostics", ...identity, reportedOutcome: outcome, diagnostics };
  // DB 감사 저장이 실패해도 같은 식별자의 구조화 로그는 남긴다.
  if (input.outcome === "FAILED") logger.warn(detail, "에이전트 계산 실패 진단");
  else logger.info(detail, "에이전트 계산 종료 진단");
  try {
    audit.record("system", "agent.worker.diagnostics", detail);
  } catch (error) {
    logger.warn({ event: "agent.diagnostics-audit-failed", jobId: input.jobId,
      attempt: input.attempt, err: error }, "에이전트 진단 감사 저장 실패");
  }
}
