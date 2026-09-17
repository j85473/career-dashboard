export function defaultJobSort(status: string): 'combined' | 'newest' | 'aim_fit' {
  if (status === 'inbox') return 'combined';
  if (status === 'applied') return 'newest';
  return status === 'log' ? 'newest' : 'aim_fit';
}

/** Applied is a chronological application log, never a score-sortable board. */
export function selectedJobSort(status: string, requested?: string | null): string {
  if (status === 'applied') return 'newest';
  return requested || defaultJobSort(status);
}
