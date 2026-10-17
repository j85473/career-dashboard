/** A durable ID boundary stays fair when new rows arrive or resolved rows leave. */
export function selectCanonicalRecoveryIds(
  ids: readonly string[],
  afterId: string | null,
  limit: number,
): { ids: string[]; afterId: string | null } {
  const sorted = [...new Set(ids)].sort();
  const start = afterId ? sorted.findIndex(id => id > afterId) : 0;
  const rotated = start < 0 ? sorted : [...sorted.slice(start), ...sorted.slice(0, start)];
  const selected = rotated.slice(0, Math.max(0, Math.floor(limit)));
  return { ids: selected, afterId: selected.at(-1) || afterId };
}

/** Checkpoint only the contiguous attempted prefix, even when employers are grouped. */
export function canonicalRecoveryCheckpoint(ids: readonly string[], attempted: ReadonlySet<string>): string | null {
  let last: string | null = null;
  for (const id of ids) {
    if (!attempted.has(id)) break;
    last = id;
  }
  return last;
}
