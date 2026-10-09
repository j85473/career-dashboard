import { tenantAtsIdentityFromUrl } from './tenantAtsBoards';
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

import type { Prisma } from '@prisma/client';

import { cleanHtmlText, fetchAtsPlatformResponse, normalizeCompany, normalizeJobLocation, normalizeTitle, normalizeUrl } from './jobIngestion';
import { isExplicitInternationalLocationOption } from './jobLocationPolicy';
import { safeExternalFetch } from './safeExternalFetch';
import { buildEmployerRuleIndex, resolveEmployer, sameEmployer, type EmployerRule } from './employerIdentity';
import { eightfoldBoardSlugFromUrl, eightfoldBoardIdentity, eightfoldCareersUrl, eightfoldSearchUrl,
  eightfoldDetailUrl, eightfoldPostingUrl, eightfoldLocation, parseEightfoldConfig, parseEightfoldListing } from './eightfoldBoard';
import { workdayBoardSlugFromJobUrl } from './atsBoardYield';
import { reserveProviderBudgetForSource } from './ingestionControl';
import { zohoRecruitBoardSlugFromUrl, zohoRecruitBoardRequest, parseZohoRecruitListing } from './zohoRecruitBoard';

export type BoardIdentity = { platform: string; slug: string };

export type BoardPosting = {
  title: string;
  url: string;
  location: string | null;
  description: string | null;
};

export type DirectAtsMatch = {
  url: string;
  description: string | null;
  platform: string;
  slug: string;
  /** Whether the posting came from what we already stored or from a live ping. */
  matchedVia: 'stored' | 'live';
  /** The exact posting title is preferred; a unique substantial-body match is the fallback. */
  matchedBy?: 'title' | 'description';
  postingTitle: string;
  postingLocation: string | null;
};

/** Sources that are already the employer's ATS, or Joseph's own entries. */
const NON_AGGREGATOR_SOURCE = /^(?:ATS-|Manual Import$)/i;

