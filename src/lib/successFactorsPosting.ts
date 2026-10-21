import * as cheerio from 'cheerio';
import { publishedEmployerName } from './publicAtsEmployer';

const value = (input: unknown) => typeof input === 'string' ? input.replace(/\s+/g, ' ').trim() : '';
const regionNames = new Intl.DisplayNames(['en'], { type: 'region' });
const countryNames = new Set(['United States of America', 'Turkey', 'Czech Republic', ...Array.from({ length: 676 }, (_v, index) => {
  const code = String.fromCharCode(65 + Math.floor(index / 26), 65 + index % 26);
  const name = regionNames.of(code);
  return name && name !== code && name !== 'Unknown Region' ? name : '';
})].filter(Boolean).map(name => name.toLowerCase()));
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
  if (tenant === 'grundfosP1' && logo === 'http://www.grundfos.com/content/dam/Global%20Site/successfactors/Grundfos_Logo-A_neg.png') return 'Grundfos';
  if (tenant === 'sanlamlifeP2' && logo === 'https://www.sanlam.co.za/Style%20Library/img/sanlam-logo.png') return 'Sanlam Group';
  if (tenant === 'engelhardaP' && logo === 'https://performancemanager5.successfactors.eu/companyLogoServlet/?companyId=engelhardaP') return 'Engelhard';
  return '';
}

