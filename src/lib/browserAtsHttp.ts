import { PaycomPublicHttp } from './paycomPublicHttp';
import { createHash } from 'node:crypto';
import * as cheerio from 'cheerio';
import { browserAtsBoardFromUrl, type BrowserAtsPlatform } from './browserAtsBoards';
import { browserPostingLink, parseBrowserPosting, type BrowserPosting, type BrowserPostingLink } from './browserAtsPosting';
import type { BrowserListing } from './browserAtsReader';
import { safeExternalFetch } from './safeExternalFetch';
import { readBoundedAtsBody } from './tenantAtsBoards';
import { BrassringHttpDetailReader } from './brassringHttpDetail';

type Fetcher = (url: string, init: RequestInit) => Promise<Response>;
type PaylocityCatalogue = { company: string; links: BrowserPostingLink[] };
const PAGE_SIZE = 250;
const signature = (links: BrowserPostingLink[]) => createHash('sha256').update(links.map(j => j.id).sort().join('\n')).digest('hex');
const companyKey = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, '');
const companyName = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 1
    && value.length < 200 && /[a-z]/i.test(value) && !/^(?:unknown(?: company)?|company|careers?|jobs?|paylocity)$/i.test(value.trim());
export const canUseBrowserAtsHttp = (platform: string): boolean => platform === 'paylocity' || platform === 'icims' || platform === 'paycom';
export const canUseBrowserAtsHttpDetail = (platform: string): boolean => canUseBrowserAtsHttp(platform) || platform === 'brassring';

function icimsListingUrl(value: string, board: string, page: number): URL | null {
    try {
        const url = new URL(value);
        if (browserAtsBoardFromUrl('icims', url.href) !== board || !/^\/jobs\/search\/?$/i.test(url.pathname)) return null;
        for (const [key, entry] of url.searchParams) {
            if (!['pr', 'in_iframe', 'ss', 'schemaId', 'o'].includes(key) || url.searchParams.getAll(key).length !== 1) return null;
            if (['schemaId', 'o'].includes(key) && entry !== '') return null;
            if (['in_iframe', 'ss'].includes(key) && entry !== '1') return null;
            if (key === 'pr' && !/^\d+$/.test(entry)) return null;
        }
        return Number(url.searchParams.get('pr') || '0') === page - 1 ? url : null;
    } catch { return null; }
}

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

    private async document(url: string): Promise<{ url: string; html: string; text: string } | null> {
        await this.check();
        try {
            const response = await this.fetcher(url, { signal: AbortSignal.timeout(10_000), headers: { Accept: 'text/html' } });
            if (!response.ok) { await response.body?.cancel(); return null; }
            const html = await readBoundedAtsBody(response, 5 * 1024 * 1024);
            if (!html || /(?:just a moment\.\.\.|verify you are human|challenge-platform|cf-chl-)/i.test(html)) return null;
            const $ = cheerio.load(html);
            return { url: response.url || url, html, text: $('body').text() };
        } catch { return null; }
    }

    private async paylocityCatalogue(board: string): Promise<PaylocityCatalogue | null> {
        const previous = this.catalogues.get(board);
        if (previous) return previous;
        const doc = await this.document(board);
        if (!doc || browserAtsBoardFromUrl('paylocity', doc.url) !== board) return null;
        const data = publicPageData(doc.html);
        if (!data || data.ShowInternal !== false || !companyName(data.ModuleTitle)
            || !Array.isArray(data.Jobs) || data.Jobs.length > PAGE_SIZE) return null;
        const $ = cheerio.load(doc.html), company = data.ModuleTitle.trim();
        // Bind the JSON employer to page branding before using an empty array
        // or constructing posting URLs from that board's published identities.
        const heading = $('header #LayoutLogoName,#LayoutLogoName').first().text().trim();
        const pageTitle = $('title').text().replace(/\s+-\s+Job Opportunities\s*$/i, '').trim();
        if (![heading, pageTitle].some(value => companyKey(value) === companyKey(company))) return null;
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
        const doc = await this.document(url.href);
        // Apply the same scope guard after redirects; a matching employer host
        // and plausible final-page markup do not prove an unfiltered catalogue.
        if (!doc || !icimsListingUrl(doc.url, board, page)) return null;
        const $ = cheerio.load(doc.html), title = $('title').text().trim();
        if (!/^Job Listings at .+/i.test(title) || !$('.iCIMS_JobsTable').length) return null;
        const links = new Map<string, BrowserPostingLink>();
        $('.iCIMS_JobsTable a[href]').each((_, node) => {
            const heading = $(node).find('h3').first().text().trim();
            const link = browserPostingLink(platform, board, $(node).attr('href')!, heading || $(node).text());
            if (link && heading) link.titleVerified = true;
            if (link) links.set(link.id, link);
        });
        if (!links.size || links.size > PAGE_SIZE || $('.iCIMS_JobsTable .iCIMS_JobCardItem').length !== links.size) return null;
        const paging = $('.iCIMS_Paging');
        const position = /Page\s+(\d+)\s+of\s+(\d+)/i.exec(paging.find('.selected').text().replace(/\s+/g, ' '));
        if (!position || Number(position[1]) !== page || Number(position[2]) < page) return null;
        const next = paging.find('a[href]').toArray().filter(node => {
            const control = $(node);
            return /Next page of results/i.test(control.text() + ' ' + (control.attr('aria-label') || ''))
                && !control.is('.invisible,[hidden],[disabled],[aria-disabled="true"]')
                && !control.parents('[hidden]').length;
        });
        let nextUrl: string | null = null;
        if (Number(position[2]) > page) {
            if (!next.length) return null;
            let hrefs: string[];
            try { hrefs = [...new Set(next.map(node => new URL($(node).attr('href')!, doc.url).href))]; }
            catch { return null; }
            if (hrefs.length !== 1 || browserAtsBoardFromUrl(platform, hrefs[0]) !== board) return null;
            const published = icimsListingUrl(hrefs[0], board, page + 1);
            if (!published) return null;
            nextUrl = published.href;
        } else if (next.length) return null;
        const result = [...links.values()];
        return { links: result, signature: signature(result), total: null, next: nextUrl ? { kind: 'url', url: nextUrl } : null };
    }

    async detail(platform: BrowserAtsPlatform, board: string, link: BrowserPostingLink): Promise<BrowserPosting | null> {
        await this.check();
        if (!canUseBrowserAtsHttpDetail(platform) || browserAtsBoardFromUrl(platform, board) !== board
            || browserPostingLink(platform, board, link.url)?.id !== link.id) return null;
        if (platform === 'paycom') return this.paycom.detail(board, link);
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
        if (!posting || catalogue && companyKey(posting.company) !== companyKey(catalogue.company)) return null;
        return posting;
    }
}
