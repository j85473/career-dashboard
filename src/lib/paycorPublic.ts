import * as cheerio from 'cheerio';
import { createHash } from 'node:crypto';
import { cleanBrowserHtml, type BrowserDocument, type BrowserPosting, type BrowserPostingLink } from './browserAtsPosting';
import type { BrowserListing } from './browserAtsReader';
import { paycorIdentity, paycorBoardUrl, paycorPostingUrl, paycorUnfilteredBoard } from './paycorIdentity';
import { isPlaceholderEmployerName } from './companyIdentity';

const normalized = (value: string) => value.replace(/\s+/g, ' ').trim();
export function paycorPostingLink(board: string, value: string, title = ''): BrowserPostingLink | null {
    const identity = paycorIdentity(value);
    if (!identity?.detail || !identity.jobId || paycorBoardUrl(identity.clientId) !== board) return null;
    return { id: identity.jobId, url: paycorPostingUrl(identity.clientId, identity.jobId), title: normalized(title) };
}
function publishedCompany($: cheerio.CheerioAPI): string {
    const name = /^Careers\s*\|\s*(.+)$/i.exec($('title').first().text().trim())?.[1]?.trim()
        || $('[itemprop="hiringOrganization"] [itemprop="name"]').first().text().trim();
    return name && name.length < 200 && !isPlaceholderEmployerName(name) && !/^(?:Paycor|Newton)(?: Software)?$/i.test(name)
        ? name : 'Unknown Company';
}
/** Accept the publisher's complete, unfiltered single-page catalogue only. */
export const PAYCOR_CATALOGUE_LIMIT = 50_000;
export function paycorPublicListing(doc: BrowserDocument, board: string): BrowserListing | null {
    if (!paycorUnfilteredBoard(doc.url, board)) return null;
    const $ = cheerio.load(doc.html);
    const identity = paycorIdentity(doc.url)!;
    const clients = $('form[name="candidateHome"] input[name="clientId"]');
    if (clients.length !== 1 || clients.attr('value')?.toLowerCase() !== identity.clientId
        || $('form[name="candidateHome"] input[name="internal"]').attr('value') !== 'false') return null;
    if ($('#gnewtonCareerBody').length !== 1 || $('#gnewtonCareerHome').length !== 1) return null;
    if ($('#gnewtonCareerHome input').toArray().some(n => /^(?:keyword|search)/i.test($(n).attr('name') || '') && !!$(n).attr('value')?.trim())
        || $('#gnewtonCareerHome select option[selected]').toArray().some(n => !!$(n).attr('value')?.trim())) return null;
    const rows = $('#gnewtonCareerHome .gnewtonCareerGroupRowClass');
    const links: BrowserPostingLink[] = [], seen = new Set<string>();
    for (const row of rows.toArray()) {
        const anchors = $(row).find('.gnewtonCareerGroupJobTitleClass a[href]');
        if (anchors.length !== 1) return null;
        let link: BrowserPostingLink | null;
        try { link = paycorPostingLink(board, new URL(anchors.attr('href')!, doc.url).href, anchors.text()); } catch { return null; }
        if (!link || !link.title || seen.has(link.id)) return null;
        seen.add(link.id); links.push({ ...link, titleVerified: true });
    }
    // An unfamiliar layout or partial row must never silently exhaust a board.
    if ($('#gnewtonCareerHome a[href*="JobIntroduction.action"]').length !== links.length || links.length > PAYCOR_CATALOGUE_LIMIT) return null;
    const empty = !links.length && $('#gnewtonNoActiveJobs').length === 1
        && /We do not currently have any open jobs/i.test($('#gnewtonNoActiveJobs').text());
    if (!links.length && !empty) return null;
    return { links, total: links.length, next: null, emptyVerified: empty,
        signature: createHash('sha256').update(links.map(link => link.id).sort().join('\n')).digest('hex') };
}
export function parsePaycorPosting(board: string, link: BrowserPostingLink, docs: BrowserDocument[]): BrowserPosting | null {
    if (paycorPostingLink(board, link.url)?.id !== link.id) return null;
    for (const doc of docs) {
        if (paycorPostingLink(board, doc.url)?.id !== link.id) continue;
        const $ = cheerio.load(doc.html);
        if ($('#gnewtonJobDescription').length !== 1 || $('#gnewtonJobDescriptionText').length !== 1) continue;
        const application = $('#gravityApplyJob[action]');
        try {
            if (application.length !== 1) continue;
            const target = new URL(application.attr('action')!, doc.url);
            if (target.pathname !== '/career/SubmitResume.action') continue;
            target.pathname = '/career/JobIntroduction.action';
            if (paycorPostingLink(board, target.href)?.id !== link.id) continue;
        } catch { continue; }
        const title = normalized($('#gnewtonJobPosition').text()).replace(/^Position:\s*/i, '');
        const description = cleanBrowserHtml($('#gnewtonJobDescriptionText').html() || '');
        if (!title || description.length < 200) continue;
        const location = cleanBrowserHtml($('#gnewtonJobLocationInfo').html() || '').split(/\n+/).map(normalized).filter(Boolean).join('; ');
        return { ...link, title, titleVerified: true, company: publishedCompany($), description, location };
    }
    return null;
}
