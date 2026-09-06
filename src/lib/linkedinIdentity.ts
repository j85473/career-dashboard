/** LinkedIn's public posting ID, independent of slug, tracking, or regional host. */
export function linkedinPostingId(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)
      || !(url.hostname === 'linkedin.com' || url.hostname.endsWith('.linkedin.com'))) return null;
    const path = decodeURIComponent(url.pathname).replace(/\/+$/, '');
    const match = path.match(/^\/jobs\/view\/(?:[^/]*-)?(\d+)$/i)
      || path.match(/^\/jobs-guest\/jobs\/api\/jobPosting\/(\d+)$/i);
    return match?.[1] || null;
  } catch {
    return null;
  }
}

export function isLinkedinUrl(value: string | null | undefined): boolean {
  try {
    const host = new URL(value || '').hostname;
    return host === 'linkedin.com' || host.endsWith('.linkedin.com');
  } catch { return false; }
}

export type LinkedInObservationIdentity = {
  url: string | null;
  job: { url: string | null; canonicalUrl: string | null };
};

/** Only affirmative, different public IDs disqualify a historical link. */
export function conflictingLinkedInObservation(observation: LinkedInObservationIdentity): string | null {
  const observedId = linkedinPostingId(observation.url);
  const jobIds = [observation.job.url, observation.job.canonicalUrl].map(linkedinPostingId).filter(Boolean);
  return observedId && jobIds.length > 0 && jobIds.every((id) => id !== observedId) ? observedId : null;
}

export function recoveredLinkedInSourceId(postingId: string): string {
  if (!/^\d+$/.test(postingId)) throw new Error('A public LinkedIn posting ID is required');
  return `linkedin-posting:${postingId}`;
}

/** Read-only resolution: retain the bad historical link and use a new key. */
export async function resolveLinkedInObservation<T extends LinkedInObservationIdentity & { id: string; jobId: string }>(input: {
  sourceId: string;
  incomingUrl?: string | null;
  find: (sourceId: string) => Promise<T | null>;
}): Promise<{ sourceId: string; observation: T | null; ignoredObservation: T | null }> {
  const legacy = await input.find(input.sourceId);
  const conflictId = legacy && conflictingLinkedInObservation(legacy);
  if (!conflictId) return { sourceId: input.sourceId, observation: legacy, ignoredObservation: null };
  // A caller with only a saved card may omit the URL. A fresh payload must
  // agree with that card before using its public ID for recovery.
  if (input.incomingUrl && linkedinPostingId(input.incomingUrl) !== conflictId) {
    throw new Error('LinkedIn observation recovery requires a matching fresh posting URL');
  }
  const sourceId = recoveredLinkedInSourceId(conflictId);
  const observation = await input.find(sourceId);
  if (observation && (conflictingLinkedInObservation(observation)
    || linkedinPostingId(observation.url) !== conflictId)) {
    throw new Error('LinkedIn recovery observation conflicts with the posting ID');
  }
  return { sourceId, observation, ignoredObservation: legacy };
}
