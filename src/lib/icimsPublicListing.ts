import { createHash } from 'node:crypto';
import * as cheerio from 'cheerio';
import { browserAtsBoardFromUrl } from './browserAtsBoards';
import { browserPostingLink, type BrowserDocument, type BrowserPostingLink } from './browserAtsPosting';
import type { BrowserListing } from './browserAtsReader';

export function icimsListingUrl(value: string, board: string, page: number): URL | null {
    try {
        const url = new URL(value);
        if (browserAtsBoardFromUrl('icims', url.href) !== board || !/^\/jobs\/search\/?$/i.test(url.pathname)) return null;
        for (const [key, entry] of url.searchParams) {
            if (!['pr', 'in_iframe', 'ss', 'schemaId', 'o', 'searchRelation'].includes(key) || url.searchParams.getAll(key).length !== 1) return null;
            if (['schemaId', 'o'].includes(key) && entry !== '') return null;
            if (['in_iframe', 'ss'].includes(key) && entry !== '1') return null;
            if (key === 'searchRelation' && entry !== 'keyword_all') return null;
            if (key === 'pr' && !/^\d+$/.test(entry)) return null;
        }
        return Number(url.searchParams.get('pr') || '0') === page - 1 ? url : null;
    } catch { return null; }
}

/** Both public templates publish their position, including one-page catalogues
 * with no paginator. Never infer completion just from a missing Next link. */
export function icimsPublicListing(doc: BrowserDocument, board: string, page: number): BrowserListing | null {
    if (!icimsListingUrl(doc.url, board, page)) return null;
    const $ = cheerio.load(doc.html);
    if (!/\bJob Listings at\s+\S.+/i.test($('title').text())) return null;
    const links = new Map<string, BrowserPostingLink>();
    $('.iCIMS_JobsTable a[href]').each((_, node) => {
        const heading = $(node).find('h3').first().text().trim();
        const link = browserPostingLink('icims', board, $(node).attr('href')!, heading || $(node).text());
        if (link && heading) link.titleVerified = true;
        if (link) links.set(link.id, link);
    });
    const result = [...links.values()];
    const signature = createHash('sha256').update(result.map(l => l.id).sort().join('\n')).digest('hex');
    if (!links.size) {
        const empty = $('.iCIMS_Message.iCIMS_ErrorMessage').toArray().some(n => $(n).text().trim() === 'Sorry, no jobs were found that match your search criteria. Please try other selections.');
        const filtered = $('#searchForm select').toArray().some(n => {
            if ($(n).attr('name') === 'searchRelation') return $(n).val() !== 'keyword_all';
            return [$(n).val()].flat().some(v => !!v);
        }) || $('#searchForm input[type="text"],#searchForm input[name="latitude"],#searchForm input[name="longitude"]').toArray().some(n => !!$(n).val())
            || !!$('#searchForm input[type="checkbox"][checked]').length;
        const anyPosting = $('a[href]').toArray().some(n => browserPostingLink('icims', board, $(n).attr('href')!));
        return page === 1 && empty && $('#searchForm').length === 1 && !filtered && !anyPosting && !$('.iCIMS_JobCardItem').length
            ? { links: [], total: 0, next: null, signature, emptyVerified: true } : null;
    }
    if (!$('.iCIMS_JobsTable').length || links.size > 250 || $('.iCIMS_JobsTable .iCIMS_JobCardItem').length !== links.size) return null;
    const positions = $('.iCIMS_Paging .selected,.iCIMS_SearchResultsHeader .iCIMS_SubHeader_Jobs').toArray()
        .map(n => /Page\s+(\d+)\s+of\s+(\d+)/i.exec($(n).text().replace(/\s+/g, ' ')));
    if (!positions.length || positions.some(p => !p || Number(p[1]) !== page || Number(p[2]) < page || p[2] !== positions[0]?.[2])) return null;
    const next = $('.iCIMS_Paging a[href]').toArray().filter(n => /Next page of results/i.test($(n).text() + ' ' + ($(n).attr('aria-label') || ''))
        && !$(n).is('.invisible,[hidden],[disabled],[aria-disabled="true"]') && !$(n).parents('[hidden]').length);
    let nextUrl: string | null = null;
    if (Number(positions[0]![2]) > page) {
        if (!next.length) return null;
        try {
            const hrefs = [...new Set(next.map(n => new URL($(n).attr('href')!, doc.url).href))];
            if (hrefs.length !== 1) return null;
            nextUrl = icimsListingUrl(hrefs[0], board, page + 1)?.href || null;
        } catch { return null; }
        if (!nextUrl) return null;
    } else if (next.length) return null;
    return { links: result, signature, total: null, next: nextUrl ? { kind: 'url', url: nextUrl } : null };
}
