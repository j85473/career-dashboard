/** URL-only identities shared by imports, API dispatch and board discovery. */
export function greenhousePostingUrl(value: string): { board: string; id: string } | null {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port
      || !/^(?:boards|job-boards)(?:\.eu)?\.greenhouse\.io$/.test(url.hostname)) return null;
    const path = /^\/([a-z0-9_-]+)\/jobs\/(\d+)\/?$/i.exec(url.pathname);
    if (path) return { board: path[1], id: path[2] };
    if (!/^\/embed\/job_app\/?$/.test(url.pathname)) return null;
    const boards = url.searchParams.getAll('for');
    const ids = url.searchParams.getAll('token');
    const alternateIds = url.searchParams.getAll('gh_jid');
    if (boards.length !== 1 || !/^[a-z0-9_-]+$/i.test(boards[0])
      || ids.length !== 1 || !/^\d+$/.test(ids[0])
      || alternateIds.length > 1 || (alternateIds.length === 1 && alternateIds[0] !== ids[0])) return null;
    return { board: boards[0], id: ids[0] };
  } catch { return null; }
}

export function coreAtsHostedProvider(value: string): 'Greenhouse' | 'Lever' | 'Ashby' | null {
  try {
    const host = new URL(value).hostname;
    if (/^(?:boards|job-boards)(?:\.eu)?\.greenhouse\.io$/.test(host)) return 'Greenhouse';
    if (/^jobs(?:\.eu)?\.lever\.co$/.test(host)) return 'Lever';
    if (host === 'jobs.ashbyhq.com') return 'Ashby';
  } catch { /* Not a hosted ATS URL. */ }
  return null;
}

/** The application form and posting page identify the same selected opening. */
export function coreAtsPostingPageUrl(value: string): string {
  const greenhouse = greenhousePostingUrl(value);
  if (greenhouse) {
    const url = new URL(value);
    url.pathname = `/${greenhouse.board}/jobs/${greenhouse.id}`;
    for (const key of ['for', 'token', 'gh_jid']) url.searchParams.delete(key);
    return url.toString();
  }
  if (leverAshbyPostingUrl(value)) {
    const url = new URL(value);
    url.pathname = url.pathname.replace(/\/(?:apply|application)\/?$/, '');
    return url.toString();
  }
  return value;
}

export function leverAshbyPostingUrl(value: string): {
  provider: 'Lever' | 'Ashby'; board: string; id: string; apiUrl: string;
} | null {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
    const provider = coreAtsHostedProvider(value);
    if (provider !== 'Lever' && provider !== 'Ashby') return null;
    const path = /^\/([^/]+)\/([a-z0-9_-]+)(?:\/(apply|application))?\/?$/i.exec(url.pathname);
    if (!path || (path[3] && (provider === 'Lever' ? path[3] !== 'apply' : !['apply', 'application'].includes(path[3])))) return null;
    const board = decodeURIComponent(path[1]);
    if (!/^[a-z0-9_.-]+$/i.test(board) || ['.', '..'].includes(board)) return null;
    const id = path[2];
    const apiUrl = provider === 'Lever'
      ? `https://${url.hostname === 'jobs.eu.lever.co' ? 'api.eu.lever.co' : 'api.lever.co'}/v0/postings/${encodeURIComponent(board)}/${id}`
      : `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(board)}`;
    return { provider, board, id, apiUrl };
  } catch { return null; }
}
