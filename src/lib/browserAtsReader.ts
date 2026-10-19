import type { BrowserContext, Page, Locator } from 'playwright-core';
import * as cheerio from 'cheerio';
import { createHash } from 'node:crypto';
import { browserAtsBoardFromUrl, type BrowserAtsPlatform } from './browserAtsBoards';
import { browserPostingLink, parseBrowserPosting, type BrowserDocument, type BrowserPostingLink, type BrowserPosting } from './browserAtsPosting';
import { readBoundedAtsBody } from './tenantAtsBoards';
import { safeExternalFetch } from './safeExternalFetch';
import { parseAdpPosting, parseAdpClientCompany } from './adpPosting';
import { taleoSearchPage, taleoPageMatches, type TaleoSearchPage } from './browserTaleoEvidence';
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
    terminal?: BrowserPageEnd;
    pageNumberJump?: boolean;
};
export type BrowserPageEnd = { kind: 'verified-final-page'; page: number; pageCount: number; advertisedTotal: number; signature: string; publicSearchPage?: TaleoSearchPage };
export const BROWSER_MAX_PAGES = 1000;
export const BROWSER_MAX_SEEN_IDS = 50000;
/** Only HTTPS destinations can become saved navigation URLs. JavaScript
 * widget links remain on-page controls; all other schemes fail closed. */
