import * as cheerio from 'cheerio';
import { publishedEmployerName } from './publicAtsEmployer';

const value = (input: unknown) => typeof input === 'string' ? input.replace(/\s+/g, ' ').trim() : '';
export type SuccessFactorsMetadata = { title: string; company?: string; location?: string };

/** XML titles can retain one extra layer of entities; identity comparisons
 * decode those entities without changing the historical title on the card. */
export function normalizedSuccessFactorsTitle(text: string): string {
  return value(text.replace(/&(?:#[0-9]+|#x[0-9a-f]+|[a-z][a-z0-9]+);/gi,
    entity => cheerio.load(entity, {}, false).text())
    .replace(/\((?:[mwf]\/[mwf]\/[dx]|all genders)\)/gi, ' ')).normalize('NFKC').toLowerCase();
}

export function successFactorsEmployerPageMatches(requested: string, responded: string): boolean {
  try {
    const left = new URL(requested), right = new URL(responded);
    const host = (url: URL) => url.hostname.replace(/^(?:www|jobs|careers)\./, '');
    return right.protocol === 'https:' && !right.username && !right.password && !right.port && host(left) === host(right);
  } catch { return false; }
}

/** Exact requisition and tenant identity; a search page is never a posting. */
export function successFactorsPostingIdentity(input: string): { host: string; tenant: string; id: string } | null {
  try {
    const url = new URL(input);
    const tenant = url.searchParams.getAll('company'), ids = url.searchParams.getAll('career_job_req_id');
    if (url.protocol !== 'https:' || !/^career\d*\.(?:successfactors|sapsf)\.(?:com|eu)$/i.test(url.hostname)
      || !/^\/career(?:;[^/]*)?\/?$/i.test(url.pathname) || tenant.length !== 1 || !tenant[0]
      || ids.length !== 1 || !/^\d+$/.test(ids[0]) || url.searchParams.get('career_ns') !== 'job_listing') return null;
    return { host: url.hostname.toLowerCase(), tenant: tenant[0], id: ids[0] };
  } catch { return null; }
}

/** Only the published masthead supplies logo authority, not JD image mentions. */
export function successFactorsBrandedEmployer(html: string, tenant: string): string {
  const $ = cheerio.load(html);
  const meta = publishedEmployerName($('meta[property="og:site_name"]').attr('content'));
  if (meta) return meta;
  const styles = $('style').toArray().map(node => $(node).text()).join('\n');
  const masthead = /#masthead\s*\{([^}]+)\}/i.exec(styles)?.[1] || '';
  const logo = /background-image\s*:\s*url\(['"]?([^'"\)]+)/i.exec(masthead)?.[1];
  // Exact branded asset and tenant, independently verified from the public page.
  if (tenant === 'Mahindra' && logo === 'https://performancemanager4.successfactors.com/Mahindra/Mahindra%20Logo.png') return 'Mahindra';
  if (tenant === 'C0001122692P' && logo === 'https://store.delaval.com/globalassets/logo_delaval_ats.png') return 'DeLaval';
  return '';
}

/** SAP's public configuration links its employer-owned Recruiting Marketing site. */
export function successFactorsCareerSite(html: string): string | null {
  const $ = cheerio.load(html);
  const urls = $('script').toArray().flatMap(node => [...($(node).text()).matchAll(
    /https:\/\/[^\s'"<>\\]+\/services\/security\/logoutp\?[^\s'"<>\\]*/g,
  )].map(match => {
    try { return new URL(match[0].replace(/&amp;/g, '&')).origin; } catch { return ''; }
  })).filter(Boolean);
  const unique = [...new Set(urls)];
  return unique.length === 1 ? unique[0] : null;
}

export function parseSuccessFactorsPostingHtml(html: string, url: string): SuccessFactorsMetadata | null {
  const identity = successFactorsPostingIdentity(url);
  if (!identity) return null;
  const $ = cheerio.load(html);
  if ($('input#career_company').attr('value') !== identity.tenant
    || $('input#career_job_req_id').attr('value') !== identity.id) return null;
  const heading = value($('.pagetitle h1, h1#candidateProfileTitle').first().text());
  const title = heading.match(new RegExp(`^Career Opportunities:\\s*(.+)\\s*\\(${identity.id}\\)$`))?.[1]?.trim();
  if (!title || !$('.joqReqDescription .externalPosting').length) return null;
  const company = successFactorsBrandedEmployer(html, identity.tenant);
  let location = '';
  const posting = $('.joqReqDescription .externalPosting').clone();
  posting.find('script,style').remove();
  posting.find('br').replaceWith('\n');
  posting.find('p,div,h1,h2,h3,li').append('\n');
  const labeledLocations = posting.text().split('\n').slice(0, 40).flatMap(line => {
    const text = value(line);
    const match = /^(?:job location|work location|location|arbeitsort|standort)\s*:\s*(.{2,150})$/i.exec(text);
    return match ? [match[1].trim()] : [];
  });
  const uniqueLocations = [...new Set(labeledLocations)];
  if (uniqueLocations.length === 1) location = uniqueLocations[0];
  // Mahindra publishes exactly location and department here. Other tenants
  // reorder their custom fields, so never interpret their first bold field.
  if (!location && identity.tenant === 'Mahindra' && company === 'Mahindra') {
    const header = $('.pagetitle').parent().children('div').filter((_i, node) =>
      value($(node).text()).startsWith(`Requisition ID ${identity.id} `));
    const fields = header.children('b').toArray();
    if (header.length === 1 && fields.length === 4 && $(fields[1]).attr('id') === 'postedOnDate') {
      location = value($(fields[2]).text());
    }
  }
  return { title, company: company || undefined, location: location || undefined };
}

/** Search only locates candidates; exact requisition proof is required below. */
export function successFactorsCareerPostingLinks(html: string, site: string, expectedTitle?: string): string[] {
  const $ = cheerio.load(html);
  return [...new Set($('a.jobTitle-link[href]').toArray().flatMap(node => {
    try {
      if (expectedTitle && normalizedSuccessFactorsTitle($(node).text()) !== normalizedSuccessFactorsTitle(expectedTitle)) return [];
      const link = new URL($(node).attr('href')!, site);
      return link.origin === new URL(site).origin && /^\/(?:[a-z0-9_-]+\/)*job\/[^/]+\/\d+\/?$/i.test(link.pathname) ? [link.href] : [];
    } catch { return []; }
  }))];
}

/** Recruiting Marketing microdata is bound to the underlying SAP requisition. */
export function parseSuccessFactorsCareerPosting(html: string, id: string, expectedTitle: string): SuccessFactorsMetadata | null {
  const $ = cheerio.load(html);
  for (const script of $('script[type="application/ld+json"]').toArray()) {
    try {
      const row = JSON.parse($(script).text());
      if (row['@type'] !== 'JobPosting' || value(row.identifier?.value) !== id
        || normalizedSuccessFactorsTitle(value(row.title)) !== normalizedSuccessFactorsTitle(expectedTitle)) continue;
      const locations = (Array.isArray(row.jobLocation) ? row.jobLocation : [row.jobLocation]).map((place: { address?: Record<string, unknown> }) => {
        const address = place?.address;
        return ['addressLocality', 'addressRegion', 'addressCountry'].map(key => value(address?.[key])).filter(Boolean).join(', ');
      }).filter(Boolean);
      return { title: value(row.title), company: publishedEmployerName(row.hiringOrganization?.name) || undefined,
        location: [...new Set(locations)].join('; ') || undefined };
    } catch { /* Invalid structured data cannot establish posting identity. */ }
  }
  const codes = $('script[data-company-job-code]').toArray().map(node => $(node).attr('data-company-job-code'));
  for (const script of $('script').toArray()) {
    const configs = [...$(script).text().matchAll(/\bapplyWithLinkedIn2Config\s*:\s*(\{[^{}]*\})/g)];
    for (const config of configs) {
      try { codes.push(JSON.parse(config[1]).internalId); } catch { /* Inert JSON only. */ }
    }
  }
  const title = value($('[itemprop="title"], [data-careersite-propertyid="title"]').first().text())
    || value($('meta[property="og:title"]').attr('content')) || value($('h1').first().text());
  if (!codes.length || codes.some(code => !code || !new RegExp(`^${id}(?:-[a-z]{2}(?:[_-][a-z]{2})?)?$`, 'i').test(code))
    || normalizedSuccessFactorsTitle(title) !== normalizedSuccessFactorsTitle(expectedTitle)) return null;
  const names = $('[itemprop="hiringOrganization"]').toArray().map(node =>
    publishedEmployerName($(node).attr('content') || $(node).find('[itemprop="name"]').text() || $(node).text())).filter(Boolean);
  const uniqueNames = [...new Set(names)];
  const locations = $('[itemprop="jobLocation"]').toArray().map(node => {
    const address = $(node);
    const fields = [...new Set(['addressLocality', 'addressRegion', 'addressCountry'].map(key => {
      const field = address.find(`[itemprop="${key}"]`).first();
      return value(field.attr('content') || field.text());
    }).filter(Boolean))].join(', ');
    // Many SAP portals publish their complete location only as streetAddress,
    // including multiple addresses. Keep all of those source-provided values.
    const fullAddresses = address.find('[itemprop="streetAddress"]').toArray().map(field =>
      value($(field).attr('content') || $(field).text())).filter(text => text
        && !text.split(/,\s*/).includes(id));
    return fields || [...new Set(fullAddresses)].join('; ');
  }).filter(Boolean);
  const displayLocations = $('.jobGeoLocation').toArray().map(node => value($(node).text()))
    .filter(text => text && !text.split(/,\s*/).includes(id));
  const displayLocation = [...new Set(displayLocations)].join('; ');
  return { title, company: uniqueNames.length === 1 ? uniqueNames[0] : undefined,
    location: displayLocation || [...new Set(locations)].join('; ') || undefined };
}

/** Shared recovery for acquisition, manual refresh and the historical backfill. */
export async function recoverSuccessFactorsMetadata(html: string, url: string,
  readPage: (url: string) => Promise<string>): Promise<SuccessFactorsMetadata | null> {
  const primary = parseSuccessFactorsPostingHtml(html, url);
  const identity = successFactorsPostingIdentity(url);
  if (!primary || !identity || (primary.company && primary.location)) return primary;
  const site = successFactorsCareerSite(html);
  if (!site) return primary;
  const search = new URL('/search/', site);
  search.searchParams.set('q', identity.id);
  const searchHtml = await readPage(search.href);
  const searchPage = cheerio.load(searchHtml);
  const portalName = publishedEmployerName(searchPage('meta[property="og:site_name"]').attr('content'))
    || publishedEmployerName(value(searchPage('title').text()).match(new RegExp(`^${identity.id}\\s+-\\s+(.+?)(?: Jobs| Careers)?$`, 'i'))?.[1]);
  const base = { ...primary, company: primary.company || portalName || undefined };
  const links = successFactorsCareerPostingLinks(searchHtml, site, primary.title);
  // Royal Mail moved the linked SAP portal to Phenom. Its public route and
  // JSON-LD retain the same SAP requisition; do not generalize this URL shape
  // to unrelated employers or accept a homepage as exact posting evidence.
  if (new URL(site).hostname === 'jobs.royalmailgroup.com' && !links.length) {
    const detailUrl = `https://careers.royalmailgroup.com/gb/en/job/${identity.id}/${encodeURIComponent(primary.title.replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, ''))}`;
    const detail = parseSuccessFactorsCareerPosting(await readPage(detailUrl), identity.id, primary.title);
    return detail ? { ...base, company: detail.company || base.company, location: primary.location || detail.location } : base;
  }
  // An ambiguous keyword result cannot identify this posting.
  if (links.length !== 1) return base;
  const detail = parseSuccessFactorsCareerPosting(await readPage(links[0]), identity.id, primary.title);
  return detail ? { ...base, company: detail.company || base.company, location: primary.location || detail.location } : base;
}
