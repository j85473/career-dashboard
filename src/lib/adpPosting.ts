import * as cheerio from 'cheerio';
import { safeExternalFetch } from './safeExternalFetch';
import { manualImportCompanyValue } from './manualImportPolicy';
import { adpPostingIdentity } from './adpPostingIdentity';
import { publishedEmployerName } from './publicAtsEmployer';

export { adpPostingIdentity } from './adpPostingIdentity';

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
    if (!['ClientName', 'CLIENT_NAME'].includes(field?.nameCode?.codeValue)) continue;
    if (typeof field.stringValue === 'string' && !field.stringValue.trim()) continue;
    const name = typeof field.stringValue === 'string' ? manualImportCompanyValue(field.stringValue) : undefined;
    if (!name || name.length > 200 || /^(?:ADP|Workforce Now|ADP Workforce Now|Default(?: Brand(?:ing)?)?|Recruitment|Careers?)$/i.test(name)) return undefined;
    names.add(name);
  }
  return names.size === 1 ? [...names][0] : undefined;
}

/** Authored employer sections need a named introductory subject plus a
 * matching hiring statement or first-person description of its own staff. */
function authoredAdpEmployer($: cheerio.CheerioAPI): string | undefined {
  const names = new Set<string>();
  const normalize = (text: string) => text.replace(/\s+/g, ' ').trim();
  const postingText = normalize($('h1,h2,h3,h4,p,li').toArray().map(node => $(node).text()).join(' '));
  for (const node of $('h1,h2,h3,h4,p').toArray()) {
    const heading = normalize($(node).text());
    const next = $(node).nextAll().toArray().slice(0, 10).map(sibling => normalize($(sibling).text())).filter(Boolean);
    const named = /^About\s+(.{2,100})$/i.exec(heading);
    if (named && !/^(?:us|the role|the company|you|the team)$|^(?:our|the) (?:clients?|customers?)\b/i.test(named[1])
      && (next[0]?.startsWith(`At ${named[1]},`) || next[0]?.startsWith(`${named[1]} `))) {
      const name = publishedEmployerName(named[1]);
      if (name) names.add(name);
    }
    if (!/^(?:about us|company overview)\s*:?$/i.test(heading)) continue;
    const subject = /^(.{2,100}?)\s+(?:is|are)\b/i.exec(next[0] || '')?.[1];
    const name = publishedEmployerName(subject);
    if (!name || /^(?:we|it|this|our|the company|the team|the role)$|^(?:our|the) (?:clients?|customers?)\b/i.test(name)
      || /^\s+(?:is|are)\s+(?:a|our|the)\s+(?:client|customer)\b/i.test((next[0] || '').slice(subject!.length))) continue;
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const hiring = new RegExp(`(?:^|[^\\p{L}\\p{N}])${escaped}\\s+(?:is|are)\\s+(?:seeking|hiring|recruiting|looking\\s+for)\\b`, 'iu');
    if (hiring.test(postingText) || /\bour (?:team|company|spas|employees|organization|staff)\b/i.test(next.slice(0, 3).join(' '))) names.add(name);
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
  $('script,style').remove();
  const company = authoredAdpEmployer($);
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
