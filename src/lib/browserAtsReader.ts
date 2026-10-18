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
    emptyVerified?: boolean;
    links: BrowserPostingLink[];
    next: BrowserNext | null;
    signature: string;
    total: number | null;
};
export const BROWSER_MAX_PAGES = 1000;
export const BROWSER_MAX_SEEN_IDS = 50000;
export function listingSignature(links: BrowserPostingLink[]): string { return createHash('sha256').update(links.map(j => j.id).sort().join('\n')).digest('hex'); }
export function listingTotal(text: string): number | null {
    const patterns = [/\b[\d,]+\s*[-–]\s*[\d,]+\s+of\s+([\d,]+) results\b/i, /\b(?:Viewing|Showing|Job Openings)\s+[\d,]+\s*[-–]\s*[\d,]+\s+of\s+([\d,]+)(?:\s+(?:results|jobs))?/i, /Current Openings\s*\(\d+ of ([\d,]+)\)/i, /Your search resulted in:\s*([\d,]+) positions/i, /\b([\d,]+) Jobs Found\b/i, /\b([\d,]+) of [\d,]+ Job Opportunities/i, /\b([\d,]+) Results\b/i];
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
        if (platform === 'jobvite') $('[onclick]').each((_, n) => {
            const href = /^\s*window\.location\.href\s*=\s*['"]([^'"]+)['"]\s*;?\s*$/.exec($(n).attr('onclick') || '')?.[1];
            const link = href ? browserPostingLink(platform, board, href, $(n).find('.jv-job-list-name').text() || $(n).text()) : null;
            if (link) result.set(link.id, link);
        });
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
export function verifiedEmptyBoard(platform: BrowserAtsPlatform, docs: BrowserDocument[], board?: string): boolean {
    return docs.some(doc => {
        if (board && browserAtsBoardFromUrl(platform, doc.url) !== board) return false;
        const $ = cheerio.load(doc.html);
        const empty = /(?:^|\n)\s*(?:Currently no jobs available|No (?:current |open )?(?:job openings|jobs|positions)(?: found| available)?[.!]?|Search from over 0 opportunities|There are (?:currently )?no (?:open )?(?:jobs|positions|vacancies)(?: that match your criteria| matching(?: your (?:search|criteria))?[^\n]*)?[.!]?)\s*(?:$|\n)/i.test(doc.text);
        const brand = platform === 'paycom' ? $('h1').first().text().replace(/Career Page/i, '').trim()
            : platform === 'brassring' ? $('img[alt]').map((_, n) => $(n).attr('alt') || '').get().find(x => /.+ Logo$/i.test(x))?.replace(/ Logo$/i, '').trim() || /^Search Jobs at (.+)$/i.exec($('head title').first().text().trim())?.[1] : '';
        return empty && !!brand && brand.length > 2 && !/^(?:company|paycom|brassring)$/i.test(brand);
    });
}
/** The modern search first paints ten cards before the full selected page arrives. */
export function brassringResultsReady(docs: BrowserDocument[], linkCount: number): boolean {
    return docs.some(doc => {
        const $ = cheerio.load(doc.html);
        if (!$('#gateway.searchResults').length) return false;
        const total = listingTotal(doc.text);
        if (total === null) return false;
        const size = /Refine\s+([\d,]+) results/i.exec(doc.text)?.[1];
        const page = /Page\s+(\d+) of\s+\d+/i.exec(doc.text)?.[1] || '1';
        const expected = size ? Math.min(Number(size.replaceAll(',','')), Math.max(0,total-(Number(page)-1)*Number(size.replaceAll(',','')))) : Math.min(total,linkCount);
        return expected > 0 && linkCount >= expected;
    });
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
    private detailPage: Page | null = null;
    private position: { platform: BrowserAtsPlatform; board: string; page: number } | null = null;
    constructor(private context: BrowserContext, private check: () => Promise<void>) { }
    async close() {
        if (this.listing) await this.listing.close();
        if (this.detailPage) await this.detailPage.close();
        this.listing = this.detailPage = null; this.position = null;
    }
    private async navigate(page: Page, url: string) { await this.check(); const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
        // Hash-routed job changes return no response. Reload clears the prior
        // job DOM and obtains a real response before parsing a different job.
        const verified = response || await page.reload({ waitUntil: 'domcontentloaded', timeout: 45000 });
        return verified?.status() || 0; }
    private async readyNextControl(page: Page, platform: BrowserAtsPlatform, pageNumber: number, timeoutMs: number): Promise<Locator | null> {
        const until = Date.now() + timeoutMs;
        do {
            await this.check();
            const next = await nextControl(page, platform, pageNumber);
            if (next) return next;
            await page.waitForTimeout(250);
        } while (Date.now() < until);
        return null;
    }
    private async listingDocuments(page: Page, platform: BrowserAtsPlatform, board: string): Promise<BrowserDocument[]> {
        for (let attempt = 0; attempt < 12; attempt++) {
            const docs = await documents(page);
            const count = postingLinksFromDocuments(platform, board, docs).length;
            if (count && (platform !== 'brassring' || brassringResultsReady(docs,count)))
                return docs;
            const text = docs.map(d => d.text).join('\n');
            if (verifiedEmptyBoard(platform, docs, board)) return docs;
            if (platform === 'freshteam' && /We couldn't find [\w.-]+\.freshteam\.com/i.test(text)) throw Error('Public employer tenant is unavailable; retain for weekly retry');
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
        const reuse = !!this.listing && this.position?.board === board && this.position.platform === platform && pageNumber === this.position.page + 1 && !pageUrl;
        if (!reuse) {
            if (this.listing) await this.listing.close();
            this.listing = await this.context.newPage();
        }
        const page = this.listing!;
        if (pageUrl && browserAtsBoardFromUrl(platform, pageUrl) !== board)
            throw Error('Saved pagination URL escaped the employer board');
        if (reuse) {
            const before = listingSignature(postingLinksFromDocuments(platform, board, await this.listingDocuments(page, platform, board)));
            const next = await this.readyNextControl(page, platform, pageNumber - 1, 10000);
            if (!next) throw Error('Live pagination cannot advance without skipping work');
            await next.click();
            let moved = false;
            for (let attempt = 0; attempt < 40; attempt++) {
                await page.waitForTimeout(250); await this.check();
                const links = postingLinksFromDocuments(platform, board, await documents(page));
                if (links.length && listingSignature(links) !== before) { moved = true; break; }
            }
            if (!moved) throw Error('Live pagination did not change posting identities');
        } else {
            const start = new URL(pageUrl || board);
            // This is the public form's unfiltered search submission (ss=1).
            if (platform === 'icims') start.searchParams.set('ss', '1');
            const status = await this.navigate(page, start.href);
            if ([404, 410, 429].includes(status) || status >= 500) throw Error('Board returned HTTP ' + status);
        }
        if (!reuse && platform === 'brassring') {
            // The homepage only shows recent openings. Submit the public search before pagination.
            const search = await visible(page.getByRole('button', { name: /^(?:Search|Find Jobs|Search Jobs)$/i })) || await visible(page.getByText('Search', { exact: true }));
            if (!search && !verifiedEmptyBoard(platform, await documents(page), board))
                throw Error('BrassRing full-board search control is missing');
            if (search) { await search.click(); await page.waitForTimeout(500); }
        }
        if (!reuse && !pageUrl) {
            for (let n = 1; n < pageNumber; n++) {
                await this.check();
                const before = listingSignature(postingLinksFromDocuments(platform, board, await this.listingDocuments(page, platform, board)));
                const next = await this.readyNextControl(page, platform, n, 10000);
                if (!next)
                    throw Error('Saved page cannot be replayed without skipping work');
                await next.click();
                let moved = false;
                for (let attempt = 0; attempt < 40; attempt++) {
                    await page.waitForTimeout(250);
                    await this.check();
                    const links = postingLinksFromDocuments(platform, board, await documents(page));
                    if (links.length && listingSignature(links) !== before) {
                        moved = true;
                        break;
                    }
                }
                if (!moved) throw Error('Saved page replay did not change posting identities');
            }
        }
        const docs = await this.listingDocuments(page, platform, board);
        const links = postingLinksFromDocuments(platform, board, docs);
        const total = listingTotal(docs.map(d => d.text).join('\n'));
        let control = await nextControl(page, platform, pageNumber);
        if (!control && platform === 'paycom' && total !== null && total > links.length)
            control = await this.readyNextControl(page, platform, pageNumber, 5000);
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
        this.position = { platform, board, page: pageNumber };
        return { links, next, signature: listingSignature(links), total, emptyVerified: !links.length && verifiedEmptyBoard(platform, docs, board) };
    }
    async detail(platform: BrowserAtsPlatform, board: string, link: BrowserPostingLink): Promise<BrowserPosting | null> {
        this.detailPage ??= await this.context.newPage();
        const page = this.detailPage;
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
            // Reuse the detail tab within this bounded board turn. close() owns both tabs.
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
    if (Array.isArray(data.jobRequisitions) && !data.jobRequisitions.length && data.meta?.totalNumber === undefined) throw Error('Public employer catalogue has no verifiable jobs; retain for weekly retry');
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
