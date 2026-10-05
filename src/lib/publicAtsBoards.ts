import * as cheerio from 'cheerio';

type RecordValue = Record<string, unknown>;
export const PUBLIC_ATS_PLATFORMS = ['dayforce', 'oracle', 'ukg', 'comeet', 'successfactors'] as const;
export type PublicAtsPlatform = typeof PUBLIC_ATS_PLATFORMS[number];
export type PublicAtsConfig = { company: string; token?: string };
export const isPublicAtsPlatform = (platform: string): platform is PublicAtsPlatform =>
  (PUBLIC_ATS_PLATFORMS as readonly string[]).includes(platform);
const atom = /^[a-z0-9_.-]+$/i;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const sapHost = /^career\d*\.(?:successfactors|sapsf)\.(?:com|eu)$/i;
const ukgHost = /^recruiting\d*\.ultipro\.com$/i;
const text = (value: unknown): string => typeof value === 'string' ? value.trim() : '';
const object = (value: unknown): RecordValue => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('ATS listing schema expected an object');
  return value as RecordValue;
};
const array = (value: unknown): RecordValue[] => {
  if (!Array.isArray(value)) throw new Error('ATS listing schema expected an array');
  return value.map(object);
};
const required = (value: unknown): string => {
  const result = typeof value === 'number' ? String(value) : text(value);
  if (!result || !atom.test(result)) throw new Error('ATS listing schema has no valid posting identity');
  return result;
};

/** Vendor-owned URLs identify a board. Employer vanity domains never supply guessed IDs. */
export function publicAtsBoardSlugFromUrl(value: string, platform: PublicAtsPlatform): string | null {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port) return null;
    const host = url.hostname.toLowerCase();
    const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    if (platform === 'oracle' && host.endsWith('.oraclecloud.com')) {
      const match = url.pathname.match(/^\/hcmUI\/CandidateExperience\/[^/]+\/sites\/([a-z0-9_-]+)(?:\/|$)/i);
      return match ? `${host}::${match[1]}` : null;
    }
    if (platform === 'ukg' && ukgHost.test(host) && parts[1]?.toLowerCase() === 'jobboard'
      && atom.test(parts[0]) && uuid.test(parts[2] || '')) return `${host}::${parts[0]}::${parts[2].toLowerCase()}`;
    if (platform === 'comeet' && /^(?:www\.)?comeet\.(?:com|co)$/.test(host)
      && parts[0] === 'jobs' && atom.test(parts[1] || '') && /^[a-z0-9]+\.[a-z0-9]+$/i.test(parts[2] || '')) {
      return `${parts[1]}::${parts[2]}`;
    }
    if (platform === 'dayforce' && /^jobs\.dayforce(?:hcm)?\.com$/.test(host)) {
      const tenant = /^[a-z]{2}-[a-z]{2}$/i.test(parts[0] || '') ? parts[1] : parts[0];
      return tenant && atom.test(tenant) && !['api', 'assets', 'jobs'].includes(tenant.toLowerCase()) ? tenant : null;
    }
    if (platform === 'successfactors' && sapHost.test(host) && /^\/career(?:;[^/]*)?\/?$/i.test(url.pathname)) {
      const companies = url.searchParams.getAll('company');
      const locales = url.searchParams.getAll('rcm_site_locale');
      if (companies.length !== 1 || !atom.test(companies[0]) || locales.length > 1
        || (locales[0] && !/^[a-z]{2}_[a-z]{2}$/i.test(locales[0]))) return null;
      return `${host}::${companies[0]}::${locales[0] || 'default'}`;
    }
  } catch { /* Malformed paths and encodings do not identify a board. */ }
  return null;
}

export function publicAtsBoardUrl(platform: PublicAtsPlatform, slug: string): string {
  const [first, second, third] = slug.split('::');
  let url: URL;
  if (platform === 'oracle') url = new URL(`https://${first}/hcmUI/CandidateExperience/en/sites/${second}/`);
  else if (platform === 'ukg') url = new URL(`https://${first}/${second}/JobBoard/${third}`);
  else if (platform === 'comeet') url = new URL(`https://www.comeet.com/jobs/${first}/${second}`);
  else if (platform === 'dayforce') url = new URL(`https://jobs.dayforcehcm.com/en-US/${first}/CANDIDATEPORTAL`);
  else {
    url = new URL(`https://${first}/career`);
    url.searchParams.set('company', second);
    if (third !== 'default') url.searchParams.set('rcm_site_locale', third);
  }
  if (publicAtsBoardSlugFromUrl(url.href, platform) !== slug) throw new Error(`Invalid ${platform} board identity`);
  return url.href;
}

export function publicAtsPageSize(platform: string): number | null {
  return platform === 'oracle' ? 25 : platform === 'ukg' ? 20 : null;
}

