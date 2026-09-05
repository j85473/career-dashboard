export type SnapshotCacheStatus = 'miss' | 'hit' | 'stale' | 'expired';

export type SnapshotCacheResult<T> = {
  value: T;
  status: SnapshotCacheStatus;
  ageMs: number;
};

type SnapshotCacheOptions = {
  freshForMs: number;
  /**
   * The age past which the retained snapshot stops being an acceptable answer.
   *
   * Without this the cache hands out its last good value forever: a refresh
   * only runs when someone asks, so an unattended night leaves the first
   * caller of the morning holding yesterday's numbers with nothing to say so.
   * Past this age a caller waits for a rebuild instead of being answered with
   * the old one.
   */
  maxServeAgeMs?: number;
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
  if (options.maxServeAgeMs !== undefined
    && (!Number.isSafeInteger(options.maxServeAgeMs) || options.maxServeAgeMs <= options.freshForMs)) {
    throw new Error('maxServeAgeMs must be a positive integer greater than freshForMs');
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

    if (options.maxServeAgeMs !== undefined && ageMs >= options.maxServeAgeMs) {
      // Too old to answer with. Wait for the rebuild rather than hand back a
      // reading this stale as though it were current. The value held now is
      // captured first: a refresh that fails must still be able to fall back
      // to it, and `cached` is reassigned by any refresh that succeeds.
      const held = cached;
      try {
        const value = await refresh();
        return { value, status: 'hit', ageMs: Math.max(0, now() - (cached?.loadedAt ?? now())) };
      } catch (error) {
        // A failed load still never replaces a good value. The caller gets the
        // old one, but labelled so nothing downstream can read it as current.
        options.onBackgroundError?.(error);
        return { value: held.value, status: 'expired', ageMs: Math.max(0, now() - held.loadedAt) };
      }
    }

    void refresh().catch((error) => options.onBackgroundError?.(error));
    return { value: cached.value, status: 'stale', ageMs };
  };

  return { get, refresh };
}