function paginationTarget(platform: BrowserAtsPlatform, board: string, currentUrl: string, href: string | null): BrowserNext {
    const value = href?.trim();
    if (!value || value.startsWith('#')) return { kind: 'click' };
    const url = new URL(value, currentUrl);
    switch (url.protocol) {
        case 'https:':
            url.hash = '';
            if (browserAtsBoardFromUrl(platform, url.href) !== board)
                throw Error('Next page escaped employer identity');
            return { kind: 'url', url: url.href };
        case 'javascript:':
            return { kind: 'click' };
        case 'data:':
        case 'vbscript:':
        default:
            throw Error('Next page navigation must use HTTPS; retaining progress');
    }
}
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
function paycomRange(docs: BrowserDocument[]): { start: number; end: number; size: number; total: number } | undefined {
    const match = /\b([\d,]+)\s*[-–]\s*([\d,]+)\s+of\s+([\d,]+) Results\b/i.exec(docs.map(d=>d.text).join('\n'));
    if (!match) return;
    const start=Number(match[1].replaceAll(',','')),end=Number(match[2].replaceAll(',',''));
    const total=Number(match[3].replaceAll(',',''));
    if (start>0 && end>=start && end<=total) return {start,end,size:end-start+1,total};
}
function taleoRange(docs: BrowserDocument[]): { start: number; end: number; total: number } | undefined {
    for (const doc of docs) {
        const match = /\bJob Openings\s+([\d,]+)\s*[-–]\s*([\d,]+)\s+of\s+([\d,]+)/i.exec(doc.text);
        if (!match) continue;
        const [start, end, total] = match.slice(1).map(value => Number(value.replaceAll(',', '')));
        if (start > 0 && end >= start && end <= total) return { start, end, total };
    }
}
/** Taleo updates its range before incrementally painting every job row. */
export function taleoResultsReady(docs: BrowserDocument[], linkCount: number, page: number): boolean {
    const range = taleoRange(docs);
    if (!range) return linkCount > 0;
    const publishedPage = /\bPage\s+(\d+)\b/i.exec(docs.map(doc => doc.text).join('\n'));
    return linkCount === range.end - range.start + 1 && (!publishedPage || Number(publishedPage[1]) === page);
}
export function postingLinksFromDocuments(platform: BrowserAtsPlatform, board: string, docs: BrowserDocument[]): BrowserPostingLink[] {
    const result = new Map<string, BrowserPostingLink>();
    const retain = (link: BrowserPostingLink) => {
        // A second Apply link must not erase a dedicated title read earlier.
        if (!result.get(link.id)?.titleVerified || link.titleVerified) result.set(link.id, link);
    };
    for (const doc of docs) {
        const $ = cheerio.load(doc.html);
        // Classic Taleo lists publish the requisition number beside a JS title
        // action. Build the public permalink from that same row, never from the
        // action's different internal database ID or from the tenant name.
        if (platform === 'taleo' && browserAtsBoardFromUrl(platform, doc.url) === board) {
            $('a[id]').each((_, n) => {
                const row = /^requisitionListInterface\.reqTitleLinkAction\.(row\d+)$/.exec($(n).attr('id') || '')?.[1];
                if (!row) return;
                const number = $(`[id="requisitionListInterface.reqContestNumberValue.${row}"]`);
                if (number.length !== 1) return;
                const url = new URL(board.replace(/jobsearch\.ftl$/, 'jobdetail.ftl'));
                url.searchParams.set('job', number.text().trim());
                const link = browserPostingLink(platform, board, url.href, $(n).text());
                if (link) { link.titleVerified = true; retain(link); }
            });
        }
        if (platform === 'jobvite') $('[onclick]').each((_, n) => {
            const href = /^\s*window\.location\.href\s*=\s*['"]([^'"]+)['"]\s*;?\s*$/.exec($(n).attr('onclick') || '')?.[1];
            const link = href ? browserPostingLink(platform, board, href, $(n).find('.jv-job-list-name').text() || $(n).text()) : null;
            if (link) {
                if ($(n).find('.jv-job-list-name').length === 1) link.titleVerified = true;
                retain(link);
            }
        });
        $('a[href]').each((_, n) => { try {
            const link = browserPostingLink(platform, board, new URL($(n).attr('href')!, doc.url).href, $(n).text());
            if (link) {
                // Only source-specific title elements can authorize exclusions.
                // Other anchors still enumerate jobs and receive full details.
                if (platform === 'jobvite' && $(n).closest('.jv-job-list-name').length === 1) link.titleVerified = true;
                if (platform === 'dzconnex' && $(n).is('a.shmJobtitle[data-rel="link-job-name"]')) link.titleVerified = true;
                if (platform === 'taleo' && $(n).attr('title')?.replace(/\s+/g, ' ').trim() === link.title && link.title) link.titleVerified = true;
                if (platform === 'avature' && $(n).is('.article__header__text__title a.link_result')) link.titleVerified = true;
                if (platform === 'paycom') {
                    const title = $(n).find('h2[data-testid="typography"]');
                    if (title.length === 1 && title.text().trim()) {
                        link.title = title.text().replace(/\s+/g, ' ').trim();
                        link.titleVerified = true;
                    }
                }
                retain(link);
            }
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
/** A missing control is not proof of completion. Require the published final
 * page number, a fully rendered results page and its explicitly disabled Next. */
export function verifiedBrowserPageEnd(platform: BrowserAtsPlatform, board: string, docs: BrowserDocument[], page: number, links: BrowserPostingLink[], hasNext: boolean, taleoEvidence?: TaleoSearchPage): BrowserPageEnd | undefined {
    if (platform === 'taleo' && !hasNext && taleoEvidence && taleoPageMatches(board, docs, links, page, taleoEvidence)
        && page === Math.ceil(taleoEvidence.total / taleoEvidence.pageSize)) {
        for (const doc of docs) {
            if (browserAtsBoardFromUrl(platform, doc.url) !== board) continue;
            const range = taleoRange([doc]), $ = cheerio.load(doc.html), next = $('a#next');
            if (!range || range.total !== taleoEvidence.total || range.end !== range.total || !next.length
                || next.toArray().some(n => !$(n).is('[aria-disabled="true"],.navigation-link-disabled'))) continue;
            return { kind: 'verified-final-page', page, pageCount: page, advertisedTotal: range.total,
                signature: listingSignature(links), publicSearchPage: taleoEvidence };
        }
    }
    if (platform !== 'brassring' || hasNext || !links.length) return;
    for (const doc of docs) {
        if (browserAtsBoardFromUrl(platform, doc.url) !== board || !brassringResultsReady([doc], links.length)) continue;
        const match = /Page\s+(\d+) of\s+(\d+)/i.exec(doc.text);
        const total = listingTotal(doc.text);
        if (!match || Number(match[1]) !== page || Number(match[2]) !== page || total === null) continue;
        const $ = cheerio.load(doc.html);
        const next = $('button[aria-label="Go to next page"],button[title="Next Page"]');
        if (!next.length || next.toArray().some(n => !$(n).is('[disabled],[aria-disabled="true"]') && !/disabled/.test($(n).attr('class') || ''))) continue;
        return { kind: 'verified-final-page', page, pageCount: page, advertisedTotal: total, signature: listingSignature(links) };
    }
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
/** The published widget uses zero-based DOM page numbers. Its hash can change
 * during rendering, so only the active results control proves our position. */
function dzconnexPageReady(docs: BrowserDocument[], page: number): boolean {
    return docs.some(doc => {
        const $ = cheerio.load(doc.html);
        const active = $('.section-job-results-paging a.active[data-page-number]');
        return active.length === 1 && active.attr('data-page-number') === String(page - 1);
    });
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
        if (platform === 'taleo') {
            const next = await visible(frame.locator('a#next'));
            if (next) return next;
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
    private taleoPages = new Map<number, TaleoSearchPage>();
    constructor(private context: BrowserContext, private check: () => Promise<void>) { }
    async close() {
        if (this.listing) await this.listing.close();
        if (this.detailPage) await this.detailPage.close();
        this.listing = this.detailPage = null; this.position = null; this.taleoPages.clear();
    }
    private async navigate(page: Page, url: string, documentOnly = false) { await this.check(); const response = await page.goto(url, { waitUntil: documentOnly ? 'commit' : 'domcontentloaded', timeout: documentOnly ? 15000 : 45000 });
        // Hash-routed job changes return no response. Reload clears the prior
        // job DOM and obtains a real response before parsing a different job.
        const verified = response || await page.reload({ waitUntil: documentOnly ? 'commit' : 'domcontentloaded', timeout: documentOnly ? 15000 : 45000 });
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
    private async listingDocuments(page: Page, platform: BrowserAtsPlatform, board: string, pageNumber = 1): Promise<BrowserDocument[]> {
        for (let attempt = 0; attempt < 12; attempt++) {
            const docs = await documents(page);
            const links = postingLinksFromDocuments(platform, board, docs), count = links.length;
            if (count && (platform !== 'brassring' || brassringResultsReady(docs,count))
                && (platform !== 'taleo' || taleoPageMatches(board, docs, links, pageNumber, this.taleoPages.get(pageNumber)) || taleoResultsReady(docs,count,pageNumber))
                && (platform !== 'dzconnex' || dzconnexPageReady(docs,pageNumber)))
                return docs;
            const text = docs.map(d => d.text).join('\n');
            if (platform === 'taleo' && /Career Section Unavailable|The Career section you are trying to access is not available for the moment/i.test(text))
                throw Error('Public employer career section is temporarily unavailable; retaining progress for retry');
            if (verifiedEmptyBoard(platform, docs, board)) return docs;
            if (platform === 'freshteam' && /We couldn't find [\w.-]+\.freshteam\.com/i.test(text)) throw Error('Public employer tenant is unavailable; retain for weekly retry');
            if (attempt >= 5 && /(?:there are (?:currently )?no (?:open )?(?:jobs|positions|vacancies)|there are no jobs matching)/i.test(text) && !/(?:just a moment|verify you are human|access denied)/i.test(text))
                return docs;
            await page.waitForTimeout(1000);
            await this.check();
        }
        throw Error('Public board did not expose verifiable posting links or an explicit empty state');
    }
    private async jumpToPage(page: Page, platform: BrowserAtsPlatform, board: string, from: number, target: number): Promise<boolean> {
        if (platform !== 'paycom' && platform !== 'brassring') return false;
        const selector = platform === 'paycom' ? '[data-testid="job-post-pagination"] input[data-testid="pagination-control-input"]' : '#gateway.searchResults input#gotoPageInput';
        const before = await this.listingDocuments(page,platform,board);
        let input = await visible(page.locator(selector));
        for(let attempt=0;!input && attempt<4;attempt++) {
            await page.waitForTimeout(250); await this.check();
            input=await visible(page.locator(selector));
        }
        if (!input) return false;
        const signature = listingSignature(postingLinksFromDocuments(platform,board,before));
        const range = platform==='paycom' ? paycomRange(before) : undefined;
        if (platform==='paycom' && !range) return false;
        await this.check();
        // Public keyboard controls avoid cookie banners/card overlays covering
        // the arrow hitbox, and resume a saved page without replaying its prefix.
        await input.scrollIntoViewIfNeeded({timeout:5000});
        await input.fill(String(target),{timeout:5000});
        await input.press('Enter',{timeout:5000});
        for(let attempt=0;attempt<40;attempt++) {
            await page.waitForTimeout(250); await this.check();
            const docs=await documents(page),links=postingLinksFromDocuments(platform,board,docs);
            const positioned=platform==='brassring'
                ? docs.some(d=>Number(/Page\s+(\d+) of\s+\d+/i.exec(d.text)?.[1])===target)
                : !!range && paycomRange(docs)?.start===range.start+(target-from)*range.size && await input.inputValue()===String(target);
            if(positioned && links.length && listingSignature(links)!==signature) return true;
        }
        throw Error('Public page-number control did not reach the requested page with new posting identities');
    }
    private async activateNext(control: Locator, platform: BrowserAtsPlatform, board: string, currentUrl: string) {
        // The live DOM may have changed since the continuation was saved.
        paginationTarget(platform, board, currentUrl, await control.getAttribute('href'));
        if (platform==='paycom' || platform==='taleo') {
            await control.scrollIntoViewIfNeeded({timeout:5000});
            await this.check();
            paginationTarget(platform, board, currentUrl, await control.getAttribute('href'));
            await control.press('Enter',{timeout:5000});
        }
        else await control.click({timeout:5000});
    }
    async page(platform: BrowserAtsPlatform, board: string, pageNumber: number, pageUrl?: string): Promise<BrowserListing> {
        if (pageNumber < 1 || pageNumber > BROWSER_MAX_PAGES)
            throw Error('Board page limit reached; progress retained for review');
        const reuse = platform !== 'dzconnex' && !!this.listing && this.position?.board === board && this.position.platform === platform && pageNumber === this.position.page + 1 && !pageUrl;
        if (!reuse) {
            if (this.listing) await this.listing.close();
            this.listing = await this.context.newPage();
            this.taleoPages.clear();
            if (platform === 'taleo') this.listing.on('response', async response => {
                try {
                    if (!response.ok() || response.request().method() !== 'POST'
                        || !response.url().includes('/careersection/rest/jobboard/searchjobs?')) return;
                    const body = await response.text();
                    if (Buffer.byteLength(body) > 5 * 1024 * 1024) return;
                    const evidence = taleoSearchPage(board, response.url(), response.request().postDataJSON(), JSON.parse(body));
                    if (evidence) this.taleoPages.set(evidence.page, evidence);
                } catch { /* Unsupported responses retain strict rendered-page checks. */ }
            });
        }
        const page = this.listing!;
        if (pageUrl && (new URL(pageUrl).protocol !== 'https:' || browserAtsBoardFromUrl(platform, pageUrl) !== board))
            throw Error('Saved pagination URL escaped the employer board');
        let pageNumberJump = reuse && await this.jumpToPage(page,platform,board,pageNumber-1,pageNumber);
        if (reuse && !pageNumberJump) {
            const before = listingSignature(postingLinksFromDocuments(platform, board, await this.listingDocuments(page, platform, board)));
            const next = await this.readyNextControl(page, platform, pageNumber - 1, 10000);
            if (!next) throw Error('Live pagination cannot advance without skipping work');
            await this.activateNext(next,platform,board,page.url());
            let moved = false;
            for (let attempt = 0; attempt < 40; attempt++) {
                await page.waitForTimeout(250); await this.check();
                const links = postingLinksFromDocuments(platform, board, await documents(page));
                if (links.length && listingSignature(links) !== before) { moved = true; break; }
            }
            if (!moved) throw Error('Live pagination did not change posting identities');
        } else if (!reuse) {
            const start = new URL(pageUrl || board);
            // Shazamme's public pg-N route restores the exact browser page.
            // Replaying N-1 animated clicks could consume every bounded turn.
            if (platform === 'dzconnex') {
                start.href = board;
                start.hash = pageNumber > 1 ? `/pg-${pageNumber}` : '/';
                pageNumberJump = pageNumber > 1;
            }
            // This is the public form's unfiltered search submission (ss=1).
            if (platform === 'icims') start.searchParams.set('ss', '1');
            const status = await this.navigate(page, start.href);
            if ([404, 410, 429].includes(status) || status >= 500) throw Error('Board returned HTTP ' + status);
        }
        if (!reuse && platform === 'brassring') {
            // The homepage only shows recent openings. Submit the public search before pagination.
            let ready = false;
            for (let attempt = 0; attempt < 24; attempt++) {
                await this.check();
                const docs = await documents(page);
                if (docs.some(d=>/^This site is temporarily unavailable\.\s*Please try again later\.?$/i.test(d.text.trim())))
                    throw Error('Public employer site is temporarily unavailable; retaining progress for retry');
                if (brassringResultsReady(docs, postingLinksFromDocuments(platform,board,docs).length) || verifiedEmptyBoard(platform,docs,board)) { ready=true; break; }
                const search = await visible(page.getByRole('button', { name: /^(?:Search|Find Jobs|Search Jobs)$/i })) || await visible(page.getByText('Search', { exact: true }));
                if (search) { await search.click({timeout:5000}); ready=true; break; }
                await page.waitForTimeout(500);
            }
            if (!ready) throw Error('BrassRing full-board search control is missing');
        }
        if (!reuse && !pageUrl && !pageNumberJump && pageNumber>1) pageNumberJump=await this.jumpToPage(page,platform,board,1,pageNumber);
        if (!reuse && !pageUrl && !pageNumberJump) {
            for (let n = 1; n < pageNumber; n++) {
                await this.check();
                const before = listingSignature(postingLinksFromDocuments(platform, board, await this.listingDocuments(page, platform, board)));
                const next = await this.readyNextControl(page, platform, n, 10000);
                if (!next)
                    throw Error('Saved page cannot be replayed without skipping work');
                await this.activateNext(next,platform,board,page.url());
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
        const docs = await this.listingDocuments(page, platform, board, pageNumber);
        const links = postingLinksFromDocuments(platform, board, docs);
        const total = listingTotal(docs.map(d => d.text).join('\n'));
        let control = await nextControl(page, platform, pageNumber);
        const range=platform==='paycom' ? paycomRange(docs) : undefined;
        if (!control && platform === 'paycom' && total !== null && total > links.length && (!range || range.end<range.total))
            control = await this.readyNextControl(page, platform, pageNumber, 5000);
        let next: BrowserNext | null = null;
        if (control) {
            next = paginationTarget(platform, board, page.url(), await control.getAttribute('href'));
        }
        this.position = { platform, board, page: pageNumber };
        return { links, next, signature: listingSignature(links), total, pageNumberJump, terminal: verifiedBrowserPageEnd(platform,board,docs,pageNumber,links,!!next,this.taleoPages.get(pageNumber)), emptyVerified: !links.length && verifiedEmptyBoard(platform, docs, board) };
    }
    async detail(platform: BrowserAtsPlatform, board: string, link: BrowserPostingLink): Promise<BrowserPosting | null> {
        this.detailPage ??= await this.context.newPage();
        const page = this.detailPage;
        try {
            // DZConneX publishes details in the document. External scripts can
            // hold DOMContentLoaded after that document is usable; parse the
            // exact job after commit and wait for its verified content below.
            const status = await this.navigate(page, link.url, platform === 'dzconnex');
            if ([404, 410].includes(status))
                return null;
            if (status < 200 || status >= 400)
                throw Error('Job detail HTTP ' + status);
            if (platform === 'dzconnex') {
                // Interactive means the HTML parser has finished, even when a
                // deferred script is still delaying DOMContentLoaded. Never
                // accept a description from a partly streamed document.
                await page.waitForFunction(() => document.readyState !== 'loading', undefined, { timeout: 10000 });
                await this.check();
            }
            for (let attempt = 0; attempt < 12; attempt++) {
                const docs = await documents(page);
                const result = parseBrowserPosting(platform, board, link, docs);
                if (result)
                    return result;
                if (platform === 'taleo' && new URL(page.url()).hostname !== new URL(board).hostname)
                    throw Error('Public job redirected to a different career site; retaining it for verified routing');
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
        return { ...l, titleVerified: true };
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
