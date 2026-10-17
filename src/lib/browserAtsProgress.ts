import { browserAtsBoardFromUrl, type BrowserAtsPlatform } from './browserAtsBoards';
import { browserPostingLink, type BrowserPostingLink } from './browserAtsPosting';
import { BROWSER_MAX_PAGES, BROWSER_MAX_SEEN_IDS, type BrowserListing, type BrowserNext } from './browserAtsReader';
export type BrowserSweepProgress = {
    version: 1;
    board: string;
    page: number;
    pageUrl?: string;
    queue: BrowserPostingLink[];
    offset: number;
    seen: string[];
    signatures: string[];
    next: BrowserNext | null;
    total: number | null;
    loaded: boolean;
};
export function newBrowserSweep(board: string): BrowserSweepProgress { return { version: 1, board, page: 1, queue: [], offset: 0, seen: [], signatures: [], next: null, total: null, loaded: false }; }
export function readBrowserSweep(value: unknown, platform: BrowserAtsPlatform, board: string): BrowserSweepProgress {
    if (browserAtsBoardFromUrl(platform, board) !== board)
        throw Error('Invalid public-board identity');
    if (value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0)
        return newBrowserSweep(board);
    const p = value as BrowserSweepProgress;
    if (!p || p.version !== 1 || p.board !== board || browserAtsBoardFromUrl(platform, board) !== board || !Number.isInteger(p.page) || p.page < 1 || p.page > BROWSER_MAX_PAGES || !Array.isArray(p.queue) || p.queue.length > 250 || !Number.isInteger(p.offset) || p.offset < 0 || p.offset > p.queue.length || !Array.isArray(p.seen) || p.seen.length > BROWSER_MAX_SEEN_IDS || !p.seen.every(id => typeof id === 'string') || !Array.isArray(p.signatures) || p.signatures.length > BROWSER_MAX_PAGES || !p.signatures.every(x => typeof x === 'string') || typeof p.loaded !== 'boolean')
        throw Error('Invalid durable public-board progress; preserving it for review');
    if (p.pageUrl && browserAtsBoardFromUrl(platform, p.pageUrl) !== board)
        throw Error('Saved page escaped board identity');
    if (p.queue.some(l => !l || typeof l.id !== 'string' || typeof l.url !== 'string' || typeof l.title !== 'string' || browserPostingLink(platform, board, l.url)?.id !== l.id))
        throw Error('Saved posting escaped board identity');
    if (p.next !== null && (!p.next || !['url', 'click'].includes(p.next.kind) || p.next.kind === 'url' && browserAtsBoardFromUrl(platform, p.next.url) !== board))
        throw Error('Invalid saved pagination');
    if (p.total !== null && (!Number.isSafeInteger(p.total) || p.total < 0))
        throw Error('Invalid published job count');
    return p;
}
export function loadBrowserSweepPage(p: BrowserSweepProgress, listing: BrowserListing): BrowserSweepProgress {
    if (p.loaded && p.offset < p.queue.length)
        throw Error('Cannot replace unprocessed postings');
    if (listing.links.length && p.signatures.includes(listing.signature))
        throw Error('Pagination repeated a previous page; retaining progress');
    return { ...p, queue: listing.links, offset: 0, loaded: true, next: listing.next, total: listing.total ?? p.total, signatures: [...p.signatures, listing.signature] };
}
export function advanceBrowserSweep(p: BrowserSweepProgress): BrowserSweepProgress | null {
    if (!p.loaded || p.offset !== p.queue.length)
        throw Error('Cannot advance before every posting is durably processed');
    if (!p.next) {
        if (p.total !== null && p.seen.length < p.total)
            throw Error(`Only ${p.seen.length} of ${p.total} advertised jobs enumerated; retaining progress`);
        return null;
    }
    if (p.page >= BROWSER_MAX_PAGES || p.seen.length >= BROWSER_MAX_SEEN_IDS)
        throw Error('Board exceeds bounded catalogue limits; retaining progress for review');
    return { ...p, page: p.page + 1, pageUrl: p.next.kind === 'url' ? p.next.url : undefined, queue: [], offset: 0, loaded: false, next: null };
}
