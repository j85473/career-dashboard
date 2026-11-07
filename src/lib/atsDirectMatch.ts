import { smartRecruitersLocation } from './smartRecruitersLocation';
import { browserAtsBoardFromUrl, isBrowserAtsPlatform } from './browserAtsBoards';
import { isPublicAtsPlatform, publicAtsBoardSlugFromUrl } from './publicAtsBoards';
import { tenantAtsIdentityFromUrl } from './tenantAtsBoards';
import { recruiteePostingLocation } from './recruiteeLocation';
/**
 * Resolving an aggregator listing to the employer's own ATS posting.
 *
 * ## The problem this solves
 *
 * Karbon's "Customer Success Manager - Mid Market" arrived through Jobicy and
 * was applied to through a jobicy.com link, while the requisition it came from
 * sat on `boards-api.greenhouse.io/v1/boards/karbon` — a board already in
 * `AtsCompany`. Nothing connected the two. `resolveCanonicalUrl` looks like it
 * would: it accepts `company` and `title` and ignores both, following redirects
 * for four hosts and returning the original URL for everything else.
 *
 * So an aggregator listing is resolved here in two steps, cheapest first:
 *
 *   1. Look through the ATS postings already stored for that company.
 *   2. Only if that misses, ping the company's board for its current postings.
 *
 * ## Why matching is deliberately strict
 *
 * A wrong match rewrites the apply link of a job Joseph may act on, sending him
 * to a different requisition than the one he read. Karbon shows how easily that
 * happens: the board carries *two* postings titled exactly "Customer Success
 * Manager - Mid Market", one US and one Canada. Title alone picks the wrong one
 * half the time.
 *
 * A match therefore requires the same board, an exact normalized title, a
 * compatible location, and — after all that — exactly one surviving candidate.
 * Ambiguity is refused rather than guessed, which is the same bar
 * `isLikelyDuplicatePosting` holds for merging two records.
 *
 * ## Fail-soft by construction
 *
 * Every parser returns `[]` for a shape it does not recognize and every network
 * step swallows its error. A board that changes its response format produces no
 * candidates, which produces no match, which leaves the job exactly as it was.
 * The failure mode is "no enrichment", never "wrong enrichment".
 */

import type { Prisma } from './prismaClient';

import { cleanHtmlText, fetchAtsPlatformResponse, generatePostingIdentity, normalizeCompany, normalizeJobLocation, normalizeTitle, normalizeUrl } from './jobIngestion';
import { locationsCompatibleForDirectMatch } from './directMatchLocation';
import { identifyAts } from './atsUtils';
import { GENERIC_EMPLOYER_WORDS, isPlaceholderEmployerName } from './companyIdentity';
import { safeExternalFetch } from './safeExternalFetch';
import { buildEmployerRuleIndex, resolveEmployer, sameEmployer, type EmployerRule } from './employerIdentity';
import { eightfoldBoardSlugFromUrl, eightfoldBoardIdentity, eightfoldCareersUrl, eightfoldSearchUrl,
  eightfoldDetailUrl, eightfoldPostingUrl, eightfoldLocation, parseEightfoldConfig, parseEightfoldListing } from './eightfoldBoard';
import { workdayBoardSlugFromJobUrl } from './atsBoardYield';
import { reserveProviderBudgetForSource } from './ingestionControl';
import { zohoRecruitBoardSlugFromUrl, zohoRecruitBoardRequest, parseZohoRecruitListing } from './zohoRecruitBoard';
import { EMPLOYER_CATALOGUE_TIMEOUT_MS, fetchEmployerBoardPostings, supportsEmployerBoardLookup } from './employerBoardPostings';
import { adpPostingsConflict } from './adpPostingIdentity';
import { workdayAliasCandidates } from './workdayDirectMatch';

export { locationsCompatibleForDirectMatch } from './directMatchLocation';

export type BoardIdentity = { platform: string; slug: string };

export type BoardPosting = {
  title: string;
  url: string;
  location: string | null;
  description: string | null;
};

export type DirectMatchJob = {
  title: string; company: string; location?: string | null; description?: string | null;
  url?: string | null; canonicalUrl?: string | null; source?: string | null;
};

export type StoredAtsCatalogue = {
  postings: BoardPosting[]; board: BoardIdentity | null; boards: BoardIdentity[];
  /** Crawl-excluded evidence remains a rival, but needs current confirmation. */
  verificationRequiredUrls?: string[];
  /** Known but excluded boards cannot authorize admitting an unverified job. */
  unavailableBoards?: BoardIdentity[];
};

export type DirectAtsMatch = {
  url: string;
  description: string | null;
  platform: string;
  slug: string;
  /** Whether the posting came from what we already stored or from a live ping. */
  matchedVia: 'stored' | 'live';
  /** The exact posting title is preferred; a unique substantial-body match is the fallback. */
  matchedBy?: 'title' | 'description' | 'requisition' | 'source_url';
  postingTitle: string;
  postingLocation: string | null;
};

/** Sources that are already the employer's ATS, or Joseph's own entries. */
const NON_AGGREGATOR_SOURCE = /^(?:ATS-|Manual Import$)/i;

export function isAggregatorSource(source: string | null | undefined): boolean {
  const value = String(source || '').trim();
  return value.length > 0 && !NON_AGGREGATOR_SOURCE.test(value);
}

/** BrassRing puts the selected requisition in its fragment, not tracking. */
export function normalizeDirectPostingUrl(value: string): string {
  const normalized = normalizeUrl(value);
  try {
    const source = new URL(value);
    if (source.hostname.endsWith('.brassring.com') && /^#jobDetails=\d+_\d+$/i.test(source.hash)) {
      const target = new URL(normalized); target.hash = source.hash; return target.href;
    }
  } catch { /* ordinary URL normalization handles empty input */ }
  return normalized;
}

/**
 * The board a stored ATS posting belongs to.
 *
 * Reading the slug off a URL we already ingested is the reliable direction.
 * Guessing a slug from a company name is what `discover_boards_from_aggregators`
 * has to defend against with title-overlap verification, because a wrong guess
 * pulls a stranger's entire catalogue into the pipeline.
 */
