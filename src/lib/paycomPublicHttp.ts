import { isPlaceholderEmployerName } from './companyIdentity';
import { createHash } from 'node:crypto';
import * as cheerio from 'cheerio';
import { safeExternalFetch } from './safeExternalFetch';
import { readBoundedAtsBody } from './tenantAtsBoards';
import { browserAtsBoardFromUrl } from './browserAtsBoards';
import { browserPostingLink, type BrowserPostingLink, type BrowserPosting } from './browserAtsPosting';
import type { BrowserListing } from './browserAtsReader';
const ORIGIN = 'https://portal-applicant-tracking.us-cent.paycomonline.net';
export const PAYCOM_HTTP_CATALOGUE_LIMIT = 2000;
const SEARCH_PAGE_SIZE = 50;
type Session = { token: string; client: string; company: string; links?: BrowserPostingLink[] };
class PaycomControlError extends Error { constructor(readonly original: unknown) { super('Paycom collection interrupted'); } }
/** Enumerate bounded public pages into one durable catalogue before processing
 * any job. A saved queue is never rebuilt from changing vendor offsets. */
export class PaycomPublicHttp {
    private sessions = new Map<string, Session>();
    constructor(private check: () => Promise<void>, private fetcher: (url: string, init: RequestInit) => Promise<Response> = safeExternalFetch) {}
    private async checkpoint() {
        try { await this.check(); } catch (error) { throw new PaycomControlError(error); }
    }
    private async json(path: string, token: string, body?: unknown): Promise<Record<string, unknown>> {
        await this.checkpoint();
        const response = await this.fetcher(ORIGIN + path, { method: body === undefined ? 'GET' : 'POST',
            redirect: 'error', signal: AbortSignal.timeout(10000), headers: { Authorization: token, Locale: 'en-US', 'Content-Type': 'application/json' },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
        if (!response.ok) { await response.body?.cancel(); throw Error('Public Paycom response unavailable'); }
        return JSON.parse(await readBoundedAtsBody(response, 5 * 1024 * 1024));
    }
    private async session(board: string): Promise<Session | null> {
        if (this.sessions.has(board)) return this.sessions.get(board)!;
        if (browserAtsBoardFromUrl('paycom', board) !== board) return null;
        await this.checkpoint();
        const response = await this.fetcher(board, { redirect: 'error', signal: AbortSignal.timeout(10000) });
        if (!response.ok) { await response.body?.cancel(); return null; }
        const html = await readBoundedAtsBody(response, 5 * 1024 * 1024);
        const match = /var configsFromHost = (\{[^\n]*?\});/.exec(html);
        if (!match) return null;
        const config = JSON.parse(match[1]);
        // Anonymous page-issued token only; never persist it in a cursor or receipt.
        const token = config.sessionJWT;
        if (typeof token !== 'string') return null;
        const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
        if (claims.sub !== '0' || claims.isInternalJobBoard !== '' || typeof claims.clientcode !== 'string') return null;
        const branding = await this.json('/api/ats/company-name', token);
        if (typeof branding.companyName !== 'string' || branding.companyName.trim().length < 2 || branding.companyName.length > 200 || isPlaceholderEmployerName(branding.companyName)) return null;
        const session: Session = { token, client: claims.clientcode, company: branding.companyName.trim() };
        if (this.sessions.size >= 8) this.sessions.clear();
        this.sessions.set(board, session);
        return session;
    }
    private async search(token: string, skip: number) {
        return this.json('/api/ats/job-posting-previews/search', token, { skip, take: SEARCH_PAGE_SIZE,
            filtersForQuery: { distanceFrom: 0, workEnvironments: [], positionTypes: [], educationLevels: [], categories: [], travelTypes: [], shiftTypes: [], otherFilters: [], keywordSearchText: '', location: '', sortOption: 'N' } });
    }
    private async catalogue(board: string): Promise<Session | null> {
        const session = await this.session(board);
        if (!session || session.links) return session;
        const links: BrowserPostingLink[] = [], ids = new Set<string>();
        let total: number | undefined, firstPage = '';
        do {
            const result = await this.search(session.token, links.length);
            const rows = result.jobPostingPreviews, count = result.jobPostingPreviewsCount;
            if (!Number.isSafeInteger(count) || (count as number) < 0 || (count as number) > PAYCOM_HTTP_CATALOGUE_LIMIT
                || total !== undefined && count !== total || !Array.isArray(rows)) return null;
            total = count as number;
            if (rows.length !== Math.min(SEARCH_PAGE_SIZE, total - links.length)) return null;
            if (!links.length) firstPage = JSON.stringify(rows.map(row => [row?.jobId, row?.jobTitle]));
            for (const row of rows) {
                if (!row || !Number.isSafeInteger(row.jobId) || row.jobId <= 0 || typeof row.jobTitle !== 'string' || !row.jobTitle.trim()) return null;
                const link = browserPostingLink('paycom', board, board.replace(/career-page$/, 'jobs/' + row.jobId), row.jobTitle);
                if (!link || ids.has(link.id)) return null;
                ids.add(link.id); links.push({ ...link, titleVerified: true });
            }
        } while (links.length < total);
        // Catch insertions/removals/reordering at the head while fetching offsets.
        // Counts and distinct IDs were also checked on every intervening page.
        if (total > SEARCH_PAGE_SIZE) {
            const again = await this.search(session.token, 0);
            if (again.jobPostingPreviewsCount !== total || !Array.isArray(again.jobPostingPreviews)
                || JSON.stringify(again.jobPostingPreviews.map(row => [row?.jobId, row?.jobTitle])) !== firstPage) return null;
        }
        session.links = links;
        return session;
    }
    async page(board: string, page: number, pageUrl?: string): Promise<BrowserListing | null> {
        try {
            if (page !== 1 || pageUrl && pageUrl !== board) return null;
            const session = await this.catalogue(board);
            if (!session?.links) return null;
            return { links: session.links, total: session.links.length, next: null, emptyVerified: !session.links.length,
                signature: createHash('sha256').update(session.links.map(l => l.id).sort().join('\n')).digest('hex') };
        } catch (error) { if (error instanceof PaycomControlError) throw error.original; return null; }
    }
    async detail(board: string, link: BrowserPostingLink, savedCatalogue?: BrowserPostingLink[]): Promise<BrowserPosting | null> {
        try {
            // Only the caller's persisted, complete HTTP catalogue can replace
            // fresh enumeration. Tokens and API offsets never enter the cursor.
            if (savedCatalogue && (savedCatalogue.length > PAYCOM_HTTP_CATALOGUE_LIMIT
                || new Set(savedCatalogue.map(l => l.id)).size !== savedCatalogue.length
                || savedCatalogue.some(l => !l.titleVerified || browserPostingLink('paycom', board, l.url)?.id !== l.id))) return null;
            const session = savedCatalogue ? await this.session(board) : await this.catalogue(board);
            if (!session || !(savedCatalogue || session.links)?.some(l => l.id === link.id && l.url === link.url && l.title === link.title)) return null;
            const result = await this.json('/api/ats/job-postings/' + link.id, session.token);
            const job = result.jobPosting as Record<string, unknown> | undefined;
            if (!job || String(job.jobId) !== link.id || job.clientCode !== session.client || job.jobTitle !== link.title
                || typeof job.description !== 'string' || typeof job.location !== 'string') return null;
            const description = cheerio.load(job.description.replace(/<\/(?:p|div|li|h[1-6])>/gi, '$&\n').replace(/<br\s*\/?>/gi, '\n')).text().trim();
            if (description.length < 200) return null;
            const location = [job.remoteType, job.location].filter(v => typeof v === 'string' && v).join('; ');
            return { ...link, company: session.company, description, location };
        } catch (error) { if (error instanceof PaycomControlError) throw error.original; return null; }
    }
}
