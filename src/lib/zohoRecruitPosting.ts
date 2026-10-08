import { load } from 'cheerio';
import { cleanHtmlText } from './jobIngestion';
import { assessJobDescriptionQuality } from './jobDescriptionQuality';
import { postingMetadataValue } from './postingMetadata';
import { parseHttpUrl } from './urlHost';
import { isZohoRecruitHost } from './zohoRecruitHost';
import type { AtsScrapeResult } from './atsApi';

export function zohoRecruitPostingIdentity(value: string): { host: string; page: string; id: string } | null {
  const url = parseHttpUrl(value);
  if (!url || !isZohoRecruitHost(url.hostname)) return null;
  const match = /^\/jobs\/([^/]+)\/(\d+)(?:\/[^/]+)?\/?$/.exec(url.pathname);
  if (!match) return null;
  try {
    return { host: url.hostname.toLowerCase(), page: decodeURIComponent(match[1]), id: match[2] };
  } catch {
    return null;
  }
}

export function zohoRecruitPublicDetailUrl(value: string): string | null {
  const identity = zohoRecruitPostingIdentity(value);
  if (!identity) return null;
  const apiUrl = new URL(`https://${identity.host}/recruit/v2/public/Job_Openings/${identity.id}`);
  apiUrl.searchParams.set('pagename', identity.page);
  return apiUrl.toString();
}

function postingResult(job: Record<string, unknown>): AtsScrapeResult | null {
  const title = postingMetadataValue(job.Posting_Title);
  const text = typeof job.Job_Description === 'string' ? cleanHtmlText(job.Job_Description) : '';
  if (!title || job.Publish === false || !assessJobDescriptionQuality(text, { structuredSource: true }).scorable) return null;
  const address = [job.City, job.State, job.Country].map(postingMetadataValue).filter(Boolean).join(', ');
  return {
    ats: 'Zoho Recruit', title, text,
    // Remote alone does not establish a country or eligible hiring region.
    location: job.Remote_Job === true ? (address ? `Remote, ${address}` : undefined) : (address || undefined),
  };
}

function exactPosting(records: unknown[], id: string): Record<string, unknown> | null {
  const matches = records.filter((value): value is Record<string, unknown> => Boolean(
    value && typeof value === 'object' && !Array.isArray(value)
    && (value as Record<string, unknown>).id === id,
  ));
  return matches.length === 1 ? matches[0] : null;
}

/** The public career-site API requires a page name, rather than an employer OAuth token. */
export function parseZohoRecruitPostingJson(payload: unknown, url: string): AtsScrapeResult | null {
  const identity = zohoRecruitPostingIdentity(url);
  if (!identity || !payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const response = payload as Record<string, unknown>;
  if (response.code !== 'success' || !Array.isArray(response.data)) return null;
  const job = exactPosting(response.data, identity.id);
  return job ? postingResult(job) : null;
}

/** Decode a JS string literal as data, without evaluating the page's scripts. */
function decodeStringLiteral(raw: string): string | null {
  let decoded = '';
  for (let index = 0; index < raw.length; index += 1) {
    const character = raw[index];
    if (character !== '\\') {
      decoded += character;
      continue;
    }
    const escaped = raw[++index];
    if (escaped === undefined) return null;
    if (escaped === 'x' || escaped === 'u') {
      const digits = escaped === 'x' ? 2 : 4;
      const hex = raw.slice(index + 1, index + 1 + digits);
      if (hex.length !== digits || !/^[0-9a-f]+$/i.test(hex)) return null;
      decoded += String.fromCharCode(Number.parseInt(hex, 16));
      index += digits;
    } else if (escaped === '\n' || escaped === '\r') {
      if (escaped === '\r' && raw[index + 1] === '\n') index += 1;
    } else if (/\d/.test(escaped) && (escaped !== '0' || /\d/.test(raw[index + 1] || ''))) {
      return null;
    } else {
      const controls: Record<string, string> = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', '0': '\0' };
      decoded += controls[escaped] ?? escaped;
    }
  }
  return decoded;
}

function bootstrapJobs(script: string): unknown[] | null {
  const match = /\b(?:var|let|const)\s+jobs\s*=\s*JSON\.parse\(\s*(?:'((?:\\[\s\S]|[^'\\])*)'|"((?:\\[\s\S]|[^"\\])*)")\s*\)/.exec(script);
  if (!match) return null;
  const decoded = decodeStringLiteral(match[1] ?? match[2]);
  if (decoded === null) return null;
  try {
    const jobs: unknown = JSON.parse(decoded);
    return Array.isArray(jobs) ? jobs : null;
  } catch {
    return null;
  }
}

function bootstrapCompany(script: string): string | undefined {
  // Employer branding is distinct from clients mentioned inside the JD.
  const organization = /"org_info"\s*:\s*\{([^{}]*)\}/.exec(script)?.[1];
  if (!organization || /"hide_company_name"\s*:\s*true/.test(organization)) return undefined;
  const name = /"company_name"\s*:\s*"((?:\\.|[^"\\])*)"/.exec(organization)?.[1];
  return name === undefined ? undefined : postingMetadataValue(decodeStringLiteral(name));
}

/** Read only the exact posting's public bootstrap record, excluding portal templates and navigation. */
export function parseZohoRecruitPostingHtml(html: string, url: string): AtsScrapeResult | null {
  const identity = zohoRecruitPostingIdentity(url);
  if (!identity) return null;
  const $ = load(html);
  for (const element of $('script:not([src])').toArray()) {
    const script = $(element).text();
    const jobs = bootstrapJobs(script);
    const job = jobs ? exactPosting(jobs, identity.id) : null;
    if (!job) continue;
    const result = postingResult(job);
    return result ? { ...result, company: bootstrapCompany(script) } : null;
  }
  return null;
}
