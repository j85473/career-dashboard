import { publicAtsBoardUrl, publicAtsBoardSlugFromUrl, parsePublicAtsConfig } from './publicAtsBoards';
import { oracleCareerSiteUrl, oracleCareerSiteEmployer, publishedEmployerName, resolveUkgBoardEmployer, oracleEmployerWebsiteUrl, employerWebsiteName } from './publicAtsEmployer';
import { verifiedAtsBoardEmployer } from './atsEmployerRegistry';
import { safeExternalFetch } from './safeExternalFetch';

const cache = new Map<string, { expiresAt: number; result: Promise<string> }>();
export type AtsPostingEmployerEvidence = { company: string; description: string | null; location: string | null };
const postingCache = new Map<string, { expiresAt: number; result: Promise<AtsPostingEmployerEvidence | null> }>();
export type AtsEmployerEvidenceDependencies = {
  fetchPage: (url: string) => Promise<Response>;
  registry: typeof verifiedAtsBoardEmployer;
};
type PublishedPage = { url: string; html: string };
export type AtsPostingEvidenceResponse = { url: string; response: Response };

/** A board alias is usable only after the exact saved requisition survives the
 * redirect. A different site on the same tenant is not, by itself, evidence. */
export async function readPublishedAtsPostingEvidence(platform: string, slug: string,
  job: Record<string, unknown>, dependencies: AtsEmployerEvidenceDependencies,
  initial?: AtsPostingEvidenceResponse): Promise<AtsPostingEmployerEvidence | null> {
  if (!['oracle', 'ukg'].includes(platform) || typeof job.url !== 'string'
    || typeof job.title !== 'string' || !job.title.trim()
    || publicAtsBoardSlugFromUrl(job.url, platform as 'oracle' | 'ukg') !== slug) return null;
  const [{ oraclePostingDetailUrl, parseOraclePostingDetail }, { parseUkgPostingHtml, ukgPostingIdentity }] = await Promise.all([
    import('./oraclePosting'), import('./ukgPosting'),
  ]);
  const requested = new URL(job.url);
  const postingId = String(job.publicAtsPostingId || '');
  const original = platform === 'oracle' ? oraclePostingDetailUrl(job.url) : ukgPostingIdentity(job.url);
  if (!original || !postingId || (platform === 'oracle'
    ? requested.pathname.split('/').filter(Boolean).at(-1) !== postingId
    : ukgPostingIdentity(job.url)?.id !== postingId.toLowerCase())) return null;
  const normalizeTitle = (title: string) => title.replace(/\s+/g, ' ').trim();
  const employerName = (value: unknown, url: URL) => value === 'Oracle' && url.hostname === 'eeho.fa.us2.oraclecloud.com'
    ? 'Oracle' : publishedEmployerName(value);
  const evidence = (detail: { title?: string; company?: string; text: string; location?: string } | null, url: URL) => {
    if (!detail?.title || normalizeTitle(detail.title) !== normalizeTitle(job.title as string)) return null;
    return { company: employerName(detail.company, url) || employerName(job.company, requested),
      description: detail.text || null, location: detail.location || null };
  };
  // Acquisition already has the exact API response. Reuse it, and avoid a
  // posting-page lookup when its own employer evidence is sufficient.
  let initialPayload: unknown;
  if (platform === 'oracle' && initial && initial.url === oraclePostingDetailUrl(job.url)?.href && initial.response.ok) {
    if (new URL(initial.response.url || initial.url).href !== initial.url) return null;
    initialPayload = await initial.response.json();
    const found = evidence(parseOraclePostingDetail(initialPayload, job.url), requested);
    if (!found) return null;
    if (found.company) return found;
  }
  const page = await dependencies.fetchPage(job.url);
  if (!page.ok) return null;
  const landed = new URL(page.url || job.url);
  const canonicalSlug = publicAtsBoardSlugFromUrl(landed.href, platform as 'oracle' | 'ukg');
  if (!canonicalSlug || requested.protocol !== 'https:' || landed.protocol !== 'https:'
    || landed.username || landed.password || landed.port) return null;
  if (platform === 'oracle') {
    if (landed.origin !== requested.origin || !oraclePostingDetailUrl(landed.href)
      || landed.pathname.split('/').filter(Boolean).at(-1) !== postingId) return null;
  } else {
    const identity = ukgPostingIdentity(landed.href), prior = ukgPostingIdentity(job.url)!;
    if (!identity || identity.id !== prior.id || identity.boardPath.toLowerCase() !== prior.boardPath.toLowerCase()) return null;
  }
  const html = await page.text();
  let found: AtsPostingEmployerEvidence | null;
  if (platform === 'ukg') {
    found = evidence(parseUkgPostingHtml(html, landed.href), landed);
  } else {
    const detailUrl = oraclePostingDetailUrl(landed.href)!;
    let payload = initial?.url === detailUrl.href ? initialPayload : undefined;
    if (payload === undefined) {
      const response = initial?.url === detailUrl.href ? initial.response : await dependencies.fetchPage(detailUrl.href);
      if (!response.ok || new URL(response.url || detailUrl.href).href !== detailUrl.href) return null;
      payload = await response.json();
    }
    found = evidence(parseOraclePostingDetail(payload, landed.href, html), landed);
  }
  if (!found) return null;
  if (found.company) return found;
  // Reuse the already verified posting's header. Do not fetch an unrelated
  // site's home page or promote an alias into a permanent employer rule.
  const boardUrl = publicAtsBoardUrl(platform as 'oracle' | 'ukg', canonicalSlug);
  const company = await readPublishedAtsBoardEmployer(platform, canonicalSlug, dependencies, { url: boardUrl, html });
  return company ? { ...found, company } : null;
}

