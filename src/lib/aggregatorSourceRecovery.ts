import * as cheerio from 'cheerio';
import { extractJsonLdJobPosting, jsonLdCompanyName, jsonLdPageMetadata } from './atsApi';
import { isDirectPostingUrl, selectDirectAtsMatch, boardIdentityFromUrl, directAtsPostingKey,
  type DirectMatchJob, type DirectAtsMatch, type BoardPosting } from './atsDirectMatch';
import { cleanHtmlText, normalizeUrl } from './jobIngestion';
import { sameEmployer } from './employerIdentity';
import { safeExternalFetch } from './safeExternalFetch';
import { readBoundedAtsBody } from './tenantAtsBoards';
import { discoverEmployerBoards, type EmployerBoardDiscovery } from './employerAtsDiscovery';
import { getHimalayasCompanyDetails } from './himalayasMcp';
import { himalayasCompanySlug } from './himalayasEmployerResolution';

const SHARED_HOSTS = /(?:^|\.)(?:linkedin\.com|adzuna\.com|himalayas\.app|trabajo\.org|jobleads\.com|jooble\.org|indeed\.com|glassdoor\.com|ziprecruiter\.com|jobgether\.com|builtin\.com|facebook\.com|google\.com|appcast\.io|jobicy\.com|dejobs\.org|jobsyn\.org|weworkremotely\.com|bebee\.com|jobmesh\.io|jobilize\.com|lensa\.com|recruit\.net|snagajob\.com|monster\.com|tealhq\.com)$/i;
const httpUrl = (value: unknown, base: string): string | null => {
  try { const url = new URL(String(value || ''), base);
    return /^https?:$/.test(url.protocol) && !url.username && !url.password && value ? url.href : null;
  } catch { return null; }
};

export type SourcePageEvidence = { posting: BoardPosting; company: string; employerWebsite: string | null;
  employerPage: boolean; applyUrls: string[] };

