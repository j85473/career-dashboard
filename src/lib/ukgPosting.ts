import * as cheerio from 'cheerio';
import { cleanHtmlText } from '@/lib/jobIngestion';
import { postingMetadataValue } from '@/lib/postingMetadata';
import type { AtsScrapeResult } from '@/lib/atsApi';

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const DETAIL_PATH = new RegExp(`^/[^/]+/JobBoard/${UUID}/OpportunityDetail/?$`, 'i');

export function ukgPostingIdentity(value: string): { id: string; boardPath: string } | null {
  try {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol)
      || !/(?:^|\.)ultipro\.com$/i.test(url.hostname)
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

/** UKG renders empty headings from this data; bind it to the requested posting and board branding. */
export function parseUkgPostingHtml(html: string, url: string): AtsScrapeResult | null {
  const identity = ukgPostingIdentity(url);
  if (!identity) return null;
  const $ = cheerio.load(html);
  const opportunity = $('script').toArray().map((script) => opportunityData($(script).html() || ''))
    .find((data) => typeof data?.Id === 'string' && data.Id.toLowerCase() === identity.id);
  const title = postingMetadataValue(opportunity?.Title);
  if (!opportunity || !title) return null;
  const employerNames = $('img[data-automation="navbar-small-logo"], img[data-automation="navbar-large-logo"]')
    .toArray().flatMap((image) => {
      try {
        const imageUrl = new URL($(image).attr('src') || '', url);
        const name = postingMetadataValue($(image).attr('alt'));
        return imageUrl.origin === new URL(url).origin
          && imageUrl.pathname.toLowerCase() === `${identity.boardPath}/Styles/GetLargeHeaderLogo`.toLowerCase()
          && name && !/^(?:logo|company logo|ukg|ultipro)$/i.test(name) ? [name] : [];
      } catch {
        return [];
      }
    });
  const employers = [...new Set(employerNames)];
  const locations = Array.isArray(opportunity.Locations)
    ? opportunity.Locations.map(ukgLocation).filter((location): location is string => Boolean(location)) : [];
  return {
    ats: 'UKG', title,
    text: typeof opportunity.Description === 'string' ? cleanHtmlText(opportunity.Description) : '',
    company: employers.length === 1 ? employers[0] : undefined,
    location: [...new Set(locations)].join('; ') || undefined,
  };
}
