import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { installCancellationHandlers } from '../../src/workers/cancellation.js';

describe('worker cancellation', () => {
  it('records cancel IPC and SIGTERM requests but ignores unrelated IPC', () => {
    const ipcSource = new EventEmitter();
    const ipcCancellation = installCancellationHandlers(ipcSource);

    ipcSource.emit('message', { type: 'progress' });
    expect(ipcCancellation.isRequested()).toBe(false);
    ipcSource.emit('message', { type: 'cancel' });
    expect(ipcCancellation.isRequested()).toBe(true);

    const signalSource = new EventEmitter();
    const signalCancellation = installCancellationHandlers(signalSource);
    signalSource.emit('SIGTERM');
    expect(signalCancellation.isRequested()).toBe(true);
  });
});