function employerEvidenceDependencies(platform: string, slug: string): AtsEmployerEvidenceDependencies {
  const signal = AbortSignal.timeout(15000);
  return {
    registry: verifiedAtsBoardEmployer,
    fetchPage: async url => {
      const boardHost = new URL(publicAtsBoardUrl(platform as 'oracle' | 'ukg' | 'zohorecruit', slug)).hostname;
      if (new URL(url).hostname !== boardHost && publicAtsBoardSlugFromUrl(url, 'ukg') === null) {
        return safeExternalFetch(url, { signal, headers: { 'User-Agent': 'Mozilla/5.0' } });
      }
      const [{ fetchAtsPlatformResponse }, { reserveProviderBudgetForSource }] = await Promise.all([
        import('./jobIngestion'), import('./ingestionControl'),
      ]);
      return fetchAtsPlatformResponse(platform, signal, async () => {
        const available = await reserveProviderBudgetForSource('ATS-' + platform);
        if (!available.allowed) throw new Error('Employer recovery awaits the provider cooldown');
        if (/\/OpportunityDetail\/?$|\/recruitingCEJobRequisitionDetails$|\/sites\/[^/]+\/job\/[^/]+\/?$/i.test(new URL(url).pathname)) {
          const details = await reserveProviderBudgetForSource('ATS-' + platform + ' Details');
          if (!details.allowed) throw new Error('Employer recovery awaits the detail request budget');
        }
        return safeExternalFetch(url, { signal, headers: { 'User-Agent': 'Mozilla/5.0' } });
      }, { requestedUrl: url, boardSlug: slug, recordPlatformFailures: false });
    },
  };
}

/** Fill missing evidence on a consumer's local copy; saved manifests and
 * terminal markers remain immutable, and failed proofs retain their hold. */
export async function recoverPublishedAtsPostingEvidence(platform: string, slug: string,
  job: Record<string, unknown>): Promise<AtsPostingEmployerEvidence | null> {
  if (!['oracle', 'ukg'].includes(platform)) return null;
  const key = JSON.stringify([platform, slug, job.url, job.publicAtsPostingId, job.title]);
  const prior = postingCache.get(key);
  if (prior && prior.expiresAt > Date.now()) return prior.result;
  const result = readPublishedAtsPostingEvidence(platform, slug, job, employerEvidenceDependencies(platform, slug)).catch(() => null);
  if (postingCache.size >= 1000) postingCache.delete(postingCache.keys().next().value!);
  postingCache.set(key, { expiresAt: Date.now() + 5 * 60_000, result });
  return result;
}

