export type LatestOnlyAsyncWriter<T> = {
  push(value: T): void;
  waitForIdle(): Promise<void>;
};

/**
 * Keeps one write in flight and, while it runs, only the newest pending value.
 * This is useful for high-frequency progress mirrors where intermediate states
 * have no durable meaning but the latest state does.
 */
export function createLatestOnlyAsyncWriter<T>(
  write: (value: T) => Promise<void>,
  onError: (error: unknown) => void = () => undefined,
): LatestOnlyAsyncWriter<T> {
  let pending: { value: T } | null = null;
  let active = false;
  let idlePromise = Promise.resolve();
  let resolveIdle: (() => void) | null = null;

  const ensureBusy = () => {
    if (resolveIdle) return;
    idlePromise = new Promise<void>((resolve) => {
      resolveIdle = resolve;
    });
  };

  const settleIdle = () => {
    if (active || pending) return;
    const resolve = resolveIdle;
    resolveIdle = null;
    resolve?.();
  };

  const drain = async () => {
    if (active) return;
    active = true;
    try {
      while (pending) {
        const current = pending.value;
        pending = null;
        try {
          await write(current);
        } catch (error) {
          onError(error);
        }
      }
    } finally {
      active = false;
      if (pending) void drain();
      else settleIdle();
    }
  };

  return {
    push(value: T) {
      pending = { value };
      ensureBusy();
      void drain();
    },
    waitForIdle() {
      return idlePromise;
    },
  };
}
