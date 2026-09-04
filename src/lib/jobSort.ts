export function defaultJobSort(status: string): 'combined' | 'newest' | 'aim_fit' {
  if (status === 'inbox') return 'combined';
  return status === 'log' ? 'newest' : 'aim_fit';
}
