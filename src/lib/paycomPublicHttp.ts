import { isPlaceholderEmployerName } from './companyIdentity';
import { createHash } from 'node:crypto';
import * as cheerio from 'cheerio';
import { safeExternalFetch } from './safeExternalFetch';
import { readBoundedAtsBody } from './tenantAtsBoards';
import { browserAtsBoardFromUrl } from './browserAtsBoards';
import { browserPostingLink, type BrowserPostingLink, type BrowserPosting } from './browserAtsPosting';
import type { BrowserListing } from './browserAtsReader';
const ORIGIN = 'https://portal-applicant-tracking.us-cent.paycomonline.net';
type Session = { token: string; client: string; company: string; links: BrowserPostingLink[] };
/** Only complete, single-page public catalogues qualify. Larger or uncertain boards retain browser ownership. */
export class PaycomPublicHttp {
    private sessions = new Map<string, Session>();
    constructor(private check: () => Promise<void>, private fetcher: (url: string, init: RequestInit) => Promise<Response> = safeExternalFetch) {}
    private async json(path: string, token: string, body?: unknown): Promise<Record<string, unknown>> {
        await this.check();
        const response = await this.fetcher(ORIGIN + path, { method: body === undefined ? 'GET' : 'POST',
            redirect: 'error', signal: AbortSignal.timeout(10000), headers: { Authorization: token, Locale: 'en-US', 'Content-Type': 'application/json' },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
        if (!response.ok) { await response.body?.cancel(); throw Error('Public Paycom response unavailable'); }
        return JSON.parse(await readBoundedAtsBody(response, 5 * 1024 * 1024));
    }
    private async catalogue(board: string): Promise<Session | null> {
        if (this.sessions.has(board)) return this.sessions.get(board)!;
        if (browserAtsBoardFromUrl('paycom', board) !== board) return null;
        await this.check();
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
        const result = await this.json('/api/ats/job-posting-previews/search', token, { skip: 0, take: 50,
            filtersForQuery: { distanceFrom: 0, workEnvironments: [], positionTypes: [], educationLevels: [], categories: [], travelTypes: [], shiftTypes: [], otherFilters: [], keywordSearchText: '', location: '', sortOption: 'N' } });
        const rows = result.jobPostingPreviews;
        if (!Array.isArray(rows) || !Number.isSafeInteger(result.jobPostingPreviewsCount) || result.jobPostingPreviewsCount !== rows.length || rows.length > 50) return null;
        const links: BrowserPostingLink[] = [];
        for (const row of rows) {
            if (!row || !Number.isSafeInteger(row.jobId) || row.jobId <= 0 || typeof row.jobTitle !== 'string' || !row.jobTitle.trim()) return null;
            const link = browserPostingLink('paycom', board, board.replace(/career-page$/, 'jobs/' + row.jobId), row.jobTitle);
            if (!link || links.some(prior => prior.id === link.id)) return null;
            links.push({ ...link, titleVerified: true });
        }
        const session = { token, client: claims.clientcode, company: branding.companyName.trim(), links };
        if (this.sessions.size >= 8) this.sessions.clear();
        this.sessions.set(board, session);
        return session;
    }
    async page(board: string, page: number, pageUrl?: string): Promise<BrowserListing | null> {
        try {
            if (page !== 1 || pageUrl && pageUrl !== board) return null;
            const session = await this.catalogue(board);
            if (!session) return null;
            return { links: session.links, total: session.links.length, next: null, emptyVerified: !session.links.length,
                signature: createHash('sha256').update(session.links.map(l => l.id).sort().join('\n')).digest('hex') };
        } catch { return null; }
    }
    async detail(board: string, link: BrowserPostingLink): Promise<BrowserPosting | null> {
        try {
            const session = await this.catalogue(board);
            if (!session?.links.some(l => l.id === link.id && l.url === link.url)) return null;
            const result = await this.json('/api/ats/job-postings/' + link.id, session.token);
            const job = result.jobPosting as Record<string, unknown> | undefined;
            if (!job || String(job.jobId) !== link.id || job.clientCode !== session.client || job.jobTitle !== link.title
                || typeof job.description !== 'string' || typeof job.location !== 'string') return null;
            const description = cheerio.load(job.description.replace(/<\/(?:p|div|li|h[1-6])>/gi, '$&\n').replace(/<br\s*\/?>/gi, '\n')).text().trim();
            if (description.length < 200) return null;
            const location = [job.remoteType, job.location].filter(v => typeof v === 'string' && v).join('; ');
            return { ...link, company: session.company, description, location };
        } catch { return null; }
    }
}
