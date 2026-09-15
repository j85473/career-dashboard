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
