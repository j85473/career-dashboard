import { publicAtsBoardUrl, publicAtsBoardSlugFromUrl, parsePublicAtsConfig } from './publicAtsBoards';
import { oracleCareerSiteUrl, oracleCareerSiteEmployer, publishedEmployerName, resolveUkgBoardEmployer, oracleEmployerWebsiteUrl, employerWebsiteName } from './publicAtsEmployer';
import { verifiedAtsBoardEmployer } from './atsEmployerRegistry';
import { safeExternalFetch } from './safeExternalFetch';

const cache = new Map<string, { expiresAt: number; result: Promise<string> }>();
type Dependencies = {
  fetchPage: (url: string) => Promise<Response>;
  registry: typeof verifiedAtsBoardEmployer;
};

/** Source-verified metadata recovery; never infer a name from an opaque tenant. */
export async function readPublishedAtsBoardEmployer(platform: string, slug: string,
  dependencies: Dependencies): Promise<string> {
  if (!['oracle', 'ukg', 'zohorecruit'].includes(platform)) return '';
  const registered = await dependencies.registry(platform, slug);
  if (registered) return registered;
  const supported = platform as 'oracle' | 'ukg' | 'zohorecruit';
  const url = publicAtsBoardUrl(supported, slug);
  const response = await dependencies.fetchPage(url);
  if (!response.ok) return '';
  const respondedSlug = publicAtsBoardSlugFromUrl(response.url || url, supported);
  // Oracle's own former CX entry now redirects to its branded jobsearch site.
  // This exact alias still requires Oracle's corporate-logo evidence below.
  const ownOracleAlias = platform === 'oracle' && slug === 'eeho.fa.us2.oraclecloud.com::CX'
    && respondedSlug === 'eeho.fa.us2.oraclecloud.com::jobsearch';
  if (respondedSlug !== slug && !ownOracleAlias) return '';
  const html = await response.text();
  let company = parsePublicAtsConfig(supported, slug, html).company;
  if (ownOracleAlias && company !== 'Oracle') return '';
  if (platform === 'oracle' && !company) {
    const employerUrl = oracleEmployerWebsiteUrl(html, url);
    if (employerUrl) {
      const employer = await dependencies.fetchPage(employerUrl);
      if (employer.ok) company = employerWebsiteName(await employer.text(), employerUrl, employer.url || employerUrl);
    }
    const metadataUrl = oracleCareerSiteUrl(url);
    if (!company && metadataUrl) {
      const metadata = await dependencies.fetchPage(metadataUrl);
      if (metadata.ok && new URL(metadata.url || metadataUrl).origin === new URL(url).origin) {
        company = oracleCareerSiteEmployer(await metadata.json(), url);
      }
    }
  }
  if (platform === 'ukg' && !company) company = await resolveUkgBoardEmployer(html, url, dependencies.fetchPage);
  return company === 'Oracle' && slug.startsWith('eeho.fa.us2.oraclecloud.com::') ? company : publishedEmployerName(company);
}

/** Coalesce recovery across a consumer's items, keeping failed probes bounded. */
export async function recoverPublishedAtsBoardEmployer(platform: string, slug: string): Promise<string> {
  const key = platform + ':' + slug;
  const prior = cache.get(key);
  if (prior && prior.expiresAt > Date.now()) return prior.result;
  const result = readPublishedAtsBoardEmployer(platform, slug, {
    registry: verifiedAtsBoardEmployer,
    fetchPage: async url => {
      const signal = AbortSignal.timeout(15000);
      const boardHost = new URL(publicAtsBoardUrl(platform as 'oracle' | 'ukg' | 'zohorecruit', slug)).hostname;
      // The employer's corporate website has its own availability; a refusal
      // there must not open the ATS vendor's circuit.
      if (new URL(url).hostname !== boardHost) {
        return safeExternalFetch(url, { signal, headers: { 'User-Agent': 'Mozilla/5.0' } });
      }
      const [{ fetchAtsPlatformResponse }, { reserveProviderBudgetForSource }] = await Promise.all([
        import('./jobIngestion'), import('./ingestionControl'),
      ]);
      return fetchAtsPlatformResponse(platform, signal, async () => {
        const available = await reserveProviderBudgetForSource('ATS-' + platform);
        if (!available.allowed) throw new Error('Employer recovery awaits the provider cooldown');
        return safeExternalFetch(url, { signal, headers: { 'User-Agent': 'Mozilla/5.0' } });
      }, { requestedUrl: url, boardSlug: slug, recordPlatformFailures: false });
    },
  }).catch(() => '');
  cache.set(key, { expiresAt: Date.now() + 5 * 60_000, result });
  const name = await result;
  if (cache.get(key)?.result === result && name) cache.set(key, { expiresAt: Date.now() + 60 * 60_000, result });
  return name;
}
