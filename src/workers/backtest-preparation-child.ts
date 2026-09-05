import type { AppConfig } from '../server/bootstrap/config.js';
import { createPreparationRuntime, type PreparationRuntime } from '../server/bootstrap/preparation-runtime.js';
import type {
  PreparationChildRequest,
  SerializedPreparationError,
} from '../server/modules/backtest/application/backtest-preparation-execution.js';

type ParentMessage =
  | { readonly type: 'EXECUTE'; readonly config: AppConfig; readonly request: PreparationChildRequest }
  | { readonly type: 'CANCEL'; readonly jobId: string }
  | { readonly type: 'SHUTDOWN' };

let runtime: PreparationRuntime | null = null;
let activeOperation: Promise<void> | null = null;
let stopping = false;

// Install lifecycle handling before accepting work. A parent-controlled SIGKILL remains the
// bounded fallback when synchronous SQLite/JS work prevents these callbacks from running.
const requestStop = (): void => {
  if (stopping) return;
  stopping = true;
  void runtime?.orchestrator.stop();
};
process.once('SIGTERM', requestStop);
process.once('SIGINT', requestStop);
process.once('disconnect', requestStop);

process.on('message', (message: ParentMessage) => {
  if (message.type === 'CANCEL' || message.type === 'SHUTDOWN') {
    requestStop();
    return;
  }
  if (activeOperation !== null) return;
  activeOperation = execute(message.config, message.request)
    .finally(() => {
      activeOperation = null;
    });
});

async function execute(config: AppConfig, request: PreparationChildRequest): Promise<void> {
  let value: unknown;
  try {
    runtime = createPreparationRuntime(
      config,
      (jobId) => {
        if (process.connected) process.send?.({ type: 'JOB_UPDATED', jobId });
      },
      (notification) => {
        if (process.connected) process.send?.({ type: 'NOTIFICATION_CREATED', notification });
      },
    );
    switch (request.type) {
      case 'RUN_JOB':
        await runtime.orchestrator.runClaimedJob(request.jobId);
        value = null;
        break;
      case 'GET_READY_PREVIEW':
        value = await runtime.orchestrator.getReadyPreview(request.input);
        break;
      case 'GET_READY_PREVIEW_DETAILS':
        value = await runtime.orchestrator.getReadyPreviewDetails(request.input);
        break;
      case 'GET_CACHED_PREVIEW':
        value = runtime.orchestrator.getCachedPreview(request.input, request.preparationJobId);
        break;
      case 'NEEDS_DART':
        value = await runtime.orchestrator.needsDart(request.input);
        break;
    }
    await runtime.close();
    runtime = null;
    if (process.connected) process.send?.({ type: 'RESULT', value }, () => finish(0));
    else finish(0);
  } catch (error) {
    try {
      await runtime?.close();
    } catch {
      // Preserve the operation's original error for the parent.
    }
    runtime = null;
    const serialized = serializeError(error);
    if (process.connected) process.send?.({ type: 'ERROR', error: serialized }, () => finish(1));
    else finish(1);
  }
}

function finish(code: number): void {
  if (process.connected) process.disconnect();
  process.exitCode = code;
}

function serializeError(error: unknown): SerializedPreparationError {
  if (!(error instanceof Error)) return { name: 'Error', message: String(error) };
  const withDate = error as Error & { readonly date?: unknown };
  return {
    name: error.name,
    message: error.message,
    ...(typeof withDate.date === 'string' ? { date: withDate.date } : {}),
    ...(error.stack === undefined ? {} : { stack: error.stack }),
  };
}
