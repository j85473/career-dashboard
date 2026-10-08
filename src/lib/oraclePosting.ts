import { oracleBrandedEmployer } from './publicAtsEmployer';

import type { AtsScrapeResult } from '@/lib/atsApi';
import { cleanHtmlText } from '@/lib/jobIngestion';

export function oraclePostingDetailUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || !url.hostname.toLowerCase().endsWith('.oraclecloud.com')) return null;
    const match = url.pathname.match(/^\/hcmUI\/CandidateExperience\/[^/]+\/sites\/([a-z0-9_-]+)\/job\/([a-z0-9_-]+)\/?$/i);
    if (!match) return null;
    const detail = new URL('/hcmRestApi/resources/latest/recruitingCEJobRequisitionDetails', url.origin);
    detail.searchParams.set('expand', 'all');
    detail.searchParams.set('onlyData', 'true');
    detail.searchParams.set('finder', `ById;Id="${match[2]}",siteNumber=${match[1]}`);
    return detail;
  } catch {
    return null;
  }
}

function textValue(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
    : [];
}

/** The detail API's country-wide search location can hide the actual work address. */
function oracleLocation(posting: Record<string, unknown>): string | undefined {
  const addresses = [...records(posting.workLocation), ...records(posting.otherWorkLocations)];
  const locations = addresses.map((address) => {
    const city = textValue(address.TownOrCity);
    if (!city) return '';
    const region = textValue(address.Region2);
    const country = textValue(address.Country);
    return [city, region || country].filter(Boolean).join(', ');
  }).filter(Boolean);
  if (!locations.length) {
    const published = [textValue(posting.PrimaryLocation), ...records(posting.secondaryLocations).map((place) => textValue(place.Name))].filter(Boolean);
    const isCountryOnlyUS = (place: string) => /^(?:u\.?s\.?a?\.?|united states(?: of america)?)$/i.test(place);
    const specific = published.filter((place) => !isCountryOnlyUS(place));
    // Oracle includes a country search node alongside actual cities. It is
    // country metadata, not another work site that can override city triage.
    // Keep a country-only posting when no more specific location is supplied.
    locations.push(...(specific.length ? specific : published));
  }
  const location = [...new Set(locations)].join('; ');
  if (!location) return undefined;
  const workplace = textValue(posting.WorkplaceType);
  const code = textValue(posting.WorkplaceTypeCode);
  const arrangement = code === 'ORA_REMOTE' ? 'Remote' : code === 'ORA_HYBRID' ? 'Hybrid' : workplace;
  return arrangement && /^(remote|hybrid)$/i.test(arrangement) && !location.toLowerCase().includes(arrangement.toLowerCase())
    ? `${location} (${arrangement})`
    : location;
}

/** Only accept the requested posting; site branding supplies the employer when Oracle omits it. */
export function parseOraclePostingDetail(payload: unknown, url: string, pageHtml = ''): AtsScrapeResult | null {
  const detailUrl = oraclePostingDetailUrl(url);
  if (!detailUrl || !payload || typeof payload !== 'object') return null;
  const jobId = new URL(url).pathname.split('/').filter(Boolean).at(-1);
  const posting = records((payload as { items?: unknown }).items)
    .find((item) => String(item.Id) === jobId);
  if (!posting) return null;

  const ownOracleEmployer = new URL(url).hostname === 'eeho.fa.us2.oraclecloud.com'
    && /Oracle is an Equal Employment Opportunity Employer/i.test(textValue(posting.CorporateDescriptionStr));
  // This customer publishes the legal employer in its first-person equality
  // statement, rather than the empty LegalEmployer field. Do not use arbitrary
  // company mentions elsewhere in the description or the parent board name.
  const declaredEmployer = new URL(url).hostname === 'egjl.fa.us6.oraclecloud.com'
    ? textValue(posting.ShortDescriptionStr).match(/^[“"]?En (.{2,100}?) estamos comprometidos con promover la equidad, la diversidad y la inclusi[oó]n/i)?.[1]
      || textValue(posting.ShortDescriptionStr).match(/^Desde hace más de .{1,400}?forma parte del gran equipo ([^,]{2,80}), empresa peruana del grupo Intercorp/i)?.[1] || '' : '';
  const company = textValue(posting.LegalEmployer) || declaredEmployer || oracleBrandedEmployer(pageHtml, url)
    || (ownOracleEmployer ? 'Oracle' : '');
  const title = textValue(posting.Title);
  const location = oracleLocation(posting);
  const description = [
    posting.ExternalDescriptionStr,
    posting.ExternalResponsibilitiesStr,
    posting.ExternalQualificationsStr,
    posting.CorporateDescriptionStr,
    posting.OrganizationDescriptionStr,
  ].filter((value): value is string => typeof value === 'string' && Boolean(value.trim()));

  return {
    text: cleanHtmlText(description.join('\n\n')),
    ats: 'Oracle Cloud',
    ...(title ? { title } : {}),
    ...(company ? { company } : {}),
    ...(location ? { location } : {}),
  };
}