const BOARD_URL_PATTERNS: Array<{ platform: string; test: RegExp }> = [
  { platform: 'greenhouse', test: /^(?:job-boards|boards)\.greenhouse\.io\/([^/?#]+)/i },
  { platform: 'lever', test: /^jobs\.(?:eu\.)?lever\.co\/([^/?#]+)/i },
  { platform: 'ashby', test: /^jobs\.ashbyhq\.com\/([^/?#]+)/i },
  { platform: 'smartrecruiters', test: /^(?:jobs|careers)\.smartrecruiters\.com\/([^/?#]+)/i },
  { platform: 'workable', test: /^apply\.workable\.com\/([^/?#]+)/i },
  { platform: 'recruitee', test: /^([^./?#]+)\.recruitee\.com/i },
  { platform: 'breezy', test: /^([^./?#]+)\.breezy\.hr/i },
  { platform: 'teamtailor', test: /^([^./?#]+)\.teamtailor\.com/i },
  { platform: 'pinpoint', test: /^([^./?#]+)\.pinpointhq\.com/i },
  { platform: 'bamboohr', test: /^([^./?#]+)\.bamboohr\.com/i },
];

export function boardIdentityFromUrl(url: string | null | undefined): BoardIdentity | null {
  const value = String(url || '').trim();
  if (!value) return null;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) return null;
  const label = identifyAts({ url: value }).toLowerCase().replace(/\s/g, '');
  const platform = label === 'oraclecloud' ? 'oracle' : label === 'symphonytalent' ? 'symphony' : label;
  if (isBrowserAtsPlatform(platform)) {
    const slug = browserAtsBoardFromUrl(platform, value);
    if (slug) return { platform, slug };
  }
  if (isPublicAtsPlatform(platform)) {
    const slug = publicAtsBoardSlugFromUrl(value, platform);
    if (slug) return { platform, slug };
  }
  const tenant = tenantAtsIdentityFromUrl(value);
  if (tenant) return tenant;
  const zoho = zohoRecruitBoardSlugFromUrl(value);
  if (zoho) return { platform: 'zohorecruit', slug: zoho };
  const eightfold = eightfoldBoardSlugFromUrl(value);
  if (eightfold) return { platform: 'eightfold', slug: eightfold };
  const workday = workdayBoardSlugFromJobUrl(value);
  if (workday) return { platform: 'workday', slug: workday };
  const hostAndPath = `${parsed.hostname.replace(/^www\./i, '')}${parsed.pathname}`;
  for (const { platform, test } of BOARD_URL_PATTERNS) {
    const match = hostAndPath.match(test);
    const slug = match?.[1]?.trim();
    // `/embed/job_board` and similar console paths are not company slugs.
    if (slug && !/^(?:embed|api|v\d+)$/i.test(slug)) return { platform, slug: slug.toLowerCase() };
  }
  return null;
}

/**
 * The trailing location segment `normalizeTitle` removes, if there is one.
 *
 * Mirrors that function's separators and city/state shape deliberately: this
 * exists to see what the normalizer discarded, so two titles that are equal
 * only because their different territories were stripped can be told apart.
 */
export function titleLocationSuffix(title: string | null | undefined): string | null {
  const original = String(title || '').trim();
  const knownLocations = new Set(['remote', 'hybrid', 'minneapolis', 'st paul', 'saint paul', 'twin cities']);
  for (const separator of [' - ', ' | ', ' (', ', ']) {
    const index = original.lastIndexOf(separator);
    if (index <= 0) continue;
    const rawSuffix = original.slice(index + separator.length);
    let suffixEnd = rawSuffix.length;
    while (suffixEnd > 0 && (rawSuffix[suffixEnd - 1] === ')' || rawSuffix[suffixEnd - 1] === '|')) suffixEnd -= 1;
    const suffix = rawSuffix.slice(0, suffixEnd).trim();
    const normalizedSuffix = suffix.toLowerCase().replace(/\./g, '').replace(/\s+/g, ' ');
    const cityState = suffix.split(',').map((part) => part.trim());
    const looksLikeCityState = cityState.length === 2
      && cityState[0].length > 0
      && cityState[0].length <= 80
      && /^[a-z .]+$/i.test(cityState[0])
      && /^[a-z]{2}$/i.test(cityState[1]);
    if (knownLocations.has(normalizedSuffix) || looksLikeCityState) {
      return normalizeJobLocation(suffix);
    }
  }
  return null;
}

export function directAtsTitleKey(value: string): string {
  return normalizeTitle(cleanHtmlText(value)
    .replace(/\s*[,|–—-]\s*(?:remote job|now hiring)\s*$/i, ''))
    .replace(/\bsr\b/g, 'senior').replace(/\bmgr\b/g, 'manager');
}

/** An explicitly labelled employer requisition, never an aggregator's URL ID. */
export function declaredRequisitionId(description: string | null | undefined): string | null {
  const ids = new Set([...cleanHtmlText(String(description || '')).matchAll(
    /^\s*(?:req(?:uisition)?\s*(?:id|number|no\.?|#)|job requisition id)\s*[:#]?\s*([a-z0-9][a-z0-9_-]{3,39})(?=\s|$)/gim,
  )].map(match => match[1].toLowerCase()).filter(id => /\d/.test(id)));
  return ids.size === 1 ? [...ids][0] : null;
}

/** Exact source metadata retained by a scraper, not an arbitrary body link. */
function declaredSourcePostingKeys(description: string | null | undefined): Set<string> {
  return new Set([...String(description || '').matchAll(/^\s*URL Source:\s*(https?:\/\/\S+)\s*$/gim)]
    .map(match => match[1]).filter(isDirectPostingUrl).map(url => directAtsPostingKey({ url })));
}

/**
 * Picks the one posting that is unambiguously this job. Pure, so the decision
 * is testable without a network or a database.
 */
export function selectDirectAtsMatch(
  job: { title: string; location?: string | null; description?: string | null; source?: string | null; canonicalUrl?: string | null },
  postings: readonly BoardPosting[],
): BoardPosting | null {
  const titleKey = directAtsTitleKey;
  const wantedTitle = titleKey(job.title || '');
  if (!wantedTitle) return null;

  // Earlier recovery sometimes saved only canonicalUrl, leaving View Posting
  // on the aggregator. Honor that already-stored exact destination when it is
  // present in the verified employer catalogue, even among same-title roles.
  if (isDirectPostingUrl(job.canonicalUrl)) {
    const known = postings.find(posting => directAtsPostingKey(posting) === directAtsPostingKey({ url: job.canonicalUrl! }));
    if (known) return known;
  }

  const wantedSuffix = titleLocationSuffix(job.title);
  const wantedRequisition = declaredRequisitionId(job.description);
  const territoryAgrees = (posting: BoardPosting) => {
    // Equal only because each title's own territory was stripped off means the
    // titles never actually agreed. "... - Milwaukee, WI" is not
    // "... - Minneapolis, MN", whatever the location fields happen to say.
    const postingSuffix = titleLocationSuffix(posting.title);
    if (wantedSuffix && postingSuffix && !locationsCompatibleForDirectMatch(wantedSuffix, postingSuffix)) return false;
    if (wantedSuffix && !locationsCompatibleForDirectMatch(wantedSuffix, posting.location)) return false;
    if (postingSuffix && !locationsCompatibleForDirectMatch(job.location, postingSuffix)) return false;
    return true;
  };
  // A same-title replacement is not the original application. Scraped copies
  // sometimes retain the exact ATS URL even when the card still links through
  // an aggregator. If that requisition is absent, refuse a newer sibling.
  const sourceKeys = declaredSourcePostingKeys(job.description);
  if (sourceKeys.size) {
    if (sourceKeys.size !== 1) return null;
    const exact = uniquePostings(postings.filter(posting => sourceKeys.has(directAtsPostingKey(posting))
      && territoryAgrees(posting) && locationsCompatibleForDirectMatch(job.location, posting.location)));
    return exact.length === 1 ? exact[0] : null;
  }
  const requisitionAgrees = (posting: BoardPosting) => {
    const candidate = wantedRequisition ? declaredRequisitionId(posting.description) : null;
    return !candidate || candidate === wantedRequisition;
  };
  if (wantedRequisition) {
    const exact = uniquePostings(postings.filter(posting => posting.url && territoryAgrees(posting)
      && locationsCompatibleForDirectMatch(job.location, posting.location)
      && declaredRequisitionId(posting.description) === wantedRequisition));
    if (exact.length === 1) return exact[0];
  }
  const compatible = postings.filter((posting) => titleKey(posting.title || '') === wantedTitle
    && requisitionAgrees(posting)
    && territoryAgrees(posting) && posting.url
    && locationsCompatibleForDirectMatch(job.location, posting.location));
  // Every posting under this title was ruled out by geography, or several
  // survived and nothing distinguishes them. Both are refusals, not matches.
  if (uniquePostings(compatible).length === 1) {
    const [match] = compatible;
    return match.url ? match : null;
  }

  // Aggregators sometimes relabel a posting even though they retain the
  // employer's full description. Himalayas did this for Panopto: the listing
  // title said "Senior Account Executive, EDU" while the body and employer
  // board both said "Senior Account Executive, Enterprise". A long body is a
  // much stronger identity signal than that label, but it is accepted only
  // when exactly one same-company board posting has the same substantial text
  // and compatible geography.
  const wantedBody = substantialDescription(job.description, job.source);
  if (!wantedBody) return null;
  // A complete body can distinguish same-title requisitions (including their
  // salary terms). It cannot use a near match or generic employer boilerplate.
  const sameBody = (compatible.length > 1 ? compatible : postings).filter((posting) => {
    if (!posting.url || !territoryAgrees(posting)
      || !requisitionAgrees(posting)
      || !locationsCompatibleForDirectMatch(job.location, posting.location)) return false;
    const postingBody = substantialDescription(posting.description);
    if (!postingBody) return false;
    if (wantedBody === postingBody) return true;
    const shorter = wantedBody.length <= postingBody.length ? wantedBody : postingBody;
    const longer = wantedBody.length > postingBody.length ? wantedBody : postingBody;
    // Permit only a small publisher footer or heading around an otherwise
    // identical body. A partial or merely similar description is not proof.
    if (shorter.length / longer.length >= 0.94 && longer.includes(shorter)) return true;
    // Some feeds remove the whitespace at HTML boundaries, then cut off the
    // posting mid-sentence. Accept an exact, long opening passage, not fuzzy
    // word overlap: all supplied text must appear in order near the beginning
    // of the employer copy and cover at least 75% of it. Multiple matching
    // requisitions still refuse below, including copies with a different tail.
    const excerpt = wantedBody.replace(/\s/g, '');
    const full = postingBody.replace(/\s/g, '');
    const startsAt = full.indexOf(excerpt);
    const postingTitleInBody = cleanHtmlText(posting.title).toLowerCase().replace(/[^a-z0-9]/g, '');
    // A renamed excerpt must actually name this role. A long corporate intro
    // shared across jobs cannot identify a role whose duties were cut off.
    if (wantedTitle !== titleKey(posting.title)
      && (!postingTitleInBody || !excerpt.includes(postingTitleInBody))) return false;
    return excerpt.length >= 3_000 && excerpt.length / full.length >= 0.75
      && startsAt >= 0 && startsAt <= Math.min(300, full.length * 0.05);
  });
  const uniqueBody = uniquePostings(sameBody);
  return uniqueBody.length === 1 ? uniqueBody[0] : null;
}

/** Collapse only known URL aliases, retaining each provider's tenant scope. */
export function directAtsPostingKey(posting: Pick<BoardPosting, 'url'>): string {
  const board = boardIdentityFromUrl(posting.url);
  if (!board) return normalizeUrl(posting.url);
  const url = new URL(posting.url);
  if (board.platform === 'oracle') {
    const id = url.pathname.match(/^\/hcmUI\/CandidateExperience\/[^/]+\/sites\/[^/]+\/job\/(\d+)\/?$/i)?.[1];
    // Oracle exposes one tenant requisition through several career sites and
    // locales. Those are URL aliases, while production/test tenants and
    // different requisition IDs remain distinct.
    if (id) return `oracle:${url.hostname.toLowerCase()}:posting:${id}`;
  }
  if (board.platform === 'workday') {
    url.pathname = url.pathname.replace(/\/apply\/?$/i, '');
    return generatePostingIdentity({ url: url.href }) || normalizeUrl(posting.url);
  }
  if (board.platform === 'greenhouse') {
    const postingId = url.pathname.match(/^\/[^/]+\/jobs\/(\d+)\/?$/i)?.[1];
    if (postingId && /^(?:boards|job-boards)\.greenhouse\.io$/i.test(url.hostname)) {
      return `greenhouse:${board.slug}:posting:${postingId}`;
    }
  }
  if (board.platform === 'lever') {
    const postingId = url.pathname.match(/^\/[^/]+\/([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})(?:\/apply)?\/?$/i)?.[1];
    if (postingId && /^jobs\.(?:eu\.)?lever\.co$/i.test(url.hostname)) {
      // The EU and US hosting regions are separate posting namespaces.
      return `lever:${url.hostname.toLowerCase()}:${board.slug}:posting:${postingId.toLowerCase()}`;
    }
  }
  return normalizeDirectPostingUrl(posting.url);
}

function uniquePostings(postings: readonly BoardPosting[]): BoardPosting[] {
  const unique = new Map<string, BoardPosting>();
  for (const posting of postings) {
    const key = directAtsPostingKey(posting);
    // Stored candidates put the preferred canonical URL before retained
    // observations; do not replace it with an older alias of the same posting.
    if (!unique.has(key)) unique.set(key, posting);
  }
  return [...unique.values()];
}

/** A vendor homepage or employer board is not an individual application target. */
function isSpecificPostingUrl(value: string | null | undefined): value is string {
  if (!value) return false;
  try {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return false;
    if (/\.(?:svg|png|jpe?g|gif|webp|ico|css|js|woff2?|ttf|mp4|pdf)\/?$/i.test(url.pathname)) return false;
    const host = url.hostname.toLowerCase();
    if (host === 'careers.hireology.com') return /^\/[^/]+\/\d+\/(?:description|application)\/?$/i.test(url.pathname);
    if (host === 'app.dover.com') return /^\/apply\/[^/]+\/[a-f0-9-]{36}\/?$/i.test(url.pathname);
    if (host.endsWith('.hire.trakstar.com')) return /^\/jobs\/[a-z0-9]+\/?$/i.test(url.pathname);
    if (host.endsWith('.prevueaps.com')) return /^\/jobs\/\d+(?:-\d+)?\.html$/i.test(url.pathname);
    if (host.endsWith('.prismhr-hire.com') || host.endsWith('.hiringthing.com')) return /^\/job\/\d+(?:\/[^/]+)?\/?$/i.test(url.pathname);
    if (host.endsWith('.icims.com')) return /^\/jobs\/\d+\/(?:[^/]+\/)?job\/?$/i.test(url.pathname);
    if (host.endsWith('.taleo.net')) return /\/jobdetail\.ftl$/i.test(url.pathname)
      && /^[\w-]+$/.test(url.searchParams.get('job') || '');
    if (host.endsWith('.brassring.com')) return Boolean(url.searchParams.get('partnerid')
      && url.searchParams.get('siteid') && (/^#jobDetails=\d+_\d+$/i.test(url.hash)
        || /^\d+$/.test(url.searchParams.get('jobid') || '')));
    if (host === 'myjobs.adp.com') return /^\/[^/]+\/?$/.test(url.pathname)
      && /^\d+$/.test(url.searchParams.get('c') || '') && /^\d+$/.test(url.searchParams.get('r') || '');
    const parts = url.pathname.split('/').filter(Boolean);
    if ([...url.searchParams].some(([key, id]) => /^(?:job_?id|gh_jid|requisition_?id|req_?id|posting_?id|position_?id|opportunityid)$/i.test(key) && Boolean(id))) return true;
    if (parts.length < 2 || /^(?:jobs?|careers?|search|openings?|job_board|positions?)$/i.test(parts.at(-1)!)) return false;
    return Boolean(generatePostingIdentity({ url: value }))
      || parts.some(part => /^(?:jobs?|careers?|openings?|positions?|o|apply)$/i.test(part));
  } catch { return false; }
}

/** Recognized employer postings can be retained on cards from any discovery source. */
export function isDirectPostingUrl(value: string | null | undefined): boolean {
  return isSpecificPostingUrl(value) && identifyAts({ url: value }) !== 'Unknown';
}

function substantialDescription(value: string | null | undefined, source?: string | null): string | null {
  let body = String(value || '');
  if (source === 'WeWorkRemotely') {
    // RSS adds publisher metadata around the full employer body. Strip only
    // those anchored wrappers, retaining salary and all actual posting text.
    body = body.replace(/^Headquarters:[^\n]*\n\s*/i, '')
      .replace(/\n\s*To apply:\s*https:\/\/weworkremotely\.com\/remote-jobs\/[^\s]+\s*$/i, '');
  }
  const normalized = cleanHtmlText(body)
    .toLowerCase()
    .replace(/\boriginally posted on himalayas\b[^.]*\.?/gi, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return normalized.length >= 1_000 ? normalized : null;
}

export type BoardRequest = { url: string; init?: RequestInit };

/**
 * How to ask a board for its current postings.
 *
 * Deliberately a separate copy from the rotation sweep's inline chain in
 * jobIngestion: that path was just stabilized around the day-assigned rotation
 * and is not worth destabilizing for this.
 */
export function atsBoardRequest(platform: string, slug: string): BoardRequest | null {
  if (platform === 'zohorecruit') return zohoRecruitBoardRequest(slug);
  if (platform === 'workable') {
    // The only board here that will not answer a GET.
    return {
      url: `https://apply.workable.com/api/v3/accounts/${encodeURIComponent(slug)}/jobs`,
      init: {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: '', location: [], department: [], worktype: [], remote: [] }),
      },
    };
  }
  const url = atsBoardApiUrl(platform, slug);
  return url ? { url } : null;
}

export function atsBoardApiUrl(platform: string, slug: string): string | null {
  if (platform === 'zohorecruit') return zohoRecruitBoardRequest(slug).url;
  const safe = encodeURIComponent(slug);
  switch (platform) {
    case 'greenhouse': return `https://boards-api.greenhouse.io/v1/boards/${safe}/jobs?content=true`;
    case 'lever': return `https://api.lever.co/v0/postings/${safe}`;
    case 'ashby': return `https://api.ashbyhq.com/posting-api/job-board/${safe}`;
    case 'smartrecruiters': return `https://api.smartrecruiters.com/v1/companies/${safe}/postings`;
    case 'recruitee': return `https://${safe}.recruitee.com/api/offers`;
    case 'breezy': return `https://${safe}.breezy.hr/json`;
    case 'teamtailor': return `https://${safe}.teamtailor.com/jobs.json`;
    case 'pinpoint': return `https://${safe}.pinpointhq.com/postings.json`;
    case 'bamboohr': return `https://${safe}.bamboohr.com/careers/list`;
    default: return null;
  }
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function descriptionText(value: string | null | undefined): string | null {
  return value ? cleanHtmlText(value) || null : null;
}

function absoluteUrl(value: unknown): string | null {
  const candidate = text(value);
  if (!candidate) return null;
  return /^https?:\/\//i.test(candidate) ? candidate : null;
}

type Row = Record<string, unknown>;

function rows(value: unknown, key?: string): Row[] {
  const list = key ? (value as Row | null)?.[key] : value;
  return Array.isArray(list) ? list.filter((item): item is Row => Boolean(item) && typeof item === 'object') : [];
}

/**
 * Response shapes verified against the live APIs on 2026-08-25. Each parser
 * reads only unambiguous title fields — Lever's `categories.team` yields
 * "Sales" and "G&A" and is never a title, a mistake this repo has made before.
 */
export function parseBoardPostings(platform: string, body: unknown, slug: string): BoardPosting[] {
  // These descriptions can replace an aggregator's already-clean JD. Normalize
  // every adapter here: Greenhouse escapes its HTML, while other boards send
  // ordinary HTML or use it as a fallback for a missing plain-text field.
  return parseRawBoardPostings(platform, body, slug).map((posting) => ({
    ...posting,
    description: descriptionText(posting.description),
  }));
}

function parseRawBoardPostings(platform: string, body: unknown, slug: string): BoardPosting[] {
  if (platform === 'zohorecruit') {
    try {
      return parseZohoRecruitListing(slug, body).jobs.map(job => ({
        title: String(job.title), url: String(job.url), location: text(job.location), description: text(job.description),
      }));
    } catch { return []; }
  }
  switch (platform) {
    case 'greenhouse':
      return rows(body, 'jobs').map((job) => ({
        title: text(job.title) || '',
        url: absoluteUrl(job.absolute_url) || '',
        location: text((job.location as Row | null)?.name),
        description: text(job.content),
      }));
    case 'lever':
      return rows(body).map((job) => ({
        title: text(job.text) || '',
        url: absoluteUrl(job.hostedUrl) || '',
        location: text((job.categories as Row | null)?.location),
        description: text(job.descriptionPlain) || text(job.description),
      }));
    case 'ashby':
      return rows(body, 'jobs').map((job) => ({
        title: text(job.title) || '',
        url: absoluteUrl(job.jobUrl) || '',
        location: text(job.location),
        description: text(job.descriptionPlain) || text(job.descriptionHtml),
      }));
    case 'smartrecruiters':
      // The list carries no description and `ref` is an API URL, so the public
      // posting URL is composed from the company identifier and posting id.
      return rows(body, 'content').map((job) => {
        const identifier = text((job.company as Row | null)?.identifier) || slug;
        const id = text(job.id);
        return {
          title: text(job.name) || '',
          url: id ? `https://jobs.smartrecruiters.com/${identifier}/${id}` : '',
          location: smartRecruitersLocation(job.location),
          description: null,
        };
      });
    case 'recruitee':
      return rows(body, 'offers').map((job) => ({
        title: text(job.title) || text(job.position) || '',
        url: absoluteUrl(job.careers_url) || '',
        location: recruiteePostingLocation(job) || null,
        description: text(job.description),
      }));
    case 'breezy':
      return rows(body).map((job) => ({
        title: text(job.name) || '',
        url: absoluteUrl(job.url) || '',
        location: text((job.location as Row | null)?.name),
        description: text(job.description),
      }));
    case 'teamtailor':
      // jobs.json is a bare JSON Feed -- id, title, url, date_published,
      // content_html -- verified live on 2026-08-25. No location field exists
      // on the list item; jobIngestion.ts recovers it from the posting page's
      // JobPosting JSON-LD, which this synchronous parser cannot fetch.
      return rows(body, 'items').map((job) => ({
        title: text(job.title) || '',
        url: absoluteUrl(job.url) || '',
        location: null,
        description: text(job.content_html),
      }));
    case 'pinpoint':
      return rows(body, 'data').map((job) => ({
        title: text(job.title) || '',
        url: absoluteUrl(job.url) || '',
        location: text((job.location as Row | null)?.name) || text(job.location),
        description: text(job.description),
      }));
    case 'workable':
      // No URL on the list item; the public posting is composed from the
      // account slug and the posting shortcode.
      return rows(body, 'results').map((job) => {
        const shortcode = text(job.shortcode);
        const where = job.location as Row | null;
        return {
          title: text(job.title) || '',
          url: shortcode ? `https://apply.workable.com/${slug}/j/${shortcode}/` : '',
          location: [text(where?.city), text(where?.country)].filter(Boolean).join(', ') || null,
          description: null,
        };
      });
    case 'bamboohr':
      return rows(body, 'result').map((job) => {
        const id = text(job.id);
        const where = job.location as Row | null;
        return {
          title: text(job.jobOpeningName) || '',
          url: id ? `https://${slug}.bamboohr.com/careers/${id}` : '',
          location: [text(where?.city), text(where?.state)].filter(Boolean).join(', ') || null,
          description: null,
        };
      });
    default:
      return [];
  }
}

export type DirectMatchDeps = {
  store: DirectMatchStore;
  fetcher?: typeof safeExternalFetch;
  /** Off by default in bulk contexts that should not spend network requests. */
  allowLivePing?: boolean;
  timeoutMs?: number;
  /** A bulk pass shares each board/title request, including failures. */
  liveCache?: Map<string, Promise<BoardPosting[] | null>>;
  onOutcome?: (outcome: 'matched_stored' | 'matched_live' | 'no_verified_board'
    | 'no_unique_stored_match' | 'stored_match_requires_live_confirmation' | 'live_unsupported' | 'live_unavailable' | 'no_unique_live_match') => void;
  /** Only a complete successful live read can establish absence at intake. */
  onLiveCatalogue?: (evidence: { boards: BoardIdentity[]; postings: BoardPosting[] }) => void;
};

type DirectMatchStore = Pick<Prisma.TransactionClient, 'job'>
  & Partial<Pick<Prisma.TransactionClient, 'atsCompany' | 'companyNameRule' | 'employerAtsBoard'>>;

const ruleContexts = new WeakMap<DirectMatchStore, { expiresAt: number; rules: EmployerRule[];
  index: ReturnType<typeof buildEmployerRuleIndex> }>();
async function employerRules(store: DirectMatchStore) {
  const cached = ruleContexts.get(store);
  if (cached && cached.expiresAt > Date.now()) return cached;
  const rules = store.companyNameRule ? await store.companyNameRule.findMany({
    select: { matchType: true, matchKey: true, standardName: true, origin: true },
  }) : [];
  const context = { expiresAt: Date.now() + 60_000, rules, index: buildEmployerRuleIndex(rules) };
  ruleContexts.set(store, context);
  return context;
}

// Paging bounds one database response, not the retained catalogue. A corrupt
// employer rule can expand this lookup across millions of unrelated postings.
// Refuse an incomplete lookup before it can exhaust the web server's heap.
export const STORED_ATS_CATALOGUE_MAX_BYTES = 32 * 1024 * 1024;

export class StoredAtsCatalogueLimitError extends Error {
  constructor(company: string) {
    super(`Stored ATS catalogue for ${company} exceeds its memory budget; canonical lookup is inconclusive.`);
    this.name = 'StoredAtsCatalogueLimitError';
  }
}

/** ATS postings already stored for this company, as match candidates. */
export async function findStoredAtsPostings(
  company: string,
  store: DirectMatchStore,
  matchJobs?: readonly DirectMatchJob[],
  options: { linksOnly?: boolean; includeRetiredBoards?: boolean } = {},
): Promise<StoredAtsCatalogue> {
  const { rules, index } = await employerRules(store);
  const employer = resolveEmployer({ company }, index);
  const wanted = normalizeCompany(employer || '');
  if (!wanted || isPlaceholderEmployerName(employer)) return { postings: [], board: null, boards: [] };
  const compactWanted = wanted.replace(/\s+/g, '');
  // Rules must participate in retrieval, not just the comparison afterwards:
  // an old card may still carry the source's alias and no canonical employer.
  const aliases = rules.filter(rule => ['employer', 'label', 'alias'].includes(rule.matchType)
    && sameEmployer({ company: resolveEmployer({ company: rule.standardName }, index) }, { employer }))
    .flatMap(rule => [rule.matchKey, rule.standardName]);
  const companyCandidates = [
    { company: { equals: company, mode: 'insensitive' as const } },
    // Canonical names are written by the same rule index. Exact equality uses
    // Job_employer_idx; ILIKE here forces a scan of millions of rows on every
    // page, even though the other OR arms have company trigram indexes.
    { employer: { equals: employer } },
    ...(wanted.length >= 3 ? [{ company: { contains: wanted, mode: 'insensitive' as const } }] : []),
    ...(compactWanted.length >= 3 && compactWanted !== wanted
      ? [{ company: { contains: compactWanted, mode: 'insensitive' as const } }]
      : []),
    ...[...new Set(aliases)].filter(Boolean).map(alias => ({ company: { equals: alias, mode: 'insensitive' as const } })),
    ...[...new Set(aliases.map(alias => normalizeCompany(alias)))].filter(alias => alias.length >= 3)
      .map(alias => ({ company: { contains: alias, mode: 'insensitive' as const } })),
    // Alias keys are compact ("progleasing"), while a legacy card may say
    // "Prog Leasing". A short indexed search stem only retrieves candidates;
    // the full canonical employer comparison below still decides identity.
    ...[...new Set(aliases.filter(alias => /^[a-z0-9]{4,}$/i.test(alias)
      && !alias.toLowerCase().includes(compactWanted)).map(alias => alias.slice(0, 4).toLowerCase())
      .filter(stem => !GENERIC_EMPLOYER_WORDS.has(stem) && !['jobs', 'care', 'work'].includes(stem)))]
      .map(stem => ({ company: { contains: stem, mode: 'insensitive' as const } })),
  ];

  // Read to the end in bounded pages. A 4,000-row employer used to discard its
  // entire catalogue; uniqueness must be judged across the complete catalogue.
  // Discovery source is not authority: an ATS observation may have attached to
  // a card first discovered by an aggregator, without changing its source.
  const candidates: Array<BoardPosting & { board: BoardIdentity | null }> = [];
  const boards = new Map<string, BoardIdentity>();
  const addBoard = (board: BoardIdentity | null) => {
    if (board) boards.set(`${board.platform}:${board.slug}`, board);
  };
  let retainedBytes = 0;
  // Short summaries cannot use the substantial-body fallback. Link-only
  // recovery need not transfer every full JD merely to compare their titles.
  // Ingestion still retrieves descriptions for enrichment after a match.
  const needsDescriptions = !options.linksOnly || !matchJobs || matchJobs.some(job =>
    substantialDescription(job.description, job.source) || declaredRequisitionId(job.description));
  let complete = false;
  let afterId: string | undefined;
  for (;;) {
    const page = await store.job.findMany({
      where: { OR: companyCandidates, ...(afterId ? { id: { gt: afterId } } : {}) },
      select: { id: true, title: true, company: true, employer: true, source: true,
        url: true, canonicalUrl: true, location: true, description: needsDescriptions,
        observations: { where: { source: { startsWith: 'ATS-' } }, select: { source: true, url: true } } },
      // A key boundary prevents OFFSET from rescanning every earlier row for
      // each page of a large employer and remains stable when rows disappear.
      orderBy: { id: 'asc' }, take: 400,
    });
    if (page.length > 400) break;
    for (const row of page) {
      // The contains clauses above are database narrowing only. The canonical
      // comparison is the authority, so a common substring cannot cross-link two
      // employers.
      if (!sameEmployer({ company: row.company, employer: row.employer || resolveEmployer(row, index) }, { employer })) continue;
      const observedUrls = (row.observations || []).filter(observation => /^ATS-/i.test(observation.source))
        .map(observation => observation.url).filter(isSpecificPostingUrl)
        // Legacy ADP observations attached equal numeric IDs from unrelated
        // tenant career centers. They cannot lend this row's employer or JD
        // to another tenant, nor seed another employer-board association.
        .filter(url => !adpPostingsConflict(row.canonicalUrl || row.url, url));
      const directSource = /^ATS-/i.test(row.source || '');
      const recognized = [row.canonicalUrl, row.url].filter(isDirectPostingUrl) as string[];
      const urls = [...new Set([...recognized, ...observedUrls,
        ...(directSource && recognized.length === 0 ? [row.canonicalUrl, row.url].filter(isSpecificPostingUrl) : []),
      ])];
      // One retained card can carry several ATS observations. Do not let the
      // order of those observations manufacture uniqueness between requisitions.
      if (urls.length === 0) continue;
      const identities = urls.map(url => ({ url, board: boardIdentityFromUrl(url) }));
      for (const { board } of identities) addBoard(board);
      // Scan every page, but keep only candidates that could match this pass's
      // jobs. Unrelated descriptions used to exhaust the 32 MiB safety limit
      // for large employers, aborting even a match on the final page. Running
      // the same predicate on each candidate preserves every title/body rival;
      // uniqueness is still decided over the complete retained set below.
      if (matchJobs && !matchJobs.some(job => identities.some(({ url }) => selectDirectAtsMatch(job, [{
        title: row.title || '', url, location: row.location, description: row.description ?? null,
      }])))) continue;
      // Count UTF-16 storage conservatively plus per-candidate object overhead.
      // Checking the raw text first also avoids normalizing an oversized body.
      retainedBytes += urls.reduce((bytes, url) => bytes + 512 + 2 * (
        url.length + (row.title?.length || 0) + (row.location?.length || 0) + (row.description?.length || 0)
      ), 0);
      if (retainedBytes > STORED_ATS_CATALOGUE_MAX_BYTES) throw new StoredAtsCatalogueLimitError(company);
      const description = descriptionText(row.description);
      for (const { url, board } of identities) {
        candidates.push({ board, title: row.title || '', url, location: row.location, description });
      }
    }
    if (page.length < 400) { complete = true; break; }
    const lastId = page.at(-1)?.id;
    if (!lastId || (afterId && lastId <= afterId)) break;
    afterId = lastId;
  }
  // Verified catalogue evidence can identify a board before its first Job is
  // persisted. A slug resembling the employer's name is never sufficient.
  for (const rule of rules) {
    if (rule.matchType !== 'ats_board_employer' || rule.origin !== 'verified_ats_source'
      || !sameEmployer({ company: rule.standardName }, { employer })) continue;
    const separator = rule.matchKey.indexOf(':');
    if (separator > 0) addBoard({ platform: rule.matchKey.slice(0, separator), slug: rule.matchKey.slice(separator + 1) });
  }
  // Employer discovery verifies these links through the official careers site.
  // Reuse that evidence even before this board has supplied its first saved job.
  // Name queries retrieve candidates; canonical employer equality authorizes them.
  const mappings = store.employerAtsBoard ? await store.employerAtsBoard.findMany({
    where: { OR: companyCandidates.flatMap(candidate => candidate.company
      ? [{ companyName: candidate.company }] : []) },
    select: { companyName: true, platform: true, slug: true, evidenceUrl: true },
  }) : [];
  for (const mapping of mappings) {
    if (mapping.evidenceUrl && sameEmployer({ company: resolveEmployer({ company: mapping.companyName }, index) }, { employer })) {
      addBoard({ platform: mapping.platform, slug: mapping.slug });
    }
  }
  const registered = store.atsCompany && boards.size ? await store.atsCompany.findMany({
    where: { OR: [...boards.values()] }, select: { platform: true, slug: true, status: true, excludedReason: true },
  }) : null;
  // A targeted aggregator check may call a retired board without changing its
  // collection status. Historical retirement evidence still needs a live read.
  const enabled = registered ? new Set(registered.filter(row => row.status !== 'excluded' || options.includeRetiredBoards)
    .map(row => `${row.platform}:${row.slug}`)) : new Set(boards.keys());
  const activeBoards = [...boards.entries()].filter(([key]) => enabled.has(key)).map(([, value]) => value);
  // Crawl yield/geography is not evidence that a saved requisition is invalid.
  // Retain its identity without reactivating the board or scheduling a fetch.
  // Explicit retirement, absent endpoints and unspecified exclusions still
  // withhold their postings. Registration is not required for saved evidence.
  const withheld = new Set((registered || []).filter(row => row.status === 'excluded'
    && !/^(?:out_of_territory|proven_unproductive):/.test(row.excludedReason || ''))
    .map(row => `${row.platform}:${row.slug}`));
  const postings = complete ? candidates.filter(row => !row.board || !withheld.has(`${row.board.platform}:${row.board.slug}`))
    .map(row => ({ title: row.title, url: row.url, location: row.location, description: row.description })) : [];
  const crawlExcluded = new Set((registered || []).filter(row => row.status === 'excluded' && !withheld.has(`${row.platform}:${row.slug}`))
    .map(row => `${row.platform}:${row.slug}`));
  const verificationRequiredUrls = candidates.filter(row => row.board && (row.board.platform === 'adp'
    || crawlExcluded.has(`${row.board.platform}:${row.board.slug}`))).map(row => row.url);
  return { postings, board: activeBoards.length === 1 ? activeBoards[0] : null, boards: activeBoards,
    ...([...boards.entries()].some(([key]) => !enabled.has(key))
      ? { unavailableBoards: [...boards.entries()].filter(([key]) => !enabled.has(key)).map(([, value]) => value) } : {}),
    ...(verificationRequiredUrls.length ? { verificationRequiredUrls } : {}) };
}

/**
 * Finds the board for a company without guessing a slug from its name: the
 * slug is read off ATS postings already stored for that company, and confirmed
 * against the registered board catalogue.
 */
export async function findBoardForCompany(
  company: string,
  store: DirectMatchStore,
): Promise<BoardIdentity | null> {
  const { board } = await findStoredAtsPostings(company, store, [], { linksOnly: true });
  return board;
}

export async function fetchBoardPostings(
  board: BoardIdentity,
  fetcher: typeof safeExternalFetch,
  timeoutMs: number,
  job?: { title: string; company: string },
): Promise<BoardPosting[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));
  try {
    // Canonical recovery shares acquisition's request budget, provider
    // cooldown and cross-process pacing. Injected fetchers remain testable.
    if (fetcher === safeExternalFetch) {
      fetcher = (url, init) => fetchAtsPlatformResponse(board.platform, controller.signal, async () => {
        const decision = await reserveProviderBudgetForSource(`ATS-${board.platform}`);
        if (!decision.allowed) throw new Error(`ATS canonical lookup deferred: ${decision.reason || 'provider control'}`);
        return safeExternalFetch(url, init);
      }, { requestedUrl: String(url) });
    }
    if (board.platform === 'eightfold' && job) return await fetchEightfoldPostings(board, job, fetcher, controller.signal);
    const request = atsBoardRequest(board.platform, board.slug);
    if (!request) return [];
    const response = await fetcher(request.url, { ...request.init, signal: controller.signal });
    if (!response.ok) return [];
    if (!/json/i.test(response.headers.get('content-type') || '')) return [];
    return parseBoardPostings(board.platform, await response.json(), board.slug);
  } catch {
    // A board that is down, throttled, or has changed shape simply yields no
    // candidates. This must never fail the ingestion of the job itself.
    return [];
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchEightfoldPostings(board: BoardIdentity, job: { title: string; company: string },
  fetcher: typeof safeExternalFetch, signal: AbortSignal): Promise<BoardPosting[]> {
  const identity = eightfoldBoardIdentity(board.slug);
  const configResponse = await fetcher(eightfoldCareersUrl(board.slug), { signal });
  if (!configResponse.ok) return [];
  const config = parseEightfoldConfig(await configResponse.text(), identity.domain);
  if (!sameEmployer({ company: config.company }, { company: job.company })) return [];
  const positions = new Map<string, Row>();
  let complete = false;
  // Search this known employer for the title. Finish every page before using
  // uniqueness; a first-page hit cannot rule out a second requisition later.
  for (let offset = 0; offset < 100; offset += 10) {
    const url = new URL(eightfoldSearchUrl(board.slug, offset, config.domain));
    url.searchParams.set('query', job.title);
    const response = await fetcher(url.href, { signal });
    if (!response.ok) return [];
    const page = parseEightfoldListing(await response.json());
    if (page.positions.length > 10 || page.positions.length < Math.min(10, page.count - offset)) return [];
    for (const position of page.positions) positions.set(String(position.id), position);
    if (offset + page.positions.length >= page.count) { complete = positions.size === page.count; break; }
  }
  if (!complete) return [];
  const postings: BoardPosting[] = [];
  for (const position of positions.values()) {
    if (normalizeTitle(String(position.name)) !== normalizeTitle(job.title)) continue;
    const response = await fetcher(eightfoldDetailUrl(board.slug, String(position.id), config.domain), { signal });
    if (!response.ok) return [];
    const payload = await response.json() as Row;
    const detail = payload.status === 200 && payload.data && typeof payload.data === 'object' ? payload.data as Row : null;
    if (!detail || String(detail.id) !== String(position.id) || detail.name !== position.name) return [];
    postings.push({ title: String(detail.name), url: eightfoldPostingUrl(board.slug, detail),
      location: eightfoldLocation(detail), description: descriptionText(text(detail.jobDescription)) });
  }
  return postings;
}

/**
 * Resolves one aggregator listing to the employer's own posting.
 *
 * Returns null whenever anything is uncertain — no board, no title match,
 * geography disagreement, or more than one equally plausible posting.
 */
export async function resolveDirectAtsPosting(
  job: DirectMatchJob,
  deps: DirectMatchDeps,
): Promise<DirectAtsMatch | null> {
  if (!isAggregatorSource(job.source)) return null;
  if (!job.title?.trim() || !job.company?.trim()) return null;

  const catalogue = await findStoredAtsPostings(job.company, deps.store, [job]);
  return resolveDirectAtsPostingFromCatalogue(job, catalogue, deps);
}

/** Ingestion and scheduled repair share the same complete-catalogue decision. */
export async function resolveDirectAtsPostingFromCatalogue(
  job: DirectMatchJob,
  { postings: stored, board, boards, verificationRequiredUrls = [] }: StoredAtsCatalogue,
  deps: DirectMatchDeps,
): Promise<DirectAtsMatch | null> {
  if (!isAggregatorSource(job.source) || !job.title?.trim() || !job.company?.trim()) return null;

  const storedMatch = selectDirectAtsMatch(job, stored);
  if (storedMatch && !verificationRequiredUrls.includes(storedMatch.url)) {
    deps.onOutcome?.('matched_stored');
    const identity = boardIdentityFromUrl(storedMatch.url) || board;
    return {
      url: normalizeDirectPostingUrl(storedMatch.url) || storedMatch.url,
      description: storedMatch.description,
      platform: identity?.platform || 'unknown',
      slug: identity?.slug || '',
      matchedVia: 'stored',
      matchedBy: declaredSourcePostingKeys(job.description).has(directAtsPostingKey(storedMatch)) ? 'source_url'
        : declaredRequisitionId(job.description) && declaredRequisitionId(job.description) === declaredRequisitionId(storedMatch.description)
        ? 'requisition' : selectDirectAtsMatch({ ...job, description: null }, stored)?.url === storedMatch.url ? 'title' : 'description',
      postingTitle: storedMatch.title,
      postingLocation: storedMatch.location,
    };
  }

  // We know the company's board but not this posting, which is exactly the case
  // where the board has moved on since its last sweep.
  if (deps.allowLivePing === false) { deps.onOutcome?.(storedMatch ? 'stored_match_requires_live_confirmation' : 'no_unique_stored_match'); return null; }
  const employerIndex = (await employerRules(deps.store)).index;
  const canonicalEmployer = (company: string) => resolveEmployer({ company }, employerIndex);
  const canonicalCompany = canonicalEmployer(job.company);
  if (workdayAliasCandidates(stored)) {
    const identity = boardIdentityFromUrl(stored[0].url)!;
    const aliases = await fetchEmployerBoardPostings(identity, deps.fetcher || safeExternalFetch,
      deps.timeoutMs ?? EMPLOYER_CATALOGUE_TIMEOUT_MS, undefined, { title: job.title, company: canonicalCompany, canonicalEmployer, storedAliases: stored });
    const aliasMatch = aliases && selectDirectAtsMatch(job, aliases);
    if (aliasMatch) {
      deps.onOutcome?.('matched_live');
      return { url: normalizeDirectPostingUrl(aliasMatch.url), description: aliasMatch.description,
        ...identity, matchedVia: 'live', matchedBy: 'requisition', postingTitle: aliasMatch.title, postingLocation: aliasMatch.location };
    }
  }
  if (!boards.length) { deps.onOutcome?.('no_verified_board'); return null; }
  if (boards.some(item => item.platform !== 'eightfold' && !supportsEmployerBoardLookup(item.platform))) {
    deps.onOutcome?.('live_unsupported');
    return null;
  }
  // Workday/Eightfold queries are title-scoped even for multi-board employers.
  const key = `boards:${JSON.stringify(boards.map(item => `${item.platform}:${item.slug}`).sort())}:${directAtsTitleKey(job.title)}`;
  let pending = deps.liveCache?.get(key);
  if (!pending) {
    pending = Promise.all(boards.map(item => item.platform === 'eightfold'
      // Eightfold already reads every search page and verifies each detail.
      ? fetchBoardPostings(item, deps.fetcher || safeExternalFetch, deps.timeoutMs ?? EMPLOYER_CATALOGUE_TIMEOUT_MS,
        { title: job.title, company: canonicalCompany }).then(items => items.length ? items : null)
      : fetchEmployerBoardPostings(item,
        deps.fetcher || safeExternalFetch, deps.timeoutMs ?? EMPLOYER_CATALOGUE_TIMEOUT_MS, undefined,
        { title: job.title, company: canonicalCompany, canonicalEmployer })))
        // An unavailable board could contain a competing requisition. Never
        // turn a partial employer catalogue into a seemingly unique match.
        .then(catalogues => catalogues.some(items => items === null) ? null : catalogues.flatMap(items => items!));
    deps.liveCache?.set(key, pending);
  }
  const live = await pending;
  if (live === null) { deps.onOutcome?.('live_unavailable'); return null; }
  deps.onLiveCatalogue?.({ boards, postings: live });
  // A newer live catalogue cannot erase a different saved requisition and
  // manufacture uniqueness. Only explicit source/req evidence can choose it.
  const liveMatch = selectDirectAtsMatch(job, [...live, ...stored]);
  if (!liveMatch) { deps.onOutcome?.('no_unique_live_match'); return null; }
  if (verificationRequiredUrls.includes(liveMatch.url)
    && !live.some(posting => directAtsPostingKey(posting) === directAtsPostingKey(liveMatch))) {
    deps.onOutcome?.('stored_match_requires_live_confirmation'); return null;
  }
  const identity = boardIdentityFromUrl(liveMatch.url) || board;
  if (!identity) return null;
  deps.onOutcome?.('matched_live');

  return {
    url: normalizeDirectPostingUrl(liveMatch.url) || liveMatch.url,
    description: liveMatch.description,
    platform: identity.platform,
    slug: identity.slug,
    matchedVia: 'live',
    matchedBy: declaredSourcePostingKeys(job.description).has(directAtsPostingKey(liveMatch)) ? 'source_url'
      : declaredRequisitionId(job.description) && declaredRequisitionId(job.description) === declaredRequisitionId(liveMatch.description)
      ? 'requisition' : selectDirectAtsMatch({ ...job, description: null }, [...live, ...stored])?.url === liveMatch.url ? 'title' : 'description',
    postingTitle: liveMatch.title,
    postingLocation: liveMatch.location,
  };
}

export type DirectMatchEnrichment = {
  url: string;
  canonicalUrl: string;
  description?: string;
};

/**
 * Compare readable content, never the length of tags, attributes or entities.
 * Used by both new ingestion and existing-row enrichment, including callers
 * supplying stored or browser-derived descriptions instead of parsed boards.
 */
export function selectFullerAtsDescription(
  current: string | null | undefined,
  candidate: string | null | undefined,
): string | null {
  const next = descriptionText(candidate);
  return next && next.length > (descriptionText(current)?.length || 0) ? next : null;
}

/**
 * What enrichment is allowed to change on an existing row.
 *
 * Only the apply target and the posting text. Nothing here touches `title`,
 * `company`, or `location`, so `identityFingerprint` stays valid and no
 * duplicate relationship is re-decided behind Joseph's back.
 *
 * The description is replaced only when the employer's readable copy is longer
 * than the aggregator's readable copy — tags must not make a stub look fuller.
 */
export function planDirectMatchEnrichment(
  job: { url?: string | null; canonicalUrl?: string | null; description?: string | null },
  match: DirectAtsMatch,
): DirectMatchEnrichment | null {
  const nextUrl = match.url;
  if (!nextUrl) return null;

  const urlAlreadyDirect = normalizeDirectPostingUrl(String(job.canonicalUrl || '')) === normalizeDirectPostingUrl(nextUrl)
    && normalizeDirectPostingUrl(String(job.url || '')) === normalizeDirectPostingUrl(nextUrl);
  const betterDescription = selectFullerAtsDescription(job.description, match.description);

  if (urlAlreadyDirect && !betterDescription) return null;
  return {
    url: nextUrl,
    canonicalUrl: nextUrl,
    ...(betterDescription ? { description: betterDescription } : {}),
  };
}

/**
 * Writes an enrichment without disturbing scoring.
 *
 * Deliberately a direct field write rather than the job PATCH route: that route
 * treats a changed description as a scoring input and invalidates the job's
 * existing score events. Per the score preservation rule a resolution like this
 * is prospective only — a job that is already scored keeps its score, and if
 * Joseph wants it re-read against the fuller ATS text he rescores it explicitly
 * from the Dashboard.
 *
 * `updatedAt` is repeated in the predicate so a row edited between the read and
 * the write is refused rather than overwritten with a stale plan.
 */
export async function applyDirectMatchEnrichment(
  jobId: string,
  expectedUpdatedAt: Date,
  enrichment: DirectMatchEnrichment,
  store: Pick<Prisma.TransactionClient, 'job'>,
): Promise<boolean> {
  const result = await store.job.updateMany({
    where: { id: jobId, updatedAt: expectedUpdatedAt, userCanonicalUrl: null },
    data: enrichment,
  });
  return result.count === 1;
}
