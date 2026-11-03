import { paycorPublicListing } from './paycorPublic';
import { icimsListingUrl, icimsPublicListing } from './icimsPublicListing';
import { assertPublicBoardAvailable, PublicBoardUnavailableError } from './publicBoardAvailability';
import { PaycomPublicHttp } from './paycomPublicHttp';
import { createHash } from 'node:crypto';
import * as cheerio from 'cheerio';
import { browserAtsBoardFromUrl, type BrowserAtsPlatform } from './browserAtsBoards';
import { browserPostingLink, parseBrowserPosting, type BrowserPosting, type BrowserPostingLink } from './browserAtsPosting';
import type { BrowserListing } from './browserAtsReader';
import { safeExternalFetch } from './safeExternalFetch';
import { readBoundedAtsBody } from './tenantAtsBoards';
import { BrassringHttpDetailReader } from './brassringHttpDetail';
import { isPlaceholderEmployerName } from './companyIdentity';

type Fetcher = (url: string, init: RequestInit) => Promise<Response>;
type PaylocityCatalogue = { company: string; links: BrowserPostingLink[] };
const PAGE_SIZE = 250;
const signature = (links: BrowserPostingLink[]) => createHash('sha256').update(links.map(j => j.id).sort().join('\n')).digest('hex');
const companyKey = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, '');
const companyName = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 1
    && value.length < 200 && /[a-z]/i.test(value) && !isPlaceholderEmployerName(value) && !/^(?:careers?|jobs?|paylocity)$/i.test(value.trim());
export const canUseBrowserAtsHttp = (platform: string): boolean => platform === 'paylocity' || platform === 'icims' || platform === 'paycom' || platform === 'paycor';
export const canUseBrowserAtsHttpDetail = (platform: string): boolean => canUseBrowserAtsHttp(platform) || platform === 'brassring';

