/** Dayforce numbers are local to a client's career site, never the shared host. */
export function isDayforcePostingHost(value: string | null | undefined): boolean {
  try { return /^jobs\.dayforce(?:hcm)?\.com$/i.test(new URL(value || '').hostname); }
  catch { return false; }
}

export function dayforcePostingIdentity(value: string | null | undefined): { host: string; key: string } | null {
  if (!isDayforcePostingHost(value)) return null;
  try {
    const url = new URL(value!);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    const parts = url.pathname.split('/').filter(Boolean).map(part => decodeURIComponent(part).toLowerCase());
    // Locale is presentation. Client and career site are the posting namespace.
    if (parts.length !== 5 || !/^[a-z]{2}-[a-z]{2}$/.test(parts[0])
      || !/^[a-z0-9_-]+$/.test(parts[1]) || !/^[a-z0-9_-]+$/.test(parts[2])
      || parts[3] !== 'jobs' || !/^\d+$/.test(parts[4])) return null;
    return { host: `dayforce:${parts[1]}:${parts[2]}`, key: parts[4] };
  } catch { return null; }
}

export function dayforcePostingKey(value: string | null | undefined): string | null {
  const identity = dayforcePostingIdentity(value);
  return identity ? `${identity.host}|${identity.key}` : null;
}

type ObservationIdentity = { id: string; jobId: string; url: string | null; job: { url: string | null; canonicalUrl: string | null } };

/** Read-only escape from a previously misassigned source key; never move user work. */
export async function resolveDayforceObservation<T extends ObservationIdentity>(input: {
  sourceId: string; incomingUrl?: string | null; find: (sourceId: string) => Promise<T | null>;
}): Promise<{ sourceId: string; observation: T | null; ignoredObservation: T | null }> {
  const incomingKey = dayforcePostingKey(input.incomingUrl);
  if (input.incomingUrl && !incomingKey) throw new Error('Dayforce ingestion requires a complete employer, career site and posting URL');
  const legacy = await input.find(input.sourceId);
  const observedKey = dayforcePostingKey(legacy?.url);
  const ownerKey = dayforcePostingKey(legacy?.job.canonicalUrl || legacy?.job.url);
  // A bare provider number cannot prove a duplicate before the URL is known.
  const scopedSourceId = /^[^:]+::[a-z]{2}-[a-z]{2}::[^:]+::[^:]+::jobs::\d+$/i.test(input.sourceId)
    || /^dayforce-posting:dayforce:[a-z0-9_-]+:[a-z0-9_-]+\|\d+$/i.test(input.sourceId);
  if (!input.incomingUrl && !scopedSourceId) {
    return { sourceId: input.sourceId, observation: null, ignoredObservation: null };
  }
  const conflict = legacy && ((incomingKey && observedKey !== incomingKey)
    || (observedKey && ownerKey && observedKey !== ownerKey));
  if (!conflict) return { sourceId: input.sourceId, observation: legacy, ignoredObservation: null };
  // A search-card-only check must request the payload rather than suppress it.
  if (!incomingKey) return { sourceId: input.sourceId, observation: null, ignoredObservation: null };
  const sourceId = `dayforce-posting:${incomingKey}`;
  const observation = await input.find(sourceId);
  if (observation) {
    const existingOwner = dayforcePostingKey(observation.job.canonicalUrl || observation.job.url);
    if (dayforcePostingKey(observation.url) !== incomingKey || (existingOwner && existingOwner !== incomingKey)) {
      throw new Error('Dayforce recovery observation conflicts with the employer, career site or posting');
    }
  }
  return { sourceId, observation, ignoredObservation: legacy };
}
