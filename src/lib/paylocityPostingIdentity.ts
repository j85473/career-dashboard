/** Paylocity's public detail IDs are global; navigation words are never IDs. */
export function isPaylocityPostingHost(value: string | null | undefined): boolean {
  try { return new URL(value || '').hostname.toLowerCase() === 'recruiting.paylocity.com'; }
  catch { return false; }
}

export function paylocityPostingId(value: string | null | undefined): string | null {
  try {
    const url = new URL(value || '');
    if (!isPaylocityPostingHost(value) || !['https:', 'http:'].includes(url.protocol)
      || url.username || url.password || url.port) return null;
    return /^\/recruiting\/jobs\/details\/([1-9]\d*)\/?$/i.exec(url.pathname)?.[1] || null;
  } catch { return null; }
}

export function paylocityPostingsConflict(left: string | null | undefined, right: string | null | undefined): boolean {
  const a = paylocityPostingId(left), b = paylocityPostingId(right);
  return Boolean(a && b && a !== b);
}

type Observation = { id: string; jobId: string; url: string | null;
  job: { url: string | null; canonicalUrl: string | null } };

/** Preserve poisoned source history while allowing the actual posting to be ingested. */
export async function resolvePaylocityObservation<T extends Observation>(input: {
  sourceId: string; incomingUrl?: string | null; find: (key: string) => Promise<T | null>;
}): Promise<{ sourceId: string; observation: T | null; ignoredObservation: T | null }> {
  const legacy = await input.find(input.sourceId);
  const id = paylocityPostingId(legacy?.url);
  const owners = legacy ? [legacy.job.url, legacy.job.canonicalUrl].map(paylocityPostingId).filter(Boolean) : [];
  if (!legacy || !id || !owners.length || owners.includes(id)) {
    return { sourceId: input.sourceId, observation: legacy, ignoredObservation: null };
  }
  if (input.incomingUrl && paylocityPostingId(input.incomingUrl) !== id) {
    throw Error('Paylocity observation recovery requires the exact historical posting ID');
  }
  const sourceId = `paylocity-posting:${id}`;
  const observation = await input.find(sourceId);
  if (observation && (paylocityPostingId(observation.url) !== id
    || ![observation.job.url, observation.job.canonicalUrl].some(url => paylocityPostingId(url) === id))) {
    throw Error('Paylocity recovery observation conflicts with its posting ID');
  }
  return { sourceId, observation, ignoredObservation: legacy };
}
