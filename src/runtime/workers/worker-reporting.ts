import { diagnosticError } from "../../shared/agent-diagnostics.js";

const deliveries = new Set<Promise<void>>();
let phase = "BOOTSTRAP";

/** IPC 실패를 처리하되 최초 계산 오류를 새 예외로 덮어쓰지 않는다. */
export function sendWorkerMessage(message: unknown): void {
  if (!process.connected || !process.send) return;
  const sent = new Promise<void>((resolve) => {
    const done = (error: Error | null): void => {
      if (error) process.stderr.write(`IPC 전송 실패: ${error.message}\n`);
      resolve();
    };
    try { process.send!(message, done); }
    catch (error) { done(error instanceof Error ? error : new Error(String(error))); }
  });
  deliveries.add(sent);
  void sent.then(() => deliveries.delete(sent));
}

export function reportWorkerPhase(value: string): void {
  if (phase === value.slice(0, 100)) return;
  phase = value.slice(0, 100);
  sendWorkerMessage({ type: "WORKER_DIAGNOSTIC", phase });
}

/** DB 종료 상태 갱신보다 먼저 호출한다. DB가 고장 나도 최초 stack은 부모에게 남는다. */
export function reportWorkerError(error: unknown, failedPhase = phase): void {
  phase = failedPhase.slice(0, 100);
  const detail = diagnosticError(error);
  process.stderr.write(`${detail.stack ?? detail.message}\n`);
  sendWorkerMessage({ type: "WORKER_DIAGNOSTIC", phase, diagnosticError: detail });
}

/** 강제 exit나 임의의 sleep 대신 IPC 송신을 마치고 자연 종료하여 출력도 비운다. */
export async function disconnectWorker(): Promise<void> {
  await Promise.all([...deliveries]);
  if (process.connected) process.disconnect();
}
