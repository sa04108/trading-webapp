import { openDatabase } from '../server/shared/db/database.js';
import { backtestPreparationJobs } from '../server/shared/db/schema.js';
import { AgentDataRequired, type AgentLease } from '../shared/agent-protocol.js';
import { createAgentPreparation } from './preparation-runtime.js';

process.once('message', (input: { lease: AgentLease; jobPath: string; dataPath: string }) => {
  void run(input).catch((error: unknown) => {
    if (process.connected) process.send?.({ type: 'FINISH', outcome: 'FAILED', error: error instanceof Error ? error.message : String(error) }, () => process.disconnect());
    else console.error(error);
    process.exitCode = 1;
  });
});

async function run(input: { lease: AgentLease; jobPath: string; dataPath: string }): Promise<void> {
  const database = openDatabase(input.jobPath, { dataPath: input.dataPath, dataReadonly: true });
  let orchestrator: ReturnType<typeof createAgentPreparation> | undefined;
  try {
    database.db.insert(backtestPreparationJobs).values({
      id: input.lease.jobId, requestHash: String(input.lease.payload.requestHash),
      requestJson: String(input.lease.payload.requestJson), status: 'RUNNING', phase: 'MARKET_DATA',
      createdAtMs: Date.now(), updatedAtMs: Date.now(),
    }).onConflictDoUpdate({ target: backtestPreparationJobs.id, set: { status: 'RUNNING', cancelRequested: false } }).run();
    orchestrator = createAgentPreparation(database, () => {
      const progress = orchestrator?.get(input.lease.jobId);
      if (progress) process.send?.({ type: 'PROGRESS', progress });
    });
    const stop = () => { orchestrator?.cancel(input.lease.jobId); };
    process.on('SIGTERM', stop);
    process.on('disconnect', stop);
    process.on('message', (message: { type: string }) => { if (message.type === 'cancel') stop(); });
    await orchestrator.runClaimedJob(input.lease.jobId);
    const job = orchestrator.get(input.lease.jobId);
    const row = database.sqlite.prepare('SELECT preview_json AS preview, data_revision AS dataRevision, fundamental_symbols_json AS fundamentalSymbols FROM backtest_preparation_jobs LEFT JOIN preparation_preview_cache ON job_id = id WHERE id = ?').get(input.lease.jobId) as { preview: string | null; dataRevision: number | null; fundamentalSymbols: string | null };
    process.send?.({ type: 'FINISH', outcome: job?.status, error: job?.error,
      result: row.preview ? { preview: JSON.parse(row.preview), dataRevision: row.dataRevision, fundamentalSymbols: JSON.parse(row.fundamentalSymbols ?? '[]') } : undefined });
  } catch (error) {
    if (error instanceof AgentDataRequired) process.send?.({ type: 'NEEDS_DATA', request: error.request });
    else process.send?.({ type: 'FINISH', outcome: 'FAILED', error: error instanceof Error ? error.message : String(error) });
  } finally {
    await orchestrator?.stop();
    database.close();
    if (process.connected) process.disconnect();
  }
}
