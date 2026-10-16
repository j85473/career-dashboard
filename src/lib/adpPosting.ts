import * as cheerio from 'cheerio';
import { safeExternalFetch } from './safeExternalFetch';
import { manualImportCompanyValue } from './manualImportPolicy';

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

/** The public page uses ClientName, not ClientID, as the employer's name. */
export function adpClientFeaturesUrl(value: string): string | null {
  const identity = adpPostingIdentity(value);
  if (!identity) return null;
  const url = new URL('/mascsr/default/careercenter/public/events/staffing/client-features', identity.origin);
  for (const [key, value] of Object.entries({ cid: identity.cid, ccId: identity.ccId, lang: 'en_US', jobId: identity.jobId })) url.searchParams.set(key, value);
  return url.toString();
}

export function parseAdpClientCompany(body: unknown): string | undefined {
  const fields = (body as { meta?: { customFieldGroup?: { stringFields?: unknown } } } | null)?.meta?.customFieldGroup?.stringFields;
  if (!Array.isArray(fields)) return undefined;
  const names = new Set<string>();
  for (const field of fields) {
    if (field?.nameCode?.codeValue !== 'ClientName') continue;
    const name = typeof field.stringValue === 'string' ? manualImportCompanyValue(field.stringValue) : undefined;
    if (!name || name.length > 200 || /^(?:ADP|Workforce Now|ADP Workforce Now|Default(?: Brand(?:ing)?)?|Recruitment|Careers?)$/i.test(name)) return undefined;
    names.add(name);
  }
  return names.size === 1 ? [...names][0] : undefined;
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

export async function fetchAdpPosting(url: string, fetchPage: typeof safeExternalFetch = safeExternalFetch) {
  const endpoint = adpPostingDetailUrl(url);
  if (!endpoint) return null;
  const response = await fetchPage(endpoint, { headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(15000) });
  if (!response.ok || (response.url && response.url !== endpoint)) return null;
  const posting = parseAdpPosting(await response.json(), url);
  if (!posting || posting.company) return posting;
  // Only supplement a verified opening, using the same tenant and career
  // center. A configuration outage must not discard its title or full JD.
  try {
    const clientEndpoint = adpClientFeaturesUrl(url)!;
    const client = await fetchPage(clientEndpoint, { headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(10000) });
    if (client.ok && (!client.url || client.url === clientEndpoint)) posting.company = parseAdpClientCompany(await client.json());
  } catch {
    // The caller retains the posting and can ask for the missing company.
  }
  return posting;
}
