/** Board identities for the serial public-career-site collector. No network or database dependencies. */
export const BROWSER_ATS_LABELS = {
  adp: 'ADP', avature: 'Avature', brassring: 'BrassRing', dzconnex: 'DZConneX', icims: 'iCIMS',
  paycom: 'Paycom', paylocity: 'Paylocity', phenom: 'Phenom', sagehr: 'Sage HR',
  talemetry: 'Talemetry', taleo: 'Taleo', jobvite: 'Jobvite', freshteam: 'Freshteam', cats: 'CATS',
} as const;
export type BrowserAtsPlatform = keyof typeof BROWSER_ATS_LABELS;
export const BROWSER_ATS_PLATFORMS = Object.keys(BROWSER_ATS_LABELS) as BrowserAtsPlatform[];
export const isBrowserAtsPlatform = (platform: string): platform is BrowserAtsPlatform => Object.hasOwn(BROWSER_ATS_LABELS, platform);
export const NON_API_ATS_PLATFORMS = ['gusto', ...BROWSER_ATS_PLATFORMS];
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const tenant = (host: string, suffix: string) => host.endsWith('.' + suffix)
  && !/^(?:www|api|app|support|docs|help|blog|cdn|assets|qa|test|training)(?:[.-]|$)/i.test(host.slice(0, -suffix.length - 1));
