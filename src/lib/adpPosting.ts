import * as cheerio from 'cheerio';
import { safeExternalFetch } from './safeExternalFetch';

/** ADP appends the selected opening to the URL when navigating between jobs. */
export function adpPostingIdentity(value: string): { cid: string; ccId: string; jobId: string; origin: string } | null {
  try {
    const url = new URL(value);
    if (url.hostname !== 'workforcenow.adp.com' || !url.pathname.endsWith('/recruitment.html')) return null;
    const cid = url.searchParams.get('cid') || '';
    const jobId = url.searchParams.getAll('jobId').at(-1) || '';
    const ccId = url.searchParams.get('ccId') || '19000101_000001';
    return /^[a-f0-9-]{36}$/i.test(cid) && /^\d+$/.test(jobId) && /^[\w-]+$/.test(ccId)
      ? { cid, ccId, jobId, origin: url.origin } : null;
  } catch { return null; }
}

export function adpPostingDetailUrl(value: string): string | null {
  const identity = adpPostingIdentity(value);
  if (!identity) return null;
  const url = new URL(`/mascsr/default/careercenter/public/events/staffing/v1/job-requisitions/${identity.jobId}`, identity.origin);
  for (const [key, value] of Object.entries({ cid: identity.cid, ccId: identity.ccId, lang: 'en_US', locale: 'en_US' })) url.searchParams.set(key, value);
  return url.toString();
}

export function parseAdpPosting(body: unknown, url: string) {
  const identity = adpPostingIdentity(url);
  if (!identity || !body || typeof body !== 'object') return null;
  const job = body as { requisitionTitle?: string; requisitionDescription?: string;
    customFieldGroup?: { stringFields?: Array<{ stringValue?: string; nameCode?: { codeValue?: string } }> };
    requisitionLocations?: Array<{ nameCode?: { shortName?: string } }> };
  const id = job.customFieldGroup?.stringFields?.find(field => field.nameCode?.codeValue === 'ExternalJobID')?.stringValue;
  if (id !== identity.jobId || !job.requisitionTitle?.trim() || typeof job.requisitionDescription !== 'string') return null;
  const $ = cheerio.load(job.requisitionDescription);
  // Only an authored company heading corroborated by its opening sentence is
  // employer evidence. Client tokens and the ADP hostname are infrastructure.
  let company: string | undefined;
  for (const node of $('h1,h2,h3').toArray()) {
    const match = /^About\s+(.{2,100})$/.exec($(node).text().trim());
    const next = $(node).next().text().trim();
    if (match && !/^(?:us|the role|the company|you|the team)$/i.test(match[1])
      && (next.startsWith(`At ${match[1]},`) || next.startsWith(`${match[1]} `))) { company = match[1]; break; }
  }
  $('script,style').remove();
  $('p,div,li,h1,h2,h3,br').append('\n');
  const text = $.root().text().replace(/[\t ]+/g, ' ').replace(/\n\s*\n+/g, '\n\n').trim();
  const locations = [...new Set((job.requisitionLocations || []).map(place => place.nameCode?.shortName?.trim()).filter(Boolean))];
  return { ats: 'ADP', title: job.requisitionTitle.trim(), company,
    location: locations.join('; ') || undefined, text };
}

export async function fetchAdpPosting(url: string) {
  const endpoint = adpPostingDetailUrl(url);
  if (!endpoint) return null;
  const response = await safeExternalFetch(endpoint, { headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(15000) });
  if (!response.ok || (response.url && response.url !== endpoint)) return null;
  return parseAdpPosting(await response.json(), url);
}
