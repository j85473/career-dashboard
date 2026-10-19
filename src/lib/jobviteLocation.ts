import * as cheerio from 'cheerio';

/** Jobvite publishes department, then locations, separated by empty spans. */
export function jobviteHeaderLocation(html: string): string {
  const $ = cheerio.load(html);
  const locations = new Set<string>();
  $('.jv-job-detail-meta').each((_, node) => {
    const header = $(node).clone();
    header.find('script,style').remove();
    header.find('br').replaceWith('\n');
    const separators = header.find('.jv-inline-separator');
    if (separators.length) {
      // The first separator ends the department. Later separators delimit
      // additional locations, which must not be discarded or read as one city.
      separators.replaceWith('\nJOBVITE_LOCATION_SEPARATOR\n');
      const parts = header.text().split('JOBVITE_LOCATION_SEPARATOR').slice(1);
      for (const part of parts) add(part);
    } else {
      // Some employers omit the department entirely (for example ActioNet).
      const text = header.text().trim();
      // A bare department is indistinguishable from a city-only value. Keep
      // affirmative geography/remote evidence; never save "Analytics" as a city.
      if (text.includes(',') || /\b(?:remote|hybrid)\b/i.test(text)
        || /^(?:United States|United Kingdom|Canada)$/i.test(text)) add(text);
    }
  });
  // AGS uses a labeled job snapshot instead of the standard metadata header.
  $('.snapshot-item.location').each((_, node) => {
    const field = $(node).clone();
    field.find('.fa-li').remove();
    const values = field.find('p');
    if (values.length) {
      values.each((_, value) => {
        const text = $(value).text().trim();
        if (!/^Location\s*:$/i.test(text)) add(text);
      });
    } else add(field.text().replace(/^\s*Location\s*:\s*/i, ''));
  });
  function add(value: string): void {
    const normalized = value.split(/\b(?:Salary|Posting Closes)\s*:/i)[0]
      .replace(/\s+/g, ' ').replace(/\s*,\s*/g, ', ').trim();
    if (normalized && !/[{}]/.test(normalized)
      && !/^#.*\(reqID\)$/i.test(normalized)
      && !/^(?:unknown(?: location)?|not (?:specified|provided)|multiple locations?|locations?)$/i.test(normalized)) {
      locations.add(normalized);
    }
  }
  return [...locations].join('; ');
}

/** Some Jobvite JSON-LD uses JavaScript's \\' escape, which JSON forbids. */
export function jobvitePublishedLocation(html: string, expectedUrl: string): string {
  const header = jobviteHeaderLocation(html);
  if (header) return header;
  const $ = cheerio.load(html);
  for (const node of $('script[type="application/ld+json"]').toArray()) {
    let parsed: unknown;
    try {
      const raw = $(node).text().replace(/(\\+)'/g, (match, slashes: string) =>
        slashes.length % 2 ? slashes.slice(1) + "'" : match);
      parsed = JSON.parse(raw);
    } catch { continue; }
    const candidates = Array.isArray(parsed) ? [...parsed] : [parsed];
    for (const candidate of [...candidates]) {
      if (candidate && Array.isArray(candidate['@graph'])) candidates.push(...candidate['@graph']);
    }
    for (const candidate of candidates) {
      if (!candidate || typeof candidate !== 'object') continue;
      const types = Array.isArray(candidate['@type']) ? candidate['@type'] : [candidate['@type']];
      if (!types.includes('JobPosting')) continue;
      const identity = jobvitePostingIdentity(expectedUrl);
      if (!identity || typeof candidate.url === 'string' && jobvitePostingIdentity(candidate.url) !== identity
        || typeof candidate.identifier === 'string' && candidate.identifier !== identity.split('/')[1]) continue;
      const places = Array.isArray(candidate.jobLocation) ? candidate.jobLocation : [candidate.jobLocation];
      const locations = places.map((place: { address?: Record<string, unknown> } | undefined) => {
        const address = place?.address;
        const country = typeof address?.addressCountry === 'object' && address.addressCountry
          ? (address.addressCountry as { name?: unknown }).name : address?.addressCountry;
        return [...new Set([address?.addressLocality, address?.addressRegion, country]
          .filter((v): v is string => typeof v === 'string' && !!v.trim()).map(v => v.trim()))].join(', ');
      }).filter(Boolean);
      const requirements = Array.isArray(candidate.applicantLocationRequirements)
        ? candidate.applicantLocationRequirements : [candidate.applicantLocationRequirements];
      for (const requirement of requirements) {
        const name = typeof requirement === 'string' ? requirement : requirement?.name;
        if (typeof name === 'string' && name.trim()) locations.push(name.trim());
      }
      if (candidate.jobLocationType === 'TELECOMMUTE') locations.unshift('Remote');
      if (locations.length) return [...new Set(locations)].join('; ');
    }
  }
  return '';
}

/** Bind recovery evidence to the exact tenant/requisition, including redirects. */
export function jobvitePostingIdentity(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port
      || !['jobs.jobvite.com', 'careers.jobvite.com'].includes(url.hostname)) return null;
    const match = /^\/([^/]+)\/job\/([\w-]+)\/?$/.exec(url.pathname);
    return match ? `${match[1]}/${match[2]}` : null;
  } catch { return null; }
}

export function recoverableJobviteLocation(html: string, requestedUrl: string, responseUrl: string): string {
  const identity = jobvitePostingIdentity(requestedUrl);
  if (!identity || jobvitePostingIdentity(responseUrl) !== identity) return '';
  const $ = cheerio.load(html);
  const hasMatchingApplyLink = $('a[href]').toArray().some(node => {
    try {
      const apply = new URL($(node).attr('href')!, responseUrl);
      if (!/\/apply\/?$/.test(apply.pathname)) return false;
      apply.pathname = apply.pathname.replace(/\/apply\/?$/, '');
      return jobvitePostingIdentity(apply.href) === identity;
    } catch { return false; }
  });
  return hasMatchingApplyLink ? jobvitePublishedLocation(html, responseUrl) : '';
}
