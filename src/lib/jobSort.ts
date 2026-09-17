const STATUS_ENTRY_SORTS: Record<string, string> = {
  applied: 'applied',
  archived: 'archived',
  bookmarked: 'bookmarked',
  cooldown: 'cooldown',
  expired: 'expired',
  passed: 'passed',
  local_dismissed: 'dismissed',
  dismissed: 'dismissed',
};

export function statusEntryHistoryValue(status: string): string | null {
  return STATUS_ENTRY_SORTS[status] || null;
}

export function usesStatusEntryTimeSort(status: string, sort: string): boolean {
  return statusEntryHistoryValue(status) !== null && (sort === 'newest' || sort === 'oldest');
}

export function defaultJobSort(status: string): 'combined' | 'newest' | 'aim_fit' {
  if (status === 'inbox') return 'combined';
  if (statusEntryHistoryValue(status)) return 'newest';
  return status === 'log' ? 'newest' : 'aim_fit';
}

/**
 * Applied is an application log, not a score board. Its only meaningful order
 * is the latest explicit transition into Applied first, so stale browser state
 * and hand-written API requests cannot switch it back to score or oldest-first
 * ordering.
 */
export function selectedJobSort(status: string, requested?: string | null): string {
  if (status === 'applied') return 'newest';
  return requested || defaultJobSort(status);
}