/** Source-verified metadata recovery; never infer a name from an opaque tenant. */
export async function readPublishedAtsBoardEmployer(platform: string, slug: string,
  dependencies: AtsEmployerEvidenceDependencies, page?: PublishedPage): Promise<string> {
  if (!['oracle', 'ukg', 'zohorecruit'].includes(platform)) return '';
  const registered = await dependencies.registry(platform, slug);
  if (registered) return registered;
  const supported = platform as 'oracle' | 'ukg' | 'zohorecruit';
  const url = publicAtsBoardUrl(supported, slug);
  if (!page) {
    const response = await dependencies.fetchPage(url);
    if (!response.ok) return '';
    page = { url: response.url || url, html: await response.text() };
  }
  const respondedSlug = publicAtsBoardSlugFromUrl(page.url, supported);
  // Oracle's own former CX entry now redirects to its branded jobsearch site.
  // This exact alias still requires Oracle's corporate-logo evidence below.
  const ownOracleAlias = platform === 'oracle' && slug === 'eeho.fa.us2.oraclecloud.com::CX'
    && respondedSlug === 'eeho.fa.us2.oraclecloud.com::jobsearch';
  if (respondedSlug !== slug && !ownOracleAlias) return '';
  const html = page.html;
  let company = parsePublicAtsConfig(supported, slug, html).company;
  if (ownOracleAlias && company !== 'Oracle') return '';
  if (platform === 'oracle' && !company) {
    const employerUrl = oracleEmployerWebsiteUrl(html, url);
    if (employerUrl) {
      const employer = await dependencies.fetchPage(employerUrl);
      if (employer.ok) company = employerWebsiteName(await employer.text(), employerUrl, employer.url || employerUrl);
    }
    const metadataUrl = oracleCareerSiteUrl(url, html);
    if (!company && metadataUrl) {
      const metadata = await dependencies.fetchPage(metadataUrl);
      if (metadata.ok && new URL(metadata.url || metadataUrl).origin === new URL(url).origin) {
        company = oracleCareerSiteEmployer(await metadata.json(), url, html);
      }
    }
  }
  if (platform === 'ukg' && !company) company = await resolveUkgBoardEmployer(html, url, dependencies.fetchPage);
  return company === 'Oracle' && slug.startsWith('eeho.fa.us2.oraclecloud.com::') ? company : publishedEmployerName(company);
}

/** Coalesce recovery across a consumer's items, keeping failed probes bounded. */
export async function recoverPublishedAtsBoardEmployer(platform: string, slug: string, page?: PublishedPage): Promise<string> {
  const key = platform + ':' + slug;
  const prior = cache.get(key);
  if (prior && prior.expiresAt > Date.now()) return prior.result;
  const result = readPublishedAtsBoardEmployer(platform, slug, employerEvidenceDependencies(platform, slug), page).catch(() => '');
  cache.set(key, { expiresAt: Date.now() + 5 * 60_000, result });
  const name = await result;
  if (cache.get(key)?.result === result && name) cache.set(key, { expiresAt: Date.now() + 60 * 60_000, result });
  return name;
}

/** Compatibility recovery for immutable handoffs made before acquisition
 * required a verified employer. New handoffs already carry this evidence. */
export async function recoverRetainedAtsEmployerEvidence(platform: string, slug: string,
  job: Record<string, unknown>, recovery = {
    boardEmployer: recoverPublishedAtsBoardEmployer,
    postingEvidence: recoverPublishedAtsPostingEvidence,
  }): Promise<AtsPostingEmployerEvidence | null> {
  const supplied = typeof job.company === 'string' ? job.company : '';
  if (supplied === 'Oracle' || publishedEmployerName(supplied)) {
    return { company: supplied, description: null, location: null };
  }
  const company = await recovery.boardEmployer(platform, slug);
  return company ? { company, description: null, location: null }
    : recovery.postingEvidence(platform, slug, job);
}
