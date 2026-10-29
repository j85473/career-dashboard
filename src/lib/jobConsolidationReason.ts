/** Shared with the browser so a combined copy keeps its lifecycle explanation. */
export const CONSOLIDATED_REASON_PREFIX = 'Consolidated after URL edit into job ';

export function consolidatedIntoJobId(reason: string | null | undefined): string | null {
  if (!reason?.startsWith(CONSOLIDATED_REASON_PREFIX)) return null;
  return reason.slice(CONSOLIDATED_REASON_PREFIX.length).trim() || null;
}
