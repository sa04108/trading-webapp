import fs from 'node:fs';
import path from 'node:path';

type Message = {
  readonly type: 'EXECUTE';
  readonly config: { readonly tempRoot: string; readonly preparationExecutionMaxQueued: number };
  readonly request: { readonly type: string; readonly jobId?: string };
};

// A synchronous loop prevents this callback from running. Merely registering it suppresses
// Node's default SIGTERM exit so the parent test must reach its SIGKILL deadline.
process.on('SIGTERM', () => undefined);

process.on('message', (message: Message) => {
  if (message.type !== 'EXECUTE') return;
  fs.mkdirSync(message.config.tempRoot, { recursive: true });
  fs.appendFileSync(path.join(message.config.tempRoot, 'preparation-child-spawns'), `${process.pid}\n`);
  if (message.request.jobId === 'block' || message.config.preparationExecutionMaxQueued === 7) {
    fs.writeFileSync(path.join(message.config.tempRoot, 'preparation-child-started'), 'started');
    process.send?.({ type: 'JOB_UPDATED', jobId: 'block' });
    // Intentionally block signal/IPC callbacks. The parent deadline must still terminate us.
    for (;;) { /* test fixture */ }
  }
  if (message.request.jobId === 'notify') {
    process.send?.({
      type: 'NOTIFICATION_CREATED',
      notification: {
        id: 'ntf_test',
        type: 'data-sync',
        severity: 'error',
        title: 'quota',
        body: null,
        link: null,
        read: false,
        createdAtMs: Date.now(),
      },
    });
  }
  const value = message.request.type === 'NEEDS_DART' ? false : null;
  process.send?.({ type: 'RESULT', value }, () => {
    process.disconnect();
    process.exitCode = 0;
  });
});
