import { atsBoardRequest, boardIdentityFromUrl, parseBoardPostings, type BoardIdentity, type BoardPosting } from './atsDirectMatch';
import { cleanHtmlText, fetchAtsPlatformResponse } from './jobIngestion';
import { reserveProviderBudgetForSource } from './ingestionControl';
import { safeExternalFetch } from './safeExternalFetch';
import { fetchWorkdayMatchPostings, fetchWorkdayStoredAliases, type WorkdayMatchJob } from './workdayDirectMatch';
import { parseZohoRecruitListing } from './zohoRecruitBoard';
import { readAdditionalEmployerCatalogue, supportsAdditionalEmployerCatalogue } from './employerCatalogueReaders';

// A complete paginated search can take longer on M70 than a single ATS ping.
// C.H. Robinson required 20 seconds for seven pages plus exact details while
// sharing the production request leases. Keep a bounded budget for that work.
export const EMPLOYER_CATALOGUE_TIMEOUT_MS = 30_000;

export function supportsEmployerBoardLookup(platform: string): boolean {
  return ['workday', 'lever', 'greenhouse', 'ashby', 'recruitee', 'breezy', 'bamboohr',
    'smartrecruiters', 'workable', 'teamtailor', 'pinpoint', 'zohorecruit'].includes(platform)
    || supportsAdditionalEmployerCatalogue(platform);
}

/** Complete public catalogues only: a partial page cannot prove a unique job. */
export async function fetchEmployerBoardPostings(
  board: BoardIdentity,
  fetcher: typeof safeExternalFetch = safeExternalFetch,
  timeoutMs = EMPLOYER_CATALOGUE_TIMEOUT_MS,
  parentSignal?: AbortSignal,
  job?: WorkdayMatchJob,
): Promise<BoardPosting[] | null> {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = parentSignal ? AbortSignal.any([timeoutSignal, parentSignal]) : timeoutSignal;
  const readResponse = async (url: string | URL, init?: RequestInit) => {
    const request = async () => {
      if (fetcher === safeExternalFetch) {
        const decision = await reserveProviderBudgetForSource(`ATS-${board.platform}`);
        if (!decision.allowed) throw new Error('Employer lookup deferred by provider controls');
      }
      return fetcher(String(url), { ...init, signal });
    };
    const response = fetcher === safeExternalFetch
      ? await fetchAtsPlatformResponse(board.platform, signal, request, { requestedUrl: String(url) })
      : await request();
    if (!response.ok) throw new Error('Employer catalogue unavailable');
    return response;
  };
  const read = async (url: string | URL, init?: RequestInit) => {
    const response = await readResponse(url, { ...init, headers: { ...init?.headers, Accept: 'application/json' } });
    if (!/json/i.test(response.headers.get('content-type') || '')) throw new Error('Employer catalogue unavailable');
    if (response.url) {
      const expected = new URL(url);
      const actual = new URL(response.url);
      if (actual.origin !== expected.origin || actual.pathname.toLowerCase() !== expected.pathname.toLowerCase()) {
        throw new Error('Employer catalogue redirected away from its verified identity');
      }
    }
    return response.json();
  };
  const postings = new Map<string, BoardPosting>();
  try {
    if (board.platform === 'workday') return job
      ? job.storedAliases ? await fetchWorkdayStoredAliases(job, read) : await fetchWorkdayMatchPostings(board.slug, job, read) : null;
    if (board.platform !== 'zohorecruit' && supportsAdditionalEmployerCatalogue(board.platform)) {
      return await readAdditionalEmployerCatalogue(board, readResponse, job);
    }
    if (!supportsEmployerBoardLookup(board.platform)) return null;
    const request = atsBoardRequest(board.platform, board.slug);
    if (!request) return null;
    let expectedTotal: number | undefined;
    let nextToken: string | undefined;
    const tokens = new Set<string>();
    for (let page = 0; page < 20; page += 1) {
      const url = new URL(request.url);
      let init = request.init;
      if (board.platform === 'lever') {
        url.searchParams.set('mode', 'json');
        url.searchParams.set('skip', String(page * 100));
        url.searchParams.set('limit', '100');
      }
      if (board.platform === 'smartrecruiters') {
        url.searchParams.set('offset', String(page * 100));
        url.searchParams.set('limit', '100');
      }
      if (board.platform === 'workable' && nextToken) {
        init = { ...request.init, body: JSON.stringify({ ...JSON.parse(String(request.init?.body)), token: nextToken }) };
      }
      const body = await read(url, init);
      if (board.platform === 'zohorecruit') {
        // This parser validates the whole public feed, including unpublished
        // rows, before filtering them out. A malformed feed throws below.
        return parseZohoRecruitListing(board.slug, body).jobs.map(row => ({
          title: String(row.title), url: String(row.url),
          location: typeof row.location === 'string' ? row.location : null,
          description: typeof row.description === 'string' ? cleanHtmlText(row.description) : null,
        }));
      }
      const raw = board.platform === 'greenhouse' || board.platform === 'ashby' ? body?.jobs
        : board.platform === 'recruitee' ? body?.offers
          : board.platform === 'bamboohr' ? body?.result
            : board.platform === 'smartrecruiters' ? body?.content
              : board.platform === 'workable' ? body?.results
                : board.platform === 'teamtailor' ? body?.items
                  : board.platform === 'pinpoint' ? body?.data : body;
      if (!Array.isArray(raw)) return null;
      if (board.platform === 'lever' && raw.length > 100) return null;
      if (board.platform === 'greenhouse' && body.meta?.total !== undefined && body.meta.total !== raw.length) return null;
      if (board.platform === 'teamtailor' && body.next_url) return null;
      if (board.platform === 'pinpoint' && (body.links?.next || body.meta?.next_page
        || (body.meta?.total !== undefined && body.meta.total !== raw.length))) return null;
      if (board.platform === 'smartrecruiters' || board.platform === 'workable') {
        const total = board.platform === 'smartrecruiters' ? body.totalFound : body.total;
        if (!Number.isSafeInteger(total) || total < 0 || (expectedTotal !== undefined && expectedTotal !== total)) return null;
        expectedTotal = total;
      }
      const parsed = parseBoardPostings(board.platform, body, board.slug);
      // Reject malformed rows and cross-board URLs rather than silently losing
      // a competing requisition before the ambiguity check.
      if (parsed.length !== raw.length) return null;
      for (const posting of parsed) {
        const identity = boardIdentityFromUrl(posting.url);
        if (!posting.title || !identity || identity.platform !== board.platform
          || identity.slug.toLowerCase() !== board.slug.toLowerCase() || postings.has(posting.url)) return null;
        postings.set(posting.url, posting);
      }
      if (expectedTotal !== undefined) {
        if (postings.size === expectedTotal) return [...postings.values()];
        if (postings.size > expectedTotal || raw.length === 0) return null;
        if (board.platform === 'smartrecruiters' && raw.length !== 100) return null;
        if (board.platform === 'workable') {
          const token = body.nextPage;
          if (typeof token !== 'string' || !token || tokens.has(token)) return null;
          nextToken = token;
          tokens.add(token);
        }
      } else if (board.platform !== 'lever' || raw.length < 100) return [...postings.values()];
    }
    return null;
  } catch {
    return null;
  }
}
