export function defaultJobSort(status: string): 'newest' | 'aim_fit' {
  return status === 'inbox' || status === 'log' ? 'newest' : 'aim_fit';
}
