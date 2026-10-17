import type { BrowserContext, Page, Locator } from 'playwright-core';
import * as cheerio from 'cheerio';
import { createHash } from 'node:crypto';
import { browserAtsBoardFromUrl, type BrowserAtsPlatform } from './browserAtsBoards';
import { browserPostingLink, parseBrowserPosting, type BrowserDocument, type BrowserPostingLink, type BrowserPosting } from './browserAtsPosting';
import { readBoundedAtsBody } from './tenantAtsBoards';
import { safeExternalFetch } from './safeExternalFetch';
import { parseAdpPosting, parseAdpClientCompany } from './adpPosting';
export type BrowserNext = {
    kind: 'url';
    url: string;
} | {
    kind: 'click';
};
export type BrowserListing = {
    links: BrowserPostingLink[];
    next: BrowserNext | null;
    signature: string;
    total: number | null;
};
export const BROWSER_MAX_PAGES = 1000;
export const BROWSER_MAX_SEEN_IDS = 50000;
export function listingSignature(links: BrowserPostingLink[]): string { return createHash('sha256').update(links.map(j => j.id).sort().join('\n')).digest('hex'); }
export function listingTotal(text: string): number | null {
    const patterns = [/\b[\d,]+\s*[-–]\s*[\d,]+\s+of\s+([\d,]+) results\b/i, /\b(?:Viewing|Showing|Job Openings)\s+[\d,]+\s*[-–]\s*[\d,]+\s+of\s+([\d,]+)(?:\s+(?:results|jobs))?/i, /Current Openings\s*\(\d+ of ([\d,]+)\)/i, /Your search resulted in:\s*([\d,]+) positions/i, /\b([\d,]+) Jobs Found\b/i, /\b([\d,]+) of [\d,]+ Job Opportunities/i, /\b([\d,]+) Results\b/];
    for (const re of patterns) {
        const m = re.exec(text);
        if (m)
            return Number(m[1].replaceAll(',', ''));
    }
    return null;
}
export function postingLinksFromDocuments(platform: BrowserAtsPlatform, board: string, docs: BrowserDocument[]): BrowserPostingLink[] {
    const result = new Map<string, BrowserPostingLink>();
    for (const doc of docs) {
        const $ = cheerio.load(doc.html);
        $('a[href]').each((_, n) => { try {
            const link = browserPostingLink(platform, board, new URL($(n).attr('href')!, doc.url).href, $(n).text());
            if (link)
                result.set(link.id, link);
        }
        catch { /* Ignore malformed anchors, never the valid postings beside them. */ } });
    }
    if (result.size > 250)
        throw Error('Board page exceeds the 250-posting page limit; retaining it for review');
    return [...result.values()];
}
async function documents(page: Page): Promise<BrowserDocument[]> {
    const docs: BrowserDocument[] = [];
    for (const frame of page.frames()) {
        if (!frame.url().startsWith('http') || new URL(frame.url()).hostname !== new URL(page.url()).hostname)
            continue;
        let html: string;
        try {
            html = await frame.content();
        }
        catch {
            continue;
        }
        if (Buffer.byteLength(html) > 5 * 1024 * 1024)
            throw Error('Rendered career page exceeds 5 MiB');
        try {
            docs.push({ url: frame.url(), html, text: await frame.locator('body').innerText() });
        }
        catch { /* Retry the next snapshot if this frame navigated. */ }
    }
    return docs;
}
async function visible(locator: Locator): Promise<Locator | null> { for (let i = 0; i < await locator.count(); i++) {
    const l = locator.nth(i);
    if (await l.isVisible() && !await l.isDisabled() && !/disabled/.test(await l.getAttribute('class') || '') && await l.getAttribute('aria-disabled') !== 'true')
        return l;
} return null; }
async function nextControl(page: Page, platform: BrowserAtsPlatform, pageNumber: number): Promise<Locator | null> {
    for (const frame of page.frames()) {
        if (!frame.url().startsWith('http') || new URL(frame.url()).hostname !== new URL(page.url()).hostname)
            continue;
        if (platform === 'dzconnex') {
            const n = await visible(frame.locator(`.section-job-results-paging a[data-rel="paging-select"][data-page-number="${pageNumber}"]`));
            if (n)
                return n;
        }
        if (platform === 'paycom') {
            const n = await visible(frame.locator('button:has(svg[data-testid="forward arrow-icon"])'))
                || await visible(frame.getByRole('button', { name: String(pageNumber + 1), exact: true }));
            if (n)
                return n;
        }
        for (const selector of ['a[rel="next"]', 'a.next_page', 'button[aria-label="Go to next page"]', '[aria-label="Next page of results"]', '[aria-label="Next page"]']) {
            const n = await visible(frame.locator(selector));
            if (n)
                return n;
        }
        const numeric = frame.locator('a[href]').filter({ hasText: new RegExp('^\\s*' + (pageNumber + 1) + '\\s*$') });
        for (let i = 0; i < await numeric.count(); i++) {
            const candidate = numeric.nth(i), href = await candidate.getAttribute('href');
            if (href) {
                try {
                    const u = new URL(href, page.url());
                    if (browserAtsBoardFromUrl(platform, u.href) === browserAtsBoardFromUrl(platform, page.url()) && await visible(candidate))
                        return candidate;
                }
                catch { }
            }
        }
        const name = /^(?:Next(?: page(?: of results)?)?(?:\s*>>|\s*»)?|View more jobs|Load more(?: jobs)?|Show more jobs|›|»|next)$/i;
        for (const role of ['link', 'button'] as const) {
            const n = await visible(frame.getByRole(role, { name }));
            if (n)
                return n;
        }
    }
    return null;
}
export class BrowserAtsReader {
    private listing: Page | null = null;
    constructor(private context: BrowserContext, private check: () => Promise<void>) { }
    async close() { if (this.listing)
        await this.listing.close(); this.listing = null; }
    private async navigate(page: Page, url: string) { await this.check(); const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 }); await page.waitForTimeout(1200); return response?.status() || 0; }
    private async listingDocuments(page: Page, platform: BrowserAtsPlatform, board: string): Promise<BrowserDocument[]> {
        for (let attempt = 0; attempt < 12; attempt++) {
            const docs = await documents(page);
            if (postingLinksFromDocuments(platform, board, docs).length)
                return docs;
            const text = docs.map(d => d.text).join('\n');
            if (attempt >= 5 && /(?:there are (?:currently )?no (?:open )?(?:jobs|positions|vacancies)|there are no jobs matching)/i.test(text) && !/(?:just a moment|verify you are human|access denied)/i.test(text))
                return docs;
            await page.waitForTimeout(1000);
            await this.check();
        }
        throw Error('Public board did not expose verifiable posting links or an explicit empty state');
    }
    async page(platform: BrowserAtsPlatform, board: string, pageNumber: number, pageUrl?: string): Promise<BrowserListing> {
        if (pageNumber < 1 || pageNumber > BROWSER_MAX_PAGES)
            throw Error('Board page limit reached; progress retained for review');
        if (this.listing)
            await this.listing.close();
        this.listing = await this.context.newPage();
        const page = this.listing;
        if (pageUrl && browserAtsBoardFromUrl(platform, pageUrl) !== board)
            throw Error('Saved pagination URL escaped the employer board');
        const status = await this.navigate(page, pageUrl || board);
        if ([404, 410, 429].includes(status) || status >= 500)
            throw Error('Board returned HTTP ' + status);
        if (platform === 'brassring') {
            // The homepage only shows recent openings. Submit the public search before pagination.
            const search = await visible(page.getByRole('button', { name: 'Search', exact: true })) || await visible(page.getByText('Search', { exact: true }));
            if (!search)
                throw Error('BrassRing full-board search control is missing');
            await search.click();
            await page.waitForTimeout(1500);
        }
        if (!pageUrl) {
            for (let n = 1; n < pageNumber; n++) {
                await this.check();
                const next = await nextControl(page, platform, n);
                if (!next)
                    throw Error('Saved page cannot be replayed without skipping work');
                await next.click();
                await page.waitForTimeout(1000);
            }
        }
        const docs = await this.listingDocuments(page, platform, board);
        const links = postingLinksFromDocuments(platform, board, docs);
        const control = await nextControl(page, platform, pageNumber);
        let next: BrowserNext | null = null;
        if (control) {
            const href = await control.getAttribute('href');
            if (href && !href.startsWith('#') && !href.startsWith('javascript:')) {
                const u = new URL(href, page.url());
                u.hash = '';
                if (browserAtsBoardFromUrl(platform, u.href) !== board)
                    throw Error('Next page escaped employer identity');
                next = { kind: 'url', url: u.href };
            }
            else
                next = { kind: 'click' };
        }
        return { links, next, signature: listingSignature(links), total: listingTotal(docs.map(d => d.text).join('\n')) };
    }
    async detail(platform: BrowserAtsPlatform, board: string, link: BrowserPostingLink): Promise<BrowserPosting | null> {
        const page = await this.context.newPage();
        try {
            const status = await this.navigate(page, link.url);
            if ([404, 410].includes(status))
                return null;
            if (status < 200 || status >= 400)
                throw Error('Job detail HTTP ' + status);
            for (let attempt = 0; attempt < 12; attempt++) {
                const docs = await documents(page);
                const result = parseBrowserPosting(platform, board, link, docs);
                if (result)
                    return result;
                if (docs.some(d => /^(?:This job (?:listing )?is no longer|The job listing no longer exists|This position has been filled)/i.test(d.text.trim())))
                    return null;
                await page.waitForTimeout(750);
                await this.check();
            }
            throw Error('Job detail lacks a verified employer, title, or full description: ' + link.id);
        }
        finally {
            await page.close();
        }
    }
}
async function json(url: string, init?: RequestInit): Promise<unknown> {
    const response = await safeExternalFetch(url, { ...init, signal: AbortSignal.timeout(20000) });
    if (!response.ok)
        throw Error('Public JSON HTTP ' + response.status);
    return JSON.parse(await readBoundedAtsBody(response, 5 * 1024 * 1024));
}
export async function adpListing(board: string, page: number): Promise<BrowserListing> {
    const b = new URL(board), base = new URL('/mascsr/default/careercenter/public/events/staffing/v1/job-requisitions', b);
    for (const key of ['cid', 'ccId', 'lang'])
        base.searchParams.set(key, b.searchParams.get(key)!);
    base.searchParams.set('locale', 'en_US');
    base.searchParams.set('$top', '20');
    if (page > 1)
        base.searchParams.set('$skip', String((page - 1) * 20 + 1));
    const data = await json(base.href) as {
        jobRequisitions?: unknown[];
        meta?: {
            totalNumber?: unknown;
        };
    };
    if (!Array.isArray(data.jobRequisitions) || typeof data.meta?.totalNumber !== 'number' || !Number.isSafeInteger(data.meta.totalNumber) || data.meta.totalNumber < 0)
        throw Error('ADP listing schema changed');
    const links = data.jobRequisitions.map(raw => {
        if (!raw || typeof raw !== 'object')
            throw Error('ADP posting schema changed');
        const j = raw as {
            requisitionTitle?: unknown;
            customFieldGroup?: {
                stringFields?: Array<{
                    nameCode?: {
                        codeValue?: unknown;
                    };
                    stringValue?: unknown;
                }>;
            };
        };
        const id = j.customFieldGroup?.stringFields?.find(f => f.nameCode?.codeValue === 'ExternalJobID')?.stringValue;
        if (typeof id !== 'string' || !/^\d+$/.test(id) || typeof j.requisitionTitle !== 'string' || !j.requisitionTitle.trim())
            throw Error('ADP listing has no stable published job identity');
        const u = new URL(board);
        u.searchParams.set('jobId', id);
        const l = browserPostingLink('adp', board, u.href, j.requisitionTitle);
        if (!l)
            throw Error('ADP listing has no stable published job ID');
        return l;
    });
    return { links, signature: listingSignature(links), total: data.meta.totalNumber, next: page * 20 < data.meta.totalNumber ? { kind: 'click' } : null };
}
export async function adpDetail(board: string, link: BrowserPostingLink): Promise<BrowserPosting> {
    const b = new URL(board), base = '/mascsr/default/careercenter/public/events/staffing/';
    const endpoint = new URL(base + 'v1/job-requisitions/' + link.id, b);
    for (const key of ['cid', 'ccId', 'lang'])
        endpoint.searchParams.set(key, b.searchParams.get(key)!);
    const body = await json(endpoint.href), posting = parseAdpPosting(body, link.url);
    if (!posting)
        throw Error('ADP exact posting validation failed');
    const client = new URL(base + 'client-features', b);
    for (const key of ['cid', 'ccId', 'lang'])
        client.searchParams.set(key, b.searchParams.get(key)!);
    const company = posting.company || parseAdpClientCompany(await json(client.href));
    if (!company)
        throw Error('ADP employer is unverified');
    return { ...link, title: posting.title, company, description: posting.text, location: posting.location || '' };
}
