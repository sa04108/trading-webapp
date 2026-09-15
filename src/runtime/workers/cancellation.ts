export interface CancellationEventSource {
  on(event: 'message', listener: (message: unknown) => void): unknown;
  on(event: 'SIGTERM', listener: () => void): unknown;
}

export interface CancellationState {
  isRequested(): boolean;
}

export function installCancellationHandlers(
  source: CancellationEventSource = process,
): CancellationState {
  let requested = false;

  source.on('message', (message: unknown) => {
    if (
      typeof message === 'object' &&
      message !== null &&
      'type' in message &&
      message.type === 'cancel'
    ) {
      requested = true;
    }
  });
  source.on('SIGTERM', () => {
    requested = true;
  });

  return { isRequested: () => requested };
}