export function buildPublicAtsBoardRequest(platform: PublicAtsPlatform, slug: string, offset = 0,
  config?: PublicAtsConfig): { url: string; init: RequestInit } {
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('Invalid ATS listing offset');
  const board = new URL(publicAtsBoardUrl(platform, slug));
  const [first, second] = slug.split('::');
  if (platform === 'oracle') {
    const url = new URL('/hcmRestApi/resources/latest/recruitingCEJobRequisitions', board);
    url.searchParams.set('onlyData', 'true');
    url.searchParams.set('expand', 'requisitionList');
    url.searchParams.set('finder', `findReqs;siteNumber=${second},limit=25,offset=${offset},sortBy=POSTING_DATES_DESC`);
    return { url: url.href, init: {} };
  }
  if (platform === 'ukg') return { url: `${board.href}/JobBoardView/LoadSearchResults`, init: {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ opportunitySearch: { Top: 20, Skip: offset, QueryString: '', Filters: [] } }),
  } };
  if (platform === 'comeet') {
    const url = new URL(`https://www.comeet.co/careers-api/2.0/company/${second}/positions`);
    url.searchParams.set('details', 'true');
    if (config?.token) url.searchParams.set('token', config.token);
    return { url: url.href, init: {} };
  }
  if (platform === 'dayforce') return { url: `https://www.dayforcehcm.com/api/${first}/V1/JobFeeds`, init: {} };
  board.searchParams.set('career_ns', 'job_listing_summary');
  board.searchParams.set('resultType', 'XML');
  return { url: board.href, init: {} };
}

/** Read a JSON object from public page configuration without evaluating page scripts. */
export function assignedPublicJson(source: string, name: string): RecordValue | null {
  const match = new RegExp(`\\b${name}\\s*=\\s*\\{`).exec(source);
  if (!match) return null;
  const start = match.index + match[0].lastIndexOf('{');
  let depth = 0, quoted = false, escaped = false;
  for (let index = start; index < source.length; index++) {
    const c = source[index];
    if (quoted) { if (escaped) escaped = false; else if (c === '\\') escaped = true; else if (c === '"') quoted = false; continue; }
    if (c === '"') quoted = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) {
      try { return object(JSON.parse(source.slice(start, index + 1))); } catch { return null; }
    }
  }
  return null;
}

export function parsePublicAtsConfig(platform: PublicAtsPlatform, slug: string, html: string): PublicAtsConfig {
  const $ = cheerio.load(html);
  if (platform === 'comeet') {
    const data = assignedPublicJson(html, 'COMPANY_DATA');
    if (text(data?.company_uid) !== slug.split('::')[1] || !text(data?.token) || !text(data?.name)) {
      throw new Error('Comeet public career configuration identity mismatch');
    }
    return { company: text(data!.name), token: text(data!.token) };
  }
  let company = text($('meta[property="og:site_name"]').attr('content'));
  if (platform === 'successfactors' && !company) {
    // This tenant's public career page identifies DeLaval through its branded
    // header. Keep both the exact tenant and its actual branding evidence:
    // an opaque SAP company ID alone is never an employer-name fallback.
    if (slug.startsWith('career5.successfactors.eu::C0001122692P::')
      && html.includes('https://store.delaval.com/globalassets/logo_delaval_ats.png')) company = 'DeLaval';
    for (const script of $('script[type="application/ld+json"]').toArray()) {
      try {
        const data = JSON.parse($(script).text());
        const records = Array.isArray(data) ? data : Array.isArray(data['@graph']) ? data['@graph'] : [data];
        const employers = records.filter((entry: RecordValue) => entry?.['@type'] === 'JobPosting')
          .map((entry: RecordValue) => text((entry.hiringOrganization as RecordValue)?.name)).filter(Boolean);
        if (new Set(employers).size === 1) company = employers[0];
      } catch { /* Invalid structured data does not supply employer authority. */ }
    }
  }
  return { company: /^(?:oracle(?: cloud)?|careers?|jobs?|candidate experience|successfactors)$/i.test(company) ? '' : company };
}

function sameBoardPosting(url: string, platform: PublicAtsPlatform, slug: string): string {
  if (publicAtsBoardSlugFromUrl(url, platform) !== slug) throw new Error(`${platform} posting URL does not match its board`);
  return new URL(url).href;
}

