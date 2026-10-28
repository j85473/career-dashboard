/** A publisher-owned JobNotFound redirect is affirmative closure evidence. */
export function paylocityRecoveryClosed(url: string, title: string, body: string): boolean {
  try {
    const final = new URL(url);
    return final.hostname === 'recruiting.paylocity.com'
      && /^\/recruiting\/jobs\/JobNotFound\/?$/i.test(final.pathname)
      && /^Job Not Found$/i.test(title.trim())
      && /job does not exist or is not currently active/i.test(body);
  } catch { return false; }
}

export function paylocityRetryDelayMs(value: string | null, now = Date.now()): number {
  if (value && /^\d+$/.test(value)) return Math.max(1000, Number(value) * 1000);
  const date = value ? Date.parse(value) : NaN;
  return Number.isFinite(date) ? Math.max(1000, date - now) : 30000;
}