/** Read only a literal array of strings. Never evaluate a page's event handler. */
export function successFactorsStringArray(source: string): string[] | null {
  let i = 0;
  const space = () => { while (/\s/.test(source[i] || '') && i < source.length) i++; };
  const result: string[] = [];
  space(); if (source[i++] !== '[') return null;
  while (i < source.length && result.length < 100) {
    space();
    if (source[i] === ']') { i++; space(); return i === source.length ? result : null; }
    const quote = source[i++];
    if (quote !== "'" && quote !== '"') return null;
    let text = '', closed = false;
    while (i < source.length) {
      let char = source[i++];
      if (char === quote) { closed = true; break; }
      if (char === '\\') {
        char = source[i++];
        if (char === 'u' || char === 'x') {
          const length = char === 'u' ? 4 : 2, hex = source.slice(i, i + length);
          if (!new RegExp(`^[0-9a-f]{${length}}$`, 'i').test(hex)) return null;
          text += String.fromCharCode(parseInt(hex, 16)); i += length; continue;
        }
        char = ({ n: '\n', r: '\r', t: '\t' } as Record<string, string>)[char] || char;
      }
      if (char === undefined || text.length > 500) return null;
      text += char;
    }
    if (!closed) return null;
    result.push(value(text)); space();
    if (source[i] === ',') i++;
    else if (source[i] !== ']') return null;
  }
  return null;
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
  // SAP lets employers customize this heading. Vestas uses "Talent Universe"
  // on the same tenant/requisition-bound posting template.
  const title = heading.match(new RegExp(`^(?:Career Opportunities|Talent Universe):\\s*(.+)\\s*\\(${identity.id}\\)$`))?.[1]?.trim();
  if (!title || !$('.joqReqDescription .externalPosting').length) return null;
  const descriptionText = value($('.joqReqDescription .externalPosting').text());
  const intro = descriptionText.slice(0, 2000);
  const declaredCompany = identity.tenant === 'ICCE' && /^We['’]re Coca-Cola Europacific Partners \(CCEP\)\./.test(intro)
    ? 'Coca-Cola Europacific Partners' : identity.tenant === 'tasmaniannP' && /\bAt TasNetworks,? we(?:['’]re| are)\b/.test(intro)
      ? 'TasNetworks' : identity.tenant === 'dinosolsup' && /\ben el Grupo DinoSol contamos\b/.test(intro)
        ? 'Grupo DinoSol' : identity.tenant === 'sarawakene' && /\bCompany\s*:\s*Sarawak Energy Berhad\b/.test(intro)
          ? 'Sarawak Energy Berhad' : identity.tenant === 'bancodepor' && /^O Banco de Portugal admite\b/.test(intro)
            ? 'Banco de Portugal' : identity.tenant === 'grupogarni' && /\bSi quieres unirte al equipo de Garnica,/.test(descriptionText)
              ? 'Garnica' : '';
  // This multi-brand board publishes its hiring business as a primary logo in
  // the posting itself. These exact first-party assets were visually verified;
  // never assign the masthead's retail brand to every business on the board.
  const primaryLogo = $('.joqReqDescription .externalPosting img[src]').first().attr('src') || '';
  const colombianaLogos: Record<string, string> = { 'Distribuciones.png': 'Corbeta', 'Casa_Principal.png': 'Corbeta',
    'AKT.png': 'AKT Motos', 'Alkomprar.png': 'Alkomprar', 'Corautos.png': 'Corautos Andino',
    'Alkosto.png': 'Alkosto', 'Kalley.png': 'Kalley', 'Ktronix.png': 'Ktronix', 'Alkosto_Narino.PNG': 'Alkosto' };
  const logoPrefix = 'https://hcm19.sapsf.com/doc/custom/colombiana/';
  const logoCompany = identity.tenant === 'colombiana' && primaryLogo.startsWith(logoPrefix)
    ? colombianaLogos[primaryLogo.slice(logoPrefix.length)] || '' : '';
  const company = successFactorsBrandedEmployer(html, identity.tenant) || declaredCompany || logoCompany;
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
  if (!location && identity.tenant === 'bancodepor' && company === 'Banco de Portugal') {
    const label = $('.externalPosting p').filter((_i, node) => value($(node).text()) === 'LOCAL DE TRABALHO');
    const places = label.next('ul').find('li').toArray().map(node => value($(node).text()).replace(/\.$/, ''));
    if (label.length === 1 && places.length) location = [...new Set(places)].join('; ');
  }
  if (!location && identity.tenant === 'grupogarni' && company === 'Garnica') {
    // This employer publishes the plant in the posting title. Accept only the
    // observed city suffixes, never arbitrary text after a title separator.
    location = /(?:\s*-\s*| HQ )(VALENCIA DE DON JUAN|BAÑOS DE RIO TOBIA|FUENMAYOR|LOGROÑO)$/i.exec(title)?.[1] || '';
  }
  const header = $('div[tabindex="0"]').filter((_i, node) =>
    value($(node).text()).startsWith(`Requisition ID ${identity.id} `)).filter((_i, node) => $(node).children('#postedOnDate').length === 1);
  if (!location && header.length === 1) {
    const geographic = header.find('.jobMFieldContent').toArray().flatMap(node => {
      const label = value($(node).text()).replace(/\s*\(\d+\)$/, '');
      const rank = /^(?:country(?:\/region)?)$/i.test(label) ? 3
        : /^(?:location: )?(?:state\/ pro(?:vience|vince)|state|province)$/i.test(label) ? 2
          : /^(?:location(?: search|: city)?|city|arbeitsort|standort)$/i.test(label)
            || (identity.tenant === 'dinosolsup' && label === 'Zona') ? 1 : 0;
      const callback = /^(?:javascript:)?showMFieldDialog\('([^']+)',\s*(\[[\s\S]*\])\)\s*;?$/.exec($(node).attr('onclick') || '');
      const values = callback && callback[1] === $(node).attr('id') ? successFactorsStringArray(callback[2])
        ?.filter(text => text && !/^(?:unknown(?: location)?|n\/a|not specified)$/i.test(text)) : null;
      return rank && values?.length ? [{ rank, values }] : [];
    }).sort((a, b) => a.rank - b.rank);
    if (geographic.length) location = [...new Set(geographic.flatMap(field => field.values))]
      .join(geographic.some(field => field.values.length > 1) ? '; ' : ', ');
    const fields = header.children('b').toArray().map(node => value($(node).text()));
    // These exact tenants' published headers have stable, verified columns.
    // Do not apply their positional schemas to another employer's custom fields.
    if (!location && identity.tenant === 'grundfosP1' && company === 'Grundfos' && fields.length >= 6 && fields.length <= 8
      && countryNames.has(fields[2].toLowerCase())) location = fields.slice(2, -3).reverse().join(', ');
    const provinces = /^(?:North West|Gauteng|Limpopo|Western Cape|Eastern Cape|Free State|Mpumalanga|KwaZulu[ -]Natal|Northern Cape)$/i;
    if (!location && identity.tenant === 'sanlamlifeP2' && company === 'Sanlam Group' && fields.length >= 5 && fields.length <= 7
      && provinces.test(fields.at(-2)!)) location = [fields.at(-1), fields.at(-2)].join(', ');
    if (!location && identity.tenant === 'colombiana' && fields.length === 4
      && /https:\/\/media\.aws\.alkosto\.com\/media\/catalog\/product\/c\/a\/casappal\.png/.test(html)) location = fields[3];
    if (!location && identity.tenant === 'tasmaniannP' && fields.length === 8 && /\bTasmania\b/.test(fields[4])) location = fields[4];
  }
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
  if (!primary || !identity) return primary;
  if (!primary.company && identity.tenant === 'colombiana') {
    const $ = cheerio.load(html);
    const logo = $('.joqReqDescription .externalPosting img[src]').first().attr('src') || '';
    if (logo.startsWith('data:image/png;base64,')) {
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(logo));
      const hash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
      const logos: Record<string, string> = {
        '30790ce436334d63d58c9c731869546f79ba82d897a4fb48c6d650b5b398df0e': 'Alkosto', 'f6c6034d92b3d00fa4cfc1936a6c29ddf56a6a89cff1fb42e77e079b97247209': 'Corbeta',
      };
      primary.company = logos[hash];
    }
  }
  if (primary.company && primary.location) return primary;
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