// Phenom often uses employer-owned domains. Harvest only verified hosts until a
// public employer page establishes another host's publishing technology.
export const PHENOM_BOARD_HOSTS = ['jobs.thecignagroup.com', 'careers.arrow.com'];
export const BROWSER_ATS_PATTERNS: Record<BrowserAtsPlatform, string[]> = {
  adp: ['workforcenow.adp.com/mascsr/default/mdf/recruitment/*'],
  avature: ['*.avature.net/*', 'apply.deloitte.com/*'],
  brassring: ['sjobs.brassring.com/TGnewUI/*'], dzconnex: ['*.dzconnex.com/*'],
  icims: ['*.icims.com/jobs/*'], paycom: ['www.paycomonline.net/v4/ats/*', 'paycomonline.net/v4/ats/*'],
  paylocity: ['recruiting.paylocity.com/recruiting/jobs/All/*', 'recruiting.paylocity.com/Recruiting/Jobs/All/*'],
  phenom: PHENOM_BOARD_HOSTS.map(host => host + '/*'), sagehr: ['talent.sage.hr/*/vacancies'],
  talemetry: ['*.ttcportals.com/*'], taleo: ['*.taleo.net/careersection/*'],
  jobvite: ['jobs.jobvite.com/*', 'careers.jobvite.com/*'], freshteam: ['*.freshteam.com/jobs*'], cats: ['*.catsone.com/careers/*'],
};
/** Rebuild a canonical board from published tenant IDs, never from company-name guesses. */
export function browserAtsBoardFromUrl(platform: string, value: string): string | null {
  if (!isBrowserAtsPlatform(platform)) return null;
  try {
    const u = new URL(value);
    if (!['https:', 'http:'].includes(u.protocol) || u.username || u.password || u.port) return null;
    const host = u.hostname.toLowerCase(), p = u.pathname;
    const origin = 'https://' + host;
    if (platform === 'adp' && host === 'workforcenow.adp.com' && /\/recruitment\.html$/i.test(p)) {
      const cid = u.searchParams.get('cid') || '', ccId = u.searchParams.get('ccId') || '19000101_000001';
      return UUID.test(cid) && /^[\w-]+$/.test(ccId) ? origin + '/mascsr/default/mdf/recruitment/recruitment.html?' + new URLSearchParams({cid: cid.toLowerCase(), ccId, lang: 'en_US'}) : null;
    }
    if (platform === 'icims' && tenant(host, 'icims.com') && /^\/jobs(?:\/|$)/i.test(p)) return origin + '/jobs/search?in_iframe=1';
    if (platform === 'avature' && !/^(?:qa|test|training)/i.test(host) && (tenant(host, 'avature.net') || host === 'apply.deloitte.com')) {
      const m = /^(\/(?:[\w-]+\/)*)(?:SearchJobs|JobDetail|FolderDetail|InviteToApply)(?:\/|$)/i.exec(p);
      return m && !/example|training/i.test(m[1]) ? origin + m[1] + 'SearchJobs' : null;
    }
    if (platform === 'paylocity' && host === 'recruiting.paylocity.com') {
      const id = /\/jobs\/All\/([a-f0-9-]{36})(?:\/|$)/i.exec(p)?.[1];
      return id && UUID.test(id) ? origin + '/recruiting/jobs/All/' + id.toLowerCase() : null;
    }
    if (platform === 'paycom' && ['www.paycomonline.net', 'paycomonline.net'].includes(host) && p.startsWith('/v4/ats/')) {
      const id = /\/portal\/([a-f0-9]{32})(?:\/|$)/i.exec(p)?.[1] || u.searchParams.get('clientkey');
      return id && /^[a-f0-9]{32}$/i.test(id) ? 'https://www.paycomonline.net/v4/ats/web.php/portal/' + id.toUpperCase() + '/career-page' : null;
    }
    if (platform === 'taleo' && tenant(host, 'taleo.net')) {
      const portal = /^\/careersection\/([\w-]+)\/(?:jobsearch|jobdetail)\.ftl$/i.exec(p)?.[1];
      return portal ? origin + '/careersection/' + portal + '/jobsearch.ftl' : null;
    }
    if (platform === 'brassring' && host === 'sjobs.brassring.com' && /^\/TGnewUI\/Search\//i.test(p)) {
      const entries = Object.fromEntries([...u.searchParams].map(([k,v])=>[k.toLowerCase(),v]));
      return /^\d+$/.test(entries.partnerid || '') && /^\d+$/.test(entries.siteid || '') ? origin + '/TGnewUI/Search/Home/Home?' + new URLSearchParams({partnerid:entries.partnerid,siteid:entries.siteid}) : null;
    }
    if (platform === 'dzconnex' && tenant(host, 'dzconnex.com')) return origin + '/';
    if (platform === 'talemetry' && tenant(host, 'ttcportals.com')) return origin + '/search/jobs';
    if (platform === 'sagehr' && host === 'talent.sage.hr') {
      const id = /^\/([a-f0-9-]{36})\/vacancies\/?$/i.exec(p)?.[1];
      return id && UUID.test(id) ? origin + '/' + id.toLowerCase() + '/vacancies' : null;
    }
    if (platform === 'phenom' && PHENOM_BOARD_HOSTS.includes(host)) {
      const locale = /^\/([a-z]{2}\/[a-z]{2})(?:\/|$)/i.exec(p)?.[1];
      return locale ? origin + '/' + locale + '/search-results' : null;
    }
    if (platform === 'jobvite' && ['jobs.jobvite.com','careers.jobvite.com'].includes(host)) {
      const name = /^\/([\w-]+)(?:\/|$)/.exec(p)?.[1];
      return name && !['careers','careersite','careersites','__assets__','css','js','api'].includes(name.toLowerCase()) ? 'https://jobs.jobvite.com/' + name + '/jobs' : null;
    }
    if (platform === 'freshteam' && tenant(host, 'freshteam.com') && /^\/jobs(?:\/|$)/.test(p)) return origin + '/jobs';
    if (platform === 'cats' && tenant(host, 'catsone.com')) {
      const id = /^\/careers\/(\d+)(?:-[^/]*)?(?:\/|$)/.exec(p)?.[1];
      return id ? origin + '/careers/' + id + '/' : null;
    }
    return null;
  } catch { return null; }
}
export const browserAtsDiscoveryAdapters = Object.fromEntries(BROWSER_ATS_PLATFORMS.map(platform => [platform, {
  cc_pattern: BROWSER_ATS_PATTERNS[platform], extract_slug: (url: string) => browserAtsBoardFromUrl(platform, url),
  test_api: '', get_jobs: (_data: unknown): unknown[] => [],
}])) as Record<BrowserAtsPlatform, {cc_pattern: string[]; extract_slug: (url: string) => string | null; test_api: string; get_jobs: (data: any) => any[]}>;
