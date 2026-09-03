export type ClientPolling = { refresh: () => void; stop: () => void };

/** One current request and one future poll. Superseded responses have no authority. */
export function startClientPolling<T>(options: {
  request: (signal: AbortSignal) => Promise<T>;
  onData: (data: T) => void;
  onError?: (error: unknown) => void;
  intervalMs: () => number;
}): ClientPolling {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let active: AbortController | undefined;

  const clearTimer = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };

  const refresh = () => {
    if (stopped) return;
    clearTimer();
    active?.abort();
    const controller = new AbortController();
    active = controller;
    const isCurrent = () => !stopped && active === controller && !controller.signal.aborted;
    void (async () => {
      try {
        const data = await options.request(controller.signal);
        if (isCurrent()) options.onData(data);
      } catch (error) {
        if (isCurrent()) options.onError?.(error);
      } finally {
        if (isCurrent()) {
          active = undefined;
          timer = setTimeout(refresh, options.intervalMs());
        }
      }
    })();
  };

  // Defer the initial request so effects do not synchronously update React state.
  timer = setTimeout(refresh, 0);
  return {
    refresh,
    stop: () => {
      stopped = true;
      clearTimer();
      active?.abort();
      active = undefined;
    },
  };
}
