/** The user's link is stored verbatim (apart from surrounding whitespace).
 * Redirects and provider-specific URL forms are retrieval inputs only.
 */
export function userCanonicalJobUrlFields(value: string, updatedAt = new Date()) {
  const url = value.trim();
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new Error('Enter a valid HTTP or HTTPS job URL.'); }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error('Enter a valid HTTP or HTTPS job URL.');
  }
  return { url, canonicalUrl: url, userCanonicalUrl: url, userCanonicalUrlUpdatedAt: updatedAt };
}

type UserLink = { userCanonicalUrl?: string | null; userCanonicalUrlUpdatedAt?: Date | null };

/** A merge preserves the latest deliberate link choice regardless of survivor. */
export function latestUserCanonicalJobUrl(jobs: readonly UserLink[]) {
  return jobs.filter(job => job.userCanonicalUrl)
    .sort((a, b) => (b.userCanonicalUrlUpdatedAt?.valueOf() ?? 0) - (a.userCanonicalUrlUpdatedAt?.valueOf() ?? 0))[0];
}