/** Read a single source posting and its published application controls only. */
export function sourcePageEvidence(job: DirectMatchJob, html: string, pageUrl: string): SourcePageEvidence | null {
  const ld = extractJsonLdJobPosting(html, pageUrl);
  const company = jsonLdCompanyName(ld?.hiringOrganization);
  if (!ld || typeof ld.title !== 'string' || !company || !sameEmployer({ company }, { company: job.company })) return null;
  const posting = { title: ld.title, url: pageUrl, description: cleanHtmlText(String(ld.description || '')) || null,
    location: jsonLdPageMetadata(ld, html).location || null };
  if (!selectDirectAtsMatch(job, [posting])) return null;
  const $ = cheerio.load(html);
  const org = typeof ld.hiringOrganization === 'object' ? ld.hiringOrganization as Record<string, unknown> : {};
  const website = httpUrl(org.sameAs || org.url, pageUrl);
  const employerWebsite = website && !SHARED_HOSTS.test(new URL(website).hostname) ? website : null;
  const host = new URL(pageUrl).hostname;
  // Custom employer domains often host SuccessFactors/Phenom. Require the
  // platform's published widget assets AND this exact employer's JobPosting.
  const customPlatform = !SHARED_HOSTS.test(host) && (
    /https?:\/\/[^\s"'<>]*rmkcdn\.successfactors\.com\//i.test(html)
    || /https?:\/\/[^\s"'<>]*(?:phenompeople\.com|phenom\.com)\//i.test(html));
  const employerPage = isDirectPostingUrl(pageUrl) || customPlatform
    || Boolean(employerWebsite && new URL(employerWebsite).hostname === host);
  const applyUrls = new Set<string>();
  $('a[href]').each((_i, node) => {
    const label = $(node).text().trim().replace(/\s+/g, ' ');
    if (!/^(?:apply(?: now| for (?:this|the) (?:job|position))?|apply on (?:company|employer)(?: website| site)?)$/i.test(label)) return;
    const url = httpUrl($(node).attr('href'), pageUrl);
    if (url && normalizeUrl(url) !== normalizeUrl(pageUrl)) applyUrls.add(url);
  });
  // Trabajo publishes these signed GET destinations on the current job's
  // Apply controls. Never synthesize an ID/token or submit a registration form.
  if (/(?:^|\.)trabajo\.org$/i.test(host)) {
    $('[data-rt][data-id][data-fuente]').each((_i, node) => {
      const element = $(node);
      if (!/apply|postular|solicitar/i.test(element.text())
        && !(element.is('[data-apply-direct-link]') && element.attr('data-job-apply-intent') === 'cpc_final_redirect')) return;
      const target = new URL('/redirect', pageUrl);
      for (const [key, attr] of [['id', 'data-id'], ['fuente', 'data-fuente'], ['rt', 'data-rt']]) {
        target.searchParams.set(key, element.attr(attr)!);
      }
      applyUrls.add(target.href);
    });
  }
  return { posting, company, employerWebsite, employerPage, applyUrls: [...applyUrls] };
}

export type SourceRecoveryResult = { outcome: string; match?: DirectAtsMatch;
  website?: string; discoveries?: EmployerBoardDiscovery[] };
export type SourceRecoveryCache = { pages: Map<string, Promise<{ url: string; html: string; status: number } | null>>;
  employers: Map<string, Promise<string | null>>; refusals: Map<string, number> };
export const sourceRecoveryCache = (): SourceRecoveryCache => ({ pages: new Map(), employers: new Map(), refusals: new Map() });

/** Bounded recovery for jobs with no saved match, including unknown boards. */
export async function recoverAggregatorSource(job: DirectMatchJob, options: {
  fetcher?: typeof safeExternalFetch; cache?: SourceRecoveryCache; timeoutMs?: number;
  companyProfile?: typeof getHimalayasCompanyDetails;
  discover?: typeof discoverEmployerBoards;
  competingPostings?: readonly BoardPosting[];
} = {}): Promise<SourceRecoveryResult> {
  if (!job.url) return { outcome: 'source_url_missing' };
  const fetcher = options.fetcher || safeExternalFetch;
  const cache = options.cache || sourceRecoveryCache();
  const timeoutMs = options.timeoutMs ?? 25_000;
  const startedAt = Date.now();
  const signal = AbortSignal.timeout(timeoutMs);
  const read = async (url: string) => {
    const host = new URL(url).hostname;
    if ((cache.refusals.get(host) || 0) >= 3) return null;
    let pending = cache.pages.get(url);
    if (!pending) {
      pending = (async () => {
        try {
          const response = await fetcher(url, { headers: { Accept: 'text/html,application/xhtml+xml' },
            signal: AbortSignal.any([signal, AbortSignal.timeout(8_000)]) });
          if ([401, 403, 429].includes(response.status)) cache.refusals.set(host, (cache.refusals.get(host) || 0) + 1);
          return { url: response.url || url, status: response.status,
            html: response.ok ? await readBoundedAtsBody(response, 2 * 1024 * 1024) : '' };
        } catch { return null; }
      })();
      cache.pages.set(url, pending);
    }
    return pending;
  };
  const asMatch = (posting: BoardPosting): DirectAtsMatch => {
    const board = boardIdentityFromUrl(posting.url);
    return { ...posting, platform: board?.platform || 'employer', slug: board?.slug || '',
      postingTitle: posting.title, postingLocation: posting.location, matchedVia: 'live', matchedBy: 'source_url' };
  };
  let website: string | null = null;
  let sourceOutcome = 'source_identity_unverified';
  const slug = himalayasCompanySlug(job.url);
  if (slug) {
    let profile = cache.employers.get(slug);
    if (!profile) {
      profile = (options.companyProfile || getHimalayasCompanyDetails)(slug, undefined, Math.min(8_000, timeoutMs))
        .then(result => result?.website || null);
      cache.employers.set(slug, profile);
    }
    website = await profile;
    sourceOutcome = website ? 'no_unique_discovered_match' : 'employer_website_unavailable';
  } else {
    const page = await read(job.url);
    if (!page || page.status !== 200) return { outcome: page ? `source_http_${page.status}` : 'source_access_unavailable' };
    const evidence = sourcePageEvidence(job, page.html, page.url);
    if (!evidence) return { outcome: sourceOutcome };
    if (evidence.employerPage) return normalizeUrl(page.url) === normalizeUrl(job.url)
      ? { outcome: 'already_direct_employer_page' }
      : { outcome: 'matched_source_redirect', match: asMatch(evidence.posting) };
    website = evidence.employerWebsite;
    const matches = new Map<string, BoardPosting>();
    let complete = true;
    // Too many distinct Apply controls usually means a search/recommendations
    // page. Do not pick an arbitrary prefix of its destinations.
    if (evidence.applyUrls.length > 3) return { outcome: 'source_apply_ambiguous' };
    for (const url of evidence.applyUrls) {
      const target = await read(url);
      if (!target || target.status !== 200) { complete = false; sourceOutcome = 'source_apply_unavailable'; continue; }
      const proof = sourcePageEvidence(job, target.html, target.url);
      if (proof?.employerPage) matches.set(directAtsPostingKey(proof.posting), proof.posting);
    }
    if (matches.size === 1 && complete) return { outcome: 'matched_source_apply', match: asMatch([...matches.values()][0]) };
    if (matches.size && !complete) return { outcome: 'source_apply_unavailable' };
    if (matches.size > 1) return { outcome: 'source_apply_ambiguous' };
    if (!evidence.applyUrls.length) sourceOutcome = 'source_has_no_direct_apply';
  }
  if (!website || signal.aborted) return { outcome: sourceOutcome };
  const remaining = timeoutMs - (Date.now() - startedAt);
  if (remaining < 1000) return { outcome: 'employer_discovery_deferred' };
  const discoveries = await (options.discover || discoverEmployerBoards)({ website, jobs: [job], fetcher,
    totalTimeoutMs: remaining, timeoutMs: Math.min(8_000, remaining) });
  const discoveredPostings = discoveries.flatMap(item => item.postings);
  const candidate = selectDirectAtsMatch(job, [...discoveredPostings, ...(options.competingPostings || [])]);
  const match = candidate && discoveredPostings.some(posting => posting.url === candidate.url) ? candidate : null;
  return match ? { outcome: 'matched_discovered_board', match: asMatch(match), website, discoveries }
    : { outcome: discoveries.length ? 'discovered_match_ambiguous' : 'no_unique_discovered_match', website };
}
