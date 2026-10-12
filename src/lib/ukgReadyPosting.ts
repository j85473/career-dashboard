import { load } from 'cheerio';
import type { AtsScrapeResult } from './atsApi';
import { cleanHtmlText } from './jobIngestion';
import { postingMetadataValue } from './postingMetadata';
import { safeExternalFetch } from './safeExternalFetch';
import { ukgReadyApiUrl, ukgReadyJobUrl, ukgReadyPage } from './ukgReadyUrl';

type PublicJsonReader = (url: string) => Promise<unknown>;
type JsonObject = Record<string, unknown>;
const object = (value: unknown): JsonObject => value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {};
const id = (value: unknown): string | null => (typeof value === 'string' || (typeof value === 'number' && Number.isSafeInteger(value))) && /^[1-9]\d*$/.test(String(value)) ? String(value) : null;

async function readPublicJson(url: string): Promise<unknown> {
  const response = await safeExternalFetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(15_000) });
  if (!response.ok || new URL(response.url).origin !== new URL(url).origin || new URL(response.url).pathname !== new URL(url).pathname) {
    throw new Error('UKG could not return the requested opening. Please retry or paste the full job description.');
  }
  return response.json();
}

function location(data: JsonObject): string | undefined {
  // Ready publishes the work restriction separately from the office address.
  if (data.is_remote_job === true) return postingMetadataValue(data.selected_loc_value_for_cp_display) || 'Remote';
  const address = object(data.location);
  return [address.city, address.state, address.country].map(postingMetadataValue).filter(Boolean).join(', ') || undefined;
}

/** Only an employer introduction immediately following an About heading. */
function authoredEmployer(html: string): string | undefined {
  const $ = load(html);
  for (const element of $('p,h1,h2,h3,h4').toArray()) {
    const heading = $(element).text().trim();
    if (!/^about\s+(?!you\b|the role\b|the job\b|our clients\b)[\w ]{2,60}$/i.test(heading)) continue;
    const intro = $(element).next().text().replace(/\s+/g, ' ').trim();
    const name = /^([^.!?]{2,100}?)\s+(?:\([^)]{1,60}\)\s+)?is\s+(?:a|an|the)\b/i.exec(intro)?.[1]?.trim();
    if (name && !/^(?:this|the role|the team|our client|our customer)$/i.test(name)) {
      return name.replace(/\s+\([^)]*\)(?=\s*(?:,|$))/g, '').replace(/,\s*by\s+[^,]+,?$/i, '').trim();
    }
  }
  return undefined;
}

function compensation(data: JsonObject): string | undefined {
  const currency = postingMetadataValue(data.job_ein_currency_code_symbol);
  // Do not invent a currency when the public API did not publish it.
  if (!currency) return undefined;
  const from = typeof data.base_pay_from === 'number' ? data.base_pay_from : null;
  const to = typeof data.base_pay_to === 'number' ? data.base_pay_to : null;
  if (from === null && to === null) return undefined;
  const amount = (n: number) => `${currency}${n.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
  const range = from !== null && to !== null ? `${amount(from)} - ${amount(to)}` : amount((from ?? to)!);
  const frequency = postingMetadataValue(data.base_pay_frequency);
  return `${range}${frequency ? ` / ${frequency.toLowerCase()}` : ''}`;
}

export function parseUkgReadyPosting(data: unknown, url: string, branding: unknown = {}): AtsScrapeResult | null {
  const page = ukgReadyPage(url);
  const detail = object(data);
  if (!page?.jobId || id(detail.id) !== page.jobId) return null;
  const title = postingMetadataValue(detail.job_title);
  if (!title) return null;
  const html = [detail.job_description, detail.job_requirement, detail.job_preview].filter(v => typeof v === 'string').join('\n');
  const company = authoredEmployer(typeof detail.job_description === 'string' ? detail.job_description : '')
    || postingMetadataValue(object(branding).comp_name)
    || postingMetadataValue(object(object(branding).company).name);
  const pay = compensation(detail);
  return {
    ats: 'UKG', title, company, location: location(detail),
    text: [cleanHtmlText(html), pay ? `Posted compensation: ${pay}` : ''].filter(Boolean).join('\n\n'),
  };
}

export async function fetchUkgReadyPosting(url: string, readJson: PublicJsonReader = readPublicJson): Promise<AtsScrapeResult | null> {
  const page = ukgReadyPage(url);
  if (!page?.jobId) return null;
  const detailUrl = new URL(ukgReadyApiUrl(url, `job-requisitions/${page.jobId}`));
  detailUrl.searchParams.set('showMap', '1');
  const detail = await readJson(detailUrl.toString());
  // Refuse a different requisition before reading or using any employer data.
  if (id(object(detail).id) !== page.jobId) return null;
  const config = await readJson(ukgReadyApiUrl(url, 'job-search/config')).catch(() => ({}));
  const company = authoredEmployer(String(object(detail).job_description || '')) || postingMetadataValue(object(config).comp_name);
  const branding = company ? config : await readJson(`https://${page.host}/ta/rest/ui/bootstrap/companies/%7C${page.tenant}/format-settings`).catch(() => config);
  return parseUkgReadyPosting(detail, url, branding);
}

export type UkgReadyOpening = { id: string; title: string; location: string | null; url: string };
export type UkgReadySelection = { kind: 'choose_opening'; sourceUrl: string; jobs: UkgReadyOpening[]; page: number; total: number; hasMore: boolean };

export async function fetchUkgReadyOpenings(url: string, pageNumber = 1, readJson: PublicJsonReader = readPublicJson): Promise<UkgReadySelection> {
  const page = ukgReadyPage(url);
  if (!page || page.jobId || !Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > 1000) throw new Error('Invalid UKG careers page');
  const listingUrl = new URL(ukgReadyApiUrl(url, 'job-requisitions'));
  listingUrl.searchParams.set('offset', String(pageNumber));
  listingUrl.searchParams.set('size', '100');
  listingUrl.searchParams.set('sort', 'desc');
  const result = object(await readJson(listingUrl.toString()));
  if (!Array.isArray(result.job_requisitions) || result.job_requisitions.length > 100) throw new Error('UKG did not return a usable list of openings. Please paste an individual job link.');
  const jobs = result.job_requisitions.map(value => {
    const row = object(value);
    const jobId = id(row.id);
    const title = postingMetadataValue(row.job_title);
    if (!jobId || !title) throw new Error('UKG returned an opening without a usable identity. Please paste its individual job link.');
    return { id: jobId, title, location: location(row) || null, url: ukgReadyJobUrl(url, jobId) };
  });
  if (new Set(jobs.map(job => job.id)).size !== jobs.length) throw new Error('UKG returned conflicting opening identities. Please retry.');
  const paging = object(result._paging);
  const total = paging.total;
  if (!Number.isSafeInteger(total) || Number(total) < jobs.length || paging.offset !== pageNumber || paging.size !== 100) throw new Error('UKG returned incomplete pagination. Please paste an individual job link.');
  if (jobs.length !== Math.min(100, Math.max(0, Number(total) - (pageNumber - 1) * 100))) throw new Error('UKG returned an incomplete page of openings. Please retry.');
  return { kind: 'choose_opening', sourceUrl: url, jobs, page: pageNumber, total: Number(total), hasMore: pageNumber * 100 < Number(total) };
}
