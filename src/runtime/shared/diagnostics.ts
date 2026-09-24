import { AsyncLocalStorage } from "node:async_hooks";
import { performance } from "node:perf_hooks";

export interface DiagnosticIdentity {
  readonly reqId?: string;
  readonly jobId?: string;
  readonly preparationJobId?: string;
  readonly dataRequestId?: string;
  readonly attempt?: number;
  readonly retryCount?: number;
}
export interface StageDiagnostic {
  readonly event: "diagnostic.stage.started" | "diagnostic.stage.finished";
  readonly stage: string;
  readonly elapsedMs?: number;
  readonly outcome?: "COMPLETED" | "FAILED";
  readonly rowCount?: number;
  readonly itemCount?: number;
  readonly cpuUserMs?: number;
  readonly cpuSystemMs?: number;
  readonly rssBytes?: number;
  readonly heapUsedBytes?: number;
  readonly lastPhase?: string;
}
export type DiagnosticSink = (fields: DiagnosticIdentity & StageDiagnostic) => void;
const scope = new AsyncLocalStorage<{ identity: DiagnosticIdentity; sink: DiagnosticSink }>();

/** 요청·수집 작업의 식별자를 비동기 호출 체인에서만 공유한다. DB에는 기록하지 않는다. */
export function withDiagnostics<T>(identity: DiagnosticIdentity, sink: DiagnosticSink, work: () => T): T {
  return scope.run({ identity, sink }, work);
}

export function recordDiagnostic(fields: StageDiagnostic): void {
  const context = scope.getStore();
  if (!context) return;
  try { context.sink({ ...context.identity, ...fields }); }
  catch { /* 진단 출력 실패가 작업의 성공·실패를 바꾸지 않는다. */ }
}

interface StageOptions {
  readonly itemCount?: number;
  readonly logStart?: boolean;
  readonly slowMs?: number;
}

function stageMeasurement(stage: string, options: StageOptions) {
  const start = performance.now();
  const cpu = process.cpuUsage();
  if (options.logStart) recordDiagnostic({ event: "diagnostic.stage.started", stage, itemCount: options.itemCount });
  return (outcome: "COMPLETED" | "FAILED", result?: unknown) => {
    const elapsedMs = performance.now() - start;
    if (outcome === "COMPLETED" && !options.logStart && elapsedMs < (options.slowMs ?? 250)) return;
    const usage = process.cpuUsage(cpu);
    const memory = process.memoryUsage();
    recordDiagnostic({ event: "diagnostic.stage.finished", stage, outcome, elapsedMs,
      itemCount: options.itemCount, rowCount: Array.isArray(result) ? result.length : undefined,
      cpuUserMs: usage.user / 1000, cpuSystemMs: usage.system / 1000,
      rssBytes: memory.rss, heapUsedBytes: memory.heapUsed });
  };
}

/** SQL과 파싱의 경과 시간은 단조 시계로 재고 본문·쿼리 인자는 출력하지 않는다. */
export function measureSync<T>(stage: string, work: () => T, options: StageOptions = {}): T {
  if (!scope.getStore()) return work();
  const finish = stageMeasurement(stage, options);
  try { const result = work(); finish("COMPLETED", result); return result; }
  catch (error) { finish("FAILED"); throw error; }
}

export async function measureAsync<T>(stage: string, work: () => Promise<T>, options: StageOptions = {}): Promise<T> {
  if (!scope.getStore()) return work();
  const finish = stageMeasurement(stage, options);
  try { const result = await work(); finish("COMPLETED", result); return result; }
  catch (error) { finish("FAILED"); throw error; }
}