/** Parse only JSON emitted by the public page; never execute page scripts. */
export function publicPageData(html: string): Record<string, unknown> | null {
    const start = /\bwindow\.pageData\s*=\s*\{/.exec(html);
    if (!start) return null;
    const offset = start.index + start[0].lastIndexOf('{');
    let depth = 0, quoted = false, escaped = false;
    for (let index = offset; index < html.length; index++) {
        const character = html[index];
        if (quoted) {
            if (escaped) escaped = false;
            else if (character === '\\') escaped = true;
            else if (character === '"') quoted = false;
        } else if (character === '"') quoted = true;
        else if (character === '{') depth++;
        else if (character === '}' && --depth === 0) {
            try { return JSON.parse(html.slice(offset, index + 1)); } catch { return null; }
        }
    }
    return null;
}

/** Public HTTP is an optimization. A refusal or incomplete page returns null so
 * the caller can retain its existing browser path and durable sweep progress. */
export class BrowserAtsHttpReader {
    private catalogues = new Map<string, PaylocityCatalogue>();
    private paycom: PaycomPublicHttp;
    private brassring: BrassringHttpDetailReader;
    constructor(private check: () => Promise<void> = async () => {}, private fetcher: Fetcher = safeExternalFetch) {
        this.paycom = new PaycomPublicHttp(check, fetcher);
        this.brassring = new BrassringHttpDetailReader(check, fetcher);
    }

    private async document(url: string, missingBoardMatches?: (landed: string) => boolean): Promise<{ url: string; html: string; text: string } | null> {
        await this.check();
        try {
            const response = await this.fetcher(url, { signal: AbortSignal.timeout(10_000), headers: { Accept: 'text/html' } });
            if (!response.ok) {
                await response.body?.cancel();
                if ([404, 410].includes(response.status) && missingBoardMatches?.(response.url || url))
                    throw new PublicBoardUnavailableError('Board returned HTTP ' + response.status);
                return null;
            }
            const html = await readBoundedAtsBody(response, 5 * 1024 * 1024);
            if (!html || /(?:just a moment\.\.\.|verify you are human|challenge-platform|cf-chl-)/i.test(html)) return null;
            const $ = cheerio.load(html);
            return { url: response.url || url, html, text: $('body').text() };
        } catch (error) {
            if (error instanceof PublicBoardUnavailableError) throw error;
            return null;
        }
    }

    private async paylocityCatalogue(board: string): Promise<PaylocityCatalogue | null> {
        const previous = this.catalogues.get(board);
        if (previous) return previous;
        const doc = await this.document(board);
        if (!doc) return null;
        assertPublicBoardAvailable('paylocity', doc);
        if (browserAtsBoardFromUrl('paylocity', doc.url) !== board) return null;
        const data = publicPageData(doc.html);
        if (!data || data.ShowInternal !== false
            || !Array.isArray(data.Jobs) || data.Jobs.length > PAGE_SIZE) return null;
        const $ = cheerio.load(doc.html);
        const heading = $('header #LayoutLogoName,#LayoutLogoName').first().text().trim();
        const pageTitle = /^(.*?)\s+-\s+Job Opportunities\s*$/i.exec($('title').text())?.[1]?.trim();
        const names = [heading, pageTitle].filter(companyName);
        const configured = companyName(data.ModuleTitle) ? data.ModuleTitle.trim() : '';
        // Missing branding is optional; contradictory published names still
        // fail validation. Tenant URL, public flag and exact job IDs bind jobs.
        if (configured && names.length && !names.some(name => companyKey(name) === companyKey(configured))) return null;
        const company = configured || (new Set(names.map(companyKey)).size === 1 ? names[0] : 'Unknown Company');
        const links: BrowserPostingLink[] = [], ids = new Set<string>();
        for (const raw of data.Jobs) {
            if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
            const job = raw as Record<string, unknown>;
            if (!Number.isSafeInteger(job.JobId) || (job.JobId as number) <= 0 || job.IsInternal !== false
                || typeof job.JobTitle !== 'string' || !job.JobTitle.trim()) return null;
            const id = String(job.JobId);
            if (ids.has(id)) return null;
            ids.add(id);
            const link = browserPostingLink('paylocity', board, new URL('/Recruiting/Jobs/Details/' + id, board).href, job.JobTitle);
            if (!link) return null;
            link.titleVerified = true;
            links.push(link);
        }
        if (!links.length && isPlaceholderEmployerName(company)) return null;
        const catalogue = { company, links };
        // Readers normally live for one board turn; keep accidental reuse bounded.
        if (this.catalogues.size >= 8) this.catalogues.delete(this.catalogues.keys().next().value!);
        this.catalogues.set(board, catalogue);
        return catalogue;
    }

    async page(platform: BrowserAtsPlatform, board: string, page: number, pageUrl?: string): Promise<BrowserListing | null> {
        await this.check();
        if (!canUseBrowserAtsHttp(platform) || browserAtsBoardFromUrl(platform, board) !== board
            || !Number.isSafeInteger(page) || page < 1 || page > 1000
            || pageUrl && browserAtsBoardFromUrl(platform, pageUrl) !== board) return null;
        if (platform === 'paycor') {
            if (page !== 1 || pageUrl && pageUrl !== board) return null;
            const doc = await this.document(board);
            return doc ? paycorPublicListing(doc, board) : null;
        }
        if (platform === 'paycom') return this.paycom.page(board, page, pageUrl);
        if (platform === 'paylocity') {
            // This is one complete publisher catalogue, not a synthetic page
            // series. Saved array offsets are unsafe if the publisher reorders
            // its catalogue between turns, so larger boards retain the browser.
            if (page !== 1 || pageUrl && pageUrl !== board) return null;
            const catalogue = await this.paylocityCatalogue(board);
            if (!catalogue) return null;
            const links = catalogue.links;
            return { links, signature: signature(links), total: catalogue.links.length,
                next: null,
                emptyVerified: catalogue.links.length === 0 };
        }
        if (page > 1 && !pageUrl) return null;
        const url = icimsListingUrl(pageUrl || board, board, page);
        // A same-host filtered search cannot silently become a full-board sweep.
        if (!url) return null;
        if (page === 1) url.searchParams.set('ss', '1');
        // A missing exact board already has a retry policy. Reopening it in a
        // browser only spends the shared browser slot on the same missing page.
        const doc = await this.document(url.href, landed => !!icimsListingUrl(landed, board, page));
        // Apply the same scope guard after redirects; a matching employer host
        // and plausible final-page markup do not prove an unfiltered catalogue.
        if (!doc || !icimsListingUrl(doc.url, board, page)) return null;
        return icimsPublicListing(doc, board, page);
    }

    async detail(platform: BrowserAtsPlatform, board: string, link: BrowserPostingLink, savedCatalogue?: BrowserPostingLink[]): Promise<BrowserPosting | null> {
        await this.check();
        if (!canUseBrowserAtsHttpDetail(platform) || browserAtsBoardFromUrl(platform, board) !== board
            || browserPostingLink(platform, board, link.url)?.id !== link.id) return null;
        if (platform === 'paycom') return this.paycom.detail(board, link, savedCatalogue);
        if (platform === 'brassring') return this.brassring.detail(board, link);
        const catalogue = platform === 'paylocity' ? await this.paylocityCatalogue(board) : null;
        if (platform === 'paylocity' && !catalogue?.links.some(item => item.id === link.id)) return null;
        const target = new URL(link.url);
        // iCIMS' canonical URL can be an outer iframe shell. Request its
        // published iframe view while preserving the posting's canonical URL.
        if (platform === 'icims') target.searchParams.set('in_iframe', '1');
        const doc = await this.document(target.href);
        if (!doc) return null;
        let posting: BrowserPosting | null;
        try { posting = parseBrowserPosting(platform, board, link, [doc]); }
        catch { return null; }
        if (!posting) return null;
        if (catalogue && !isPlaceholderEmployerName(catalogue.company)) {
            if (!isPlaceholderEmployerName(posting.company) && companyKey(posting.company) !== companyKey(catalogue.company)) return null;
            if (isPlaceholderEmployerName(posting.company)) return { ...posting, company: catalogue.company };
        }
        return posting;
    }
}