export function parsePublicAtsListing(platform: PublicAtsPlatform, slug: string, parsed: unknown,
  bodyText: string | null = null, config: PublicAtsConfig = { company: '' }):
  { jobs: RecordValue[]; metadata: RecordValue; total: number | null } {
  const boardUrl = publicAtsBoardUrl(platform, slug);
  let rows: RecordValue[], total: number | null = null;
  if (platform === 'successfactors') {
    const xml = cheerio.load(bodyText || '', { xmlMode: true });
    const roots = xml.root().children().filter((_i, element) => element.type === 'tag');
    if (roots.length !== 1 || !roots.is('Job-Listing') || roots.children().toArray().some(node => node.type === 'tag' && node.name !== 'Job')) {
      throw new Error('SuccessFactors listing schema expected a Job-Listing XML root');
    }
    rows = roots.children('Job').toArray().map(node => {
      const job = xml(node), value = (key: string) => job.children(key).first().text().trim();
      const id = required(value('ReqId')), title = value('JobTitle'), description = value('Job-Description');
      if (!title || !description) throw new Error('SuccessFactors job listing schema is incomplete');
      const url = new URL(boardUrl);
      url.searchParams.set('career_ns', 'job_listing'); url.searchParams.set('career_job_req_id', id);
      return { id: `${slug}::${id}`, title, description, location: value('Location'),
        company: value('CompanyName') || config.company, url: url.href, createdAt: value('Posted-Date'), publicAtsPostingId: id };
    });
  } else {
    if (platform === 'oracle') {
      const items = array(object(parsed).items);
      if (items.length !== 1) throw new Error('Oracle listing schema expected one search envelope');
      rows = array(items[0].requisitionList);
      total = Number(items[0].TotalJobsCount);
    } else if (platform === 'ukg') { const data = object(parsed); rows = array(data.opportunities); total = Number(data.totalCount); }
    else rows = array(parsed);
    if (total !== null && (!Number.isSafeInteger(total) || total < 0)) throw new Error(`${platform} listing schema has invalid total`);
    rows = rows.filter(row => platform !== 'comeet' || row.is_internal !== true).map(row => {
      const dayforceUrl = platform === 'dayforce' ? text(row.JobDetailsUrl) : '';
      const id = required(platform === 'oracle' || platform === 'ukg' ? row.Id : platform === 'comeet' ? row.uid
        : new URL(dayforceUrl).pathname.match(/\/jobs\/([^/]+)\/?$/)?.[1]);
      const title = text(row.Title || row.name);
      if (!title) throw new Error(`${platform} listing schema has no title`);
      let url: string, company: string, location: string, description = '', createdAt: unknown;
      if (platform === 'oracle') {
        url = `${boardUrl}job/${id}/`;
        company = text(row.LegalEmployer) || config.company;
        location = text(row.PrimaryLocation); createdAt = row.PostedDate;
      } else if (platform === 'ukg') {
        if (!uuid.test(id)) throw new Error('UKG listing schema has an invalid opportunity identity');
        url = `${boardUrl}/OpportunityDetail?opportunityId=${id}`;
        company = config.company; createdAt = row.PostedDate;
        location = array(row.Locations).map(place => text(place.LocalizedDescription)
          || [object(place.Address || {}).City, object(object(place.Address || {}).State || {}).Code,
            object(object(place.Address || {}).Country || {}).Name].map(text).filter(Boolean).join(', ')).filter(Boolean).join('; ');
      } else if (platform === 'comeet') {
        url = sameBoardPosting(text(row.url_comeet_hosted_page || row.url_recruit_hosted_page), platform, slug);
        company = text(row.company_name) || config.company;
        const place = object(row.location || {});
        location = [place.city, place.state, place.country].map(text).filter(Boolean).join(', ') || text(place.name);
        const arrangement = text(row.workplace_type);
        if (arrangement) location = `${location} (${arrangement})`;
        description = array(row.details).map(detail => `${text(detail.name)}\n${text(detail.value)}`).filter(Boolean).join('\n\n');
        createdAt = row.time_created; // time_updated is a refresh date, not a publication date.
      } else {
        url = sameBoardPosting(text(row.JobDetailsUrl), platform, slug);
        company = text(row.CompanyName); description = text(row.Description); createdAt = row.DatePosted;
        location = [row.City, row.State, row.Country].map(text).filter(Boolean).join(', ');
        if (row.IsVirtualLocation === true) location = `${location} (Remote)`;
      }
      if ((platform === 'comeet' || platform === 'dayforce') && (!company || !description)) {
        throw new Error(`${platform} listing schema has no employer or full description`);
      }
      // Dayforce repeats requisitions for each locale and client career site.
      const sourceId = platform === 'dayforce' ? new URL(url).pathname.split('/').filter(Boolean).map(encodeURIComponent).join('::') : id;
      return { id: `${slug}::${sourceId}`, publicAtsPostingId: id, title, company, location, description, url,
        ...(typeof createdAt === 'string' && createdAt ? { createdAt } : {}) };
    });
  }
  return { jobs: rows, metadata: { name: config.company }, total };
}

/** Reconstruct pagination locally; never follow a URL supplied by a feed. */
export function teamtailorHasMore(data: RecordValue, requestedUrl?: string): boolean {
  if (data.next_url === undefined || data.next_url === null || data.next_url === '') return false;
  if (typeof data.next_url !== 'string') throw new Error('Teamtailor listing schema has an invalid next page');
  const next = new URL(data.next_url);
  if (!/^https:\/\/[^./]+\.teamtailor\.com\/jobs\.json$/.test(`${next.origin}${next.pathname}`)
    || next.username || next.password || next.searchParams.get('per_page') !== '100'
    || !/^[1-9]\d*$/.test(next.searchParams.get('page') || '')) throw new Error('Teamtailor listing schema has an invalid next page');
  if (requestedUrl) {
    const current = new URL(requestedUrl);
    if (next.origin !== current.origin || Number(next.searchParams.get('page')) !== Number(current.searchParams.get('page') || 1) + 1) {
      throw new Error('Teamtailor listing schema next page does not advance this board');
    }
  }
  return true;
}
