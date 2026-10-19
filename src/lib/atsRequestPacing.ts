/** Conservative application pacing for providers observed refusing bursts.
 * These intervals are operational settings, not asserted vendor limits. */
export function atsRequestSpacingMs(platform: string): number {
  return ['symphony', 'manatal', 'workable', 'eightfold', 'hirehive', 'recruitee', 'kula'].includes(platform) ? 1000 : 0;
}

export function atsRequestPacingDelay(lastStartedAt: Date | null, spacingMs: number, now: Date): number {
  return lastStartedAt ? Math.max(0, lastStartedAt.getTime() + spacingMs - now.getTime()) : 0;
}
