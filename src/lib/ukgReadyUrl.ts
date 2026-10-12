export type UkgReadyPage = { host: string; tenant: string; jobId: string | null };

/** UKG Ready's careers links identify a tenant; ShowJob identifies one opening. */
export function ukgReadyPage(value: string): UkgReadyPage | null {
  try {
    const url = new URL(value);
    const tenant = /^\/ta\/([a-z0-9_-]+)\.(?:careers|jobs)$/i.exec(url.pathname)?.[1];
    if (!/^https?:$/.test(url.protocol) || !/^secure\d+\.saashr\.com$/i.test(url.hostname) || !tenant) return null;
    const ids = [...url.searchParams].filter(([key]) => /^(?:showjob|applytojob|jobid)$/i.test(key)).map(([, id]) => id);
    // Conflicting or malformed IDs must never fall back to a different posting.
    if (ids.some(id => !/^[1-9]\d*$/.test(id)) || new Set(ids).size > 1) throw new Error('The UKG link has an invalid or conflicting job ID. Please copy the individual job link again.');
    return { host: url.hostname.toLowerCase(), tenant, jobId: ids[0] || null };
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('The UKG link')) throw error;
    return null;
  }
}

export function ukgReadyJobUrl(value: string, jobId: string): string {
  const page = ukgReadyPage(value);
  if (!page || !/^[1-9]\d*$/.test(jobId)) throw new Error('Invalid UKG Ready posting link');
  const input = new URL(value);
  const result = new URL(`https://${page.host}/ta/${page.tenant}.careers`);
  result.searchParams.set('ShowJob', jobId);
  for (const key of ['lang', 'ein_id', 'career_portal_id', 'HostedBy', 'InFrameset']) {
    const values = input.searchParams.getAll(key);
    if (values.length === 1 && values[0]) result.searchParams.set(key, values[0]);
  }
  return result.toString();
}

/** Same-origin endpoint paths observed in UKG Ready's public careers client. */
export function ukgReadyApiUrl(value: string, resource: string): string {
  const page = ukgReadyPage(value);
  if (!page) throw new Error('Invalid UKG Ready careers link');
  const url = new URL(`https://${page.host}/ta/rest/ui/recruitment/companies/%7C${page.tenant}/${resource}`);
  const input = new URL(value);
  for (const key of ['lang', 'ein_id', 'career_portal_id']) {
    if (input.searchParams.getAll(key).length === 1 && input.searchParams.get(key)) url.searchParams.set(key, input.searchParams.get(key)!);
  }
  return url.toString();
}
