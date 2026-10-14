import { atsBoardRequest, boardIdentityFromUrl, parseBoardPostings, type BoardIdentity, type BoardPosting } from './atsDirectMatch';
import { fetchAtsPlatformResponse } from './jobIngestion';
import { reserveProviderBudgetForSource } from './ingestionControl';
import { safeExternalFetch } from './safeExternalFetch';

/** Complete public catalogues only: a partial page cannot prove a unique job. */
export async function fetchEmployerBoardPostings(
  board: BoardIdentity,
  fetcher: typeof safeExternalFetch = safeExternalFetch,
  timeoutMs = 15_000,
  parentSignal?: AbortSignal,
): Promise<BoardPosting[] | null> {
  if (!['lever', 'greenhouse', 'ashby', 'recruitee', 'breezy', 'bamboohr'].includes(board.platform)) return null;
  const request = atsBoardRequest(board.platform, board.slug);
  if (!request) return null;
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = parentSignal ? AbortSignal.any([timeoutSignal, parentSignal]) : timeoutSignal;
  const postings = new Map<string, BoardPosting>();
  try {
    for (let page = 0; page < 20; page += 1) {
      const url = new URL(request.url);
      if (board.platform === 'lever') {
        url.searchParams.set('mode', 'json');
        url.searchParams.set('skip', String(page * 100));
        url.searchParams.set('limit', '100');
      }
      const read = async () => {
        if (fetcher === safeExternalFetch) {
          const decision = await reserveProviderBudgetForSource(`ATS-${board.platform}`);
          if (!decision.allowed) throw new Error('Employer lookup deferred by provider controls');
        }
        return fetcher(url, { ...request.init, headers: { Accept: 'application/json' }, signal });
      };
      const response = fetcher === safeExternalFetch
        ? await fetchAtsPlatformResponse(board.platform, signal, read, { requestedUrl: url.href })
        : await read();
      if (!response.ok || !/json/i.test(response.headers.get('content-type') || '')) return null;
      const body = await response.json();
      const raw = board.platform === 'greenhouse' || board.platform === 'ashby' ? body?.jobs
        : board.platform === 'recruitee' ? body?.offers
          : board.platform === 'bamboohr' ? body?.result : body;
      if (!Array.isArray(raw)) return null;
      if (board.platform === 'lever' && raw.length > 100) return null;
      if (board.platform === 'greenhouse' && body.meta?.total !== undefined && body.meta.total !== raw.length) return null;
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
      if (board.platform !== 'lever' || raw.length < 100) return [...postings.values()];
    }
    return null;
  } catch {
    return null;
  }
}
