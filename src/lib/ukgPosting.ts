import * as cheerio from 'cheerio';
import { cleanHtmlText } from '@/lib/jobIngestion';
import { postingMetadataValue } from '@/lib/postingMetadata';
import type { AtsScrapeResult } from '@/lib/atsApi';
import { isUkgBoardHost } from './ukgHost';
import { publishedEmployerName, ukgBoardBranding } from './publicAtsEmployer';

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const DETAIL_PATH = new RegExp(`^/[^/]+/JobBoard/${UUID}/OpportunityDetail/?$`, 'i');

export function ukgPostingIdentity(value: string): { id: string; boardPath: string } | null {
  try {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol)
      || (!/(?:^|\.)ultipro\.com$/i.test(url.hostname) && !isUkgBoardHost(url.hostname))
      || !DETAIL_PATH.test(url.pathname)) return null;
    const ids = url.searchParams.getAll('opportunityId');
    if (ids.length !== 1 || !new RegExp(`^${UUID}$`, 'i').test(ids[0])) return null;
    return { id: ids[0].toLowerCase(), boardPath: url.pathname.replace(/\/OpportunityDetail\/?$/i, '') };
  } catch {
    return null;
  }
}

/** Read the JSON constructor argument without executing the surrounding JavaScript. */
function opportunityData(script: string): Record<string, unknown> | null {
  const constructor = /\bnew\s+US\.Opportunity\.CandidateOpportunityDetail\s*\(\s*\{/.exec(script);
  if (!constructor) return null;
  const start = constructor.index + constructor[0].lastIndexOf('{');
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = start; index < script.length; index += 1) {
    const character = script[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') quoted = true;
    else if (character === '{') depth += 1;
    else if (character === '}' && --depth === 0) {
      try {
        return JSON.parse(script.slice(start, index + 1)) as Record<string, unknown>;
      } catch {
        return null;
      }
    }
  }
  return null;
}

function ukgLocation(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const location = value as Record<string, unknown>;
  const description = postingMetadataValue(location.LocalizedDescription);
  if (description) return description;
  const address = location.Address as { City?: unknown; State?: { Name?: unknown }; Country?: { Name?: unknown } } | undefined;
  return [address?.City, address?.State?.Name, address?.Country?.Name]
    .map(postingMetadataValue).filter(Boolean).join(', ') || undefined;
}

/** UKG's posting-title translation publishes the board's name even when its
 * logo is only "Default Brand". Bind the inert JSON to the exact role already
 * verified by CandidateOpportunityDetail; generic search labels are not names. */
function postingBoardEmployer($: cheerio.CheerioAPI, title: string): string {
  const matches = $('script').toArray().flatMap(script => [...($(script).html() || '').matchAll(
    /\bvar\s+params\s*=\s*(\{[^;]*\})\s*;\s*var\s+alias\s*=\s*["']OpportunityDetail\.Index\.PageTitle["']\s*;/g,
  )]);
  if (matches.length !== 1) return '';
  try {
    const params = JSON.parse(matches[0][1]);
    if (params.opportunityTitle !== title) return '';
    const name = publishedEmployerName(params.jobBoardName);
    return /\b(?:opportunit(?:y|ies)|job\s*board|recruit(?:ing|ment)|external|internal|open\s+positions|candidate|portal)\b/i.test(name)
      ? '' : name;
  } catch { return ''; }
}

/** UKG renders empty headings from this data; bind it to the requested posting and board branding. */
export function parseUkgPostingHtml(html: string, url: string): AtsScrapeResult | null {
  const identity = ukgPostingIdentity(url);
  if (!identity) return null;
  const $ = cheerio.load(html);
  const opportunity = $('script').toArray().map((script) => opportunityData($(script).html() || ''))
    .find((data) => typeof data?.Id === 'string' && data.Id.toLowerCase() === identity.id);
  const title = postingMetadataValue(opportunity?.Title);
  if (!opportunity || !title) return null;
  const branding = ukgBoardBranding(html, url);
  const boardCompany = branding.company || postingBoardEmployer($, title);
  const description = typeof opportunity.Description === 'string' ? cleanHtmlText(opportunity.Description) : '';
  // A first-person introduction needs independent employer corroboration.
  // Mere parent/client mentions elsewhere in the JD never supply the employer.
  const introduction = description.replace(/\s+/g, ' ').trim();
  const about = introduction.match(/^About (.{2,80}?) At ([^,]{2,80}), (?:we(?:['’]re| are)|our)\b/i);
  const sameName = (left: string, right: string) => left.trim().toLowerCase() === right.trim().toLowerCase();
  const declared = introduction.match(/^At ([^,]{2,80}), (?:we(?:['’]re| are)|our)\b/i)?.[1]
    || (about && sameName(about[1], about[2]) ? about[2] : undefined);
  const employerToken = declared?.toLowerCase().match(/[a-z]{4,}/)?.[0];
  // Some boards publish only a generic careers logo. Accept their initial
  // About/At self-identification only when this exact opportunity's location
  // record independently names the same employer, without contradicting a
  // named board. A facility label or a later client mention alone is insufficient.
  const locationCorroborates = declared && about && sameName(about[1], declared)
    && (!boardCompany || sameName(boardCompany, declared))
    && Array.isArray(opportunity.Locations) && opportunity.Locations.some(location => {
      const name = postingMetadataValue(location?.LocalizedName)?.replace(/\s+/g, ' ').trim();
      return name && sameName(name.split(/\s+[-–—]\s+/)[0], declared);
    });
  const declaredCompany = declared && employerToken && branding.employerUrl
    && new URL(branding.employerUrl).hostname.toLowerCase().split('.').some(part => part.includes(employerToken)) ? declared
    : locationCorroborates ? declared : '';
  const company = declaredCompany || boardCompany;
  const locations = Array.isArray(opportunity.Locations)
    ? opportunity.Locations.map(ukgLocation).filter((location): location is string => Boolean(location)) : [];
  return {
    ats: 'UKG', title,
    text: description,
    company: company || undefined,
    location: [...new Set(locations)].join('; ') || undefined,
  };
}
