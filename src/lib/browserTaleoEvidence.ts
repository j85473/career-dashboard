import type { BrowserDocument, BrowserPostingLink } from './browserAtsPosting';
import { browserAtsBoardFromUrl } from './browserAtsBoards';
import * as cheerio from 'cheerio';

export type TaleoSearchPage = { portal: string; page: number; pageSize: number; total: number; ids: string[] };
/** Evidence from the browser's own public, unfiltered search response. It is
 * bound to the career section's published portal before it can certify rows. */
export function taleoSearchPage(board: string, responseUrl: string, request: unknown, data: unknown): TaleoSearchPage | null {
    try {
        const url = new URL(responseUrl), root = new URL(board);
        if (url.protocol !== 'https:' || url.origin !== root.origin || url.username || url.password
            || url.pathname !== '/careersection/rest/jobboard/searchjobs' || url.searchParams.getAll('portal').length !== 1
            || !/^\d+$/.test(url.searchParams.get('portal') || '')) return null;
        const input = request as { pageNo?: unknown; fieldData?: { fields?: Record<string, unknown>; valid?: unknown }; filterSelectionParam?: { searchFilterSelections?: { selectedValues?: unknown }[] }; advancedSearchFiltersSelectionParam?: { searchFilterSelections?: { selectedValues?: unknown }[] } };
        const result = data as { careerSectionUnAvailable?: unknown; pagingData?: { currentPageNo?: unknown; pageSize?: unknown; totalCount?: unknown }; requisitionList?: { contestNo?: unknown }[]; queryString?: unknown };
        if (input.fieldData?.valid !== true || !input.fieldData.fields || Object.values(input.fieldData.fields).some(value => value !== '')
            || [input.filterSelectionParam, input.advancedSearchFiltersSelectionParam].some(filters => !Array.isArray(filters?.searchFilterSelections)
                || filters.searchFilterSelections.some(filter => !Array.isArray(filter.selectedValues) || filter.selectedValues.length))) return null;
        const paging = result.pagingData;
        if (result.careerSectionUnAvailable !== false || !paging || !Number.isSafeInteger(paging.currentPageNo) || (paging.currentPageNo as number) < 1
            || (paging.currentPageNo as number) > 1000 || paging.currentPageNo !== input.pageNo
            || !Number.isSafeInteger(paging.pageSize) || (paging.pageSize as number) < 1 || (paging.pageSize as number) > 250
            || !Number.isSafeInteger(paging.totalCount) || (paging.totalCount as number) < 0 || (paging.totalCount as number) > 50000
            || !Array.isArray(result.requisitionList) || !result.requisitionList.length || result.requisitionList.length > (paging.pageSize as number)) return null;
        const query = new URLSearchParams(typeof result.queryString === 'string' ? result.queryString : '');
        if ([...query.keys()].some(key => !['f', 's', 'a', 'page', 'multiline'].includes(key) || query.getAll(key).length !== 1)
            || query.get('f') !== 'null' || query.get('a') !== 'null' || Number(query.get('page') || '1') !== paging.currentPageNo) return null;
        const ids = result.requisitionList.map(row => row?.contestNo);
        if (!ids.every((id): id is string => typeof id === 'string' && /^[\w.-]+$/.test(id)) || new Set(ids).size !== ids.length) return null;
        return { portal: url.searchParams.get('portal')!, page: paging.currentPageNo as number, pageSize: paging.pageSize as number, total: paging.totalCount as number, ids };
    } catch { return null; }
}
export function taleoPageMatches(board: string, docs: BrowserDocument[], links: BrowserPostingLink[], page: number, evidence?: TaleoSearchPage): boolean {
    if (!evidence || evidence.page !== page || links.length !== evidence.ids.length || !links.every(link => evidence.ids.includes(link.id))) return false;
    return docs.some(doc => {
        if (browserAtsBoardFromUrl('taleo', doc.url) !== board) return false;
        const $ = cheerio.load(doc.html);
        const portals = [...new Set($('script').toArray().flatMap(node => [...$(node).text().matchAll(/\bportalNo\s*:\s*['"](\d+)['"]/g)].map(match => match[1])))];
        const position = /\bPage\s+(\d+)\b/i.exec(doc.text);
        return portals.length === 1 && portals[0] === evidence.portal && !!position && Number(position[1]) === page;
    });
}
