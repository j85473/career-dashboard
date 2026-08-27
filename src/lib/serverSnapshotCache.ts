export type SnapshotCacheStatus = 'miss' | 'hit' | 'stale';

export type SnapshotCacheResult<T> = {
  value: T;
  status: SnapshotCacheStatus;
  ageMs: number;
};

type SnapshotCacheOptions = {
  freshForMs: number;
  now?: () => number;
  onBackgroundError?: (error: unknown) => void;
};

/**
 * Keeps the latest successful operational snapshot in this server process.
 *
 * A cold request waits for the first snapshot. Once a snapshot exists, stale
 * callers receive it immediately while one coalesced refresh runs in the
 * background. Failed refreshes never replace the last known-good value.
 */
export function createLatestSuccessfulSnapshot<T>(
  load: () => Promise<T>,
  options: SnapshotCacheOptions,
) {
  if (!Number.isSafeInteger(options.freshForMs) || options.freshForMs <= 0) {
    throw new Error('freshForMs must be a positive integer');
  }

  const now = options.now || Date.now;
  let cached: { value: T; loadedAt: number } | null = null;
  let refreshPromise: Promise<T> | null = null;

  const refresh = async (): Promise<T> => {
    if (refreshPromise) return refreshPromise;
    refreshPromise = load()
      .then((value) => {
        cached = { value, loadedAt: now() };
        return value;
      })
      .finally(() => {
        refreshPromise = null;
      });
    return refreshPromise;
  };

  const get = async (): Promise<SnapshotCacheResult<T>> => {
    if (!cached) {
      const value = await refresh();
      return { value, status: 'miss', ageMs: 0 };
    }

    const ageMs = Math.max(0, now() - cached.loadedAt);
    if (ageMs < options.freshForMs) {
      return { value: cached.value, status: 'hit', ageMs };
    }

    void refresh().catch((error) => options.onBackgroundError?.(error));
    return { value: cached.value, status: 'stale', ageMs };
  };

  return { get, refresh };
}