export function isAggregatorSource(source: string | null | undefined): boolean {
  const value = String(source || '').trim();
  return value.length > 0 && !NON_AGGREGATOR_SOURCE.test(value);
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
 * Whether two location strings could describe the same posting.
 *
 * Exact equality is too strict to be useful here: the aggregator said "USA" and
 * Greenhouse said "Remote, United States", which normalize to `us` and
 * `remote us`. Country is the honest granularity — it is what actually
 * separated Karbon's US requisition from its Canadian one.
 */
/**
 * A location that names a country or a national remote scope but no place
 * inside it — "us", "remote", "remote us". These are compatible with anything
 * domestic, because they do not claim a city to disagree about.
 */
function isBroadUsLocation(normalized: string): boolean {
  const withoutRemote = normalized.replace(/\bremote\b/g, ' ').replace(/\s+/g, ' ').trim();
  return withoutRemote === '' || withoutRemote === 'us';
}

function isWorldwideLocation(value: string): boolean {
  return /^(?:remote\s*[/,-]?\s*)?(?:anywhere(?: in the world)?|worldwide|global)(?:\s*[/,-]?\s*remote)?$/i.test(value.trim());
}

/**
 * The city a location string leads with. Feeds split their locations as
 * "City, County" or "City, ST", so the first component is the claim about
 * where the job is and the rest is administrative detail.
 */
function primaryPlace(value: string | null | undefined): string {
  return normalizeJobLocation(String(value || '').split(',')[0] || '');
}

export function locationsCompatibleForDirectMatch(
  aggregatorLocation: string | null | undefined,
  postingLocation: string | null | undefined,
): boolean {
  const left = normalizeJobLocation(String(aggregatorLocation || ''));
  const right = normalizeJobLocation(String(postingLocation || ''));
  if (left === right) return true;
  // One side genuinely does not say where the job is. The board, the exact
  // title, the title-suffix check, and the single-survivor rule still apply.
  if (left === 'unknown' || right === 'unknown') return true;
  // WWR's site-wide worldwide label supplies no country or city constraint.
  // It must still survive title/body identity and the single-candidate rule.
  if (isWorldwideLocation(left) || isWorldwideLocation(right)) return true;

  const leftForeign = isExplicitInternationalLocationOption(left);
  const rightForeign = isExplicitInternationalLocationOption(right);
  // "Remote, Canada" against "USA": one names a country outside the US and the
  // other does not, so they are different postings.
  if (leftForeign !== rightForeign) return false;
  // Two different foreign countries are only the same posting by coincidence of
  // wording, which is not evidence. Require the normalized strings to overlap.
  if (leftForeign && rightForeign) {
    return left.includes(right) || right.includes(left);
  }

  // A national or remote scope on either side cannot contradict a city.
  // This is the Karbon case: "USA" against "Remote, United States".
  if (isBroadUsLocation(left) || isBroadUsLocation(right)) return true;

  // Both name a specific US place, so they have to name the *same* one.
  // Treating any two domestic cities as compatible is what matched four
  // AbbVie "Specialty Representative, Rheumatology - Milwaukee, WI" listings
  // in Wisconsin to the Minneapolis requisition: normalizeTitle strips the
  // trailing city from both titles, so geography was the only thing left to
  // separate them and it was not being asked.
  return primaryPlace(aggregatorLocation) === primaryPlace(postingLocation);
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

/**
 * Picks the one posting that is unambiguously this job. Pure, so the decision
 * is testable without a network or a database.
 */
export function selectDirectAtsMatch(
  job: { title: string; location?: string | null; description?: string | null; source?: string | null },
  postings: readonly BoardPosting[],
): BoardPosting | null {
  const wantedTitle = normalizeTitle(job.title || '');
  if (!wantedTitle) return null;

  const wantedSuffix = titleLocationSuffix(job.title);
  const sameTitle = postings.filter((posting) => {
    if (normalizeTitle(posting.title || '') !== wantedTitle) return false;
    // Equal only because each title's own territory was stripped off means the
    // titles never actually agreed. "... - Milwaukee, WI" is not
    // "... - Minneapolis, MN", whatever the location fields happen to say.
    const postingSuffix = titleLocationSuffix(posting.title);
    if (wantedSuffix && postingSuffix && wantedSuffix !== postingSuffix) return false;
    return true;
  });
  const compatible = [...new Map(sameTitle.filter((posting) => posting.url
    && locationsCompatibleForDirectMatch(job.location, posting.location))
    .map(posting => [normalizeUrl(posting.url), posting])).values()];
  // Every posting under this title was ruled out by geography, or several
  // survived and nothing distinguishes them. Both are refusals, not matches.
  if (compatible.length === 1) {
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
    if (!posting.url || !locationsCompatibleForDirectMatch(job.location, posting.location)) return false;
    const postingBody = substantialDescription(posting.description);
    if (!postingBody) return false;
    if (wantedBody === postingBody) return true;
    const shorter = wantedBody.length <= postingBody.length ? wantedBody : postingBody;
    const longer = wantedBody.length > postingBody.length ? wantedBody : postingBody;
    // Permit only a small publisher footer or heading around an otherwise
    // identical body. A partial or merely similar description is not proof.
    return shorter.length / longer.length >= 0.94 && longer.includes(shorter);
  });
  return sameBody.length === 1 ? sameBody[0] : null;
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
          location: text((job.location as Row | null)?.fullLocation)
            || [text((job.location as Row | null)?.city), text((job.location as Row | null)?.region)]
              .filter(Boolean).join(', ') || null,
          description: null,
        };
      });
    case 'recruitee':
      return rows(body, 'offers').map((job) => ({
        title: text(job.position) || '',
        url: absoluteUrl(job.careers_url) || '',
        location: text(job.location),
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
  liveCache?: Map<string, Promise<BoardPosting[]>>;
};

type DirectMatchStore = Pick<Prisma.TransactionClient, 'job'>
  & Partial<Pick<Prisma.TransactionClient, 'atsCompany' | 'companyNameRule'>>;

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

/** ATS postings already stored for this company, as match candidates. */
export async function findStoredAtsPostings(
  company: string,
  store: DirectMatchStore,
): Promise<{ postings: BoardPosting[]; board: BoardIdentity | null }> {
  const { rules, index } = await employerRules(store);
  const employer = resolveEmployer({ company }, index);
  const wanted = normalizeCompany(employer || '');
  if (!wanted) return { postings: [], board: null };
  const compactWanted = wanted.replace(/\s+/g, '');
  const companyCandidates = [
    { company: { equals: company, mode: 'insensitive' as const } },
    { employer: { equals: employer, mode: 'insensitive' as const } },
    ...(wanted.length >= 3 ? [{ company: { contains: wanted, mode: 'insensitive' as const } }] : []),
    ...(compactWanted.length >= 3 && compactWanted !== wanted
      ? [{ company: { contains: compactWanted, mode: 'insensitive' as const } }]
      : []),
  ];

  // A large employer must not lose its known board at the old 400-job cap.
  // Read complete bounded pages; if coverage is incomplete, keep the board
  // evidence and use a live title search instead of claiming a unique hit.
  const stored: Array<{ title: string; company: string; employer?: string | null;
    url: string | null; canonicalUrl: string | null; location: string | null; description: string | null }> = [];
  let complete = false;
  for (let skip = 0; skip < 4_000; skip += 400) {
    const page = await store.job.findMany({
      where: { source: { startsWith: 'ATS-' }, OR: companyCandidates },
      select: { title: true, company: true, employer: true, url: true, canonicalUrl: true, location: true, description: true },
      orderBy: { id: 'asc' }, skip, take: 400,
    });
    stored.push(...page);
    if (page.length < 400) { complete = true; break; }
    if (page.length > 400) break;
  }

  const candidates: Array<BoardPosting & { board: BoardIdentity | null }> = [];
  const boards = new Map<string, BoardIdentity>();
  const addBoard = (board: BoardIdentity | null) => {
    if (board) boards.set(`${board.platform}:${board.slug}`, board);
  };
  for (const row of stored) {
    // The contains clauses above are database narrowing only. The canonical
    // comparison is the authority, so a common substring cannot cross-link two
    // employers.
    if (!sameEmployer({ company: row.company, employer: row.employer || resolveEmployer(row, index) }, { employer })) continue;
    const url = absoluteUrl(row.canonicalUrl) || absoluteUrl(row.url);
    if (!url) continue;
    const board = boardIdentityFromUrl(url);
    addBoard(board);
    candidates.push({
      board,
      title: row.title || '',
      url,
      location: row.location,
      description: descriptionText(row.description),
    });
  }
  // Verified catalogue evidence can identify a board before its first Job is
  // persisted. A slug resembling the employer's name is never sufficient.
  for (const rule of rules) {
    if (rule.matchType !== 'ats_board_employer' || rule.origin !== 'verified_ats_source'
      || !sameEmployer({ company: rule.standardName }, { employer })) continue;
    const separator = rule.matchKey.indexOf(':');
    if (separator > 0) addBoard({ platform: rule.matchKey.slice(0, separator), slug: rule.matchKey.slice(separator + 1) });
  }
  const registered = store.atsCompany && boards.size ? await store.atsCompany.findMany({
    where: { OR: [...boards.values()] }, select: { platform: true, slug: true, status: true },
  }) : null;
  const enabled = registered ? new Set(registered.filter(row => row.status !== 'excluded')
    .map(row => `${row.platform}:${row.slug}`)) : new Set(boards.keys());
  const activeBoards = [...boards.entries()].filter(([key]) => enabled.has(key)).map(([, value]) => value);
  const postings = complete ? candidates.filter(row => !row.board || enabled.has(`${row.board.platform}:${row.board.slug}`))
    .map(row => ({ title: row.title, url: row.url, location: row.location, description: row.description })) : [];
  return { postings, board: activeBoards.length === 1 ? activeBoards[0] : null };
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
  const { board } = await findStoredAtsPostings(company, store);
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
  job: { title: string; company: string; location?: string | null; description?: string | null; url?: string | null; source?: string | null },
  deps: DirectMatchDeps,
): Promise<DirectAtsMatch | null> {
  if (!isAggregatorSource(job.source)) return null;
  if (!job.title?.trim() || !job.company?.trim()) return null;

  const { postings: stored, board } = await findStoredAtsPostings(job.company, deps.store);

  const storedMatch = selectDirectAtsMatch(job, stored);
  if (storedMatch) {
    const identity = boardIdentityFromUrl(storedMatch.url) || board;
    return {
      url: normalizeUrl(storedMatch.url) || storedMatch.url,
      description: storedMatch.description,
      platform: identity?.platform || 'unknown',
      slug: identity?.slug || '',
      matchedVia: 'stored',
      matchedBy: selectDirectAtsMatch({ ...job, description: null }, stored)?.url === storedMatch.url ? 'title' : 'description',
      postingTitle: storedMatch.title,
      postingLocation: storedMatch.location,
    };
  }

  // We know the company's board but not this posting, which is exactly the case
  // where the board has moved on since its last sweep.
  if (!board || deps.allowLivePing === false) return null;
  const canonicalCompany = resolveEmployer({ company: job.company }, (await employerRules(deps.store)).index);
  const key = `${board.platform}:${board.slug}:${normalizeTitle(job.title)}`;
  let pending = deps.liveCache?.get(key);
  if (!pending) {
    pending = fetchBoardPostings(board, deps.fetcher || safeExternalFetch, deps.timeoutMs ?? 12_000,
      { title: job.title, company: canonicalCompany });
    deps.liveCache?.set(key, pending);
  }
  const live = await pending;
  const liveMatch = selectDirectAtsMatch(job, live);
  if (!liveMatch) return null;

  return {
    url: normalizeUrl(liveMatch.url) || liveMatch.url,
    description: liveMatch.description,
    platform: board.platform,
    slug: board.slug,
    matchedVia: 'live',
    matchedBy: selectDirectAtsMatch({ ...job, description: null }, live)?.url === liveMatch.url ? 'title' : 'description',
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

  const urlAlreadyDirect = normalizeUrl(String(job.canonicalUrl || '')) === normalizeUrl(nextUrl)
    && normalizeUrl(String(job.url || '')) === normalizeUrl(nextUrl);
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
    where: { id: jobId, updatedAt: expectedUpdatedAt },
    data: enrichment,
  });
  return result.count === 1;
}
